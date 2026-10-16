import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database";
import {
  buildChunksRevision,
  computeRequestFingerprint,
} from "../../src/modules/analysis/retrieval";
import { assertLocalSupabaseReady } from "../support/local-supabase";
import { createAnalysisFixture } from "../support/analysis-fixtures";
import {
  startEdgeConFake,
  killEdgeWorkerContainer,
  type AnalysisEdgeHandle,
} from "../support/analysis-edge";

const LOCAL_API_URL = "http://127.0.0.1:54321";

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

// Generated database.ts predates the S2-06 regen (Task 7 owns it), so the
// new columns and RPCs are reached through this narrow structural cast.
// Only pre-S2-06 names go through the typed client.
interface PrivilegedClient {
  rpc<T = unknown>(
    fn: string,
    args?: Record<string, unknown>,
  ): Promise<{
    data: T | null;
    error: { code?: string; message: string } | null;
  }>;
  from(table: string): {
    update(
      values: Record<string, unknown>,
    ): {
      eq(
        column: string,
        value: string,
      ): Promise<{ error: { message: string } | null }>;
    };
  };
}

function privileged(service: Service): PrivilegedClient {
  return service as unknown as PrivilegedClient;
}

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
  const update: Record<string, unknown> = {};
  if (patch.leaseExpired) update["lease_expires_at"] = past;
  if (patch.backoffPast) update["next_attempt_at"] = past;
  const { error } = await privileged(service)
    .from("analyses")
    .update(update)
    .eq("id", analysisId);
  expect(error).toBeNull();
}

async function readAnalysis(service: Service, analysisId: string) {
  const { data, error } = await service
    .from("analyses")
    .select("status,attempt_count,operation_id,lease_expires_at,error_code")
    .eq("id", analysisId)
    .single();
  expect(error).toBeNull();
  if (!data) throw new Error("Local analysis row is missing.");
  return data;
}

