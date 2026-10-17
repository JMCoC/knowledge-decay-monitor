import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import type { AnalysisExecutionManifest } from "../../src/types/analysis-internal";
import type { Database, Json } from "../../src/types/database";
import { createAnalysisFixture } from "../support/analysis-fixtures";
import { assertLocalSupabaseReady } from "../support/local-supabase";

const LOCAL_API_URL = "http://127.0.0.1:54321";
const MANIFEST: AnalysisExecutionManifest = {
  fingerprintVersion: "s2-05-v2",
  pricingVersion: "s2-04-v1",
  promptVersion: "prompt-run-integration-v1",
  outputSchemaVersion: "schema-run-integration-v1",
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

async function estimate(
  service: ReturnType<typeof serviceClient>,
  actorId: string,
  sourceVersionIds: string[],
  comparisonVersionIds: string[],
) {
  const { data, error } = await service.rpc("create_analysis_estimate", {
    p_actor_id: actorId,
    p_source_version_ids: sourceVersionIds,
    p_comparison_version_ids: comparisonVersionIds,
    p_manifest: MANIFEST_JSON,
  });
  expect(error?.code).toBeUndefined();
  const result = data?.[0];
  if (!result) throw new Error("The trusted local estimate did not return a row.");
  return result.estimate_ref;
}

beforeAll(assertLocalSupabaseReady);

describe("atomic analysis Run and Retry through local Supabase", () => {
  it("creates once and replays after expiry, scope changes, and missing current config", async () => {
    const fixture = await createAnalysisFixture({ versionCount: 2 });
    const foreignFixture = await createAnalysisFixture({ versionCount: 1 });
    const service = serviceClient();
    try {
      const firstVersion = fixture.versions[0];
      const secondVersion = fixture.versions[1];
      const foreignVersion = foreignFixture.versions[0];
      if (!firstVersion || !secondVersion || !foreignVersion) throw new Error("Run fixture versions are missing.");

      const trustedEstimate = await estimate(
        service, fixture.adminId, [firstVersion.versionId], [secondVersion.versionId],
      );
      const alternateEstimate = await estimate(
        service, fixture.adminId, [secondVersion.versionId], [],
      );
      const foreignEstimate = await estimate(
        service, foreignFixture.adminId, [foreignVersion.versionId], [],
      );
      const foreignScope = await service.rpc("run_analysis", {
        p_actor_id: fixture.adminId,
        p_estimate_ref: foreignEstimate,
        p_idempotency_key: "foreign-estimate-key",
        p_current_manifest: MANIFEST_JSON,
      });
      expect(foreignScope.error?.code).toBe("P0002");

      const memberCall = await service.rpc("run_analysis", {
        p_actor_id: fixture.memberId,
        p_estimate_ref: trustedEstimate,
        p_idempotency_key: "member-run-key",
        p_current_manifest: MANIFEST_JSON,
      });
      expect(memberCall.error?.code).toBe("42501");

      const first = await service.rpc("run_analysis", {
        p_actor_id: fixture.adminId,
        p_estimate_ref: trustedEstimate,
        p_idempotency_key: "run-integration-key",
        p_current_manifest: MANIFEST_JSON,
      });
      expect(first.error?.code).toBeUndefined();
      const firstRun = first.data?.[0];
      if (!firstRun) throw new Error("The Run RPC did not return its created analysis.");
      expect(firstRun.status).toBe("queued");

      await fixture.sql.query(`
        update public.analysis_estimates
        set expires_at = clock_timestamp() - interval '1 second'
        where id = '${trustedEstimate}'::uuid;
      `);
      await fixture.sql.query(`
        begin;
        update public.document_versions set version_status = 'historical'
        where id = '${firstVersion.versionId}'::uuid;
        update public.documents set active_version_id = null
        where id = '${firstVersion.documentId}'::uuid;
        commit;
      `);

      const replay = await service.rpc("run_analysis", {
        p_actor_id: fixture.adminId,
        p_estimate_ref: trustedEstimate,
        p_idempotency_key: "run-integration-key",
        p_current_manifest: null,
      });
      expect(replay.error?.code).toBeUndefined();
      expect(replay.data?.[0]).toEqual(firstRun);

      const reusedKey = await service.rpc("run_analysis", {
        p_actor_id: fixture.adminId,
        p_estimate_ref: alternateEstimate,
        p_idempotency_key: "run-integration-key",
        p_current_manifest: MANIFEST_JSON,
      });
      expect(reusedKey.error?.code).toBe("P2002");

      const persisted = await fixture.sql.query(`
        select count(*)::text || '|' ||
          (select count(*)::text from public.credit_ledger
           where analysis_id = '${firstRun.analysis_id}'::uuid and event_type = 'Reserved')
        from public.analyses where estimate_id = '${trustedEstimate}'::uuid;
      `);
      expect(persisted.split(/\r?\n/).find(Boolean)).toBe("1|1");
    } finally {
      await fixture.dispose();
      await foreignFixture.dispose();
    }
  }, 60_000);

  it("retries only a failed run with a fully released reservation and replays it", async () => {
    const fixture = await createAnalysisFixture({ versionCount: 2 });
    const service = serviceClient();
    try {
      const retryVersion = fixture.versions[1];
      if (!retryVersion) throw new Error("Retry fixture version is missing.");
      const estimateRef = await estimate(service, fixture.qaId, [retryVersion.versionId], []);

      await fixture.sql.query(`
        begin;
        update public.analyses set status = 'queued', attempt_count = 0,
          started_at = null, finished_at = null, error_code = null
        where id = '${fixture.analysisId}'::uuid;
        select private.reserve_analysis_credits('${fixture.analysisId}'::uuid, 3);
        update public.analyses set status = 'failed', attempt_count = 1,
          started_at = clock_timestamp(), finished_at = clock_timestamp(),
          error_code = 'INTERNAL_ERROR'
        where id = '${fixture.analysisId}'::uuid;
        select private.settle_analysis_credits('${fixture.analysisId}'::uuid, 3, 'Released');
        commit;
      `);

      const first = await service.rpc("retry_analysis", {
        p_actor_id: fixture.qaId,
        p_failed_analysis_id: fixture.analysisId,
        p_estimate_ref: estimateRef,
        p_idempotency_key: "retry-integration-key",
        p_current_manifest: MANIFEST_JSON,
      });
      expect(first.error?.code).toBeUndefined();
      const retry = first.data?.[0];
      if (!retry) throw new Error("The Retry RPC did not return its created analysis.");
      expect(retry.status).toBe("queued");
      expect(retry.retry_of_analysis_id).toBe(fixture.analysisId);

      const replay = await service.rpc("retry_analysis", {
        p_actor_id: fixture.qaId,
        p_failed_analysis_id: fixture.analysisId,
        p_estimate_ref: estimateRef,
        p_idempotency_key: "retry-integration-key",
        p_current_manifest: null,
      });
      expect(replay.error?.code).toBeUndefined();
      expect(replay.data?.[0]).toEqual(retry);

      const unreservedFixture = await createAnalysisFixture({ versionCount: 1 });
      try {
        const version = unreservedFixture.versions[0];
        if (!version) throw new Error("Unreserved Retry fixture version is missing.");
        const unreservedEstimate = await estimate(service, unreservedFixture.adminId, [version.versionId], []);
        await unreservedFixture.sql.query(`
          update public.analyses set status = 'failed', attempt_count = 1,
            started_at = clock_timestamp(), finished_at = clock_timestamp(), error_code = 'INTERNAL_ERROR'
          where id = '${unreservedFixture.analysisId}'::uuid;
        `);
        const rejected = await service.rpc("retry_analysis", {
          p_actor_id: unreservedFixture.adminId,
          p_failed_analysis_id: unreservedFixture.analysisId,
          p_estimate_ref: unreservedEstimate,
          p_idempotency_key: "retry-without-release",
          p_current_manifest: MANIFEST_JSON,
        });
        expect(rejected.error?.code).toBe("P2002");
      } finally {
        await unreservedFixture.dispose();
      }
    } finally {
      await fixture.dispose();
    }
  }, 60_000);
});
