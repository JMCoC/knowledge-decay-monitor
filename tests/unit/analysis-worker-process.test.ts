import { describe, expect, it, vi } from "vitest";

import { computeRequestFingerprint } from "../../src/modules/analysis/retrieval";
import type { InternalFinding } from "../../src/types/analysis-internal";
import type { AnalysisWorkerDb } from "../../src/modules/analysis/worker/types";
import { createFinalization } from "../../src/modules/analysis/worker/finalization";
import { createProvider } from "../../src/modules/analysis/worker/provider";
import { FakeAnalysisFinalization } from "../fakes/analysis-finalization.fake";
import { FakeAnalysisProvider } from "../fakes/analysis-provider.fake";

const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ANALYSIS_ID = "b0000000-0000-4000-8000-000000000001";
const OPERATION_ID = "c0000000-0000-4000-8000-000000000001";
const SOURCE_VERSION = "30000000-0000-4000-8000-000000000001";
const COMPARISON_VERSION = "30000000-0000-4000-8000-000000000002";

function pairRow(index: number) {
  const pad = index.toString(16).padStart(2, "0");
  return {
    source_chunk_id: `40000000-0000-4000-8000-0000000000${pad}`,
    source_version_id: SOURCE_VERSION,
    source_document_id: "20000000-0000-4000-8000-000000000001",
    source_text: `synthetic source ${index}`,
    comparison_chunk_id: `50000000-0000-4000-8000-0000000000${pad}`,
    comparison_version_id: COMPARISON_VERSION,
    comparison_document_id: "20000000-0000-4000-8000-000000000002",
    comparison_text: `synthetic comparison ${index}`,
    similarity: 0.9,
  };
}

function expectedFingerprint(pairCount: number) {
  const pairs = Array.from({ length: pairCount }, (_, i) => pairRow(i));
  const chunkIds = new Set<string>();
  for (const pair of pairs) {
    chunkIds.add(pair.source_chunk_id);
    chunkIds.add(pair.comparison_chunk_id);
  }
  return computeRequestFingerprint({
    chunkCount: chunkIds.size,
    candidatePairCount: pairs.length,
    sortedSourceVersionIds: [SOURCE_VERSION],
    sortedComparisonVersionIds: [COMPARISON_VERSION],
    pairs: pairs.map((pair) => ({
      sourceChunkId: pair.source_chunk_id,
      comparisonChunkId: pair.comparison_chunk_id,
    })),
    chunkIds: [...chunkIds],
  });
}

function analysisRow(pairCount: number) {
  return {
    id: ANALYSIS_ID,
    workspace_id: WORKSPACE_ID,
    request_fingerprint: expectedFingerprint(pairCount),
    retrieval_config: {
      topK: 5,
      similarityThreshold: 0.75,
      chunksRevision: "synthetic-rev",
      embeddingRevision: "gte-small-384-v1",
      fingerprint: expectedFingerprint(pairCount),
    },
    pricing_version: "s2-04-v1",
    prompt_version: "none",
    output_schema_version: "none",
    provider_config: {
      primary: { provider: "cerebras", model: "synthetic-primary" },
      fallback: { provider: "groq", model: "synthetic-fallback" },
    },
    checkpoint: null,
  };
}

function scopeRows() {
  return [
    {
      document_id: "20000000-0000-4000-8000-000000000001",
      version_id: SOURCE_VERSION,
      role: "source",
    },
    {
      document_id: "20000000-0000-4000-8000-000000000002",
      version_id: COMPARISON_VERSION,
      role: "comparison",
    },
  ];
}

function claimedRow() {
  return {
    id: ANALYSIS_ID,
    workspace_id: WORKSPACE_ID,
    initiator_id: "10000000-0000-4000-8000-000000000001",
    operation_id: OPERATION_ID,
    attempt_count: 1,
    lease_expires_at: "2026-10-15T00:03:00.000Z",
    next_attempt_at: null,
  };
}

