import "server-only";

import { createServiceClient } from "@/lib/supabase/service";
import type { AnalysisExecutionManifest } from "@/types/analysis-internal";
import type { AnalysisEstimate, AnalysisSelectionInput } from "@/types/contracts";
import type { Json } from "@/types/database";

/** Controlled failure; the Action maps only known SQL states to public errors. */
export class AnalysisQueryError extends Error {
  constructor(readonly code = "") {
    super("The estimate query failed.");
    this.name = "AnalysisQueryError";
  }
}

/**
 * Creates the authoritative estimate through a service-only RPC. PostgreSQL
 * resolves workspace/role from the persisted Profile and derives every price,
 * hash, snapshot, and timestamp inside the same statement.
 */
export async function createAnalysisEstimate(
  actorId: string,
  input: AnalysisSelectionInput,
  manifest: AnalysisExecutionManifest,
): Promise<AnalysisEstimate> {
  const client = createServiceClient();
  const { data, error } = await client.rpc("create_analysis_estimate", {
    p_actor_id: actorId,
    p_source_version_ids: input.sourceVersionIds,
    p_comparison_version_ids: input.comparisonVersionIds,
    p_manifest: manifest as unknown as Json,
  });
  if (error) throw new AnalysisQueryError(error.code);

  const row = data?.[0];
  if (!row) throw new AnalysisQueryError("empty_result");
  return {
    estimateRef: row.estimate_ref,
    fixedCost: row.fixed_cost,
    expiresAt: row.expires_at,
    sourceVersionIds: row.source_version_ids,
    comparisonVersionIds: row.comparison_version_ids,
  };
}
