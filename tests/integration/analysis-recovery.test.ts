import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { AnalysisExecutionManifest } from "../../src/types/analysis-internal";
import type { Database, Json } from "../../src/types/database";
import { assertLocalSupabaseReady } from "../support/local-supabase";
import { createAnalysisFixture } from "../support/analysis-fixtures";
import {
  openLocalSqlSession,
  type LocalSqlSession,
} from "../support/local-sql-session";
import {
  killEdgeWorkerContainer,
  startAnalysisEdge,
  startEdgeConFake,
  type AnalysisEdgeHandle,
} from "../support/analysis-edge";

const LOCAL_API_URL = "http://127.0.0.1:54321";
const LOCAL_FUNCTION_URL =
  "http://api.supabase.internal:8000/functions/v1/analyze";
const WORKER_MANIFEST: AnalysisExecutionManifest = {
  fingerprintVersion: "s2-05-v2",
  pricingVersion: "s2-04-v1",
  promptVersion: "prompt-recovery-integration-v1",
  outputSchemaVersion: "schema-recovery-integration-v1",
  providers: {
    primary: { provider: "synthetic-test", model: "fake" },
    fallback: { provider: "synthetic-test", model: "fake" },
  },
};
const WORKER_MANIFEST_JSON = WORKER_MANIFEST as unknown as Json;

function serviceClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key || process.env.KDM_LOCAL_SUPABASE_URL !== LOCAL_API_URL) {
    throw new Error("Local Supabase service test configuration is missing.");
  }
  return createClient<Database>(LOCAL_API_URL, key, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}

function sqlLiteral(value: string) {
  if (value.includes("\0")) throw new Error("Invalid local recovery fixture value.");
  return "'" + value.replaceAll("'", "''") + "'";
}

function parseJsonRecord(value: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error();
    }
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] =>
        typeof entry[1] === "string",
      ),
    );
  } catch {
    throw new Error("Local recovery Vault fixture could not be inspected.");
  }
}

interface RecoveryJob {
  fixture: Awaited<ReturnType<typeof createAnalysisFixture>>;
  analysisId: string;
  pairCount: number;
}

async function createQueuedJob(
  service: ReturnType<typeof serviceClient>,
  options: { versionCount?: number; sourceCount?: number } = {},
): Promise<RecoveryJob> {
  const versionCount = options.versionCount ?? 2;
  const sourceCount = options.sourceCount ?? 1;
  if (sourceCount < 1 || sourceCount >= versionCount) {
    throw new Error("Local recovery fixture scope is invalid.");
  }
  const fixture = await createAnalysisFixture({
    versionCount,
    status: "failed",
  });
  try {
    await fixture.sql.query(
      `delete from public.finding_evidence where analysis_id = '${fixture.analysisId}';`,
    );
    await fixture.sql.query(
      `delete from public.findings where analysis_id = '${fixture.analysisId}';`,
    );
    const sourceVersionIds = fixture.versions
      .slice(0, sourceCount)
      .map((version) => version.versionId);
    const comparisonVersionIds = fixture.versions
      .slice(sourceCount)
      .map((version) => version.versionId);
    const pairs = await service.rpc("retrieve_candidate_pairs", {
      p_workspace_id: fixture.workspaceId,
      p_source_version_ids: sourceVersionIds,
      p_comparison_version_ids: comparisonVersionIds,
      p_top_k: 5,
      p_threshold: 0.75,
    });
    expect(pairs.error).toBeNull();
    const estimate = await service.rpc("create_analysis_estimate", {
      p_actor_id: fixture.adminId,
      p_source_version_ids: sourceVersionIds,
      p_comparison_version_ids: comparisonVersionIds,
      p_manifest: WORKER_MANIFEST_JSON,
    });
    expect(estimate.error).toBeNull();
    const estimateRef = estimate.data?.[0]?.estimate_ref;
    if (!estimateRef) throw new Error("Recovery fixture estimate was not persisted.");

    const run = await service.rpc("run_analysis", {
      p_actor_id: fixture.adminId,
      p_estimate_ref: estimateRef,
      p_idempotency_key: `recovery-integration-${randomUUID()}`,
      p_current_manifest: WORKER_MANIFEST_JSON,
    });
    expect(run.error).toBeNull();
    const analysisId = run.data?.[0]?.analysis_id;
    if (!analysisId) throw new Error("Recovery fixture Run did not create an analysis.");
    return { fixture, analysisId, pairCount: pairs.data?.length ?? 0 };
  } catch (error) {
    await fixture.dispose();
    throw error;
  }
}

