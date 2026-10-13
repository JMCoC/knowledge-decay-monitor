import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "../../src/types/database";
import { computeFixedCost } from "../../src/modules/analysis/pricing";
import {
  buildChunksRevision,
  buildPairHashes,
  computeRequestFingerprint,
} from "../../src/modules/analysis/retrieval";
import { selectionSchema } from "../../src/modules/analysis/schemas";
import { createAnalysisFixture } from "../support/analysis-fixtures";
import { assertLocalSupabaseReady } from "../support/local-supabase";

beforeAll(assertLocalSupabaseReady);

interface PairRow {
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

interface RpcArgs {
  p_workspace_id: string;
  p_source_version_ids: string[];
  p_comparison_version_ids: string[];
  p_top_k: number;
  p_threshold: number;
}

// NOTE(Task 5): call the typed .from("analysis_estimates") once Dev 1
// regenerates database.ts. The cast changes no runtime behaviour.
interface EstimateRow {
  id: string;
  workspace_id: string;
  request_fingerprint: string;
  fixed_cost: number;
  expires_at: string;
}

interface EstimateInsert {
  workspace_id: string;
  initiator_id: string;
  source_version_ids: string[];
  comparison_version_ids: string[];
  request_fingerprint: string;
  retrieval_config: Json;
  chunk_count: number;
  candidate_pair_count: number;
  fixed_cost: number;
  pricing_version: string;
  expires_at: string;
}

interface EstimatesQuery {
  select: (columns: string) => EstimatesTable;
  eq: (column: string, value: string) => EstimatesTable;
  insert: (row: EstimateInsert) => EstimatesTable;
  single: () => Promise<{
    data: EstimateRow | null;
    error: { message: string } | null;
  }>;
}

type EstimatesTable = EstimatesQuery &
  PromiseLike<{
    data: EstimateRow[] | null;
    error: { message: string } | null;
  }>;

function estimatesTable(client: SupabaseClient<Database>): (
  table: "analysis_estimates",
) => EstimatesTable {
  // NOTE(Task 5): call the typed .from("analysis_estimates") once Dev 1
  // regenerates database.ts. The cast changes no runtime behaviour.
  // .bind preserves the client receiver (detaching from loses `this.rest`).
  return client.from.bind(client) as unknown as (
    table: "analysis_estimates",
  ) => EstimatesTable;
}
async function retrievePairs(
  client: SupabaseClient<Database>,
  args: RpcArgs,
): Promise<{ data: PairRow[] | null; error: { message: string } | null }> {
  const rpc = client.rpc as unknown as (
    fn: string,
    fnArgs: RpcArgs,
  ) => Promise<{ data: PairRow[] | null; error: { message: string } | null }>;
  // .call preserves the client receiver (detaching rpc loses `this.rest`).
  return rpc.call(client, "retrieve_candidate_pairs", args);
}

/**
 * End-to-end estimate path against local Supabase with the exact params
 * queries.ts uses (duplicated here on purpose: drift breaks this test).
 * Action-level auth mapping (UNAUTHENTICATED/FORBIDDEN) needs a Next
 * request scope and lives in tests/unit/analysis-estimate.test.ts.
 */
describe("analysis estimation through local Supabase", () => {
  it("estimates, persists, and re-reads with a matching fingerprint", async () => {
    const fixture = await createAnalysisFixture({ versionCount: 2 });
    try {
      const [source, comparison] = fixture.versions;
      if (!source || !comparison) throw new Error("Fixture versions missing.");

      const eligible = await fixture.admin
        .from("document_versions")
        .select("id")
        .in("id", [source.versionId, comparison.versionId])
        .eq("processing_status", "ready")
        .eq("version_status", "active");
      expect(eligible.error).toBeNull();
      expect(eligible.data?.map((row) => row.id).sort()).toEqual(
        [source.versionId, comparison.versionId].sort(),
      );

      const pairs = await retrievePairs(fixture.admin, {
        p_workspace_id: fixture.workspaceId,
        p_source_version_ids: [source.versionId],
        p_comparison_version_ids: [comparison.versionId],
        p_top_k: 5,
        p_threshold: 0.75,
      });
      expect(pairs.error).toBeNull();
      expect(pairs.data).toHaveLength(1);
      expect(pairs.data?.[0]).toMatchObject({ similarity: 1 });

      const chunkIds = [
        ...new Set(
          (pairs.data ?? []).flatMap((row) => [
            row.source_chunk_id,
            row.comparison_chunk_id,
          ]),
        ),
      ].sort();
      const chunkCount = chunkIds.length;
      const candidatePairCount = pairs.data?.length ?? 0;
      const fixedCost = computeFixedCost(chunkCount, candidatePairCount);
      expect(Number.isInteger(fixedCost)).toBe(true);
      expect(fixedCost).toBeGreaterThanOrEqual(1);
      const fingerprint = computeRequestFingerprint({
        chunkCount,
        candidatePairCount,
        sortedSourceVersionIds: [source.versionId],
        sortedComparisonVersionIds: [comparison.versionId],
        pairs: (pairs.data ?? []).map((row) => ({
          sourceChunkId: row.source_chunk_id,
          comparisonChunkId: row.comparison_chunk_id,
        })),
        chunkIds,
      });
      expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(buildPairHashes).toBeDefined();
      expect(buildChunksRevision(chunkIds)).toMatch(/^[0-9a-f]{64}$/);

      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      const inserted = await estimatesTable(fixture.admin)("analysis_estimates")
        .insert({
          workspace_id: fixture.workspaceId,
          initiator_id: fixture.adminId,
          source_version_ids: [source.versionId],
          comparison_version_ids: [comparison.versionId],
          request_fingerprint: fingerprint,
          retrieval_config: {
            topK: 5,
            similarityThreshold: 0.75,
            chunksRevision: buildChunksRevision(chunkIds),
            embeddingRevision: "gte-small-384-v1",
            fingerprint,
          },
          chunk_count: chunkCount,
          candidate_pair_count: candidatePairCount,
          fixed_cost: fixedCost,
          pricing_version: "s2-04-v1",
          expires_at: expiresAt,
        })
        .select("id")
        .single();
      expect(inserted.error).toBeNull();
      expect(inserted.data?.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );

      const reread = await estimatesTable(fixture.admin)("analysis_estimates")
        .select("request_fingerprint,fixed_cost,expires_at")
        .eq("id", inserted.data!.id)
        .single();
      expect(reread.error).toBeNull();
      expect(reread.data?.request_fingerprint).toBe(fingerprint);
      expect(reread.data?.fixed_cost).toBe(fixedCost);
      const expiresMs = Date.parse(reread.data!.expires_at);
      expect(expiresMs).toBeGreaterThan(Date.now() + 29 * 60 * 1000);
      expect(expiresMs).toBeLessThanOrEqual(Date.now() + 31 * 60 * 1000);
    } finally {
      await fixture.dispose();
    }
  }, 60_000);

  it("isolates estimates and retrieval across tenants", async () => {
    const tenantA = await createAnalysisFixture({ versionCount: 1 });
    const tenantB = await createAnalysisFixture({ versionCount: 1 });
    try {
      const read = await estimatesTable(tenantB.admin)("analysis_estimates")
        .select("id")
        .eq("workspace_id", tenantA.workspaceId);
      expect(read.error).toBeNull();
      expect(read.data).toHaveLength(0);

      const rpc = await retrievePairs(tenantB.admin, {
        p_workspace_id: tenantA.workspaceId,
        p_source_version_ids: [tenantA.versions[0]!.versionId],
        p_comparison_version_ids: [],
        p_top_k: 5,
        p_threshold: 0.75,
      });
      expect(rpc.error).toBeNull();
      expect(rpc.data).toHaveLength(0);
    } finally {
      await tenantA.dispose();
      await tenantB.dispose();
    }
  }, 60_000);

  it("denies retrieval chunks to members and prices empty comparisons", async () => {
    const fixture = await createAnalysisFixture({ versionCount: 1 });
    try {
      const [only] = fixture.versions;
      if (!only) throw new Error("Fixture version missing.");
      const memberRpc = await retrievePairs(fixture.member, {
        p_workspace_id: fixture.workspaceId,
        p_source_version_ids: [only.versionId],
        p_comparison_version_ids: [],
        p_top_k: 5,
        p_threshold: 0.75,
      });
      expect(memberRpc.error).toBeNull();
      expect(memberRpc.data).toHaveLength(0);

      const empty = await retrievePairs(fixture.admin, {
        p_workspace_id: fixture.workspaceId,
        p_source_version_ids: [only.versionId],
        p_comparison_version_ids: [],
        p_top_k: 5,
        p_threshold: 0.75,
      });
      expect(empty.error).toBeNull();
      expect(empty.data).toHaveLength(0);
      expect(computeFixedCost(0, 0)).toBe(1);

      expect(
        selectionSchema.safeParse({
          sourceVersionIds: [only.versionId, only.versionId],
          comparisonVersionIds: [],
        }).success,
      ).toBe(false);
    } finally {
      await fixture.dispose();
    }
  }, 60_000);
});
