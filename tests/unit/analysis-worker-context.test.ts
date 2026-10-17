import { describe, expect, it, vi } from "vitest";

import { computeRequestFingerprint } from "../../src/modules/analysis/retrieval";
import { loadAnalysisContext } from "../../src/modules/analysis/worker/context";
import type { AnalysisWorkerDb } from "../../src/modules/analysis/worker/types";
import { AnalysisWorkerError } from "../../src/modules/analysis/worker/types";

const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ANALYSIS_ID = "b0000000-0000-4000-8000-000000000001";
const SOURCE_VERSION = "30000000-0000-4000-8000-000000000001";
const COMPARISON_VERSION = "30000000-0000-4000-8000-000000000002";
const SOURCE_DOCUMENT = "20000000-0000-4000-8000-000000000001";
const COMPARISON_DOCUMENT = "20000000-0000-4000-8000-000000000002";
const SOURCE_CHUNK = "40000000-0000-4000-8000-000000000001";
const COMPARISON_CHUNK = "40000000-0000-4000-8000-000000000002";

interface ScopeRow {
  document_id: string;
  version_id: string;
  role: string;
}

interface PairRow {
  source_chunk_id: string;
  source_version_id: string;
  source_document_id: string;
  source_text: string;
  comparison_chunk_id: string;
  comparison_version_id: string;
  comparison_document_id: string;
  comparison_text: string;
  similarity: number;
}

function scopeRows(): ScopeRow[] {
  return [
    {
      document_id: SOURCE_DOCUMENT,
      version_id: SOURCE_VERSION,
      role: "source",
    },
    {
      document_id: COMPARISON_DOCUMENT,
      version_id: COMPARISON_VERSION,
      role: "comparison",
    },
  ];
}

function pairRows(): PairRow[] {
  return [
    {
      source_chunk_id: SOURCE_CHUNK,
      source_version_id: SOURCE_VERSION,
      source_document_id: SOURCE_DOCUMENT,
      source_text: "synthetic source text",
      comparison_chunk_id: COMPARISON_CHUNK,
      comparison_version_id: COMPARISON_VERSION,
      comparison_document_id: COMPARISON_DOCUMENT,
      comparison_text: "synthetic comparison text",
      similarity: 0.9,
    },
  ];
}

function analysisRow(fingerprint: string) {
  return {
    id: ANALYSIS_ID,
    workspace_id: WORKSPACE_ID,
    request_fingerprint: fingerprint,
    retrieval_config: {
      topK: 5,
      similarityThreshold: 0.75,
      chunksRevision: "synthetic-rev",
      embeddingRevision: "gte-small-384-v1",
      fingerprint,
    },
    pricing_version: "s2-04-v1",
    prompt_version: "none",
    output_schema_version: "none",
  };
}

function expectedFingerprint() {
  return computeRequestFingerprint({
    chunkCount: 2,
    candidatePairCount: 1,
    sortedSourceVersionIds: [SOURCE_VERSION],
    sortedComparisonVersionIds: [COMPARISON_VERSION],
    pairs: [
      { sourceChunkId: SOURCE_CHUNK, comparisonChunkId: COMPARISON_CHUNK },
    ],
    chunkIds: [COMPARISON_CHUNK, SOURCE_CHUNK],
  });
}

function mockDb(options: {
  analysis: Record<string, unknown> | null;
  scope: ScopeRow[];
  pairs: PairRow[];
  rpcImpl?: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: unknown }>;
}) {
  const fromCalls: string[] = [];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const single = vi.fn(async () =>
    options.analysis === null
      ? { data: null, error: { message: "not found" } }
      : { data: options.analysis, error: null },
  );
  const eq = vi.fn((column: string, value: unknown) => {
    void column;
    void value;
    return {
      single,
      then: (
        onFulfilled: (value: {
          data: ScopeRow[];
          error: null;
        }) => unknown,
      ) => Promise.resolve({ data: options.scope, error: null }).then(onFulfilled),
    };
  });
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn((table: string) => {
    fromCalls.push(table);
    return { select };
  });
  const rpc = vi.fn(
    async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (options.rpcImpl) return options.rpcImpl(name, args);
      if (name === "retrieve_candidate_pairs")
        return { data: options.pairs, error: null };
      throw new Error(`unexpected rpc ${name}`);
    },
  );
  const db = { from, rpc } as unknown as AnalysisWorkerDb;
  return { db, fromCalls, rpcCalls };
}

