import { describe, expect, it, vi } from "vitest";

import { loadAnalysisContext } from "../../src/modules/analysis/worker/context";
import type { AnalysisPairCursor } from "../../src/types/analysis-internal";
import type { AnalysisWorkerDb } from "../../src/modules/analysis/worker/types";
import { AnalysisWorkerError } from "../../src/modules/analysis/worker/types";

const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ANALYSIS_ID = "b0000000-0000-4000-8000-000000000001";
const OPERATION_ID = "c0000000-0000-4000-8000-000000000001";
const SOURCE_VERSION = "30000000-0000-4000-8000-000000000001";
const COMPARISON_VERSION = "30000000-0000-4000-8000-000000000002";
const SOURCE_DOCUMENT = "20000000-0000-4000-8000-000000000001";
const COMPARISON_DOCUMENT = "20000000-0000-4000-8000-000000000002";
const SOURCE_CHUNK = "40000000-0000-4000-8000-000000000001";
const COMPARISON_CHUNK = "50000000-0000-4000-8000-000000000001";
const CURSOR: AnalysisPairCursor = {
  lowChunkId: SOURCE_CHUNK,
  highChunkId: COMPARISON_CHUNK,
};

function analysisRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ANALYSIS_ID,
    workspace_id: WORKSPACE_ID,
    request_fingerprint: "persisted-fingerprint",
    fixed_cost: 3,
    retrieval_config: {
      chunksRevision: "persisted-revision",
      fingerprint: "persisted-fingerprint",
    },
    ...overrides,
  };
}

function pairRow(index: number) {
  const sourceChunkId = `40000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
  const comparisonChunkId = `50000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
  return {
    source_chunk_id: sourceChunkId,
    source_version_id: SOURCE_VERSION,
    source_document_id: SOURCE_DOCUMENT,
    source_text: `source ${index}`,
    comparison_chunk_id: comparisonChunkId,
    comparison_version_id: COMPARISON_VERSION,
    comparison_document_id: COMPARISON_DOCUMENT,
    comparison_text: `comparison ${index}`,
    similarity: 0.9,
    pair_low_id: sourceChunkId,
    pair_high_id: comparisonChunkId,
  };
}

function mockDb(options: {
  analysis?: Record<string, unknown>;
  summary?: unknown;
  page?: unknown;
  rpcImpl?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
} = {}) {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const fromCalls: string[] = [];
  const single = vi.fn(async () => ({
    data: options.analysis ?? analysisRow(),
    error: null,
  }));
  const eq = vi.fn(() => ({ single }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn((table: string) => {
    fromCalls.push(table);
    return { select };
  });
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    rpcCalls.push({ name, args });
    if (options.rpcImpl) return options.rpcImpl(name, args);
    if (name === "read_analysis_retrieval_summary") {
      return {
        data: options.summary ?? [{
          chunk_count: 2,
          candidate_pair_count: 1,
          chunks_revision: "persisted-revision",
          request_fingerprint: "persisted-fingerprint",
          fixed_cost: 3,
        }],
        error: null,
      };
    }
    if (name === "read_analysis_pair_batch") {
      return { data: options.page ?? [pairRow(1)], error: null };
    }
    throw new Error(`unexpected rpc ${name}`);
  });
  return {
    client: { from, rpc } as unknown as AnalysisWorkerDb,
    fromCalls,
    rpcCalls,
  };
}

