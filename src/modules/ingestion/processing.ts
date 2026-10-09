import "server-only";

import { createServiceClient } from "@/lib/supabase/service";
import { reportProcessingFailure } from "@/lib/observability/processing-failure.server";
import type { SafeFailureCode } from "@/lib/observability/safe-event";
import {
  createProcessingBudget,
  PROCESSING_BUDGET_MS,
  ProcessingBudgetError,
  type ProcessingBudget,
} from "./processing-budget";
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
export const PROCESSING_TIMEOUT_MS = PROCESSING_BUDGET_MS;

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

function classify(error: unknown, budget: ProcessingBudget): SafeFailureCode {
  if (error instanceof ProcessingBudgetError) {
    return error.reason === "work_expired" ? "PROCESSING_FAILED" : "PERSISTENCE_FAILED";
  }
  if (budget.workSignal.aborted) return "PROCESSING_FAILED";
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

type CompletionReconciliation = "committed" | "same_claim" | "superseded" | "unknown";

async function reconcileCompletion(
  service: ReturnType<typeof createServiceClient>,
  versionId: string,
  documentId: string,
  operationId: string,
  budget: ProcessingBudget,
): Promise<CompletionReconciliation> {
  try {
    const signal = budget.closeSignal(500);
    const [versionResult, documentResult] = await Promise.all([
      service
        .from("document_versions")
        .select("processing_status, version_status, processing_operation_id")
        .eq("id", versionId)
        .abortSignal(signal)
        .maybeSingle(),
      service
        .from("documents")
        .select("active_version_id")
        .eq("id", documentId)
        .abortSignal(signal)
        .maybeSingle(),
    ]);
    const version = versionResult.data;
    const document = documentResult.data;
    if (versionResult.error || !version) return "unknown";
    if (version.processing_status === "processing") {
      return version.processing_operation_id === operationId ? "same_claim" : "superseded";
    }
    if (documentResult.error || !document) return "unknown";
    if (
      version.processing_status === "ready" &&
      version.version_status === "active" &&
      document.active_version_id === versionId
    ) {
      return "committed";
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Runs the S1-04 pipeline for one claimed version: downloads the canonical
 * object, parses → chunks (450/50) → embeds (gte-small 384d) → closes with
 * the single `finish_processing` RPC. Never does the CAS (the Route Handler
 * owns it), never recomputes SHA-256 (S1-02 verified it at promotion), never
 * reads the attempt path, and never throws: every failure is reported with
 * `captureOperationFailure` and marked `processing_failed`.
 */
export async function runProcessing(
  versionId: string,
  operationId: string,
  operation: "process" | "retry" = "process",
): Promise<void> {
  const workerEnteredAt = Date.now();
  let budget = createProcessingBudget(
    new Date(workerEnteredAt).toISOString(),
    Date.now,
    workerEnteredAt,
  );
  let service: ReturnType<typeof createServiceClient> | null = null;
  let reportPersistenceUncertainty = false;
  try {
    service = createServiceClient();

    const { data: row, error: rowError } = await service
      .from("document_versions")
      .select("id, workspace_id, document_id, storage_path, processing_status, processing_operation_id, processing_started_at, upload_state")
      .eq("id", versionId)
      .abortSignal(AbortSignal.any([budget.workSignal, budget.closeSignal(2_000)]))
      .single();
    if (rowError || !row) {
      throw new ProcessingError("PERSISTENCE_FAILED");
    }
    // Silent guards: another worker already moved the version, or it was
    // never confirmed. No failure, no failed-marker, no Sentry.
    if (
      row.processing_status !== "processing" ||
      row.processing_operation_id !== operationId ||
      row.upload_state !== "confirmed"
    ) {
      return;
    }

    const claimBudget = createProcessingBudget(
      row.processing_started_at,
      Date.now,
      workerEnteredAt,
    );
    budget.dispose();
    budget = claimBudget;
    budget.assertWorkRemaining();

    const extension = extensionFromStoragePath(row.storage_path);
    const response = await downloadStorageObject(row.storage_path, budget.workSignal);
    budget.assertWorkRemaining();
    if (!response) {
      throw new ProcessingError("PERSISTENCE_FAILED");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    budget.assertWorkRemaining();

    const { sections } = await parseDocument(bytes, extension);
    budget.assertWorkRemaining();
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

    budget.assertWorkRemaining();
    const embeddings = await embedBatch(drafts.map((draft) => draft.text_content), {
      signal: budget.workSignal,
      assertCanStart: budget.assertWorkRemaining,
    });
    budget.assertWorkRemaining();
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

    budget.assertWorkRemaining();
    let rpcError: unknown;
    try {
      ({ error: rpcError } = await service
        .rpc("finish_processing", {
          p_version_id: versionId,
          p_operation_id: operationId,
          p_chunks: chunks,
        })
        .abortSignal(budget.closeSignal(2_000)));
    } catch (error) {
      rpcError = error;
    }
    if (rpcError) {
      const reconciliation = await reconcileCompletion(
        service,
        versionId,
        row.document_id,
        operationId,
        budget,
      );
      if (reconciliation === "committed" || reconciliation === "superseded") return;
      if (reconciliation === "unknown") reportPersistenceUncertainty = true;
      throw new ProcessingError("PERSISTENCE_FAILED");
    }
  } catch (error) {
    const code = classify(error, budget);
    let failedStatePersisted = false;
    let failurePersistenceFailed = false;
    try {
      const failureService = service ?? createServiceClient();
      const { data, error: updateError } = await failureService
        .from("document_versions")
        .update({
          processing_status: "processing_failed",
          processing_operation_id: null,
          processing_started_at: null,
        })
        .eq("id", versionId)
        .eq("processing_status", "processing")
        .eq("processing_operation_id", operationId)
        .select("id")
        .abortSignal(budget.closeSignal(1_500));
      failedStatePersisted = !updateError && Boolean(data?.length);
      failurePersistenceFailed = Boolean(updateError);
    } catch {
      failurePersistenceFailed = true;
    }
    if (failedStatePersisted || failurePersistenceFailed || reportPersistenceUncertainty) {
      await reportProcessingFailure({
        module: "ingestion",
        operation,
        code: failurePersistenceFailed || reportPersistenceUncertainty ? "PERSISTENCE_FAILED" : code,
        correlationId: crypto.randomUUID(),
        versionId,
      }, Math.min(500, budget.remainingMs()));
    }
  } finally {
    budget.dispose();
  }
}
