import { buildPairHashes } from "../retrieval";
import { N } from "./constants";
import type {
  BatchResult,
  CheckpointState,
  InternalFinding,
  RunBatchArgs,
} from "./types";
import { AnalysisWorkerError } from "./types";

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

/**
 * Runs one batch of up to N pairs sequentially, then renews the lease
 * with the advanced checkpoint (spec §6, spec §5 C2). A failed renew
 * aborts the batch without terminal calls; a failed pair returns its
 * code without advancing past it.
 */
export async function runBatch(args: RunBatchArgs): Promise<BatchResult> {
  const { claimed, context, provider, client, configuration, startIndex } =
    args;
  const startedAt =
    args.startedAt ?? new Date().toISOString();
  const findings: InternalFinding[] = [];
  let processed = startIndex;
  let lastPairFingerprint: string | null = null;

  const end = Math.min(startIndex + N, context.pairs.length);
  for (let index = startIndex; index < end; index += 1) {
    const pair = context.pairs[index];
    if (pair === undefined) break;
    let result: Awaited<ReturnType<typeof provider.analyzePair>>;
    try {
      result = await provider.analyzePair({ pair, configuration });
    } catch (error: unknown) {
      return {
        outcome: {
          kind: "failed",
          code: codeOf(error),
          processedPairs: processed,
          findings,
        },
        checkpoint: {
          processedPairs: processed,
          totalPairs: context.pairs.length,
          findingsCount: findings.length,
          lastPairFingerprint,
          startedAt,
        },
      };
    }
    if (!result.ok) {
      return {
        outcome: {
          kind: "failed",
          code: result.error.code,
          processedPairs: processed,
          findings,
        },
        checkpoint: {
          processedPairs: processed,
          totalPairs: context.pairs.length,
          findingsCount: findings.length,
          lastPairFingerprint,
          startedAt,
        },
      };
    }
    findings.push(...result.findings);
    processed = index + 1;
    lastPairFingerprint = pairFingerprint(
      pair.source.chunkId,
      pair.comparison.chunkId,
    );
  }

  const checkpoint: CheckpointState = {
    processedPairs: processed,
    totalPairs: context.pairs.length,
    findingsCount: findings.length,
    lastPairFingerprint,
    startedAt,
  };
  try {
    const renewed = await client.rpc("renew_analysis_lease", {
      p_analysis_id: claimed.id,
      p_operation_id: claimed.operationId,
      p_checkpoint: checkpoint,
    });
    if (renewed.error) {
      return {
        outcome: { kind: "aborted", processedPairs: processed, findings },
        checkpoint,
      };
    }
  } catch {
    return { outcome: { kind: "aborted", processedPairs: processed, findings }, checkpoint };
  }
  return {
    outcome: { kind: "completed", processedPairs: processed, findings },
    checkpoint,
  };
}