describe("loadAnalysisContext", () => {
  it("loads only a bounded keyset page and validates the persisted summary", async () => {
    const { client, fromCalls, rpcCalls } = mockDb();
    const context = await loadAnalysisContext(
      ANALYSIS_ID,
      OPERATION_ID,
      null,
      0,
      client,
    );

    expect(context.pairs).toHaveLength(1);
    expect(context.pairCursors).toEqual([
      { lowChunkId: pairRow(1).pair_low_id, highChunkId: pairRow(1).pair_high_id },
    ]);
    expect(context.cursor).toBeNull();
    expect(context.candidatePairCount).toBe(1);
    expect(context.chunkCount).toBe(2);
    expect(context.fingerprint).toBe("persisted-fingerprint");
    expect(fromCalls).toEqual(["analyses"]);
    expect(rpcCalls).toEqual([
      {
        name: "read_analysis_retrieval_summary",
        args: {
          p_analysis_id: ANALYSIS_ID,
          p_operation_id: OPERATION_ID,
        },
      },
      {
        name: "read_analysis_pair_batch",
        args: {
          p_analysis_id: ANALYSIS_ID,
          p_operation_id: OPERATION_ID,
          p_after_low: null,
          p_after_high: null,
          p_limit: 10,
        },
      },
    ]);
    expect(rpcCalls.some((call) => call.name === "retrieve_candidate_pairs")).toBe(false);
  });

  it("keeps a 1,000+ pair snapshot bounded to one ten-pair text page", async () => {
    const { client, rpcCalls } = mockDb({
      analysis: analysisRow({ fixed_cost: 302 }),
      summary: [{
        chunk_count: 2_002,
        candidate_pair_count: 1_001,
        chunks_revision: "persisted-revision",
        request_fingerprint: "persisted-fingerprint",
        fixed_cost: 302,
      }],
      page: Array.from({ length: 10 }, (_, index) => pairRow(index + 1)),
    });

    const context = await loadAnalysisContext(
      ANALYSIS_ID,
      OPERATION_ID,
      null,
      0,
      client,
    );

    expect(context.candidatePairCount).toBe(1_001);
    expect(context.pairs).toHaveLength(10);
    expect(context.pairs.map((pair) => pair.source.text)).toEqual(
      Array.from({ length: 10 }, (_, index) => "source " + (index + 1)),
    );
    expect(rpcCalls[1]?.args["p_limit"]).toBe(10);
    expect(rpcCalls.some((call) => call.name === "retrieve_candidate_pairs")).toBe(false);
  });

  it("passes the persisted cursor to the next SQL page", async () => {
    const { client, rpcCalls } = mockDb({ page: [] });
    await loadAnalysisContext(ANALYSIS_ID, OPERATION_ID, CURSOR, 1, client);
    expect(rpcCalls[1]?.args).toMatchObject({
      p_after_low: CURSOR.lowChunkId,
      p_after_high: CURSOR.highChunkId,
      p_limit: 10,
    });
  });

  it.each([
    ["request_fingerprint", "other-fingerprint"],
    ["chunks_revision", "other-revision"],
    ["fixed_cost", 99],
  ])("rejects a stale summary when %s differs", async (field, value) => {
    const summary = [{
      chunk_count: 2,
      candidate_pair_count: 1,
      chunks_revision: "persisted-revision",
      request_fingerprint: "persisted-fingerprint",
      fixed_cost: 3,
      [field]: value,
    }];
    const { client } = mockDb({ summary });
    const error = await loadAnalysisContext(
      ANALYSIS_ID,
      OPERATION_ID,
      null,
      0,
      client,
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AnalysisWorkerError);
    expect((error as AnalysisWorkerError).code).toBe("ESTIMATE_STALE");
  });

  it("rejects a page larger than the hard worker batch cap", async () => {
    const { client } = mockDb({ page: Array.from({ length: 11 }, (_, i) => pairRow(i + 1)) });
    const error = await loadAnalysisContext(
      ANALYSIS_ID,
      OPERATION_ID,
      null,
      0,
      client,
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AnalysisWorkerError);
    expect((error as AnalysisWorkerError).code).toBe("RETRIEVAL_FAILED");
  });

  it("maps a retrieval timeout to RETRIEVAL_FAILED", async () => {
    const { client } = mockDb({
      rpcImpl: () => new Promise(() => {}),
    });
    const error = await loadAnalysisContext(
      ANALYSIS_ID,
      OPERATION_ID,
      null,
      0,
      client,
      { retrievalTimeoutMs: 20 },
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AnalysisWorkerError);
    expect((error as AnalysisWorkerError).code).toBe("RETRIEVAL_FAILED");
  });
});
