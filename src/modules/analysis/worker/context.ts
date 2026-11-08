import type {
  AnalysisCandidatePair,
  AnalysisPairCursor,
} from "../../../types/analysis-internal.ts";
import { N, RETRIEVAL_TIMEOUT_MS } from "./constants.ts";
import type { AnalysisWorkerDb, LoadedContext } from "./types.ts";
import { AnalysisWorkerError } from "./types.ts";

interface CandidatePairRow {
  source_chunk_id: unknown;
  source_version_id: unknown;
  source_document_id: unknown;
  source_text: unknown;
  comparison_chunk_id: unknown;
  comparison_version_id: unknown;
  comparison_document_id: unknown;
  comparison_text: unknown;
  pair_low_id: unknown;
  pair_high_id: unknown;
}

interface ScopeSummaryRow {
  chunk_count: unknown;
  candidate_pair_count: unknown;
  chunks_revision: unknown;
  request_fingerprint: unknown;
  fixed_cost: unknown;
}

export interface LoadAnalysisContextOptions {
  retrievalTimeoutMs?: number;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
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
    throw new AnalysisWorkerError("RETRIEVAL_FAILED", "Invalid pair row");
  }
  return value;
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new AnalysisWorkerError("RETRIEVAL_FAILED", "Invalid retrieval summary");
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

function toPairCursor(row: CandidatePairRow): AnalysisPairCursor {
  const pair = toPair(row);
  const expectedLow =
    pair.source.chunkId < pair.comparison.chunkId
      ? pair.source.chunkId
      : pair.comparison.chunkId;
  const expectedHigh =
    pair.source.chunkId < pair.comparison.chunkId
      ? pair.comparison.chunkId
      : pair.source.chunkId;
  const lowChunkId = nonEmptyText(row.pair_low_id);
  const highChunkId = nonEmptyText(row.pair_high_id);
  if (lowChunkId !== expectedLow || highChunkId !== expectedHigh) {
    throw new AnalysisWorkerError("RETRIEVAL_FAILED", "Invalid pair cursor");
  }
  return { lowChunkId, highChunkId };
}

function cursorAfter(
  left: AnalysisPairCursor | null,
  right: AnalysisPairCursor,
): boolean {
  if (!left) return true;
  return (
    right.lowChunkId > left.lowChunkId ||
    (right.lowChunkId === left.lowChunkId &&
      right.highChunkId > left.highChunkId)
  );
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

function retrievalError(error: { code?: string } | null): AnalysisWorkerError {
  if (error?.code === "P2102") {
    return new AnalysisWorkerError("ESTIMATE_STALE", "Analysis snapshot is stale");
  }
  if (error?.code === "22023") {
    // The operation or lease was superseded. Do not terminalize a live job
    // based on a worker that no longer owns its fencing token.
    return new AnalysisWorkerError("INTERNAL_ERROR", "Analysis operation expired");
  }
  return new AnalysisWorkerError("RETRIEVAL_FAILED", "Retrieval failed");
}

function firstRow(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) return object(value[0]);
  return object(value);
}

/**
 * Loads the immutable SQL-computed summary and one bounded keyset page.
 * Pair text is never materialized beyond the worker batch size.
 */