async function readJob(service: ReturnType<typeof serviceClient>, analysisId: string) {
  const { data, error } = await service
    .from("analyses")
    .select("status,attempt_count,error_code,fixed_cost,continuation_pending,lease_expires_at,checkpoint")
    .eq("id", analysisId)
    .single();
  expect(error).toBeNull();
  if (!data) throw new Error("Local recovery analysis row is missing.");
  return data;
}

async function postAnalyze(
  edge: AnalysisEdgeHandle,
  token: string,
  analysisId: string,
  body: { continuationBudget?: number } = {},
) {
  const response = await fetch(edge.baseUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ analysisId, ...body }),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function safeResponseDiagnostic(body: Record<string, unknown>) {
  const error = body["error"];
  if (typeof error === "string" && error.length <= 64 && /^[a-zA-Z0-9_. -]+$/.test(error)) {
    return error;
  }
  return `response keys: ${Object.keys(body).sort().join(",")}`;
}

let sql: LocalSqlSession | undefined;
let edge: AnalysisEdgeHandle | undefined;
let workerToken: string | undefined;
let recoveryScheduleOwned = false;
const createdSecretIds: string[] = [];

async function enableRecoverySchedule(service: ReturnType<typeof serviceClient>) {
  const { error } = await service.rpc("configure_analysis_recovery", {
    p_enabled: true,
  });
  expect(error).toBeNull();
  recoveryScheduleOwned = true;
}

