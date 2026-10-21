import { buildPairHashes } from "../retrieval.ts";
import {
  HEARTBEAT_SECONDS,
  MAX_BATCH_MS,
} from "./constants.ts";
import type {
  BatchResult,
  CheckpointState,
  InternalFinding,
  RunBatchArgs,
} from "./types.ts";
import { AnalysisWorkerError } from "./types.ts";
import { reportAnalysisFailure } from "./telemetry.ts";

function pairFingerprint(
  sourceChunkId: string,
  comparisonChunkId: string,
): string {
  const hashes = buildPairHashes([{ sourceChunkId, comparisonChunkId }]);
  const first = hashes[0];
  if (typeof first !== "string") {
    throw new AnalysisWorkerError("INTERNAL_ERROR", "Empty pair hash");
  }
  return first;
}

function codeOf(error: unknown): AnalysisWorkerError["code"] {
  return error instanceof AnalysisWorkerError &&
    (error.code === "RETRIEVAL_FAILED" ||
      error.code === "ESTIMATE_STALE" ||
      error.code === "PROVIDER_UNAVAILABLE" ||
      error.code === "INVALID_PROVIDER_OUTPUT" ||
      error.code === "PERSISTENCE_FAILED" ||
      error.code === "TIMEOUT" ||
      error.code === "ATTEMPTS_EXHAUSTED" ||
      error.code === "INTERNAL_ERROR")
    ? error.code
    : "INTERNAL_ERROR";
}

function hasRenewal(result: { data: unknown; error: unknown }): boolean {
  if (result.error || result.data === null || result.data === undefined) {
    return false;
  }
  return !Array.isArray(result.data) || result.data.length > 0;
}

function failed(
  code: AnalysisWorkerError["code"],
  processedPairs: number,
  findings: InternalFinding[],
  checkpoint: CheckpointState,
): BatchResult {
  return {
    outcome: { kind: "failed", code, processedPairs, findings },
    checkpoint,
  };
}

/**
 * Processes one bounded page sequentially. While a provider call is pending,
 * a fenced heartbeat keeps the lease alive; the cursor advances only after
 * the batch persistence port confirms the SQL CAS.
 */
export async function runBatch(args: RunBatchArgs): Promise<BatchResult> {
  const {
    claimed,
    context,
    provider,
    client,
    persistence,
    configuration,
    checkpoint: previous,
  } = args;
  const batchStartedAt = Date.now();
  if (
    context.pairs.length !== context.pairCursors.length ||
    context.cursor?.lowChunkId !== previous.cursor?.lowChunkId ||
    context.cursor?.highChunkId !== previous.cursor?.highChunkId ||
    previous.totalPairs !== context.candidatePairCount
  ) {
    return failed("ESTIMATE_STALE", previous.processedPairs, [], previous);
  }

  const findings: InternalFinding[] = [];
  const emitBatchFailure = (
    code: AnalysisWorkerError["code"],
    index: number,
  ): void => {
    reportAnalysisFailure({
      module: "analysis",
      operation: "batch",
      code,
      analysis_id: claimed.id,
      workspace_id: claimed.workspaceId,
      attempt_count: claimed.attemptCount,
      batch_index: index,
      duration_ms: Date.now() - batchStartedAt,
    });
  };
  const startIndex = previous.processedPairs;
  let processed = startIndex;
  let lastPairFingerprint = previous.lastPairFingerprint;
  let cursor = previous.cursor;
  let abortError: AnalysisWorkerError | null = null;
  let heartbeatInFlight = false;
  let heartbeatStopped = false;
  const controller = new AbortController();
  const heartbeatInterval = args.heartbeatIntervalMs ?? HEARTBEAT_SECONDS * 1000;
  const batchTimeout = args.batchTimeoutMs ?? MAX_BATCH_MS;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(abortError ?? new AnalysisWorkerError("INTERNAL_ERROR")),
      { once: true },
    );
  });

  const stopTimers = () => {
    heartbeatStopped = true;
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
  };

  const heartbeat = async () => {
    if (heartbeatStopped || heartbeatInFlight || controller.signal.aborted) return;
    heartbeatInFlight = true;
    try {
      const result = await client.rpc<unknown>("renew_analysis_lease", {
        p_analysis_id: claimed.id,
        p_operation_id: claimed.operationId,
        p_expected_processed_pairs: previous.processedPairs,
        p_checkpoint: previous,
      });
      if (!hasRenewal(result)) {
        abortError = new AnalysisWorkerError("INTERNAL_ERROR", "Analysis lease lost");
        controller.abort();
      }
    } catch {
      abortError = new AnalysisWorkerError("INTERNAL_ERROR", "Analysis lease lost");
      controller.abort();
    } finally {
      heartbeatInFlight = false;
    }
  };

  if (heartbeatInterval > 0) {
    heartbeatTimer = setInterval(() => {
      void heartbeat();
    }, heartbeatInterval);
  }
  if (batchTimeout > 0) {
    timeoutTimer = setTimeout(() => {
      abortError = new AnalysisWorkerError("TIMEOUT", "Analysis batch timed out");
      controller.abort();
    }, batchTimeout);
  }

  try {
    for (let index = 0; index < context.pairs.length; index += 1) {
      if (controller.signal.aborted) {
        throw abortError ?? new AnalysisWorkerError("INTERNAL_ERROR");
      }
      const pair = context.pairs[index];
      const pairCursor = context.pairCursors[index];
      if (!pair || !pairCursor) {
        throw new AnalysisWorkerError("RETRIEVAL_FAILED", "Invalid retrieval page");
      }
      const result = await Promise.race([
        provider.analyzePair({ pair, configuration, signal: controller.signal }),
        aborted,
      ]);
      if (!result.ok) {
        emitBatchFailure(result.error.code, index);
        return failed(
          result.error.code,
          processed,
          findings,
          previous,
        );
      }
      findings.push(...result.findings);
      processed += 1;
      cursor = pairCursor;
      lastPairFingerprint = pairFingerprint(
        pair.source.chunkId,
        pair.comparison.chunkId,
      );
    }
  } catch (error: unknown) {
    const code = codeOf(abortError ?? error);
    if (code === "INTERNAL_ERROR") {
      return {
        outcome: { kind: "aborted", processedPairs: processed, findings },
        checkpoint: previous,
      };
    }
    emitBatchFailure(code, processed);
    return failed(code, processed, findings, previous);
  } finally {
    stopTimers();
  }

  const next: CheckpointState = {
    processedPairs: processed,
    totalPairs: context.candidatePairCount,
    findingsCount: previous.findingsCount + findings.length,
    lastPairFingerprint,
    startedAt: previous.startedAt,
    cursor,
  };
  const hasMore = processed < context.candidatePairCount;
  try {
    const saved = await persistence.persist({
      analysisId: claimed.id,
      operationId: claimed.operationId,
      expectedProcessedPairs: previous.processedPairs,
      checkpoint: next,
      findings,
      hasMore,
    });
    if (!saved.ok) {
      return {
        outcome: { kind: "aborted", processedPairs: processed, findings },
        checkpoint: previous,
      };
    }
  } catch {
    return {
      outcome: { kind: "aborted", processedPairs: processed, findings },
      checkpoint: previous,
    };
  }

  return {
    outcome: { kind: "completed", processedPairs: processed, findings },
    checkpoint: next,
  };
}