export async function loadAnalysisContext(
  analysisId: string,
  operationId: string,
  cursor: AnalysisPairCursor | null,
  processedPairs: number,
  client: AnalysisWorkerDb,
  options?: LoadAnalysisContextOptions,
): Promise<LoadedContext> {
  if (!analysisId || !operationId || !Number.isInteger(processedPairs) || processedPairs < 0) {
    throw new AnalysisWorkerError("RETRIEVAL_FAILED", "Invalid analysis operation");
  }
  const timeoutMs = options?.retrievalTimeoutMs ?? RETRIEVAL_TIMEOUT_MS;
  const analysisResult = await client
    .from("analyses")
    .select("workspace_id,request_fingerprint,retrieval_config,fixed_cost")
    .eq("id", analysisId)
    .single<Record<string, unknown>>();
  if (analysisResult.error || analysisResult.data === null) {
    throw new AnalysisWorkerError("RETRIEVAL_FAILED", "Analysis not found");
  }

  const analysis = analysisResult.data;
  const workspaceId = rowText(analysis, "workspace_id");
  const requestFingerprint = rowText(analysis, "request_fingerprint");
  const retrievalConfig = object(analysis["retrieval_config"]);
  if (!retrievalConfig) {
    throw new AnalysisWorkerError("RETRIEVAL_FAILED", "Invalid retrieval config");
  }
  const storedChunksRevision = rowText(retrievalConfig, "chunksRevision");
  const storedConfigFingerprint = rowText(retrievalConfig, "fingerprint");
  const fixedCost = nonNegativeInteger(analysis["fixed_cost"]);

  const summaryResult = await withRetrievalTimeout(
    client.rpc<ScopeSummaryRow[]>("read_analysis_retrieval_summary", {
      p_analysis_id: analysisId,
      p_operation_id: operationId,
    }),
    timeoutMs,
  );
  if (summaryResult.error || summaryResult.data === null) {
    throw retrievalError(summaryResult.error);
  }
  const summary = firstRow(summaryResult.data);
  if (!summary) {
    throw new AnalysisWorkerError("RETRIEVAL_FAILED", "Retrieval summary missing");
  }
  const chunkCount = nonNegativeInteger(summary["chunk_count"]);
  const candidatePairCount = nonNegativeInteger(summary["candidate_pair_count"]);
  const chunksRevision = rowText(summary, "chunks_revision");
  const fingerprint = rowText(summary, "request_fingerprint");
  const summaryFixedCost = nonNegativeInteger(summary["fixed_cost"]);
  if (
    fingerprint !== requestFingerprint ||
    fingerprint !== storedConfigFingerprint ||
    chunksRevision !== storedChunksRevision ||
    summaryFixedCost !== fixedCost
  ) {
    throw new AnalysisWorkerError("ESTIMATE_STALE", "Analysis snapshot diverged");
  }
  if (processedPairs > candidatePairCount) {
    throw new AnalysisWorkerError("ESTIMATE_STALE", "Analysis cursor is beyond snapshot");
  }

  const pageResult = await withRetrievalTimeout(
    client.rpc<CandidatePairRow[]>("read_analysis_pair_batch", {
      p_analysis_id: analysisId,
      p_operation_id: operationId,
      p_after_low: cursor?.lowChunkId ?? null,
      p_after_high: cursor?.highChunkId ?? null,
      p_limit: N,
    }),
    timeoutMs,
  );
  if (pageResult.error || pageResult.data === null || !Array.isArray(pageResult.data)) {
    throw retrievalError(pageResult.error);
  }
  if (pageResult.data.length > N) {
    throw new AnalysisWorkerError("RETRIEVAL_FAILED", "Retrieval page exceeded limit");
  }

  const pairs: AnalysisCandidatePair[] = [];
  const pairCursors: AnalysisPairCursor[] = [];
  let lastCursor = cursor;
  for (const unknownRow of pageResult.data) {
    const row = object(unknownRow) as CandidatePairRow | null;
    if (!row) {
      throw new AnalysisWorkerError("RETRIEVAL_FAILED", "Invalid pair row");
    }
    const pairCursor = toPairCursor(row);
    if (!cursorAfter(lastCursor, pairCursor)) {
      throw new AnalysisWorkerError("RETRIEVAL_FAILED", "Pair page is not ordered");
    }
    pairs.push(toPair(row));
    pairCursors.push(pairCursor);
    lastCursor = pairCursor;
  }
  const expectedPageSize = Math.min(N, candidatePairCount - processedPairs);
  if (pairs.length !== expectedPageSize) {
    throw new AnalysisWorkerError("ESTIMATE_STALE", "Retrieval page does not match snapshot");
  }

  return {
    analysisId,
    workspaceId,
    sourceVersionIds: [],
    comparisonVersionIds: [],
    pairs,
    pairCursors,
    cursor,
    fingerprint,
    chunkCount,
    candidatePairCount,
  };
}