function mockClient(options: {
  pairCount: number;
  claimRows?: unknown[];
  renewImpl?: () => Promise<unknown>;
}) {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const pairs = Array.from({ length: options.pairCount }, (_, i) =>
    pairRow(i),
  );
  const single = vi.fn(async () => ({
    data: analysisRow(options.pairCount),
    error: null,
  }));
  const eq = vi.fn(() => ({
    single,
    then: (onFulfilled: (value: unknown) => unknown) =>
      Promise.resolve({ data: scopeRows(), error: null }).then(onFulfilled),
  }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    rpcCalls.push({ name, args });
    if (name === "claim_analysis") {
      return {
        data: options.claimRows ?? [claimedRow()],
        error: null,
      };
    }
    if (name === "retrieve_candidate_pairs") {
      return { data: pairs, error: null };
    }
    if (name === "renew_analysis_lease" && options.renewImpl) {
      return options.renewImpl();
    }
    if (name === "renew_analysis_lease") {
      return {
        data: { lease_expires_at: "2026-10-15T00:03:00.000Z" },
        error: null,
      };
    }
    throw new Error(`unexpected rpc ${name}`);
  });
  const client = { from, rpc } as unknown as AnalysisWorkerDb;
  return { client, rpcCalls };
}

const SYNTHETIC_FINDING: InternalFinding = {
  type: "contradiction",
  severity: "High",
  confidence: 0.9,
  explanation: "synthetic contradiction",
  evidence: [],
};

