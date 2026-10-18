import { describe, expect, it, vi } from "vitest";

import { computeRequestFingerprint } from "../../src/modules/analysis/retrieval";
import { runAnalysisJob } from "../../src/modules/analysis/worker/process-analysis";
import type { InternalFinding } from "../../src/types/analysis-internal";
import type { AnalysisWorkerDb } from "../../src/modules/analysis/worker/types";
import { createFinalization } from "../../src/modules/analysis/worker/finalization";
import { createProvider } from "../../src/modules/analysis/worker/provider";
import { FakeAnalysisBatchPersistence } from "../../supabase/functions/analyze/_test_doubles/analysis-batch-persistence.fake";
import { FakeAnalysisFinalization } from "../../supabase/functions/analyze/_test_doubles/analysis-finalization.fake";
import { FakeAnalysisProvider } from "../../supabase/functions/analyze/_test_doubles/analysis-provider.fake";

const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ANALYSIS_ID = "b0000000-0000-4000-8000-000000000001";
const OPERATION_ID = "c0000000-0000-4000-8000-000000000001";
const SOURCE_VERSION = "30000000-0000-4000-8000-000000000001";
const COMPARISON_VERSION = "30000000-0000-4000-8000-000000000002";

function pairRow(index: number) {
  const pad = index.toString(16).padStart(2, "0");
  const sourceChunkId = `40000000-0000-4000-8000-0000000000${pad}`;
  const comparisonChunkId = `50000000-0000-4000-8000-0000000000${pad}`;
  return {
    source_chunk_id: sourceChunkId,
    source_version_id: SOURCE_VERSION,
    source_document_id: "20000000-0000-4000-8000-000000000001",
    source_text: `synthetic source ${index}`,
    comparison_chunk_id: comparisonChunkId,
    comparison_version_id: COMPARISON_VERSION,
    comparison_document_id: "20000000-0000-4000-8000-000000000002",
    comparison_text: `synthetic comparison ${index}`,
    similarity: 0.9,
    pair_low_id: sourceChunkId,
    pair_high_id: comparisonChunkId,
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

function analysisRow(pairCount: number, checkpoint: unknown = null) {
  return {
    id: ANALYSIS_ID,
    workspace_id: WORKSPACE_ID,
    request_fingerprint: expectedFingerprint(pairCount),
    fixed_cost: 3,
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
    checkpoint,
  };
}

function claimedRow(id = ANALYSIS_ID) {
  return {
    id,
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
  checkpoint?: unknown;
  checkpointError?: boolean;
}) {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const pairs = Array.from({ length: options.pairCount }, (_, i) => pairRow(i));
  let singleCalls = 0;
  const single = vi.fn(async () => {
    singleCalls += 1;
    if (options.checkpointError && singleCalls === 1) {
      return { data: null, error: { code: "08006", message: "connection unavailable" } };
    }
    return {
      data: analysisRow(options.pairCount, options.checkpoint ?? null),
      error: null,
    };
  });
  const eq = vi.fn(() => ({ single }));
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
    if (name === "read_analysis_retrieval_summary") {
      return {
        data: [{
          chunk_count: options.pairCount * 2,
          candidate_pair_count: options.pairCount,
          chunks_revision: "synthetic-rev",
          request_fingerprint: expectedFingerprint(options.pairCount),
          fixed_cost: 3,
        }],
        error: null,
      };
    }
    if (name === "read_analysis_pair_batch") {
      const afterLow = args["p_after_low"];
      const afterHigh = args["p_after_high"];
      const afterIndex =
        typeof afterLow === "string" && typeof afterHigh === "string"
          ? pairs.findIndex(
              (pair) =>
                pair.pair_low_id === afterLow &&
                pair.pair_high_id === afterHigh,
            )
          : -1;
      const after = afterIndex + 1;
      return {
        data: pairs.slice(after, after + Number(args["p_limit"])),
        error: null,
      };
    }
    if (name === "yield_analysis_batch") {
      return { data: true, error: null };
    }
    if (name === "renew_analysis_lease" && options.renewImpl) {
      return options.renewImpl();
    }
    if (name === "renew_analysis_lease") {
      return {
        data: [{ lease_expires_at: "2026-10-15T00:03:00.000Z" }],
        error: null,
      };
    }
    throw new Error(`unexpected rpc ${name}`);
  });
  const client = { from, rpc } as unknown as AnalysisWorkerDb;
  return { client, rpcCalls };
}

async function runJob(
  client: AnalysisWorkerDb,
  provider: FakeAnalysisProvider | { analyzePair: () => Promise<never> },
  finalization: FakeAnalysisFinalization,
  analysisId: string | null = ANALYSIS_ID,
) {
  return runAnalysisJob({
    client,
    provider: provider as never,
    finalization,
    persistence: new FakeAnalysisBatchPersistence(client),
    analysisId,
  });
}

