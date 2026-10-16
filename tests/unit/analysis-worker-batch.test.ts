import { describe, expect, it, vi } from "vitest";

import { buildPairHashes } from "../../src/modules/analysis/retrieval";
import { runBatch } from "../../src/modules/analysis/worker/batch";
import { N } from "../../src/modules/analysis/worker/constants";
import type {
  AnalysisCandidatePair,
  AnalysisConfiguration,
} from "../../src/types/analysis-internal";
import type {
  AnalysisWorkerDb,
  ClaimedAnalysis,
  LoadedContext,
} from "../../src/modules/analysis/worker/types";
import { FakeAnalysisProvider } from "../fakes/analysis-provider.fake";

const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ANALYSIS_ID = "b0000000-0000-4000-8000-000000000001";

function makePair(index: number): AnalysisCandidatePair {
  const pad = index.toString(16).padStart(2, "0");
  return {
    source: {
      documentId: "20000000-0000-4000-8000-000000000001",
      versionId: "30000000-0000-4000-8000-000000000001",
      chunkId: `40000000-0000-4000-8000-0000000000${pad}`,
      role: "source",
      text: `synthetic source ${index}`,
    },
    comparison: {
      documentId: "20000000-0000-4000-8000-000000000002",
      versionId: "30000000-0000-4000-8000-000000000002",
      chunkId: `50000000-0000-4000-8000-0000000000${pad}`,
      role: "comparison",
      text: `synthetic comparison ${index}`,
    },
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
  operationId: "c0000000-0000-4000-8000-000000000001",
  attemptCount: 1,
  leaseExpiresAt: "2026-10-15T00:03:00.000Z",
  nextAttemptAt: null,
};

function makeContext(pairCount: number): LoadedContext {
  const pairs = Array.from({ length: pairCount }, (_, i) => makePair(i));
  return {
    analysisId: ANALYSIS_ID,
    workspaceId: WORKSPACE_ID,
    sourceVersionIds: ["30000000-0000-4000-8000-000000000001"],
    comparisonVersionIds: ["30000000-0000-4000-8000-000000000002"],
    pairs,
    fingerprint: "synthetic-fingerprint",
    chunkCount: pairCount * 2,
    candidatePairCount: pairCount,
  };
}

function mockClient(renewImpl?: () => Promise<unknown>) {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    rpcCalls.push({ name, args });
    if (renewImpl) return renewImpl();
    return {
      data: { lease_expires_at: "2026-10-15T00:03:00.000Z" },
      error: null,
    };
  });
  const client = { rpc } as unknown as AnalysisWorkerDb;
  return { client, rpcCalls };
}

describe("runBatch", () => {
  it("processes pairs sequentially in order", async () => {
    const provider = new FakeAnalysisProvider({ latencyMs: 5 });
    const context = makeContext(3);
    const { client } = mockClient();
    await runBatch({
      claimed,
      context,
      provider,
      client,
      configuration,
      startIndex: 0,
    });
    expect(provider.maxActive).toBe(1);
    expect(provider.calls.map((call) => call.pair)).toEqual(context.pairs);
  });

  it("calls analyzePair once per pair with the persisted configuration", async () => {
    const provider = new FakeAnalysisProvider();
    const context = makeContext(3);
    const { client } = mockClient();
    await runBatch({
      claimed,
      context,
      provider,
      client,
      configuration,
      startIndex: 0,
    });
    expect(provider.calls).toHaveLength(3);
    for (const call of provider.calls) {
      expect(call.configuration).toEqual(configuration);
    }
  });

  it("renews once per batch with the advanced checkpoint", async () => {
    const provider = new FakeAnalysisProvider();
    const context = makeContext(3);
    const { client, rpcCalls } = mockClient();
    const result = await runBatch({
      claimed,
      context,
      provider,
      client,
      configuration,
      startIndex: 0,
    });
    expect(result.outcome).toEqual({
      kind: "completed",
      processedPairs: 3,
      findings: [],
    });
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]?.name).toBe("renew_analysis_lease");
    expect(rpcCalls[0]?.args["p_analysis_id"]).toBe(ANALYSIS_ID);
    expect(rpcCalls[0]?.args["p_operation_id"]).toBe(claimed.operationId);
    const checkpoint = rpcCalls[0]?.args["p_checkpoint"] as {
      processedPairs: number;
      totalPairs: number;
    };
    expect(checkpoint.processedPairs).toBe(3);
    expect(checkpoint.totalPairs).toBe(3);
    expect(result.checkpoint.processedPairs).toBe(3);
  });

  it("aborts without complete or fail when renew throws", async () => {
    const provider = new FakeAnalysisProvider();
    const context = makeContext(3);
    const { client, rpcCalls } = mockClient(async () => {
      throw new Error("lease gone");
    });
    const result = await runBatch({
      claimed,
      context,
      provider,
      client,
      configuration,
      startIndex: 0,
    });
    expect(result.outcome.kind).toBe("aborted");
    expect(provider.calls).toHaveLength(3);
    expect(rpcCalls).toHaveLength(1);
  });

  it("resumes from a checkpoint instead of batch zero", async () => {
    const provider = new FakeAnalysisProvider();
    const context = makeContext(3);
    const { client, rpcCalls } = mockClient();
    const result = await runBatch({
      claimed,
      context,
      provider,
      client,
      configuration,
      startIndex: 2,
    });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.pair).toEqual(context.pairs[2]);
    expect(result.checkpoint.processedPairs).toBe(3);
    const expectedHash = buildPairHashes([
      {
        sourceChunkId: context.pairs[2]?.source.chunkId ?? "",
        comparisonChunkId: context.pairs[2]?.comparison.chunkId ?? "",
      },
    ])[0];
    expect(result.checkpoint.lastPairFingerprint).toBe(expectedHash);
    expect(rpcCalls).toHaveLength(1);
  });

  it("returns the provider code without swallowing a failed pair", async () => {
    const provider = new FakeAnalysisProvider({
      failAtCallIndex: 1,
      failCode: "PROVIDER_UNAVAILABLE",
    });
    const context = makeContext(3);
    const { client, rpcCalls } = mockClient();
    const result = await runBatch({
      claimed,
      context,
      provider,
      client,
      configuration,
      startIndex: 0,
    });
    expect(result.outcome).toEqual({
      kind: "failed",
      code: "PROVIDER_UNAVAILABLE",
      processedPairs: 1,
      findings: [],
    });
    expect(rpcCalls).toHaveLength(0);
  });

  it("never exceeds N pairs per batch", async () => {
    const provider = new FakeAnalysisProvider();
    const context = makeContext(N + 5);
    const { client } = mockClient();
    const result = await runBatch({
      claimed,
      context,
      provider,
      client,
      configuration,
      startIndex: 0,
    });
    expect(provider.calls).toHaveLength(N);
    expect(result.checkpoint.processedPairs).toBe(N);
  });
});
