import {
  computeRequestFingerprint,
  FROZEN_RETRIEVAL_PARAMS,
} from "../retrieval";
import type { AnalysisCandidatePair } from "../../../types/analysis-internal";
import type { AnalysisScopeRole } from "../../../types/contracts";
import { RETRIEVAL_TIMEOUT_MS } from "./constants";
import type { AnalysisWorkerDb, LoadedContext } from "./types";
import { AnalysisWorkerError } from "./types";

interface CandidatePairRow {
  source_chunk_id: unknown;
  source_version_id: unknown;
  source_document_id: unknown;
  source_text: unknown;
  comparison_chunk_id: unknown;
  comparison_version_id: unknown;
  comparison_document_id: unknown;
  comparison_text: unknown;
}

interface ScopeRow {
  document_id: unknown;
  version_id: unknown;
  role: unknown;
}

export interface LoadAnalysisContextOptions {
  retrievalTimeoutMs?: number;
}

function configText(config: unknown, field: string): string | undefined {
  if (typeof config === "object" && config !== null) {
    const value = (config as Record<string, unknown>)[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function configNumber(config: unknown, field: string): number | undefined {
  if (typeof config === "object" && config !== null) {
    const value = (config as Record<string, unknown>)[field];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function rowText(
  row: Record<string, unknown>,
  field: string,
): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new AnalysisWorkerError("RETRIEVAL_FAILED", `Invalid row: ${field}`);
  }
  return value;
}

function nonEmptyText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AnalysisWorkerError("RETRIEVAL_FAILED", "Invalid pair text");
  }
  return value;
}

function toPair(row: CandidatePairRow): AnalysisCandidatePair {
  return {
    source: {
      documentId: nonEmptyText(row.source_document_id),
      versionId: nonEmptyText(row.source_version_id),
      chunkId: nonEmptyText(row.source_chunk_id),
      role: "source",
      text: nonEmptyText(row.source_text),
    },
    comparison: {
      documentId: nonEmptyText(row.comparison_document_id),
      versionId: nonEmptyText(row.comparison_version_id),
      chunkId: nonEmptyText(row.comparison_chunk_id),
      role: "comparison",
      text: nonEmptyText(row.comparison_text),
    },
  };
}

async function withRetrievalTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new AnalysisWorkerError(
                "RETRIEVAL_FAILED",
                "Retrieval timed out",
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Loads everything the worker needs from persisted state (spec §6 D1).
 * Only analysisId comes from the caller; scope, cost, configuration and
 * pairs are re-read from the database and the fingerprint is re-verified
 * on every attempt (divergence → ESTIMATE_STALE).
 */
export async function loadAnalysisContext(
  analysisId: string,
  client: AnalysisWorkerDb,
  options?: LoadAnalysisContextOptions,
): Promise<LoadedContext> {
  if (typeof analysisId !== "string" || analysisId.length === 0) {
    throw new AnalysisWorkerError("RETRIEVAL_FAILED", "Invalid analysis id");
  }
  const timeoutMs = options?.retrievalTimeoutMs ?? RETRIEVAL_TIMEOUT_MS;

  const analysisResult = await client
    .from("analyses")
    .select(
      "id,workspace_id,request_fingerprint,retrieval_config,pricing_version,prompt_version,output_schema_version",
    )
    .eq("id", analysisId)
    .single<Record<string, unknown>>();
  if (analysisResult.error || analysisResult.data === null) {
    throw new AnalysisWorkerError("RETRIEVAL_FAILED", "Analysis not found");
  }
  const analysisRow = analysisResult.data;
  const workspaceId = rowText(analysisRow, "workspace_id");
  const requestFingerprint = rowText(analysisRow, "request_fingerprint");
  const retrievalConfig: unknown = analysisRow["retrieval_config"];

  const scopeResult = await client
    .from("analysis_documents")
    .select("document_id,version_id,role")
    .eq("analysis_id", analysisId);
  if (scopeResult.error || scopeResult.data === null) {
    throw new AnalysisWorkerError("RETRIEVAL_FAILED", "Scope not found");
  }
  const sourceVersionIds: string[] = [];
  const comparisonVersionIds: string[] = [];
  for (const entry of scopeResult.data as ScopeRow[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const versionId =
      typeof entry.version_id === "string" ? entry.version_id : null;
    if (versionId === null || versionId.length === 0) continue;
    const role: AnalysisScopeRole | null =
      entry.role === "source" || entry.role === "comparison"
        ? entry.role
        : null;
    if (role === "source") sourceVersionIds.push(versionId);
    else if (role === "comparison") comparisonVersionIds.push(versionId);
  }

  const retrievalResult = await withRetrievalTimeout(
    client.rpc<CandidatePairRow[]>("retrieve_candidate_pairs", {
      p_workspace_id: workspaceId,
      p_source_version_ids: sourceVersionIds,
      p_comparison_version_ids: comparisonVersionIds,
      p_top_k: FROZEN_RETRIEVAL_PARAMS.topK,
      p_threshold: FROZEN_RETRIEVAL_PARAMS.similarityThreshold,
    }),
    timeoutMs,
  );
  if (retrievalResult.error || retrievalResult.data === null) {
    throw new AnalysisWorkerError("RETRIEVAL_FAILED", "Retrieval failed");
  }
  const pairs = retrievalResult.data.map(toPair);

  const chunkIds = new Set<string>();
  for (const pair of pairs) {
    chunkIds.add(pair.source.chunkId);
    chunkIds.add(pair.comparison.chunkId);
  }
  const fingerprint = computeRequestFingerprint(
    {
      chunkCount: chunkIds.size,
      candidatePairCount: pairs.length,
      sortedSourceVersionIds: sourceVersionIds,
      sortedComparisonVersionIds: comparisonVersionIds,
      pairs: pairs.map((pair) => ({
        sourceChunkId: pair.source.chunkId,
        comparisonChunkId: pair.comparison.chunkId,
      })),
      chunkIds: [...chunkIds],
    },
    {
      similarityThreshold: configNumber(retrievalConfig, "similarityThreshold"),
      topK: configNumber(retrievalConfig, "topK"),
      embeddingRevision: configText(retrievalConfig, "embeddingRevision"),
      pricingVersion: configText(analysisRow, "pricing_version"),
      promptVersion: configText(analysisRow, "prompt_version"),
      outputSchemaVersion: configText(analysisRow, "output_schema_version"),
    },
  );
  if (fingerprint !== requestFingerprint) {
    throw new AnalysisWorkerError("ESTIMATE_STALE", "Scope fingerprint diverged");
  }

  return {
    analysisId,
    workspaceId,
    sourceVersionIds,
    comparisonVersionIds,
    pairs,
    fingerprint,
    chunkCount: chunkIds.size,
    candidatePairCount: pairs.length,
  };
}