const SYNTHETIC_FINDING: InternalFinding = {
  type: "contradiction",
  severity: "High",
  confidence: 0.9,
  explanation: "synthetic contradiction",
  evidence: [],
};

describe("runAnalysisJob", () => {
  it("claims, loads bounded data, batches and finalizes completed findings", async () => {
    const provider = new FakeAnalysisProvider({ findings: [{ ...SYNTHETIC_FINDING }] });
    const finalization = new FakeAnalysisFinalization();
    const { client, rpcCalls } = mockClient({ pairCount: 2 });
    const result = await runJob(client, provider, finalization);
    expect(result).toEqual({ kind: "completed", claimedId: ANALYSIS_ID });
    expect(rpcCalls.find((call) => call.name === "claim_analysis")?.args).toEqual({
      p_analysis_id: ANALYSIS_ID,
    });
    expect(rpcCalls.some((call) => call.name === "retrieve_candidate_pairs")).toBe(false);
    expect(provider.calls).toHaveLength(2);
    expect(finalization.calls[0]?.outcome).toEqual({
      kind: "completed",
      findings: [{ ...SYNTHETIC_FINDING }, { ...SYNTHETIC_FINDING }],
    });
  });

  it("finalizes a coded provider failure", async () => {
    const provider = new FakeAnalysisProvider({
      failAtCallIndex: 0,
      failCode: "PROVIDER_UNAVAILABLE",
    });
    const finalization = new FakeAnalysisFinalization();
    const { client } = mockClient({ pairCount: 2 });
    const result = await runJob(client, provider, finalization);
    expect(result).toEqual({
      kind: "failed",
      code: "PROVIDER_UNAVAILABLE",
      claimedId: ANALYSIS_ID,
    });
    expect(finalization.calls[0]?.outcome).toEqual({
      kind: "failed",
      code: "PROVIDER_UNAVAILABLE",
    });
  });

  it("does not finalize when persistence loses its compare-and-set", async () => {
    const provider = new FakeAnalysisProvider();
    const finalization = new FakeAnalysisFinalization();
    const { client } = mockClient({
      pairCount: 2,
      renewImpl: async () => ({ data: null, error: { code: "22023", message: "lease gone" } }),
    });
    const result = await runJob(client, provider, finalization);
    expect(result).toEqual({ kind: "aborted", claimedId: ANALYSIS_ID });
    expect(finalization.calls).toHaveLength(0);
  });

  it("persists nothing on an uncoded provider crash", async () => {
    const provider = { analyzePair: async () => { throw new Error("boom"); } };
    const finalization = new FakeAnalysisFinalization();
    const { client } = mockClient({ pairCount: 2 });
    const result = await runJob(client, provider, finalization);
    expect(result).toEqual({ kind: "aborted", claimedId: ANALYSIS_ID });
    expect(finalization.calls).toHaveLength(0);
  });

  it("swallows a superseded finalization without retrying", async () => {
    const finalization = new FakeAnalysisFinalization({ okResult: false });
    const { client } = mockClient({ pairCount: 1 });
    const result = await runJob(client, new FakeAnalysisProvider(), finalization);
    expect(result).toEqual({ kind: "completed", claimedId: ANALYSIS_ID });
    expect(finalization.calls).toHaveLength(1);
  });

  it("keeps missing production provider/finalization factories fail-loud", () => {
    expect(() => createProvider()).toThrow("S2-07 not merged: AIProvider unavailable.");
    expect(() => createFinalization()).toThrow(
      "S2-08 not merged: AnalysisFinalization unavailable.",
    );
  });

  it("returns quietly when no job is claimed and supports a sweep", async () => {
    const provider = new FakeAnalysisProvider();
    const finalization = new FakeAnalysisFinalization();
    const { client, rpcCalls } = mockClient({ pairCount: 0, claimRows: [] });
    const result = await runJob(client, provider, finalization, null);
    expect(result).toEqual({ kind: "idle" });
    expect(rpcCalls.find((call) => call.name === "claim_analysis")?.args).toEqual({
      p_analysis_id: null,
    });
    expect(provider.calls).toHaveLength(0);
    expect(finalization.calls).toHaveLength(0);
  });

  it("completes an empty analysis without calling the provider", async () => {
    const provider = new FakeAnalysisProvider();
    const finalization = new FakeAnalysisFinalization();
    const { client } = mockClient({ pairCount: 0 });
    const result = await runJob(client, provider, finalization);
    expect(result).toEqual({ kind: "completed", claimedId: ANALYSIS_ID });
    expect(provider.calls).toHaveLength(0);
    expect(finalization.calls[0]?.outcome).toEqual({ kind: "completed", findings: [] });
  });

  it("operates on the job returned by the FIFO sweep", async () => {
    const sweptId = "c1111111-0000-4000-8000-000000000002";
    const provider = new FakeAnalysisProvider();
    const finalization = new FakeAnalysisFinalization();
    const { client } = mockClient({
      pairCount: 1,
      claimRows: [claimedRow(sweptId)],
    });
    const result = await runJob(client, provider, finalization, null);
    expect(result).toEqual({ kind: "completed", claimedId: sweptId });
    expect(finalization.calls[0]?.analysisId).toBe(sweptId);
  });

  it("builds provider configuration from persisted analysis data", async () => {
    const provider = new FakeAnalysisProvider();
    const finalization = new FakeAnalysisFinalization();
    const { client } = mockClient({ pairCount: 1 });
    await runJob(client, provider, finalization);
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

  it("processes at most ten pairs and yields the next keyset cursor", async () => {
    const provider = new FakeAnalysisProvider();
    const finalization = new FakeAnalysisFinalization();
    const { client, rpcCalls } = mockClient({ pairCount: 15 });
    const result = await runJob(client, provider, finalization);
    expect(result).toEqual({ kind: "has-more", claimedId: ANALYSIS_ID });
    expect(provider.calls).toHaveLength(10);
    expect(finalization.calls).toHaveLength(0);
    const yielded = rpcCalls.find((call) => call.name === "yield_analysis_batch");
    expect(yielded?.args["p_expected_processed_pairs"]).toBe(0);
    expect(yielded?.args["p_checkpoint"]).toMatchObject({
      processedPairs: 10,
      totalPairs: 15,
      cursor: {
        lowChunkId: pairRow(9).pair_low_id,
        highChunkId: pairRow(9).pair_high_id,
      },
    });
  });

  it("resumes from a persisted cursor and does not revisit earlier pairs", async () => {
    const checkpoint = {
      processedPairs: 10,
      totalPairs: 15,
      findingsCount: 0,
      lastPairFingerprint: "synthetic-hash",
      startedAt: "2026-10-15T00:00:00.000Z",
      cursor: {
        lowChunkId: pairRow(9).pair_low_id,
        highChunkId: pairRow(9).pair_high_id,
      },
    };
    const provider = new FakeAnalysisProvider();
    const finalization = new FakeAnalysisFinalization();
    const { client, rpcCalls } = mockClient({ pairCount: 15, checkpoint });
    const result = await runJob(client, provider, finalization);
    expect(result).toEqual({ kind: "completed", claimedId: ANALYSIS_ID });
    expect(provider.calls).toHaveLength(5);
    expect(provider.calls[0]?.pair.source.chunkId).toBe(pairRow(10).source_chunk_id);
    expect(finalization.calls).toHaveLength(1);
    expect(
      rpcCalls.find((call) => call.name === "read_analysis_pair_batch")?.args,
    ).toMatchObject({ p_after_low: checkpoint.cursor.lowChunkId, p_after_high: checkpoint.cursor.highChunkId });
  });

  it("finalizes from persisted EOF without replaying all candidate pairs", async () => {
    const last = pairRow(14);
    const checkpoint = {
      processedPairs: 15,
      totalPairs: 15,
      findingsCount: 2,
      lastPairFingerprint: "synthetic-hash",
      startedAt: "2026-10-15T00:00:00.000Z",
      cursor: { lowChunkId: last.pair_low_id, highChunkId: last.pair_high_id },
    };
    const provider = new FakeAnalysisProvider();
    const finalization = new FakeAnalysisFinalization();
    const { client } = mockClient({ pairCount: 15, checkpoint });
    const result = await runJob(client, provider, finalization);
    expect(result).toEqual({ kind: "completed", claimedId: ANALYSIS_ID });
    expect(provider.calls).toHaveLength(0);
    expect(finalization.calls).toHaveLength(1);
  });

  it("restarts a historical checkpoint with no keyset cursor from zero", async () => {
    const checkpoint = {
      processedPairs: 10,
      totalPairs: 15,
      findingsCount: 0,
      lastPairFingerprint: "legacy-hash",
      startedAt: "2026-10-15T00:00:00.000Z",
    };
    const provider = new FakeAnalysisProvider();
    const finalization = new FakeAnalysisFinalization();
    const { client } = mockClient({ pairCount: 15, checkpoint });
    const result = await runJob(client, provider, finalization);
    expect(result).toEqual({ kind: "has-more", claimedId: ANALYSIS_ID });
    expect(provider.calls).toHaveLength(10);
    expect(provider.calls[0]?.pair.source.chunkId).toBe(pairRow(0).source_chunk_id);
  });

  it("aborts when the persisted checkpoint cannot be read", async () => {
    const provider = new FakeAnalysisProvider();
    const finalization = new FakeAnalysisFinalization();
    const { client } = mockClient({ pairCount: 1, checkpointError: true });
    const result = await runJob(client, provider, finalization);

    expect(result).toEqual({ kind: "aborted", claimedId: ANALYSIS_ID });
    expect(provider.calls).toHaveLength(0);
    expect(finalization.calls).toHaveLength(0);
  });
});
