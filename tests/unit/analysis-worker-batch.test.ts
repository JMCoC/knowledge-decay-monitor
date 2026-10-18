import { describe, expect, it, vi } from "vitest";

import { buildPairHashes } from "../../src/modules/analysis/retrieval";
import { runBatch } from "../../src/modules/analysis/worker/batch";
import type {
  AnalysisCandidatePair,
  AnalysisConfiguration,
  AnalysisPairCursor,
} from "../../src/types/analysis-internal";
import type {
  AnalysisBatchPersistence,
  AnalysisBatchPersistenceInput,
  AnalysisWorkerDb,
  ClaimedAnalysis,
  CheckpointState,
  LoadedContext,
} from "../../src/modules/analysis/worker/types";
import { FakeAnalysisProvider } from "../../supabase/functions/analyze/_test_doubles/analysis-provider.fake";

const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ANALYSIS_ID = "b0000000-0000-4000-8000-000000000001";
const OPERATION_ID = "c0000000-0000-4000-8000-000000000001";

function makePair(index: number): AnalysisCandidatePair {
  const pad = index.toString(16).padStart(12, "0");
  return {
    source: {
      documentId: "20000000-0000-4000-8000-000000000001",
      versionId: "30000000-0000-4000-8000-000000000001",
      chunkId: `40000000-0000-4000-8000-${pad}`,
      role: "source",
      text: `synthetic source ${index}`,
    },
    comparison: {
      documentId: "20000000-0000-4000-8000-000000000002",
      versionId: "30000000-0000-4000-8000-000000000002",
      chunkId: `50000000-0000-4000-8000-${pad}`,
      role: "comparison",
      text: `synthetic comparison ${index}`,
    },
  };
}

function cursor(pair: AnalysisCandidatePair): AnalysisPairCursor {
  return {
    lowChunkId: pair.source.chunkId,
    highChunkId: pair.comparison.chunkId,
  };
}

const configuration: AnalysisConfiguration = {
  retrieval: {
    topK: 5,
    similarityThreshold: 0.75,
    chunksRevision: "synthetic-rev",
    embeddingRevision: "gte-small-384-v1",
    fingerprint: "synthetic-fingerprint",
  },
  pricingVersion: "s2-04-v1",
  promptVersion: "none",
  outputSchemaVersion: "none",
  providers: {
    primary: { provider: "cerebras", model: "synthetic" },
    fallback: { provider: "groq", model: "synthetic" },
  },
};

const claimed: ClaimedAnalysis = {
  id: ANALYSIS_ID,
  workspaceId: WORKSPACE_ID,
  initiatorId: "10000000-0000-4000-8000-000000000001",
  operationId: OPERATION_ID,
  attemptCount: 1,
  leaseExpiresAt: "2026-10-15T00:03:00.000Z",
  nextAttemptAt: null,
};

function makeContext(
  pageCount: number,
  totalPairCount = pageCount,
  startAt = 0,
  currentCursor: AnalysisPairCursor | null = null,
): LoadedContext {
  const pairs = Array.from({ length: pageCount }, (_, i) => makePair(startAt + i + 1));
  return {
    analysisId: ANALYSIS_ID,
    workspaceId: WORKSPACE_ID,
    sourceVersionIds: [],
    comparisonVersionIds: [],
    pairs,
    pairCursors: pairs.map(cursor),
    cursor: currentCursor,
    fingerprint: "synthetic-fingerprint",
    chunkCount: totalPairCount * 2,
    candidatePairCount: totalPairCount,
  };
}

function makeCheckpoint(
  processedPairs: number,
  totalPairs: number,
  currentCursor: AnalysisPairCursor | null = null,
): CheckpointState {
  return {
    processedPairs,
    totalPairs,
    findingsCount: 0,
    lastPairFingerprint: null,
    startedAt: "2026-10-15T00:00:00.000Z",
    cursor: currentCursor,
  };
}

function mockClient(renewImpl?: () => Promise<unknown>) {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    rpcCalls.push({ name, args });
    if (renewImpl) return renewImpl();
    return {
      data: [{ lease_expires_at: "2026-10-15T00:03:00.000Z" }],
      error: null,
    };
  });
  return { client: { rpc } as unknown as AnalysisWorkerDb, rpcCalls };
}

function mockPersistence(
  result: { ok: true } | { ok: false; code: string } = { ok: true },
) {
  const inputs: AnalysisBatchPersistenceInput[] = [];
  const persistence: AnalysisBatchPersistence = {
    persist: vi.fn(async (input) => {
      inputs.push(input);
      return result;
    }),
  };
  return { persistence, inputs };
}

