import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { AnalysisExecutionManifest } from "../../src/types/analysis-internal";
import type { Database, Json } from "../../src/types/database";
import { assertLocalSupabaseReady } from "../support/local-supabase";
import { createAnalysisFixture } from "../support/analysis-fixtures";
import {
  startEdgeConFake,
  killEdgeWorkerContainer,
  type AnalysisEdgeHandle,
} from "../support/analysis-edge";

const LOCAL_API_URL = "http://127.0.0.1:54321";
const WORKER_MANIFEST: AnalysisExecutionManifest = {
  fingerprintVersion: "s2-05-v2",
  pricingVersion: "s2-04-v1",
  promptVersion: "prompt-worker-integration-v1",
  outputSchemaVersion: "schema-worker-integration-v1",
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

type Service = ReturnType<typeof serviceClient>;

interface PreparedJob {
  workspaceId: string;
  analysisId: string;
  dispose: () => Promise<void>;
  pairCount: number;
}

async function backdate(
  service: Service,
  analysisId: string,
  patch: { leaseExpired?: boolean; backoffPast?: boolean },
) {
  const past = new Date(Date.now() - 60_000).toISOString();
  const { error } = await service
    .from("analyses")
    .update({
      ...(patch.leaseExpired ? { lease_expires_at: past } : {}),
      ...(patch.backoffPast ? { next_attempt_at: past } : {}),
    })
    .eq("id", analysisId);
  expect(error).toBeNull();
}

async function readAnalysis(service: Service, analysisId: string) {
  const { data, error } = await service
    .from("analyses")
    .select("status,attempt_count,operation_id,lease_expires_at,error_code,estimate_id,fixed_cost,continuation_pending,attempt_deadline_at,analysis_deadline_at")
    .eq("id", analysisId)
    .single();
  expect(error).toBeNull();
  if (!data) throw new Error("Local analysis row is missing.");
  return data;
}

async function readCheckpoint(
  service: Service,
  analysisId: string,
): Promise<{
  processedPairs?: unknown;
  totalPairs?: unknown;
  startedAt?: unknown;
  cursor?: { lowChunkId?: unknown; highChunkId?: unknown } | null;
} | null> {
  const { data, error } = await service
    .from("analyses")
    .select("checkpoint")
    .eq("id", analysisId)
    .single();
  expect(error).toBeNull();
  if (!data || typeof data.checkpoint !== "object" || data.checkpoint === null) {
    return null;
  }
  // checkpoint is Json: narrow at the boundary instead of casting.
  const value: unknown = data.checkpoint;
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  return {
    processedPairs: record["processedPairs"],
    totalPairs: record["totalPairs"],
    startedAt: record["startedAt"],
    cursor:
      typeof record["cursor"] === "object" && record["cursor"] !== null
        ? (record["cursor"] as { lowChunkId?: unknown; highChunkId?: unknown })
        : null,
  };
}

async function scopedCount(
  service: Service,
  table: "credit_ledger" | "findings" | "notification_events",
  analysisId: string,
) {
  const { count, error } = await service
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("analysis_id", analysisId);
  expect(error).toBeNull();
  return count ?? -1;
}

async function scopedCredits(service: Service, analysisId: string) {
  const { data, error } = await service
    .from("credit_ledger")
    .select("event_type,amount")
    .eq("analysis_id", analysisId)
    .order("created_at")
    // Tiebreaker: Reserved and Released/Consumed can share created_at
    // when the fixture inserts them in one transaction
    // (transaction_timestamp() is constant within a tx). Ascending
    // event_type follows the enum declaration order
    // (Promotional, Reserved, Consumed, Released), so Reserved precedes
    // both Released and Consumed. Promotional is not inserted for an
    // analysis. Revisit if the enum order changes in a future migration.
    .order("event_type", { ascending: true });
  expect(error).toBeNull();
  return data ?? [];
}

async function prepareJob(
  service: Service,
  options: { versions: number; sources: number },
): Promise<PreparedJob> {
  const fixture = await createAnalysisFixture({
    versionCount: options.versions,
    status: "failed",
  });
  try {
    const sourceIds = fixture.versions
      .slice(0, options.sources)
      .map((version) => version.versionId);
    const comparisonIds = fixture.versions
      .slice(options.sources)
      .map((version) => version.versionId);
    const { data: pairs, error: retrievalError } = await service.rpc(
      "retrieve_candidate_pairs",
      {
        p_workspace_id: fixture.workspaceId,
        p_source_version_ids: sourceIds,
        p_comparison_version_ids: comparisonIds,
        p_top_k: 5,
        p_threshold: 0.75,
      },
    );
    expect(retrievalError).toBeNull();
    const rows = pairs ?? [];

    // Fixture artifacts are not worker output: the worker must add none.
    // Deletes run over the fixture SQL session because service_role has
    // no DELETE grant on analysis tables (S2-01 grants).
    await fixture.sql.query(
      `delete from public.finding_evidence where analysis_id = '${fixture.analysisId}';`,
    );
    await fixture.sql.query(
      `delete from public.findings where analysis_id = '${fixture.analysisId}';`,
    );
    const estimate = await service.rpc("create_analysis_estimate", {
      p_actor_id: fixture.adminId,
      p_source_version_ids: sourceIds,
      p_comparison_version_ids: comparisonIds,
      p_manifest: WORKER_MANIFEST_JSON,
    });
    expect(estimate.error).toBeNull();
    const estimateRef = estimate.data?.[0]?.estimate_ref;
    if (!estimateRef) throw new Error("Worker fixture estimate was not persisted.");

    const created = await service.rpc("run_analysis", {
      p_actor_id: fixture.adminId,
      p_estimate_ref: estimateRef,
      p_idempotency_key: `worker-integration-${randomUUID()}`,
      p_current_manifest: WORKER_MANIFEST_JSON,
    });
    expect(created.error).toBeNull();
    const analysisId = created.data?.[0]?.analysis_id;
    if (!analysisId) throw new Error("S2-05 Run did not create the worker fixture.");
    return {
      workspaceId: fixture.workspaceId,
      analysisId,
      dispose: fixture.dispose,
      pairCount: rows.length,
    };
  } catch (error) {
    await fixture.dispose();
    throw error;
  }
}

async function invokeEdge(
  edge: AnalysisEdgeHandle,
  analysisId: string | null,
  fake?: Record<string, unknown>,
  continuationBudget?: number,
  timeoutMs = 60_000,
) {
  const startedAt = Date.now();
  const body = {
    ...(analysisId === null ? {} : { analysisId }),
    ...(fake === undefined ? {} : { _fake: fake }),
    ...(continuationBudget === undefined ? {} : { continuationBudget }),
  };
  const response = await fetch(edge.baseUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${edge.token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
    elapsedMs: Date.now() - startedAt,
  };
}

describe("FAKE-PROVIDER analysis worker integration", () => {
  beforeAll(async () => {
    await assertLocalSupabaseReady();
    edge = await startEdgeConFake();
  });

  let edge: AnalysisEdgeHandle | undefined;

  afterAll(async () => {
    if (edge) {
      await edge.stop();
      edge = undefined;
    }
  });

  function requireEdge(): AnalysisEdgeHandle {
    if (!edge) throw new Error("Local analysis Edge fixture is not running.");
    return edge;
  }

  it("FAKE-PROVIDER recovers a queued job without its trigger", async () => {
    const worker = requireEdge();
    const service = serviceClient();
    const job = await prepareJob(service, { versions: 2, sources: 1 });
    expect(job.pairCount).toBe(1);
    try {
      expect((await readAnalysis(service, job.analysisId)).estimate_id).toBeTruthy();
      // A directed miss falls back to the FIFO sweep; HTTP only acknowledges.
      const response = await invokeEdge(worker, randomUUID(), { latencyMs: 400 });
      const afterResponse = await readAnalysis(service, job.analysisId);
      expect(
        response.status,
        `${JSON.stringify(response.body)} job=${afterResponse.status}:${afterResponse.attempt_count}:${afterResponse.error_code ?? "none"} elapsedMs=${response.elapsedMs}\n${worker.diagnostics()}`,
      ).toBe(202);
      expect(response.body).toEqual({ ok: true, accepted: true });
      await expect
        .poll(async () => {
          const row = await readAnalysis(service, job.analysisId);
          return `${row.status}:${row.error_code ?? "none"}:${row.attempt_count}`;
        }, {
          timeout: 15_000,
        })
        .toBe("completed:none:1");
      const row = await readAnalysis(service, job.analysisId);
      expect(row.status).toBe("completed");
      expect(row.attempt_count).toBe(1);
      expect(row.operation_id).toBeTruthy();
      expect(await scopedCredits(service, job.analysisId)).toEqual([
        { event_type: "Reserved", amount: row.fixed_cost },
        { event_type: "Consumed", amount: row.fixed_cost },
      ]);
      expect(await scopedCount(service, "findings", job.analysisId)).toBe(0);
      expect(await scopedCount(service, "notification_events", job.analysisId)).toBe(1);
    } finally {
      await job.dispose();
    }
  });

  it("FAKE-PROVIDER recovers an interrupted page after a worker kill", async () => {
    const worker = requireEdge();
    const service = serviceClient();
    // Ten pairs make one page. The kill lands during provider work, before
    // the checkpoint is advanced, so reclaim safely retries that page.
    const job = await prepareJob(service, { versions: 7, sources: 2 });
    expect(job.pairCount).toBe(10);
    try {
      const accepted = await invokeEdge(worker, job.analysisId, { latencyMs: 400 });
      expect(accepted.status, `${JSON.stringify(accepted.body)}\n${worker.diagnostics()}`).toBe(202);
      await expect
        .poll(async () => (await readAnalysis(service, job.analysisId)).status, {
          timeout: 10_000,
        })
        .toBe("processing");
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      const during = await readAnalysis(service, job.analysisId);
      expect(during.status).toBe("processing");
      expect(during.attempt_count).toBe(1);
      const beforeKillCheckpoint = await readCheckpoint(service, job.analysisId);
      expect(beforeKillCheckpoint?.processedPairs ?? 0).toBe(0);
      expect(beforeKillCheckpoint?.cursor ?? null).toBeNull();
      // Kill only the disposable local Edge runtime, after SQL confirms
      // the job has been claimed and while the bounded page is active.
      await killEdgeWorkerContainer();
      await worker.stop();
      edge = await startEdgeConFake();
      await backdate(service, job.analysisId, { leaseExpired: true });
      const recoveryWorker = requireEdge();
      const response = await invokeEdge(recoveryWorker, job.analysisId, { latencyMs: 400 });
      expect(response.status, `${JSON.stringify(response.body)}\n${recoveryWorker.diagnostics()}`).toBe(202);
      await expect
        .poll(async () => (await readAnalysis(service, job.analysisId)).status, {
          timeout: 15_000,
        })
        .toBe("completed");
      const row = await readAnalysis(service, job.analysisId);
      expect(row.status).toBe("completed");
      expect(row.attempt_count).toBe(2);
      expect(await scopedCredits(service, job.analysisId)).toEqual([
        { event_type: "Reserved", amount: row.fixed_cost },
        { event_type: "Consumed", amount: row.fixed_cost },
      ]);
    } finally {
      await job.dispose();
    }
  }, 60_000);

  it("FAKE-PROVIDER processes 40+ pairs across pages in one attempt", async () => {
    const worker = requireEdge();
    const service = serviceClient();
    const job = await prepareJob(service, { versions: 20, sources: 10 });
    expect(job.pairCount).toBeGreaterThanOrEqual(40);
    try {
      const accepted = await invokeEdge(worker, job.analysisId, { latencyMs: 20 });
      expect(accepted.status, `${JSON.stringify(accepted.body)}\n${worker.diagnostics()}`).toBe(202);
      expect(accepted.body).toEqual({ ok: true, accepted: true });
      await expect
        .poll(
          async () => {
            const row = await readAnalysis(service, job.analysisId);
            const checkpoint = await readCheckpoint(service, job.analysisId);
            return `${row.status}:${row.error_code ?? "none"}:${row.attempt_count}:`
              + `${checkpoint?.processedPairs ?? "null"}/${checkpoint?.totalPairs ?? "null"}:`
              + `${row.continuation_pending}`;
          },
          { timeout: 45_000 },
        )
        .toBe(`completed:none:1:${job.pairCount}/${job.pairCount}:false`);
      const row = await readAnalysis(service, job.analysisId);
      expect(row.status).toBe("completed");
      expect(row.attempt_count).toBe(1);
      expect(row.continuation_pending).toBe(false);
      expect((await readCheckpoint(service, job.analysisId))?.processedPairs).toBe(job.pairCount);
      expect((await readCheckpoint(service, job.analysisId))?.cursor).not.toBeNull();
      expect(await scopedCredits(service, job.analysisId)).toEqual([
        { event_type: "Reserved", amount: row.fixed_cost },
        { event_type: "Consumed", amount: row.fixed_cost },
      ]);
    } finally {
      await job.dispose();
    }
  }, 60_000);

  it("FAKE-PROVIDER rejects a stale worker without side effects", async () => {
    const service = serviceClient();
    const job = await prepareJob(service, { versions: 2, sources: 1 });
    try {
      const first = await service.rpc("claim_analysis", {
        p_analysis_id: job.analysisId,
      });
      expect(first.error).toBeNull();
      const staleOperation = first.data?.[0]?.operation_id;
      expect(staleOperation).toBeTruthy();
      await backdate(service, job.analysisId, { leaseExpired: true });
      const second = await service.rpc("claim_analysis", {
        p_analysis_id: job.analysisId,
      });
      expect(second.error).toBeNull();
      const liveOperation = second.data?.[0]?.operation_id;
      expect(liveOperation).toBeTruthy();
      expect(liveOperation).not.toBe(staleOperation);
      if (!staleOperation || !liveOperation) {
        throw new Error("Local claim fixture did not return an operation.");
      }
      const stale = await service.rpc("finalize_analysis_success", {
        p_analysis_id: job.analysisId,
        p_operation_id: staleOperation,
        p_reported_findings_count: 0,
      });
      expect(stale.error?.code).toBe("22023");
      const row = await readAnalysis(service, job.analysisId);
      expect(row.status).toBe("processing");
      expect(row.operation_id).toBe(liveOperation);
      expect(await scopedCount(service, "findings", job.analysisId)).toBe(0);
      expect(await scopedCredits(service, job.analysisId)).toEqual([
        { event_type: "Reserved", amount: row.fixed_cost },
      ]);
    } finally {
      await job.dispose();
    }
  });

  it("FAKE-PROVIDER exhausts retries without adding reservations", async () => {
    const worker = requireEdge();
    const service = serviceClient();
    const job = await prepareJob(service, { versions: 2, sources: 1 });
    const fail = {
      latencyMs: 100,
      failAtCallIndex: 0,
      failCode: "PROVIDER_UNAVAILABLE",
    };
    try {
      const first = await invokeEdge(worker, job.analysisId, fail);
      expect(first.status, `${JSON.stringify(first.body)}\n${worker.diagnostics()}`).toBe(202);
      await expect
        .poll(async () => {
          const row = await readAnalysis(service, job.analysisId);
          return `${row.status}:${row.attempt_count}`;
        }, { timeout: 10_000 })
        .toBe("queued:1");
      let row = await readAnalysis(service, job.analysisId);
      expect(row.status).toBe("queued");
      expect(row.attempt_count).toBe(1);
      await backdate(service, job.analysisId, { backoffPast: true });

      const second = await invokeEdge(worker, job.analysisId, fail);
      expect(second.status, `${JSON.stringify(second.body)}\n${worker.diagnostics()}`).toBe(202);
      await expect
        .poll(async () => {
          const row = await readAnalysis(service, job.analysisId);
          return `${row.status}:${row.attempt_count}`;
        }, { timeout: 10_000 })
        .toBe("queued:2");
      row = await readAnalysis(service, job.analysisId);
      expect(row.status).toBe("queued");
      expect(row.attempt_count).toBe(2);
      await backdate(service, job.analysisId, { backoffPast: true });

      const third = await invokeEdge(worker, job.analysisId, fail);
      expect(third.status, `${JSON.stringify(third.body)}\n${worker.diagnostics()}`).toBe(202);
      await expect
        .poll(async () => {
          const row = await readAnalysis(service, job.analysisId);
          return `${row.status}:${row.attempt_count}`;
        }, { timeout: 10_000 })
        .toBe("failed:3");
      row = await readAnalysis(service, job.analysisId);
      expect(row.status).toBe("failed");
      expect(row.error_code).toBe("PROVIDER_UNAVAILABLE");
      expect(row.attempt_count).toBe(3);
      expect(await scopedCredits(service, job.analysisId)).toEqual([
        { event_type: "Reserved", amount: row.fixed_cost },
        { event_type: "Released", amount: row.fixed_cost },
      ]);
      expect(await scopedCount(service, "findings", job.analysisId)).toBe(0);
      const { count: failureEvents, error: failureEventsError } = await service
        .from("notification_events")
        .select("id", { count: "exact", head: true })
        .eq("analysis_id", job.analysisId)
        .eq("type", "analysis_failed");
      expect(failureEventsError).toBeNull();
      expect(failureEvents).toBe(1);
    } finally {
      await job.dispose();
    }
  }, 30_000);
});
