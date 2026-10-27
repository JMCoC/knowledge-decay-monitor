import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import type { Database, Json } from "../../src/types/database";
import type { AnalysisExecutionManifest } from "../../src/types/analysis-internal";
import { createAnalysisFixture } from "../support/analysis-fixtures";
import { assertLocalSupabaseReady } from "../support/local-supabase";

const LOCAL_API_URL = "http://127.0.0.1:54321";
const MANIFEST: AnalysisExecutionManifest = {
  fingerprintVersion: "s2-05-v2",
  pricingVersion: "s2-04-v1",
  promptVersion: "materialized-candidates-test-v1",
  outputSchemaVersion: "materialized-candidates-test-v1",
  providers: {
    primary: { provider: "provider-a", model: "model-a" },
    fallback: { provider: "provider-b", model: "model-b" },
  },
};
const MANIFEST_JSON = MANIFEST as unknown as Json;

function serviceClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key || process.env.KDM_LOCAL_SUPABASE_URL !== LOCAL_API_URL) {
    throw new Error("Local Supabase service test configuration is missing.");
  }
  return createClient<Database>(LOCAL_API_URL, key, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
}

async function createClaimedRun(
  fixture: Awaited<ReturnType<typeof createAnalysisFixture>>,
  service: ReturnType<typeof serviceClient>,
  key: string,
) {
  const source = fixture.versions[0];
  const comparison = fixture.versions[1];
  if (!source) throw new Error("Materialized candidate fixture source version is missing.");

  const estimate = await service.rpc("create_analysis_estimate", {
    p_actor_id: fixture.adminId,
    p_source_version_ids: [source.versionId],
    p_comparison_version_ids: comparison ? [comparison.versionId] : [],
    p_manifest: MANIFEST_JSON,
  });
  expect(estimate.error?.code).toBeUndefined();
  const estimateRef = estimate.data?.[0]?.estimate_ref;
  if (!estimateRef) throw new Error("The trusted local estimate did not return a row.");

  const created = await service.rpc("run_analysis", {
    p_actor_id: fixture.adminId,
    p_estimate_ref: estimateRef,
    p_idempotency_key: key,
    p_current_manifest: MANIFEST_JSON,
  });
  expect(created.error?.code).toBeUndefined();
  const analysisId = created.data?.[0]?.analysis_id;
  if (!analysisId) throw new Error("The trusted Run did not return an analysis ID.");

  const claim = await service.rpc("claim_analysis", { p_analysis_id: analysisId });
  expect(claim.error?.code).toBeUndefined();
  const operationId = claim.data?.[0]?.operation_id;
  if (!operationId) throw new Error("The worker did not claim the Run.");
  return { analysisId, operationId, source, comparison };
}

function snapshotCountsQuery(analysisId: string) {
  return `
    select
      (select count(*)::text from private.analysis_candidate_pair_snapshots
       where analysis_id = '${analysisId}'::uuid) || '|' ||
      (select count(*)::text from private.analysis_candidate_pair_rows
       where analysis_id = '${analysisId}'::uuid);
  `;
}

function firstSqlRow(raw: string) {
  const row = raw.split(/\r?\n/).find(Boolean);
  if (!row) throw new Error("The local SQL query returned no row.");
  return row;
}

beforeAll(assertLocalSupabaseReady);

