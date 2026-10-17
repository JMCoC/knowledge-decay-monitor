import { beforeAll, describe, expect, it } from "vitest";
import type { AnalysisExecutionManifest } from "../../src/types/analysis-internal";
import { selectionSchema } from "../../src/modules/analysis/schemas";
import { createAnalysisFixture } from "../support/analysis-fixtures";
import { LocalSqlError, openLocalSqlSession } from "../support/local-sql-session";
import { assertLocalSupabaseReady } from "../support/local-supabase";

beforeAll(assertLocalSupabaseReady);

const MANIFEST: AnalysisExecutionManifest = {
  fingerprintVersion: "s2-05-v2",
  pricingVersion: "s2-04-v1",
  promptVersion: "prompt-integration-v1",
  outputSchemaVersion: "schema-integration-v1",
  providers: {
    primary: { provider: "provider-a", model: "model-a" },
    fallback: { provider: "provider-b", model: "model-b" },
  },
};

function uuidArray(values: string[]): string {
  if (values.some((value) => !/^[0-9a-f-]{36}$/i.test(value))) {
    throw new Error("Invalid synthetic fixture UUID.");
  }
  return "array[" + values.map((value) => "'" + value + "'").join(",") + "]::uuid[]";
}

function sqlJson(value: unknown): string {
  return "'" + JSON.stringify(value).replaceAll("'", "''") + "'::jsonb";
}

function estimateSql(actorId: string, sourceIds: string[], comparisonIds: string[]): string {
  return [
    "select estimate_ref::text || '|' || fixed_cost::text || '|' || expires_at::text",
    "  || '|' || array_to_string(source_version_ids, ',')",
    "  || '|' || array_to_string(comparison_version_ids, ',')",
    "from public.create_analysis_estimate(",
    "  '" + actorId + "'::uuid, " + uuidArray(sourceIds) + ", " + uuidArray(comparisonIds) + ", " + sqlJson(MANIFEST),
    ");",
  ].join("\n");
}

function parseEstimate(value: string) {
  const row = value.split(/\r?\n/).find((line) => line.length > 0);
  if (!row) throw new Error("The local estimate RPC returned no row.");
  const [estimateRef, fixedCost, expiresAt, sourceIds, comparisonIds] = row.split("|");
  return {
    estimateRef,
    fixedCost: Number(fixedCost),
    expiresAt,
    sourceVersionIds: sourceIds ? sourceIds.split(",") : [],
    comparisonVersionIds: comparisonIds ? comparisonIds.split(",") : [],
  };
}

describe("analysis estimation through local Supabase", () => {
  it("creates a trusted estimate with SQL price, normalized scope, and SQL TTL", async () => {
    const fixture = await createAnalysisFixture({ versionCount: 2 });
    try {
      const source = fixture.versions[0];
      const comparison = fixture.versions[1];
      if (!source || !comparison) throw new Error("Fixture versions missing.");
      const sourceIds = [source.versionId];
      const comparisonIds = [comparison.versionId];
      const retrieved = await fixture.admin.rpc("retrieve_candidate_pairs", {
        p_workspace_id: fixture.workspaceId,
        p_source_version_ids: sourceIds,
        p_comparison_version_ids: comparisonIds,
        p_top_k: 5,
        p_threshold: 0.75,
      });
      expect(retrieved.error).toBeNull();
      expect(retrieved.data).toHaveLength(1);
      const estimate = parseEstimate(await fixture.sql.query(
        estimateSql(fixture.adminId, sourceIds, comparisonIds),
      ));

      expect(estimate).toMatchObject({ fixedCost: 2 });
      expect(estimate.sourceVersionIds).toEqual(sourceIds);
      expect(estimate.comparisonVersionIds).toEqual(comparisonIds);
      expect(estimate.estimateRef).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );

      const persisted = await fixture.sql.query(
        "select fixed_cost::text || '|' || chunk_count::text || '|' || candidate_pair_count::text || '|' || " +
        "extract(epoch from (expires_at - created_at))::integer::text " +
        "from public.analysis_estimates where id = '" + estimate.estimateRef + "'::uuid;",
      );
      expect(persisted.split(/\r?\n/).find(Boolean)).toBe("2|2|1|1800");

      const readableProjection = await fixture.admin
        .from("analysis_estimates")
        .select("id,fixed_cost,expires_at")
        .eq("id", estimate.estimateRef)
        .single();
      expect(readableProjection.error).toBeNull();
      expect(readableProjection.data?.fixed_cost).toBe(2);
      const privateColumns = await fixture.admin
        .from("analysis_estimates")
        .select("request_fingerprint")
        .eq("id", estimate.estimateRef);
      expect(privateColumns.error?.code).toBe("42501");

      const arbitraryInsert = await fixture.admin.from("analysis_estimates").insert({
        workspace_id: fixture.workspaceId,
        initiator_id: fixture.adminId,
        source_version_ids: sourceIds,
        comparison_version_ids: comparisonIds,
        request_fingerprint: "arbitrary-client-fingerprint",
        retrieval_config: { topK: 5, similarityThreshold: 0.75 },
        chunk_count: 0,
        candidate_pair_count: 0,
        fixed_cost: 1,
        pricing_version: "s2-04-v1",
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      });
      expect(arbitraryInsert.error?.code).toBe("42501");
      expect(JSON.stringify(estimate)).not.toContain("Synthetic analysis fixture chunk");
    } finally {
      await fixture.dispose();
    }
  }, 60_000);

  it("isolates estimate creation and retrieval across tenants", async () => {
    const tenantA = await createAnalysisFixture({ versionCount: 1 });
    const tenantB = await createAnalysisFixture({ versionCount: 1 });
    const foreignSession = await openLocalSqlSession("kdm_s205_estimate_foreign");
    try {
      const foreignEstimate = await foreignSession.query(estimateSql(
        tenantB.adminId, [tenantA.versions[0]!.versionId], [],
      )).then(() => null, (error: unknown) => error);
      expect(foreignEstimate).toBeInstanceOf(LocalSqlError);
      expect((foreignEstimate as LocalSqlError).sqlState).toBe("22023");

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
      await foreignSession.close();
      await tenantA.dispose();
      await tenantB.dispose();
    }
  }, 60_000);

  it("prices all chunks for an empty comparison and leaves scope validation strict", async () => {
    const fixture = await createAnalysisFixture({ versionCount: 1 });
    try {
      const only = fixture.versions[0];
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

      const estimate = parseEstimate(await fixture.sql.query(estimateSql(
        fixture.adminId,
        [only.versionId],
        [],
      )));
      expect(estimate.fixedCost).toBe(2);
      expect(estimate.comparisonVersionIds).toEqual([]);
      expect(selectionSchema.safeParse({
        sourceVersionIds: [only.versionId, only.versionId], comparisonVersionIds: [],
      }).success).toBe(false);
    } finally {
      await fixture.dispose();
    }
  }, 60_000);
});