describe("runAnalysisJob", () => {
  it("claims, loads, batches and finalizes completed findings", async () => {
    const provider = new FakeAnalysisProvider({
      findings: [{ ...SYNTHETIC_FINDING }],
    });
    const finalization = new FakeAnalysisFinalization();
    const { client, rpcCalls } = mockClient({ pairCount: 2 });
    const { runAnalysisJob } = await import(
      "../../src/modules/analysis/worker/process-analysis"
    );
    await runAnalysisJob({
      client,
      provider,
      finalization,
      analysisId: ANALYSIS_ID,
    });
    expect(
      rpcCalls.find((call) => call.name === "claim_analysis")?.args,
    ).toEqual({ p_analysis_id: ANALYSIS_ID });
    expect(provider.calls).toHaveLength(2);
    expect(finalization.calls).toHaveLength(1);
    expect(finalization.calls[0]).toEqual({
      analysisId: ANALYSIS_ID,
      operationId: OPERATION_ID,
      outcome: {
        kind: "completed",
        findings: [{ ...SYNTHETIC_FINDING }, { ...SYNTHETIC_FINDING }],
      },
    });
  });

  it("finalizes failed when the provider fails", async () => {
    const provider = new FakeAnalysisProvider({
      failAtCallIndex: 0,
      failCode: "PROVIDER_UNAVAILABLE",
    });
    const finalization = new FakeAnalysisFinalization();
    const { client } = mockClient({ pairCount: 2 });
    const { runAnalysisJob } = await import(
      "../../src/modules/analysis/worker/process-analysis"
    );
    await runAnalysisJob({
      client,
      provider,
      finalization,
      analysisId: ANALYSIS_ID,
    });
    expect(finalization.calls).toHaveLength(1);
    expect(finalization.calls[0]?.outcome).toEqual({
      kind: "failed",
      code: "PROVIDER_UNAVAILABLE",
    });
  });

  it("does not finalize when renew fails", async () => {
    const provider = new FakeAnalysisProvider();
    const finalization = new FakeAnalysisFinalization();
    const { client } = mockClient({
      pairCount: 2,
      renewImpl: async () => {
        throw new Error("lease gone");
      },
    });
    const { runAnalysisJob } = await import(
      "../../src/modules/analysis/worker/process-analysis"
    );
    await runAnalysisJob({
      client,
      provider,
      finalization,
      analysisId: ANALYSIS_ID,
    });
    expect(finalization.calls).toHaveLength(0);
  });

  it("persists nothing on an uncoded crash", async () => {
    const provider = {
      analyzePair: async () => {
        throw new Error("boom");
      },
    };
    const finalization = new FakeAnalysisFinalization();
    const { client } = mockClient({ pairCount: 2 });
    const { runAnalysisJob } = await import(
      "../../src/modules/analysis/worker/process-analysis"
    );
    await runAnalysisJob({
      client,
      provider: provider as never,
      finalization,
      analysisId: ANALYSIS_ID,
    });
    expect(finalization.calls).toHaveLength(0);
  });

  it("swallows a superseded finalization without retrying", async () => {
    const provider = new FakeAnalysisProvider();
    const finalization = new FakeAnalysisFinalization({ okResult: false });
    const { client } = mockClient({ pairCount: 1 });
    const { runAnalysisJob } = await import(
      "../../src/modules/analysis/worker/process-analysis"
    );
    await expect(
      runAnalysisJob({
        client,
        provider,
        finalization,
        analysisId: ANALYSIS_ID,
      }),
    ).resolves.toBeUndefined();
    expect(finalization.calls).toHaveLength(1);
  });

  it("uses only explicitly injected dependencies", () => {
    expect(() => createProvider()).toThrow(
      "S2-07 not merged: AIProvider unavailable.",
    );
    expect(() => createFinalization()).toThrow(
      "S2-08 not merged: AnalysisFinalization unavailable.",
    );
  });

  it("returns quietly when no job is claimed", async () => {
    const provider = new FakeAnalysisProvider();
    const finalization = new FakeAnalysisFinalization();
    const { client } = mockClient({ pairCount: 0, claimRows: [] });
    const { runAnalysisJob } = await import(
      "../../src/modules/analysis/worker/process-analysis"
    );
    await runAnalysisJob({
      client,
      provider,
      finalization,
      analysisId: ANALYSIS_ID,
    });
    expect(provider.calls).toHaveLength(0);
    expect(finalization.calls).toHaveLength(0);
  });

  it("operates on the claimed job when the sweep returns another id", async () => {
    const SWEPT_ID = "c1111111-0000-4000-8000-000000000002";
    const provider = new FakeAnalysisProvider();
    const finalization = new FakeAnalysisFinalization();
    const { client, rpcCalls } = mockClient({
      pairCount: 1,
      claimRows: [{ ...claimedRow(), id: SWEPT_ID }],
    });
    const { runAnalysisJob } = await import(
      "../../src/modules/analysis/worker/process-analysis"
    );
    await runAnalysisJob({
      client,
      provider,
      finalization,
      analysisId: ANALYSIS_ID,
    });
    expect(
      rpcCalls.find((call) => call.name === "claim_analysis")?.args,
    ).toEqual({ p_analysis_id: ANALYSIS_ID });
    expect(provider.calls).toHaveLength(1);
    expect(finalization.calls).toHaveLength(1);
    expect(finalization.calls[0]?.analysisId).toBe(SWEPT_ID);
    expect(finalization.calls[0]?.operationId).toBe(
      claimedRow().operation_id,
    );
  });

  it("builds the provider configuration from persisted state", async () => {
    const provider = new FakeAnalysisProvider();
    const finalization = new FakeAnalysisFinalization();
    const { client } = mockClient({ pairCount: 1 });
    const { runAnalysisJob } = await import(
      "../../src/modules/analysis/worker/process-analysis"
    );
    await runAnalysisJob({
      client,
      provider,
      finalization,
      analysisId: ANALYSIS_ID,
    });
    expect(provider.calls[0]?.configuration).toEqual({
      retrieval: {
        topK: 5,
        similarityThreshold: 0.75,
        chunksRevision: "synthetic-rev",
        embeddingRevision: "gte-small-384-v1",
        fingerprint: expectedFingerprint(1),
      },
      pricingVersion: "s2-04-v1",
      promptVersion: "none",
      outputSchemaVersion: "none",
      providers: {
        primary: { provider: "cerebras", model: "synthetic-primary" },
        fallback: { provider: "groq", model: "synthetic-fallback" },
      },
    });
  });
});
