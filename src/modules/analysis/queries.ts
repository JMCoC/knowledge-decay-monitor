import "server-only";

import { createReadOnlyClient } from "@/lib/supabase/server";
import type { Database, Json } from "@/types/database";

type EstimatesInsert =
  Database["public"]["Tables"]["analysis_estimates"]["Insert"];

/** Row shape of public.retrieve_candidate_pairs (contract §5.1). */
export interface CandidatePairRow {
  source_chunk_id: string;
  source_version_id: string;
  source_document_id: string;
  source_text: string;
  comparison_chunk_id: string;
  comparison_version_id: string;
  comparison_document_id: string;
  comparison_text: string;
  similarity: number;
}

export interface EstimateInsertInput {
  workspaceId: string;
  initiatorId: string;
  sourceVersionIds: string[];
  comparisonVersionIds: string[];
  requestFingerprint: string;
  retrievalConfig: Json;
  chunkCount: number;
  candidatePairCount: number;
  fixedCost: number;
  pricingVersion: string;
  expiresAt: string;
}

/** Controlled query failure; the action maps it to INTERNAL_ERROR. */
export class AnalysisQueryError extends Error {
  constructor(message = "The estimate query failed.") {
    super(message);
    this.name = "AnalysisQueryError";
  }
}

/**
 * Versions that exist, are ready/active, and belong to the actor's
 * workspace. Session RLS scopes every row; the caller diffs the set.
 */
export async function getEligibleVersions(
  versionIds: string[],
): Promise<Set<string>> {
  if (versionIds.length === 0) return new Set();
  const client = await createReadOnlyClient();
  const { data, error } = await client
    .from("document_versions")
    .select("id")
    .in("id", versionIds)
    .eq("processing_status", "ready")
    .eq("version_status", "active");
  if (error) throw new AnalysisQueryError();
  return new Set((data ?? []).map((row) => row.id));
}

/**
 * Bounded semantic retrieval through the session-scoped invoker RPC
 * (contract §5). Frozen retrieval params mirror AnalysisConfiguration.
 */
export async function callRetrieveCandidatePairs(
  workspaceId: string,
  sourceIds: string[],
  comparisonIds: string[],
): Promise<CandidatePairRow[]> {
  const client = await createReadOnlyClient();
  const { data, error } = await client.rpc("retrieve_candidate_pairs", {
    p_workspace_id: workspaceId,
    p_source_version_ids: sourceIds,
    p_comparison_version_ids: comparisonIds,
    p_top_k: 5,
    p_threshold: 0.75,
  });
  if (error) throw new AnalysisQueryError();
  return data ?? [];
}

/**
 * Persists the estimate under the insert policy
 * (initiator_id = auth.uid(), Admin/QA). Returns the row UUID (= estimateRef).
 */
export async function insertEstimate(
  input: EstimateInsertInput,
): Promise<{ id: string }> {
  const client = await createReadOnlyClient();
  const row: EstimatesInsert = {
    workspace_id: input.workspaceId,
    initiator_id: input.initiatorId,
    source_version_ids: input.sourceVersionIds,
    comparison_version_ids: input.comparisonVersionIds,
    request_fingerprint: input.requestFingerprint,
    retrieval_config: input.retrievalConfig,
    chunk_count: input.chunkCount,
    candidate_pair_count: input.candidatePairCount,
    fixed_cost: input.fixedCost,
    pricing_version: input.pricingVersion,
    expires_at: input.expiresAt,
  };
  const { data, error } = await client
    .from("analysis_estimates")
    .insert(row)
    .select("id")
    .single();
  if (error || !data) throw new AnalysisQueryError();
  return { id: data.id };
}