describe("loadAnalysisContext", () => {
  it("splits scope by role and calls retrieval with frozen params", async () => {
    const fingerprint = expectedFingerprint();
    const { db, rpcCalls } = mockDb({
      analysis: analysisRow(fingerprint),
      scope: scopeRows(),
      pairs: pairRows(),
    });
    const context = await loadAnalysisContext(ANALYSIS_ID, db);
    expect(context.sourceVersionIds).toEqual([SOURCE_VERSION]);
    expect(context.comparisonVersionIds).toEqual([COMPARISON_VERSION]);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]).toEqual({
      name: "retrieve_candidate_pairs",
      args: {
        p_workspace_id: WORKSPACE_ID,
        p_source_version_ids: [SOURCE_VERSION],
        p_comparison_version_ids: [COMPARISON_VERSION],
        p_top_k: 5,
        p_threshold: 0.75,
      },
    });
  });

  it("maps the nine RPC columns to an AnalysisCandidatePair", async () => {
    const { db } = mockDb({
      analysis: analysisRow(expectedFingerprint()),
      scope: scopeRows(),
      pairs: pairRows(),
    });
    const context = await loadAnalysisContext(ANALYSIS_ID, db);
    expect(context.pairs).toEqual([
      {
        source: {
          documentId: SOURCE_DOCUMENT,
          versionId: SOURCE_VERSION,
          chunkId: SOURCE_CHUNK,
          role: "source",
          text: "synthetic source text",
        },
        comparison: {
          documentId: COMPARISON_DOCUMENT,
          versionId: COMPARISON_VERSION,
          chunkId: COMPARISON_CHUNK,
          role: "comparison",
          text: "synthetic comparison text",
        },
      },
    ]);
    expect(context.chunkCount).toBe(2);
    expect(context.candidatePairCount).toBe(1);
    expect(context.fingerprint).toBe(expectedFingerprint());
  });

  it("reads persisted retrieval config instead of hardcoded values", async () => {
    const custom = computeRequestFingerprint(
      {
        chunkCount: 2,
        candidatePairCount: 1,
        sortedSourceVersionIds: [SOURCE_VERSION],
        sortedComparisonVersionIds: [COMPARISON_VERSION],
        pairs: [
          {
            sourceChunkId: SOURCE_CHUNK,
            comparisonChunkId: COMPARISON_CHUNK,
          },
        ],
        chunkIds: [SOURCE_CHUNK, COMPARISON_CHUNK],
      },
      { similarityThreshold: 0.8 },
    );
    const row = {
      ...analysisRow(custom),
      retrieval_config: {
        topK: 5,
        similarityThreshold: 0.8,
        chunksRevision: "synthetic-rev",
        embeddingRevision: "gte-small-384-v1",
        fingerprint: custom,
      },
    };
    const { db } = mockDb({
      analysis: row,
      scope: scopeRows(),
      pairs: pairRows(),
    });
    const context = await loadAnalysisContext(ANALYSIS_ID, db);
    expect(context.fingerprint).toBe(custom);
  });

  it("rejects a diverged fingerprint with ESTIMATE_STALE", async () => {
    const { db } = mockDb({
      analysis: analysisRow("tampered-fingerprint"),
      scope: scopeRows(),
      pairs: pairRows(),
    });
    const error = await loadAnalysisContext(ANALYSIS_ID, db).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AnalysisWorkerError);
    expect((error as AnalysisWorkerError).code).toBe("ESTIMATE_STALE");
  });

  it("maps a retrieval timeout to RETRIEVAL_FAILED", async () => {
    const { db } = mockDb({
      analysis: analysisRow(expectedFingerprint()),
      scope: scopeRows(),
      pairs: pairRows(),
      rpcImpl: () => new Promise(() => {}),
    });
    const error = await loadAnalysisContext(ANALYSIS_ID, db, {
      retrievalTimeoutMs: 20,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AnalysisWorkerError);
    expect((error as AnalysisWorkerError).code).toBe("RETRIEVAL_FAILED");
  });

  it("maps a missing analysis row to RETRIEVAL_FAILED", async () => {
    const { db } = mockDb({
      analysis: null,
      scope: scopeRows(),
      pairs: pairRows(),
    });
    const error = await loadAnalysisContext(ANALYSIS_ID, db).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AnalysisWorkerError);
    expect((error as AnalysisWorkerError).code).toBe("RETRIEVAL_FAILED");
  });

  it("never reads scope from the caller, only from the database", async () => {
    const { db, fromCalls, rpcCalls } = mockDb({
      analysis: analysisRow(expectedFingerprint()),
      scope: scopeRows(),
      pairs: pairRows(),
    });
    await loadAnalysisContext(ANALYSIS_ID, db);
    expect(fromCalls).toEqual(["analyses", "analysis_documents"]);
    expect(rpcCalls[0]?.args["p_source_version_ids"]).toEqual([
      SOURCE_VERSION,
    ]);
  });
});
