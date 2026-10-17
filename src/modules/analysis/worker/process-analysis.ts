import { FROZEN_RETRIEVAL_PARAMS } from "../retrieval.ts";
import type {
  AIProvider,
  AnalysisConfiguration,
  AnalysisFailureCode,
  InternalFinding,
} from "../../../types/analysis-internal.ts";
import { runBatch } from "./batch.ts";
import { parseClaimedRow } from "./claim.ts";
import { loadAnalysisContext } from "./context.ts";
import type { AnalysisFinalization } from "./finalization.ts";
import type {
  AnalysisWorkerDb,
  ClaimedAnalysis,
} from "./types.ts";
import { AnalysisWorkerError } from "./types.ts";

export interface RunAnalysisJobArgs {
  client: AnalysisWorkerDb;
  provider: AIProvider;
  finalization: AnalysisFinalization;
  analysisId: string;
}

function configText(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value === "string" && value.length > 0) return value;
  throw new AnalysisWorkerError(
    "INTERNAL_ERROR",
    "Invalid persisted configuration",
  );
}

function providerRef(value: unknown): { provider: string; model: string } {
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (
      typeof record["provider"] === "string" &&
      record["provider"].length > 0 &&
      typeof record["model"] === "string" &&
      record["model"].length > 0
    ) {
      return { provider: record["provider"], model: record["model"] };
    }
  }
  throw new AnalysisWorkerError(
    "INTERNAL_ERROR",
    "Invalid persisted provider",
  );
}

/**
 * Builds the provider configuration from persisted state (ticket S2-06
 * DoD: the worker reads persisted scope/cost/configuration, never the
 * caller payload). Retrieval shape params stay frozen per S2-04; the
 * estimate/worker fingerprint check in loadAnalysisContext already
 * rejected any scope divergence before this runs.
 */
async function readPersistedConfiguration(
  client: AnalysisWorkerDb,
  analysisId: string,
): Promise<AnalysisConfiguration> {
  const result = await client
    .from("analyses")
    .select(
      "retrieval_config,pricing_version,prompt_version,output_schema_version,provider_config",
    )
    .eq("id", analysisId)
    .single<Record<string, unknown>>();
  if (result.error || result.data === null) {
    throw new AnalysisWorkerError(
      "INTERNAL_ERROR",
      "Configuration not found",
    );
  }
  const row = result.data;
  const retrievalConfig: unknown = row["retrieval_config"];
  const providerConfig: unknown = row["provider_config"];
  if (typeof retrievalConfig !== "object" || retrievalConfig === null) {
    throw new AnalysisWorkerError(
      "INTERNAL_ERROR",
      "Invalid persisted retrieval config",
    );
  }
  if (typeof providerConfig !== "object" || providerConfig === null) {
    throw new AnalysisWorkerError(
      "INTERNAL_ERROR",
      "Invalid persisted provider config",
    );
  }
  const configs = providerConfig as Record<string, unknown>;
  const retrievalFields = retrievalConfig as Record<string, unknown>;
  return {
    retrieval: {
      topK: FROZEN_RETRIEVAL_PARAMS.topK,
      similarityThreshold: FROZEN_RETRIEVAL_PARAMS.similarityThreshold,
      chunksRevision: configText(retrievalFields, "chunksRevision"),
      embeddingRevision: configText(retrievalFields, "embeddingRevision"),
      fingerprint: configText(retrievalFields, "fingerprint"),
    },
    pricingVersion: configText(row, "pricing_version"),
    promptVersion: configText(row, "prompt_version"),
    outputSchemaVersion: configText(row, "output_schema_version"),
    providers: {
      primary: providerRef(configs["primary"]),
      fallback: providerRef(configs["fallback"]),
    },
  };
}

interface PersistedResume {
  startIndex: number;
  startedAt?: string;
}

/**
 * Seeds batch resumption from the checkpoint persisted by renews
 * (spec §4.4: a retry continues from the checkpoint, not from batch
 * zero). Missing or malformed checkpoints resume from zero.
 */
async function readPersistedResume(
  client: AnalysisWorkerDb,
  analysisId: string,
): Promise<PersistedResume> {
  const result = await client
    .from("analyses")
    .select("checkpoint")
    .eq("id", analysisId)
    .single<Record<string, unknown>>();
  if (result.error || result.data === null) {
    return { startIndex: 0 };
  }
  const checkpoint: unknown = result.data["checkpoint"];
  if (typeof checkpoint !== "object" || checkpoint === null) {
    return { startIndex: 0 };
  }
  const record = checkpoint as Record<string, unknown>;
  const processed = record["processedPairs"];
  const startedAt = record["startedAt"];
  return {
    startIndex:
      typeof processed === "number" &&
      Number.isInteger(processed) &&
      processed >= 0
        ? processed
        : 0,
    startedAt: typeof startedAt === "string" ? startedAt : undefined,
  };
}

