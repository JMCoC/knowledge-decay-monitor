import "server-only";

import { createServiceClient } from "@/lib/supabase/service";
import type { AnalysisExecutionManifest } from "@/types/analysis-internal";
import type {
  RetryAnalysisInput,
  RetryAnalysisResult,
  RunAnalysisInput,
  RunAnalysisResult,
} from "@/types/contracts";
import type { Json } from "@/types/database";

/** Carries only the SQLSTATE used by the Action's closed public error map. */
export class AnalysisCommandError extends Error {
  constructor(readonly code = "") {
    super("The analysis command failed.");
    this.name = "AnalysisCommandError";
  }
}

function manifestJson(manifest: AnalysisExecutionManifest | null): Json {
  return manifest as unknown as Json;
}

export async function submitRunCommand(
  actorId: string,
  input: RunAnalysisInput,
  manifest: AnalysisExecutionManifest | null,
): Promise<RunAnalysisResult> {
  const client = createServiceClient();
  const { data, error } = await client.rpc("run_analysis", {
    p_actor_id: actorId,
    p_estimate_ref: input.estimateRef,
    p_idempotency_key: input.idempotencyKey,
    p_current_manifest: manifestJson(manifest),
  });
  if (error) throw new AnalysisCommandError(error.code);

  const row = data?.[0];
  if (!row) throw new AnalysisCommandError("empty_result");
  return { analysisId: row.analysis_id, status: row.status };
}

export async function submitRetryCommand(
  actorId: string,
  input: RetryAnalysisInput,
  manifest: AnalysisExecutionManifest | null,
): Promise<RetryAnalysisResult> {
  const client = createServiceClient();
  const { data, error } = await client.rpc("retry_analysis", {
    p_actor_id: actorId,
    p_failed_analysis_id: input.failedAnalysisId,
    p_estimate_ref: input.estimateRef,
    p_idempotency_key: input.idempotencyKey,
    p_current_manifest: manifestJson(manifest),
  });
  if (error) throw new AnalysisCommandError(error.code);

  const row = data?.[0];
  if (!row) throw new AnalysisCommandError("empty_result");
  return {
    analysisId: row.analysis_id,
    status: row.status,
    retryOfAnalysisId: row.retry_of_analysis_id,
  };
}
