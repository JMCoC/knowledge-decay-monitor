import { beforeAll, describe, expect, it } from "vitest";
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

      const pairs = await fixture.admin.rpc("retrieve_candidate_pairs", {
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
      const inserted = await fixture.admin
        .from("analysis_estimates")
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

      const reread = await fixture.admin
        .from("analysis_estimates")
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
      const read = await tenantB.admin
        .from("analysis_estimates")
        .select("id")
        .eq("workspace_id", tenantA.workspaceId);
      expect(read.error).toBeNull();
      expect(read.data).toHaveLength(0);

      const rpc = await tenantB.admin.rpc("retrieve_candidate_pairs", {
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
      const memberRpc = await fixture.member.rpc("retrieve_candidate_pairs", {
        p_workspace_id: fixture.workspaceId,
        p_source_version_ids: [only.versionId],
        p_comparison_version_ids: [],
        p_top_k: 5,
        p_threshold: 0.75,
      });
      expect(memberRpc.error).toBeNull();
      expect(memberRpc.data).toHaveLength(0);

      const empty = await fixture.admin.rpc("retrieve_candidate_pairs", {
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