async function settle(
  finalization: AnalysisFinalization,
  claimed: ClaimedAnalysis,
  outcome:
    | { kind: "completed"; findings: InternalFinding[] }
    | { kind: "failed"; code: AnalysisFailureCode },
): Promise<void> {
  try {
    await finalization.finalize({
      analysisId: claimed.id,
      operationId: claimed.operationId,
      outcome,
    });
  } catch {
    // The terminal channel is best-effort: S2-08 makes finalization
    // idempotent and the lease/fencing decides on reclaim. A "superseded"
    // ({ ok: false }) result is likewise swallowed, never retried here.
  }
}

/**
 * One invocation processes at most one batch (N pairs, spec §4.3) and
 * reports what the caller must do next. The loop lives in the caller
 * (self-fetch between batches, spec §4.2); the persisted checkpoint
 * written by each batch renew is what advances the next invocation.
 * Findings accumulate only in memory: the completed close carries this
 * invocation's batch findings. Cross-invocation accumulation without
 * loss requires S2-08 per-batch staging (RLS already hides findings of
 * non-completed analyses); until then this is a documented v1 limit.
 */
export type RunAnalysisJobResult =
  | { kind: "completed"; claimedId: string }
  | { kind: "has-more"; claimedId: string }
  | { kind: "failed"; code: AnalysisFailureCode; claimedId: string }
  | { kind: "aborted"; claimedId: string }
  | { kind: "idle" };

/**
 * Runs a single batch pass: claim → load → one batch → maybe finalize
 * (spec §6). Terminal calls happen only when the worker decides an
 * outcome (spec §8 F1): undecided failures (INTERNAL_ERROR, uncoded
 * throws, lost leases) leave the job processing for the sweep.
 * Never logs pair text, chunks, prompts or tokens.
 */
export async function runAnalysisJob(
  args: RunAnalysisJobArgs,
): Promise<RunAnalysisJobResult> {
  const { client, provider, finalization, analysisId } = args;

  let claimed: ClaimedAnalysis;
  try {
    const claimResult = await client.rpc<Record<string, unknown>[]>(
      "claim_analysis",
      { p_analysis_id: analysisId },
    );
    const rows =
      claimResult.error || !Array.isArray(claimResult.data)
        ? []
        : claimResult.data;
    const first = rows[0];
    if (first === undefined) return { kind: "idle" };
    claimed = parseClaimedRow(first);
  } catch {
    return { kind: "idle" };
  }

  try {
    // NOTE: claimed.id, not the caller payload: a directed claim falls
    // back to the FIFO sweep (§4.2/§5.1) and may return another job.
    const context = await loadAnalysisContext(claimed.id, client);
    const configuration = await readPersistedConfiguration(
      client,
      claimed.id,
    );
    const resumed = await readPersistedResume(client, claimed.id);
    let startIndex = resumed.startIndex;
    if (context.pairs.length > 0 && startIndex >= context.pairs.length) {
      // Crash between the last renew and finalize: recompute from zero.
      // S2-08 deduplicates findings intra-analysis by fingerprint.
      startIndex = 0;
    }
    if (startIndex >= context.pairs.length) {
      // Genuinely empty analysis: valid completed close with no findings.
      await settle(finalization, claimed, { kind: "completed", findings: [] });
      return { kind: "completed", claimedId: claimed.id };
    }
    const result = await runBatch({
      claimed,
      context,
      provider,
      client,
      configuration,
      startIndex,
      startedAt: resumed.startedAt,
    });
    if (result.outcome.kind === "failed") {
      if (result.outcome.code === "INTERNAL_ERROR")
        return { kind: "aborted", claimedId: claimed.id };
      await settle(finalization, claimed, {
        kind: "failed",
        code: result.outcome.code,
      });
      return { kind: "failed", code: result.outcome.code, claimedId: claimed.id };
    }
    if (result.outcome.kind === "aborted")
      return { kind: "aborted", claimedId: claimed.id };
    if (result.checkpoint.processedPairs < context.pairs.length) {
      return { kind: "has-more", claimedId: claimed.id };
    }
    await settle(finalization, claimed, {
      kind: "completed",
      findings: result.outcome.findings,
    });
    return { kind: "completed", claimedId: claimed.id };
  } catch (error: unknown) {
    if (error instanceof AnalysisWorkerError) {
      if (error.code === "INTERNAL_ERROR")
        return { kind: "aborted", claimedId: claimed.id };
      await settle(finalization, claimed, {
        kind: "failed",
        code: error.code,
      });
      return { kind: "failed", code: error.code, claimedId: claimed.id };
    }
    return { kind: "aborted", claimedId: claimed.id };
  }
}
