import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/types/database";
import {
  createAnalysisFixture,
  createAnalysisFixtureWithFailureAfterPersistForTest,
} from "../support/analysis-fixtures";
import { assertLocalSupabaseReady } from "../support/local-supabase";
import { openLocalSqlSession } from "../support/local-sql-session";

const LOCAL_API_URL = "http://127.0.0.1:54321";

async function expectDenied(request: PromiseLike<{
  data: unknown;
  error: { code: string } | null;
}>) {
  const { data, error } = await request;
  expect(data).toBeNull();
  expect(error?.code).toBe("42501");
}

function anonymousClient(): SupabaseClient<Database> {
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (process.env.KDM_LOCAL_SUPABASE_URL !== LOCAL_API_URL || !key) {
    throw new Error("The expected loopback Supabase client is unavailable.");
  }
  return createClient<Database>(LOCAL_API_URL, key, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
}

beforeAll(assertLocalSupabaseReady);

describe("analysis authorization through local Supabase Data API", () => {
  it("isolates tenants and roles while exposing only curated analysis fields", async () => {
    const tenantA = await createAnalysisFixture({ withLedger: true });
    let tenantB: Awaited<ReturnType<typeof createAnalysisFixture>> | undefined;

    try {
      tenantB = await createAnalysisFixture({ withLedger: true });

      const run = await tenantA.admin.from("analysis_runs").select("*").eq("id", tenantA.analysisId);
      expect(run.error).toBeNull();
      expect(run.data).toHaveLength(1);
      expect(run.data?.[0]).toMatchObject({
        id: tenantA.analysisId,
        workspace_id: tenantA.workspaceId,
        initiator_full_name: expect.any(String),
        public_error_code: null,
      });
      for (const internalColumn of [
        "lease_expires_at",
        "operation_id",
        "idempotency_key",
        "request_fingerprint",
        "retrieval_config",
        "provider_config",
        "attempt_count",
        "error_code",
      ]) {
        expect(run.data?.[0]).not.toHaveProperty(internalColumn);
      }

      const scope = await tenantA.admin.from("analysis_scope").select("*")
        .eq("analysis_id", tenantA.analysisId);
      expect(scope.error).toBeNull();
      expect(scope.data).toHaveLength(1);
      expect(scope.data?.[0]).toMatchObject({
        document_id: tenantA.versions[0].documentId,
        document_name: expect.any(String),
        owner_id: tenantA.memberId,
        owner_full_name: expect.any(String),
        version_id: tenantA.versions[0].versionId,
        version_number: 1,
        role: "source",
      });

      const findings = await tenantA.admin.from("analysis_findings").select("*")
        .eq("id", tenantA.findingId);
      expect(findings.error).toBeNull();
      expect(findings.data).toHaveLength(1);
      expect(findings.data?.[0]).not.toHaveProperty("confidence");
      expect(findings.data?.[0]).not.toHaveProperty("assignee_id");

      const evidence = await tenantA.admin.from("analysis_finding_evidence").select("*")
        .eq("id", tenantA.evidenceId);
      expect(evidence.error).toBeNull();
      expect(evidence.data).toHaveLength(1);
      expect(evidence.data?.[0]).toMatchObject({
        analysis_id: tenantA.analysisId,
        finding_id: tenantA.findingId,
        chunk_id: tenantA.versions[0].chunkId,
        snapshot: expect.any(String),
      });
      expect(evidence.data?.[0]).not.toHaveProperty("text_content");

      await expectDenied(tenantA.admin.from("analyses").select("*"));
      await expectDenied(tenantA.admin.from("analyses").select("lease_expires_at"));
      await expectDenied(tenantA.admin.from("analyses").select("error_code"));
      await expectDenied(tenantA.admin.from("findings").select("*"));
      await expectDenied(tenantA.admin.from("findings").select("confidence"));
      await expectDenied(tenantA.admin.from("notification_events").select("*"));
      await expectDenied(tenantA.admin.from("analyses").update({ status: "failed" })
        .eq("id", tenantA.analysisId));
      await expectDenied(tenantA.admin.from("analyses").delete().eq("id", tenantA.analysisId));
      await expectDenied(tenantA.admin.from("analysis_documents").insert({
        analysis_id: tenantA.analysisId,
        workspace_id: tenantA.workspaceId,
        document_id: tenantA.versions[0].documentId,
        version_id: tenantA.versions[0].versionId,
        role: "source",
      }));
      await expectDenied(tenantA.admin.from("profiles").update({ role: "Admin" })
        .eq("id", tenantA.memberId));

      const qaRun = await tenantA.qa.from("analysis_runs").select("id")
        .eq("id", tenantA.analysisId);
      const qaFindings = await tenantA.qa.from("analysis_findings").select("id")
        .eq("analysis_id", tenantA.analysisId);
      expect(qaRun.error).toBeNull();
      expect(qaRun.data).toHaveLength(1);
      expect(qaFindings.error).toBeNull();
      expect(qaFindings.data).toHaveLength(1);

      const memberRuns = await tenantA.member.from("analysis_runs").select("id");
      const memberScope = await tenantA.member.from("analysis_scope").select("analysis_id");
      const memberFindings = await tenantA.member.from("findings").select("id");
      const memberEvidence = await tenantA.member.from("finding_evidence").select("id");
      const memberLedger = await tenantA.member.from("credit_ledger").select("id");
      expect(memberRuns).toMatchObject({ data: [], error: null });
      expect(memberScope).toMatchObject({ data: [], error: null });
      expect(memberFindings).toMatchObject({ data: [], error: null });
      expect(memberEvidence).toMatchObject({ data: [], error: null });
      expect(memberLedger).toMatchObject({ data: [], error: null });

      const adminLedger = await tenantA.admin.from("credit_ledger").select("*");
      expect(adminLedger.error).toBeNull();
      expect(adminLedger.data).toHaveLength(2);

      const crossTenantRows = await tenantA.admin.from("analyses").select("id")
        .eq("id", tenantB.analysisId);
      const crossTenantView = await tenantA.admin.from("analysis_runs").select("id")
        .eq("id", tenantB.analysisId);
      expect(crossTenantRows).toMatchObject({ data: [], error: null });
      expect(crossTenantView).toMatchObject({ data: [], error: null });
      const tenantBRun = await tenantB.admin.from("analysis_runs").select("id")
        .eq("id", tenantB.analysisId);
      expect(tenantBRun.error).toBeNull();
      expect(tenantBRun.data).toHaveLength(1);

      await expectDenied(anonymousClient().from("analysis_runs").select("*"));
      await expectDenied(anonymousClient().from("analyses").select("status"));

      await tenantA.sql.query(
        `update public.profiles set role = 'Member' where id = '${tenantA.qaId}'::uuid;`,
      );
      const downgradedRun = await tenantA.qa.from("analysis_runs").select("id")
        .eq("id", tenantA.analysisId);
      const downgradedFindings = await tenantA.qa.from("analysis_findings").select("id")
        .eq("analysis_id", tenantA.analysisId);
      expect(downgradedRun).toMatchObject({ data: [], error: null });
      expect(downgradedFindings).toMatchObject({ data: [], error: null });
      await tenantA.sql.query(
        `update public.profiles set role = 'QA Lead' where id = '${tenantA.qaId}'::uuid;`,
      );

      await tenantA.dispose();
      await expect(tenantA.dispose()).resolves.toBeUndefined();
      const tenantBStillExists = await tenantB.admin.from("analysis_runs").select("id")
        .eq("id", tenantB.analysisId);
      expect(tenantBStillExists.error).toBeNull();
      expect(tenantBStillExists.data).toHaveLength(1);
    } finally {
      await tenantA.dispose();
      if (tenantB) await tenantB.dispose();
    }
  });

  it("keeps provisional findings and evidence hidden until completion", async () => {
    const fixture = await createAnalysisFixture({ status: "processing", withLedger: true });
    try {
      const run = await fixture.admin.from("analysis_runs").select("status")
        .eq("id", fixture.analysisId).single();
      expect(run.error).toBeNull();
      expect(run.data?.status).toBe("processing");

      const baseFindings = await fixture.admin.from("findings").select("id")
        .eq("analysis_id", fixture.analysisId);
      const baseEvidence = await fixture.admin.from("finding_evidence").select("id")
        .eq("analysis_id", fixture.analysisId);
      const findings = await fixture.admin.from("analysis_findings").select("id")
        .eq("analysis_id", fixture.analysisId);
      const evidence = await fixture.admin.from("analysis_finding_evidence").select("id")
        .eq("analysis_id", fixture.analysisId);
      expect(baseFindings).toMatchObject({ data: [], error: null });
      expect(baseEvidence).toMatchObject({ data: [], error: null });
      expect(findings).toMatchObject({ data: [], error: null });
      expect(evidence).toMatchObject({ data: [], error: null });
    } finally {
      await fixture.dispose();
    }
  });

  it("cleans up a fixture when construction fails after persistence", async () => {
    let checkpoint: {
      workspaceId: string;
      analysisId: string;
      adminId: string;
      workspaceName: string;
    } | undefined;

    await expect(createAnalysisFixtureWithFailureAfterPersistForTest((value) => {
      checkpoint = value;
    })).rejects.toThrow("Synthetic analysis fixture failure after persistence.");

    expect(checkpoint).toBeDefined();
    const captured = checkpoint!;
    const sql = await openLocalSqlSession("kdm_analysis_cleanup_verify");
    try {
      const counts = await sql.query(`
        select
          (select count(*) from public.workspaces where id = '${captured.workspaceId}'::uuid)::text || '|' ||
          (select count(*) from public.profiles where id = '${captured.adminId}'::uuid)::text || '|' ||
          (select count(*) from public.analyses where id = '${captured.analysisId}'::uuid)::text || '|' ||
          (select count(*) from public.analysis_documents where workspace_id = '${captured.workspaceId}'::uuid)::text || '|' ||
          (select count(*) from public.findings where workspace_id = '${captured.workspaceId}'::uuid)::text || '|' ||
          (select count(*) from public.finding_evidence where workspace_id = '${captured.workspaceId}'::uuid)::text || '|' ||
          (select count(*) from public.credit_ledger where workspace_id = '${captured.workspaceId}'::uuid)::text;
      `);
      expect(counts.split("|")).toEqual(["0", "0", "0", "0", "0", "0", "0"]);
    } finally {
      await sql.close();
    }
  });
});