describe("local pg_cron analysis recovery", () => {
  beforeAll(async () => {
    await assertLocalSupabaseReady();
    sql = await openLocalSqlSession("kdm_analysis_recovery");

    const existingJobs = Number(await sql.query(
      "select count(*)::text from cron.job where jobname = 'kdm-analysis-recovery';",
    ));
    if (existingJobs !== 0) {
      throw new Error(
        "Refusing to alter a pre-existing local kdm-analysis-recovery cron job.",
      );
    }

    const secrets = parseJsonRecord(await sql.query(`
      select coalesce(
        jsonb_object_agg(name, decrypted_secret),
        '{}'::jsonb
      )::text
      from vault.decrypted_secrets
      where name in ('analysis_function_url', 'analysis_internal_token');
    `));
    const existingUrl = secrets["analysis_function_url"];
    if (
      existingUrl !== undefined &&
      existingUrl !== LOCAL_FUNCTION_URL &&
      existingUrl !== "http://kong:8000/functions/v1/analyze"
    ) {
      throw new Error(
        "Refusing to replace a pre-existing non-local analysis recovery URL.",
      );
    }
    const existingToken = secrets["analysis_internal_token"];
    workerToken = existingToken ?? randomUUID();
    if (workerToken.length < 32 || /\s/.test(workerToken)) {
      throw new Error("The local analysis recovery token is not valid for this test.");
    }

    if (existingUrl === undefined) {
      const id = await sql.query(`
        select vault.create_secret(
          ${sqlLiteral(LOCAL_FUNCTION_URL)},
          'analysis_function_url',
          'Temporary S2-05 local recovery integration URL',
          null
        )::text;
      `);
      createdSecretIds.push(id);
    }
    if (existingToken === undefined) {
      const id = await sql.query(`
        select vault.create_secret(
          ${sqlLiteral(workerToken)},
          'analysis_internal_token',
          'Temporary S2-05 local recovery integration token',
          null
        )::text;
      `);
      createdSecretIds.push(id);
    }

    const runtime = {
      supabaseUrl: process.env.KDM_LOCAL_SUPABASE_URL,
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    };
    if (!runtime.supabaseUrl || !runtime.serviceRoleKey) {
      throw new Error("Local Supabase worker configuration is missing.");
    }
  }, 45_000);

  afterAll(async () => {
    const cleanupErrors: string[] = [];
    if (recoveryScheduleOwned && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      const { error } = await serviceClient().rpc(
        "configure_analysis_recovery",
        { p_enabled: false },
      );
      if (error) cleanupErrors.push("could not disable the local recovery cron job");
    }
    if (edge) {
      try {
        await edge.stop();
      } catch {
        cleanupErrors.push("could not stop the local Edge worker");
      }
      edge = undefined;
    }
    if (sql) {
      for (const secretId of createdSecretIds) {
        try {
          await sql.query(
            `delete from vault.secrets where id = '${secretId}'::uuid;`,
          );
        } catch {
          cleanupErrors.push("could not remove a temporary local Vault secret");
        }
      }
      await sql.close();
      sql = undefined;
    }
    if (cleanupErrors.length > 0) {
      throw new Error(cleanupErrors.join("; "));
    }
  }, 30_000);

  it("rejects a bad token and keeps a not-ready worker job queued", async () => {
    if (!workerToken || !sql) throw new Error("Local analysis Edge fixture is not initialized.");
    const service = serviceClient();
    const job = await createQueuedJob(service);
    try {
      edge = await startAnalysisEdge({
        token: workerToken,
        supabaseUrl: process.env.KDM_LOCAL_SUPABASE_URL!,
        serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
      });

      const notReady = await postAnalyze(edge, workerToken, job.analysisId);
      expect(notReady.status, `${JSON.stringify(notReady.body)}\n${edge.diagnostics()}`).toBe(503);
      expect((await readJob(service, job.analysisId))).toMatchObject({
        status: "queued",
        attempt_count: 0,
      });

      const { error: backoffError } = await service
        .from("analyses")
        .update({ next_attempt_at: new Date(Date.now() + 5 * 60_000).toISOString() })
        .eq("id", job.analysisId);
      expect(backoffError).toBeNull();
      const earlyClaim = await service.rpc("claim_analysis", {
        p_analysis_id: job.analysisId,
      });
      expect(earlyClaim.error).toBeNull();
      expect(earlyClaim.data).toEqual([]);
      expect((await readJob(service, job.analysisId))).toMatchObject({
        status: "queued",
        attempt_count: 0,
      });

      const denied = await postAnalyze(edge, "invalid-local-test-token", job.analysisId);
      expect(denied.status, `${JSON.stringify(denied.body)}\n${edge.diagnostics()}`).toBe(401);
      expect((await readJob(service, job.analysisId))).toMatchObject({
        status: "queued",
        attempt_count: 0,
      });
    } finally {
      try {
        if (edge) {
          await edge.stop();
          edge = undefined;
        }
      } finally {
        await job.fixture.dispose();
      }
    }
  }, 30_000);

  it("recovers a queued job from cron and records the pg_net request", async () => {
    if (!sql || !workerToken) throw new Error("Local recovery fixture is not initialized.");
    if (edge) await edge.stop();
    edge = await startEdgeConFake({ token: workerToken, latencyMs: 10 });
    const service = serviceClient();
    const job = await createQueuedJob(service);
    try {
      const requestBaseline = Number(await sql.query(
        "select coalesce(max(id), 0)::text from net._http_response;",
      ));
      const scheduledAfter = await sql.query(
        "select clock_timestamp()::text;",
      );
      await enableRecoverySchedule(service);

      const jobId = Number(await sql.query(
        "select jobid::text from cron.job where jobname = 'kdm-analysis-recovery';",
      ));
      expect(Number.isInteger(jobId)).toBe(true);

      await expect.poll(async () => {
        const row = await readJob(service, job.analysisId);
        const evidence = await sql!.query(`
          select
            (select count(*) from cron.job_run_details
              where jobid = ${jobId}
                and start_time >= ${sqlLiteral(scheduledAfter)}
                and status = 'succeeded')::text
            || '|' ||
            coalesce((select id::text from net._http_response
              where id > ${requestBaseline} and status_code = 202
              order by id desc limit 1), '0');
        `);
        return `${row.status}:${row.attempt_count}:${evidence}`;
      }, {
        timeout: 75_000,
        interval: 1_000,
      }).toMatch(/^completed:1:[1-9][0-9]*\|[1-9][0-9]*$/);

      const requestId = Number(await sql.query(`
        select coalesce(max(id), 0)::text from net._http_response
        where id > ${requestBaseline} and status_code = 202;
      `));
      expect(requestId).toBeGreaterThan(requestBaseline);

      const row = await readJob(service, job.analysisId);
      expect(row).toMatchObject({
        status: "completed",
        attempt_count: 1,
        error_code: null,
      });
      const { data: ledger, error: ledgerError } = await service
        .from("credit_ledger")
        .select("event_type,amount")
        .eq("analysis_id", job.analysisId)
        // Tiebreaker: ascending enum order keeps Reserved before settlements.
        .order("created_at", { ascending: true })
        .order("event_type", { ascending: true });
      expect(ledgerError).toBeNull();
      expect(ledger).toEqual([
        { event_type: "Reserved", amount: row.fixed_cost },
        { event_type: "Consumed", amount: row.fixed_cost },
      ]);
      const { count: findings, error: findingsError } = await service
        .from("findings")
        .select("id", { count: "exact", head: true })
        .eq("analysis_id", job.analysisId);
      expect(findingsError).toBeNull();
      expect(findings).toBe(0);
    } finally {
      await job.fixture.dispose();
    }
  }, 90_000);

  it("recovers a lost continuation from cron without counting another attempt", async () => {
    if (!sql || !workerToken) throw new Error("Local recovery fixture is not initialized.");
    const service = serviceClient();
    const { error: disableError } = await service.rpc("configure_analysis_recovery", {
      p_enabled: false,
    });
    expect(disableError).toBeNull();
    const job = await createQueuedJob(service, { versionCount: 7, sourceCount: 3 });
    expect(job.pairCount).toBeGreaterThan(10);
    try {
      const requestBaseline = Number(await sql.query(
        "select coalesce(max(id), 0)::text from net._http_response;",
      ));
      if (!edge) edge = await startEdgeConFake({ token: workerToken, latencyMs: 10 });
      const accepted = await postAnalyze(edge, workerToken, job.analysisId, {
        continuationBudget: 0,
      });
      expect(
        accepted.status,
        `${JSON.stringify(accepted.body)}\n${edge.diagnostics()}`,
      ).toBe(202);

      await expect.poll(async () => {
        const row = await readJob(service, job.analysisId);
        const checkpoint = row.checkpoint;
        const processedPairs = typeof checkpoint === "object" && checkpoint !== null && !Array.isArray(checkpoint)
          ? checkpoint["processedPairs"]
          : undefined;
        return `${row.status}:${row.attempt_count}:${row.continuation_pending}:${processedPairs ?? "null"}`;
      }, { timeout: 30_000, interval: 100 }).toBe("queued:1:true:10");

      // Stop the originating runtime after its durable yield, so no leftover
      // waitUntil task or self-fetch can make the recovery appear successful.
      if (edge) {
        const originatingEdge = edge;
        edge = undefined;
        await originatingEdge.stop();
      }
      edge = await startEdgeConFake({ token: workerToken, latencyMs: 10 });
      // Start the schedule only after continuation_pending is durable. This
      // prevents an earlier minute tick from consuming the observation window.
      await enableRecoverySchedule(service);
      const scheduledAfter = await sql.query("select clock_timestamp()::text;");
      const jobId = Number(await sql.query(
        "select jobid::text from cron.job where jobname = 'kdm-analysis-recovery';",
      ));
      await expect.poll(async () => {
        const row = await readJob(service, job.analysisId);
        const evidence = await sql!.query(`
          select
            (select count(*) from cron.job_run_details
              where jobid = ${jobId}
                and start_time >= ${sqlLiteral(scheduledAfter)}
                and status = 'succeeded')::text
            || '|' ||
            coalesce((select id::text from net._http_response
              where id > ${requestBaseline} and status_code = 202
              order by id desc limit 1), '0');
        `);
        return `${row.status}:${row.attempt_count}:${row.continuation_pending}:${evidence}`;
      }, { timeout: 150_000, interval: 1_000 })
        .toMatch(/^completed:1:false:[1-9][0-9]*\|[1-9][0-9]*$/);

      const row = await readJob(service, job.analysisId);
      expect(row).toMatchObject({
        status: "completed",
        attempt_count: 1,
        continuation_pending: false,
        error_code: null,
      });
      const { data: ledger, error } = await service
        .from("credit_ledger")
        .select("event_type,amount")
        .eq("analysis_id", job.analysisId)
        // Tiebreaker: ascending enum order keeps Reserved before settlements.
        .order("created_at", { ascending: true })
        .order("event_type", { ascending: true });
      expect(error).toBeNull();
      expect(ledger).toEqual([
        { event_type: "Reserved", amount: row.fixed_cost },
        { event_type: "Consumed", amount: row.fixed_cost },
      ]);
    } finally {
      await job.fixture.dispose();
    }
  }, 210_000);

  it("reclaims an interrupted worker only after its real lease expires", async () => {
    if (!sql || !workerToken) throw new Error("Local recovery fixture is not initialized.");
    const service = serviceClient();
    await enableRecoverySchedule(service);
    if (edge) {
      await edge.stop();
      edge = undefined;
    }
    edge = await startEdgeConFake({ token: workerToken, latencyMs: 30_000 });
    const job = await createQueuedJob(service);
    try {
      const requestBaseline = Number(await sql.query(
        "select coalesce(max(id), 0)::text from net._http_response;",
      ));
      const firstAttempt = await postAnalyze(edge, workerToken, job.analysisId);
      expect(firstAttempt.status, safeResponseDiagnostic(firstAttempt.body)).toBe(202);
      await expect.poll(async () => (await readJob(service, job.analysisId)).status, {
        timeout: 15_000,
        interval: 100,
      }).toBe("processing");
      const processing = await readJob(service, job.analysisId);
      expect(processing.attempt_count).toBe(1);
      if (typeof processing.lease_expires_at !== "string") {
        throw new Error("Local worker did not persist its lease expiry.");
      }
      const leaseExpiresAt = processing.lease_expires_at;
      const jobId = Number(await sql.query(
        "select jobid::text from cron.job where jobname = 'kdm-analysis-recovery';",
      ));

      await killEdgeWorkerContainer();
      await edge.stop();
      edge = await startEdgeConFake({ token: workerToken, latencyMs: 10 });

      await expect.poll(async () => {
        const row = await readJob(service, job.analysisId);
        const evidence = await sql!.query(`
          select
            (select count(*) from cron.job_run_details
              where jobid = ${jobId}
                and start_time >= ${sqlLiteral(leaseExpiresAt)}
                and status = 'succeeded')::text
            || '|' ||
            coalesce((select id::text from net._http_response
              where id > ${requestBaseline} and status_code = 202
              order by id desc limit 1), '0');
        `);
        return `${row.status}:${row.attempt_count}:${evidence}`;
      }, { timeout: 300_000, interval: 1_000 })
        .toMatch(/^completed:2:[1-9][0-9]*\|[1-9][0-9]*$/);

      const row = await readJob(service, job.analysisId);
      expect(row).toMatchObject({ status: "completed", attempt_count: 2, error_code: null });
      const { data: ledger, error } = await service
        .from("credit_ledger")
        .select("event_type,amount")
        .eq("analysis_id", job.analysisId)
        // Tiebreaker: ascending enum order keeps Reserved before settlements.
        .order("created_at", { ascending: true })
        .order("event_type", { ascending: true });
      expect(error).toBeNull();
      expect(ledger).toEqual([
        { event_type: "Reserved", amount: row.fixed_cost },
        { event_type: "Consumed", amount: row.fixed_cost },
      ]);
    } finally {
      await job.fixture.dispose();
    }
  }, 360_000);
});