describe("runBatch", () => {
  it("processes one bounded page sequentially and persists its next cursor", async () => {
    const provider = new FakeAnalysisProvider({ latencyMs: 5 });
    const context = makeContext(3, 13);
    const { client } = mockClient();
    const { persistence, inputs } = mockPersistence();
    const result = await runBatch({
      claimed,
      context,
      provider,
      client,
      persistence,
      configuration,
      checkpoint: makeCheckpoint(0, 13),
    });

    expect(provider.maxActive).toBe(1);
    expect(provider.calls.map((call) => call.pair)).toEqual(context.pairs);
    expect(result.outcome).toMatchObject({ kind: "completed", processedPairs: 3 });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      analysisId: ANALYSIS_ID,
      operationId: OPERATION_ID,
      expectedProcessedPairs: 0,
      hasMore: true,
      checkpoint: {
        processedPairs: 3,
        totalPairs: 13,
        cursor: context.pairCursors[2],
      },
    });
  });

  it("keeps processedPairs global when processing a later page", async () => {
    const context = makeContext(5, 15, 10, cursor(makePair(10)));
    const { client } = mockClient();
    const { persistence, inputs } = mockPersistence();
    const result = await runBatch({
      claimed,
      context,
      provider: new FakeAnalysisProvider(),
      client,
      persistence,
      configuration,
      checkpoint: makeCheckpoint(10, 15, context.cursor),
    });
    expect(result.checkpoint.processedPairs).toBe(15);
    expect(inputs[0]?.expectedProcessedPairs).toBe(10);
    expect(inputs[0]?.hasMore).toBe(false);
    expect(inputs[0]?.checkpoint.cursor).toEqual(context.pairCursors[4]);
  });

  it("does not advance the persisted cursor when compare-and-set loses", async () => {
    const context = makeContext(2);
    const { client } = mockClient();
    const { persistence, inputs } = mockPersistence({
      ok: false,
      code: "STALE_OPERATION",
    });
    const checkpoint = makeCheckpoint(0, 2);
    const result = await runBatch({
      claimed,
      context,
      provider: new FakeAnalysisProvider(),
      client,
      persistence,
      configuration,
      checkpoint,
    });
    expect(result.outcome.kind).toBe("aborted");
    expect(result.checkpoint).toBe(checkpoint);
    expect(inputs[0]?.checkpoint.processedPairs).toBe(2);
  });

  it("renews the lease while a provider call is pending", async () => {
    const { client, rpcCalls } = mockClient();
    const { persistence } = mockPersistence();
    await runBatch({
      claimed,
      context: makeContext(2),
      provider: new FakeAnalysisProvider({ latencyMs: 40 }),
      client,
      persistence,
      configuration,
      checkpoint: makeCheckpoint(0, 2),
      heartbeatIntervalMs: 5,
      batchTimeoutMs: 500,
    });
    expect(rpcCalls.some((call) => call.name === "renew_analysis_lease")).toBe(true);
  });

  it("aborts without persistence when its fenced heartbeat fails", async () => {
    const { client } = mockClient(async () => ({
      data: null,
      error: { code: "22023", message: "lease lost" },
    }));
    const { persistence } = mockPersistence();
    const result = await runBatch({
      claimed,
      context: makeContext(2),
      provider: new FakeAnalysisProvider({ latencyMs: 40 }),
      client,
      persistence,
      configuration,
      checkpoint: makeCheckpoint(0, 2),
      heartbeatIntervalMs: 5,
      batchTimeoutMs: 500,
    });
    expect(result.outcome.kind).toBe("aborted");
    expect(persistence.persist).not.toHaveBeenCalled();
  });

  it("clears lease timers when the provider returns a retryable failure", async () => {
    const { client, rpcCalls } = mockClient();
    const { persistence } = mockPersistence();
    const result = await runBatch({
      claimed,
      context: makeContext(2),
      provider: new FakeAnalysisProvider({
        failAtCallIndex: 0,
        failCode: "PROVIDER_UNAVAILABLE",
      }),
      client,
      persistence,
      configuration,
      checkpoint: makeCheckpoint(0, 2),
      heartbeatIntervalMs: 10,
      batchTimeoutMs: 100,
    });
    expect(result.outcome).toMatchObject({
      kind: "failed",
      code: "PROVIDER_UNAVAILABLE",
    });
    expect(persistence.persist).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(rpcCalls).toHaveLength(0);
  });

  it("aborts a slow batch with TIMEOUT and clears the lease heartbeat", async () => {
    const { client, rpcCalls } = mockClient();
    const { persistence } = mockPersistence();
    const result = await runBatch({
      claimed,
      context: makeContext(2),
      provider: new FakeAnalysisProvider({ latencyMs: 50 }),
      client,
      persistence,
      configuration,
      checkpoint: makeCheckpoint(0, 2),
      heartbeatIntervalMs: 5,
      batchTimeoutMs: 10,
    });
    expect(result.outcome).toMatchObject({ kind: "failed", code: "TIMEOUT" });
    expect(persistence.persist).not.toHaveBeenCalled();
    const callCount = rpcCalls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rpcCalls).toHaveLength(callCount);
  });

  it("keeps the last pair fingerprint stable", async () => {
    const context = makeContext(1);
    const { client } = mockClient();
    const { persistence, inputs } = mockPersistence();
    const result = await runBatch({
      claimed,
      context,
      provider: new FakeAnalysisProvider(),
      client,
      persistence,
      configuration,
      checkpoint: makeCheckpoint(0, 1),
    });
    expect(result.checkpoint.lastPairFingerprint).toBe(
      buildPairHashes([
        {
          sourceChunkId: context.pairs[0]!.source.chunkId,
          comparisonChunkId: context.pairs[0]!.comparison.chunkId,
        },
      ])[0],
    );
    expect(inputs[0]?.checkpoint.cursor).toEqual(context.pairCursors[0]);
  });
});