describe("materialized analysis candidate snapshots through local Supabase", () => {
  it("stores candidate IDs once and pages from the stored snapshot", async () => {
    const fixture = await createAnalysisFixture({ versionCount: 2 });
    const service = serviceClient();
    try {
      const { analysisId, operationId, source, comparison } = await createClaimedRun(
        fixture,
        service,
        "materialized-candidates-page-key",
      );
      if (!comparison) throw new Error("Materialized candidate comparison fixture version is missing.");
      const retrieved = await fixture.admin.rpc("retrieve_candidate_pairs", {
        p_workspace_id: fixture.workspaceId,
        p_source_version_ids: [source.versionId],
        p_comparison_version_ids: [comparison.versionId],
        p_top_k: 5,
        p_threshold: 0.75,
      });
      expect(retrieved.error).toBeNull();

      const firstSummary = await service.rpc("read_analysis_retrieval_summary", {
        p_analysis_id: analysisId,
        p_operation_id: operationId,
      });
      expect(firstSummary.error?.code).toBeUndefined();
      expect(firstSummary.data?.[0]?.candidate_pair_count).toBe(retrieved.data?.length ?? 0);
      expect(firstSqlRow(await fixture.sql.query(snapshotCountsQuery(analysisId))))
        .toBe(`1|${retrieved.data?.length ?? 0}`);

      const expectedPairIds = (retrieved.data ?? []).map((pair) => {
        const ids = [pair.source_chunk_id, pair.comparison_chunk_id].sort();
        return `${ids[0]}|${ids[1]}`;
      }).sort();
      const storedPairIds = (await fixture.sql.query(`
        select pair_low_id::text || '|' || pair_high_id::text
        from private.analysis_candidate_pair_rows
        where analysis_id = '${analysisId}'::uuid
        order by pair_low_id, pair_high_id;
      `)).split(/\r?\n/).filter(Boolean);
      expect(storedPairIds).toEqual(expectedPairIds);

      const secondSummary = await service.rpc("read_analysis_retrieval_summary", {
        p_analysis_id: analysisId,
        p_operation_id: operationId,
      });
      expect(secondSummary.error?.code).toBeUndefined();
      expect(secondSummary.data?.[0]).toEqual(firstSummary.data?.[0]);

      const page = await service.rpc("read_analysis_pair_batch", {
        p_analysis_id: analysisId,
        p_operation_id: operationId,
        p_after_low: null as unknown as string,
        p_after_high: null as unknown as string,
        p_limit: 10,
      });
      expect(page.error?.code).toBeUndefined();
      expect(page.data?.map((pair) => {
        const ids = [pair.source_chunk_id, pair.comparison_chunk_id].sort();
        return `${ids[0]}|${ids[1]}`;
      }).sort()).toEqual(expectedPairIds);

      const completed = await service.rpc("finalize_analysis_success", {
        p_analysis_id: analysisId,
        p_operation_id: operationId,
        p_reported_findings_count: 0,
      });
      expect(completed.error?.code).toBeUndefined();
      expect(firstSqlRow(await fixture.sql.query(snapshotCountsQuery(analysisId)))).toBe("0|0");
    } finally {
      await fixture.dispose();
    }
  }, 60_000);

  it("materializes an empty comparison scope as a complete zero-pair snapshot", async () => {
    const fixture = await createAnalysisFixture({ versionCount: 1 });
    const service = serviceClient();
    try {
      const { analysisId, operationId } = await createClaimedRun(
        fixture,
        service,
        "materialized-candidates-empty-key",
      );
      const summary = await service.rpc("read_analysis_retrieval_summary", {
        p_analysis_id: analysisId,
        p_operation_id: operationId,
      });
      expect(summary.error?.code).toBeUndefined();
      expect(summary.data?.[0]?.candidate_pair_count).toBe(0);
      expect(firstSqlRow(await fixture.sql.query(snapshotCountsQuery(analysisId)))).toBe("1|0");

      const page = await service.rpc("read_analysis_pair_batch", {
        p_analysis_id: analysisId,
        p_operation_id: operationId,
        p_after_low: null as unknown as string,
        p_after_high: null as unknown as string,
        p_limit: 10,
      });
      expect(page.error?.code).toBeUndefined();
      expect(page.data).toEqual([]);

      const completed = await service.rpc("finalize_analysis_success", {
        p_analysis_id: analysisId,
        p_operation_id: operationId,
        p_reported_findings_count: 0,
      });
      expect(completed.error?.code).toBeUndefined();
      expect(firstSqlRow(await fixture.sql.query(snapshotCountsQuery(analysisId)))).toBe("0|0");
    } finally {
      await fixture.dispose();
    }
  }, 60_000);

  it("retains the snapshot across a retryable failure and deletes it on terminal failure", async () => {
    const fixture = await createAnalysisFixture({ versionCount: 2 });
    const service = serviceClient();
    try {
      const { analysisId, operationId } = await createClaimedRun(
        fixture,
        service,
        "materialized-candidates-retry-key",
      );
      const summary = await service.rpc("read_analysis_retrieval_summary", {
        p_analysis_id: analysisId,
        p_operation_id: operationId,
      });
      expect(summary.error?.code).toBeUndefined();
      expect(firstSqlRow(await fixture.sql.query(snapshotCountsQuery(analysisId)))).toBe("1|1");

      const queued = await service.rpc("fail_analysis", {
        p_analysis_id: analysisId,
        p_operation_id: operationId,
        p_retryable: true,
        p_error_code: "INTERNAL_ERROR",
      });
      expect(queued.error?.code).toBeUndefined();
      expect(queued.data).toBe("queued");
      expect(firstSqlRow(await fixture.sql.query(snapshotCountsQuery(analysisId)))).toBe("1|1");

      await fixture.sql.query(`
        update public.analyses
        set next_attempt_at = clock_timestamp() - interval '1 second'
        where id = '${analysisId}'::uuid;
      `);
      const reclaimed = await service.rpc("claim_analysis", { p_analysis_id: analysisId });
      expect(reclaimed.error?.code).toBeUndefined();
      const nextOperationId = reclaimed.data?.[0]?.operation_id;
      if (!nextOperationId) throw new Error("The queued analysis did not receive a new operation token.");

      const resumedSummary = await service.rpc("read_analysis_retrieval_summary", {
        p_analysis_id: analysisId,
        p_operation_id: nextOperationId,
      });
      expect(resumedSummary.error?.code).toBeUndefined();
      expect(resumedSummary.data?.[0]).toEqual(summary.data?.[0]);

      const failed = await service.rpc("fail_analysis", {
        p_analysis_id: analysisId,
        p_operation_id: nextOperationId,
        p_retryable: false,
        p_error_code: "INTERNAL_ERROR",
      });
      expect(failed.error?.code).toBeUndefined();
      expect(failed.data).toBe("failed");
      expect(firstSqlRow(await fixture.sql.query(snapshotCountsQuery(analysisId)))).toBe("0|0");
    } finally {
      await fixture.dispose();
    }
  }, 60_000);
});