async function readCheckpoint(
  service: Service,
  analysisId: string,
): Promise<{ processedPairs?: unknown; startedAt?: unknown } | null> {
  const query = (
    service.from("analyses") as unknown as {
      select(columns: string): {
        eq(
          column: string,
          value: string,
        ): {
          single(): Promise<{
            data: { checkpoint: unknown } | null;
            error: { message: string } | null;
          }>;
        };
      };
    }
  )
    .select("checkpoint")
    .eq("id", analysisId);
  const { data, error } = await query.single();
  expect(error).toBeNull();
  if (!data || typeof data.checkpoint !== "object" || data.checkpoint === null) {
    return null;
  }
  return data.checkpoint as {
    processedPairs?: unknown;
    startedAt?: unknown;
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

async function prepareJob(
  service: Service,
  options: { versions: number; sources: number },
): Promise<PreparedJob> {
  const fixture = await createAnalysisFixture({
    versionCount: options.versions,
    status: "queued",
  });
  try {
    const sourceIds = fixture.versions
      .slice(0, options.sources)
      .map((version) => version.versionId);
    const comparisonIds = fixture.versions
      .slice(options.sources)
      .map((version) => version.versionId);
    for (const versionId of sourceIds.slice(1)) {
      // UPDATE runs over the fixture SQL session: service_role has no
      // UPDATE grant on analysis_documents (S2-01 grants).
      await fixture.sql.query(
        `update public.analysis_documents set role = 'source' where analysis_id = '${fixture.analysisId}' and version_id = '${versionId}';`,
      );
    }

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
    const chunkIds = [
      ...new Set([
        ...rows.map((pair) => pair.source_chunk_id),
        ...rows.map((pair) => pair.comparison_chunk_id),
      ]),
    ];
    const chunksRevision = buildChunksRevision(chunkIds);
    const fingerprint = computeRequestFingerprint(
      {
        chunkCount: chunkIds.length,
        candidatePairCount: rows.length,
        sortedSourceVersionIds: sourceIds,
        sortedComparisonVersionIds: comparisonIds,
        pairs: rows.map((pair) => ({
          sourceChunkId: pair.source_chunk_id,
          comparisonChunkId: pair.comparison_chunk_id,
        })),
        chunkIds,
      },
      {
        similarityThreshold: 0.75,
        topK: 5,
        embeddingRevision: "gte-small-384-v1",
        pricingVersion: "fixture-pricing-v1",
        promptVersion: "fixture-prompt-v1",
        outputSchemaVersion: "fixture-output-v1",
      },
    );
    const { error: configError } = await service
      .from("analyses")
      .update({
        request_fingerprint: fingerprint,
        retrieval_config: {
          topK: 5,
          similarityThreshold: 0.75,
          chunksRevision,
          embeddingRevision: "gte-small-384-v1",
          fingerprint,
        },
        provider_config: {
          primary: { provider: "synthetic-test", model: "fake" },
          fallback: { provider: "synthetic-test", model: "fake" },
        },
      })
      .eq("id", fixture.analysisId);
    expect(configError).toBeNull();

    // Fixture artifacts are not worker output: the worker must add none.
    // Deletes run over the fixture SQL session because service_role has
    // no DELETE grant on analysis tables (S2-01 grants).
    await fixture.sql.query(
      `delete from public.finding_evidence where analysis_id = '${fixture.analysisId}';`,
    );
    await fixture.sql.query(
      `delete from public.findings where analysis_id = '${fixture.analysisId}';`,
    );
    return {
      workspaceId: fixture.workspaceId,
      analysisId: fixture.analysisId,
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
  analysisId: string,
  fake?: Record<string, unknown>,
  timeoutMs = 60_000,
) {
  const response = await fetch(edge.baseUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${edge.token}`,
    },
    body: JSON.stringify(
      fake === undefined ? { analysisId } : { analysisId, _fake: fake },
    ),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

describe("FAKE-PROVIDER analysis worker integration", () => {
  beforeAll(assertLocalSupabaseReady);

  let edge: AnalysisEdgeHandle | undefined;

  afterAll(async () => {
    if (edge) {
      await edge.stop();
      edge = undefined;
    }
  });

  it("FAKE-PROVIDER recovers a queued job without its trigger", async () => {
    if (edge) await edge.stop();
    edge = await startEdgeConFake({ latencyMs: 400 });
    const service = serviceClient();
    const job = await prepareJob(service, { versions: 2, sources: 1 });
    expect(job.pairCount).toBe(1);
    try {
      // No direct invoke: an unknown id misses, the FIFO sweep claims ours.
      const response = await invokeEdge(edge, randomUUID());
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ ok: true, final: true });
      expect(response.body["claimedId"]).toBe(job.analysisId);
      const row = await readAnalysis(service, job.analysisId);
      expect(row.status).toBe("completed");
      expect(row.attempt_count).toBe(1);
      expect(row.operation_id).toBeTruthy();
      expect(await scopedCount(service, "credit_ledger", job.analysisId)).toBe(0);
      expect(await scopedCount(service, "findings", job.analysisId)).toBe(0);
      expect(await scopedCount(service, "notification_events", job.analysisId)).toBe(0);
    } finally {
      await job.dispose();
    }
  });

  it("FAKE-PROVIDER restarts from zero after a mid-batch kill", async () => {
    if (edge) await edge.stop();
    edge = await startEdgeConFake();
    const service = serviceClient();
    // Ten pairs exactly: one batch. The kill lands before its renew, so
    // no checkpoint exists and the retry recomputes from zero.
    const job = await prepareJob(service, { versions: 7, sources: 2 });
    expect(job.pairCount).toBe(10);
    try {
      const flight = invokeEdge(edge, job.analysisId, { latencyMs: 400 });
      await new Promise((resolve) => setTimeout(resolve, 2500));
      // Kill the worker container (not the CLI): the in-flight batch
      // dies mid-processing while the harness handle stays usable.
      await killEdgeWorkerContainer();
      // The kill must land mid-flight: either the connection drops
      // (reject) or Kong reports the dead upstream (502). A 202 here
      // would mean the batch finished before the kill landed.
      const settled = await flight.then(
        (response) => ({ resolved: true as const, response }),
        (error: unknown) => ({ resolved: false as const, error }),
      );
      expect(
        !settled.resolved || settled.response.status === 502,
      ).toBe(true);
      await edge.stop();
      edge = await startEdgeConFake();
      await backdate(service, job.analysisId, { leaseExpired: true });
      const response = await invokeEdge(edge, job.analysisId, { latencyMs: 400 });
      expect(response.body).toMatchObject({ ok: true, final: true });
      const row = await readAnalysis(service, job.analysisId);
      expect(row.status).toBe("completed");
      expect(row.attempt_count).toBe(2);
      expect(await scopedCount(service, "credit_ledger", job.analysisId)).toBe(0);
    } finally {
      await job.dispose();
    }
  }, 60_000);

  it("FAKE-PROVIDER continues from the persisted checkpoint", async () => {
    if (edge) await edge.stop();
    edge = await startEdgeConFake();
    const service = serviceClient();
    const job = await prepareJob(service, { versions: 12, sources: 6 });
    expect(job.pairCount).toBeGreaterThan(10);
    try {
      const first = await invokeEdge(edge, job.analysisId, { latencyMs: 400 });
      expect(first.body).toMatchObject({ ok: true, continued: true });
      await expect
        .poll(
          async () => {
            const value = await readCheckpoint(service, job.analysisId);
            return typeof value?.processedPairs === "number"
              ? value.processedPairs
              : -1;
          },
          { timeout: 20_000 },
        )
        .toBe(10);
      const before = await readCheckpoint(service, job.analysisId);
      const startedAt = before?.startedAt;
      // The automatic self-fetch goes idle on the fresh lease; reclaim it.
      await backdate(service, job.analysisId, { leaseExpired: true });
      let completed = false;
      for (let attempt = 0; attempt < 4 && !completed; attempt += 1) {
        const response = await invokeEdge(edge, job.analysisId, { latencyMs: 400 });
        if (response.body["final"] === true) {
          completed = true;
        } else {
          await backdate(service, job.analysisId, { leaseExpired: true });
        }
      }
      expect(completed).toBe(true);
      const row = await readAnalysis(service, job.analysisId);
      expect(row.status).toBe("completed");
      // Thirty pairs need three batches, hence three claims (one per
      // batch boundary): exactly the attempt budget, no more.
      expect(row.attempt_count).toBe(3);
      expect((await readCheckpoint(service, job.analysisId))?.startedAt).toBe(
        startedAt,
      );
    } finally {
      await job.dispose();
    }
  }, 60_000);

  it("FAKE-PROVIDER rejects a stale worker without side effects", async () => {
    const service = serviceClient();
    const client = privileged(service);
    const job = await prepareJob(service, { versions: 2, sources: 1 });
    try {
      const first = await client.rpc<Array<{ operation_id: string }>>(
        "claim_analysis",
        { p_analysis_id: job.analysisId },
      );
      expect(first.error).toBeNull();
      const staleOperation = first.data?.[0]?.operation_id;
      expect(staleOperation).toBeTruthy();
      await backdate(service, job.analysisId, { leaseExpired: true });
      const second = await client.rpc<Array<{ operation_id: string }>>(
        "claim_analysis",
        { p_analysis_id: job.analysisId },
      );
      expect(second.error).toBeNull();
      const liveOperation = second.data?.[0]?.operation_id;
      expect(liveOperation).toBeTruthy();
      expect(liveOperation).not.toBe(staleOperation);
      const stale = await client.rpc("complete_analysis", {
        p_analysis_id: job.analysisId,
        p_operation_id: staleOperation,
      });
      expect(stale.error?.code).toBe("22023");
      const row = await readAnalysis(service, job.analysisId);
      expect(row.status).toBe("processing");
      expect(row.operation_id).toBe(liveOperation);
      expect(await scopedCount(service, "findings", job.analysisId)).toBe(0);
      expect(await scopedCount(service, "credit_ledger", job.analysisId)).toBe(0);
    } finally {
      await job.dispose();
    }
  });

  it("FAKE-PROVIDER exhausts retries then fails without charges", async () => {
    if (edge) await edge.stop();
    edge = await startEdgeConFake();
    const service = serviceClient();
    const job = await prepareJob(service, { versions: 2, sources: 1 });
    const fail = {
      latencyMs: 100,
      failAtCallIndex: 0,
      failCode: "PROVIDER_UNAVAILABLE",
    };
    try {
      const first = await invokeEdge(edge, job.analysisId, fail);
      expect(first.body).toMatchObject({ ok: true, final: false });
      let row = await readAnalysis(service, job.analysisId);
      expect(row.status).toBe("queued");
      expect(row.attempt_count).toBe(1);
      await backdate(service, job.analysisId, { backoffPast: true });

      const second = await invokeEdge(edge, job.analysisId, fail);
      expect(second.body).toMatchObject({ ok: true, final: false });
      row = await readAnalysis(service, job.analysisId);
      expect(row.status).toBe("queued");
      expect(row.attempt_count).toBe(2);
      await backdate(service, job.analysisId, { backoffPast: true });

      const third = await invokeEdge(edge, job.analysisId, fail);
      expect(third.body).toMatchObject({ ok: true, final: false });
      row = await readAnalysis(service, job.analysisId);
      expect(row.status).toBe("failed");
      expect(row.error_code).toBe("PROVIDER_UNAVAILABLE");
      expect(row.attempt_count).toBe(3);
      expect(await scopedCount(service, "credit_ledger", job.analysisId)).toBe(0);
      expect(await scopedCount(service, "findings", job.analysisId)).toBe(0);
      expect(await scopedCount(service, "notification_events", job.analysisId)).toBe(0);
    } finally {
      await job.dispose();
    }
  }, 30_000);
});
