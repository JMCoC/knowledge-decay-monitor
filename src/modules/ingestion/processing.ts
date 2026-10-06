import "server-only";

import { createServiceClient } from "@/lib/supabase/service";
import { captureOperationFailure } from "@/lib/observability/operation-events";
import type { SafeFailureCode } from "@/lib/observability/safe-event";
import { downloadStorageObject } from "./storage";
import {
  MAX_CHUNKS_PER_VERSION,
  ParseError,
  chunkDeterministic,
  parseDocument,
  type ChunkDraft,
} from "./chunking";
import { EmbeddingError, embedBatch } from "./embeddings";
import type { AllowedExtension } from "./validation";

/** Frozen in Task 0: the worker fails to `processing_failed` before the platform kills it. */
export const PROCESSING_TIMEOUT_MS = 50_000;

const CHUNK_TARGET_TOKENS = 450;
const CHUNK_OVERLAP_TOKENS = 50;

/** Internal marker for failures the worker classifies itself (never a Sentry code leak). */
class ProcessingError extends Error {
  constructor(readonly code: SafeFailureCode) {
    super("The processing pipeline failed.");
    this.name = "ProcessingError";
  }
}

function extensionFromStoragePath(storagePath: string): AllowedExtension {
  const lower = storagePath.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".md")) return "md";
  throw new ProcessingError("PARSING_FAILED");
}

function classify(error: unknown, signalAborted: boolean): SafeFailureCode {
  if (signalAborted) return "PERSISTENCE_FAILED";
  if (error instanceof ProcessingError) return error.code;
  if (error instanceof ParseError) {
    // NOTE: the real ParseErrorCode has no TOO_LARGE; the chunker signals
    // the cap with CHUNK_LIMIT_EXCEEDED (chunking.ts).
    return error.code === "CHUNK_LIMIT_EXCEEDED" ? "CHUNKING_FAILED" : "PARSING_FAILED";
  }
  if (error instanceof EmbeddingError) return "EMBEDDING_FAILED";
  if (error instanceof DOMException && error.name === "AbortError") return "PERSISTENCE_FAILED";
  if (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError") {
    return "PERSISTENCE_FAILED";
  }
  return "PROCESSING_FAILED";
}

/**
 * Runs the S1-04 pipeline for one claimed version: downloads the canonical
 * object, parses → chunks (450/50) → embeds (gte-small 384d) → closes with
 * the single `finish_processing` RPC. Never does the CAS (the Route Handler
 * owns it), never recomputes SHA-256 (S1-02 verified it at promotion), never
 * reads the attempt path, and never throws: every failure is reported with
 * `captureOperationFailure` and marked `processing_failed`.
 */
export async function runProcessing(versionId: string, operationId: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROCESSING_TIMEOUT_MS);
  try {
    const service = createServiceClient();

    const { data: row, error: rowError } = await service
      .from("document_versions")
      .select("id, workspace_id, document_id, storage_path, processing_status, upload_state")
      .eq("id", versionId)
      .single();
    if (rowError || !row) {
      throw new ProcessingError("PERSISTENCE_FAILED");
    }
    // Silent guards: another worker already moved the version, or it was
    // never confirmed. No failure, no failed-marker, no Sentry.
    if (row.processing_status !== "processing" || row.upload_state !== "confirmed") {
      return;
    }

    const extension = extensionFromStoragePath(row.storage_path);
    const response = await downloadStorageObject(row.storage_path, controller.signal);
    if (!response) {
      throw new ProcessingError("PERSISTENCE_FAILED");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());

    const { sections } = await parseDocument(bytes, extension);
    let drafts: ChunkDraft[];
    try {
      drafts = chunkDeterministic(sections, {
        targetTokens: CHUNK_TARGET_TOKENS,
        overlapTokens: CHUNK_OVERLAP_TOKENS,
      });
    } catch (error) {
      if (error instanceof ParseError && error.code === "CHUNK_LIMIT_EXCEEDED") throw error;
      throw new ProcessingError("CHUNKING_FAILED");
    }
    if (drafts.length === 0 || drafts.length > MAX_CHUNKS_PER_VERSION) {
      throw new ProcessingError("CHUNKING_FAILED");
    }

    const embeddings = await embedBatch(drafts.map((draft) => draft.text_content));
    if (embeddings.length !== drafts.length) {
      throw new ProcessingError("EMBEDDING_FAILED");
    }

    const chunks = drafts.map((draft, index) => ({
      chunk_index: draft.chunk_index,
      text_content: draft.text_content,
      page_number: draft.page_number,
      section_heading: draft.section_heading,
      embedding: embeddings[index] as string,
    }));

    let rpcError: unknown;
    try {
      ({ error: rpcError } = await service.rpc("finish_processing", {
        p_version_id: versionId,
        p_operation_id: operationId,
        p_chunks: chunks,
      }));
    } catch (error) {
      rpcError = error;
    }
    if (rpcError) {
      throw new ProcessingError("PERSISTENCE_FAILED");
    }
  } catch (error) {
    const code = classify(error, controller.signal.aborted);
    try {
      captureOperationFailure({
        module: "ingestion",
        operation: "process",
        code,
        correlationId: crypto.randomUUID(),
      });
    } catch {
      // Telemetry must not change the controlled product result.
    }
    try {
      const service = createServiceClient();
      await service.from("document_versions").update({ processing_status: "processing_failed" }).eq("id", versionId);
    } catch {
      // Silent. The Sentry event above already went out.
    }
  } finally {
    clearTimeout(timeout);
  }
}
