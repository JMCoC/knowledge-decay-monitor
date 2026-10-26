import { describe, expect, it, vi } from "vitest";

import { createBatchPersistence } from "../../src/modules/analysis/worker/batch-persistence";
import type {
  AnalysisBatchPersistenceInput,
  AnalysisWorkerDb,
} from "../../src/modules/analysis/worker/types";

const BASE: AnalysisBatchPersistenceInput = {
  analysisId: "b0000000-0000-4000-8000-000000000001",
  operationId: "c0000000-0000-4000-8000-000000000001",
  expectedProcessedPairs: 10,
  checkpoint: {
    processedPairs: 20,
    totalPairs: 25,
    findingsCount: 2,
    lastPairFingerprint: "pair-hash",
    startedAt: "2026-10-17T00:00:00.000Z",
    cursor: {
      lowChunkId: "40000000-0000-4000-8000-000000000001",
      highChunkId: "50000000-0000-4000-8000-000000000001",
    },
  },
  findings: [],
  hasMore: true,
};

type RpcResult = {
  data: unknown;
  error: { message: string; code?: string } | null;
};

type Rpc = (name: string, args: Record<string, unknown>) => Promise<RpcResult>;

function mockClient(result: RpcResult = { data: true, error: null }) {
  const rpc = vi.fn<Rpc>(async () => result);
  return {
    client: { rpc } as unknown as AnalysisWorkerDb,
    rpc,
  };
}

function rejectingClient(error: unknown) {
  const rpc = vi.fn<Rpc>(async () => {
    throw error;
  });
  return {
    client: { rpc } as unknown as AnalysisWorkerDb,
    rpc,
  };
}

describe("analysis batch persistence", () => {
  it("builds with an injected client", () => {
    const client = { rpc: vi.fn() } as unknown as AnalysisWorkerDb;
    expect(() => createBatchPersistence(client)).not.toThrow();
  });

  it.each([undefined, null])(
    "requires an AnalysisWorkerDb (%s)",
    (client) => {
      expect(() =>
        createBatchPersistence(client as unknown as AnalysisWorkerDb),
      ).toThrow("AnalysisWorkerDb is required");
    },
  );

  it("calls persist_analysis_batch with the exact continuation args", async () => {
    const { client, rpc } = mockClient();
    const persistence = createBatchPersistence(client);

    await expect(persistence.persist(BASE)).resolves.toEqual({ ok: true });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("persist_analysis_batch", {
      p_analysis_id: BASE.analysisId,
      p_operation_id: BASE.operationId,
      p_expected_processed_pairs: BASE.expectedProcessedPairs,
      p_checkpoint: BASE.checkpoint,
      p_findings: BASE.findings,
      p_has_more: BASE.hasMore,
    });
    expect(rpc.mock.calls.map((call) => call[0])).toEqual([
      "persist_analysis_batch",
    ]);
  });

  it("uses the same RPC for the final page", async () => {
    const { client, rpc } = mockClient();
    const persistence = createBatchPersistence(client);

    await expect(
      persistence.persist({ ...BASE, hasMore: false }),
    ).resolves.toEqual({ ok: true });

    expect(rpc).toHaveBeenCalledWith("persist_analysis_batch", {
      p_analysis_id: BASE.analysisId,
      p_operation_id: BASE.operationId,
      p_expected_processed_pairs: BASE.expectedProcessedPairs,
      p_checkpoint: BASE.checkpoint,
      p_findings: BASE.findings,
      p_has_more: false,
    });
    expect(rpc.mock.calls.map((call) => call[0])).toEqual([
      "persist_analysis_batch",
    ]);
  });

  it("maps a false result to STALE_OPERATION", async () => {
    const { client } = mockClient({ data: false, error: null });
    const persistence = createBatchPersistence(client);

    await expect(persistence.persist(BASE)).resolves.toEqual({
      ok: false,
      code: "STALE_OPERATION",
    });
  });

  it.each([
    ["22023", "STALE_OPERATION"],
    ["P0001", "PERSISTENCE_FAILED"],
    ["P2002", "PERSISTENCE_FAILED"],
    ["P2003", "PERSISTENCE_FAILED"],
    ["55P03", "PERSISTENCE_FAILED"],
    ["57014", "PERSISTENCE_FAILED"],
    ["XX000", "INTERNAL_ERROR"],
  ] as const)("maps SQLSTATE %s to %s", async (code, expected) => {
    const { client } = mockClient({
      data: null,
      error: { message: "rpc failed", code },
    });
    const persistence = createBatchPersistence(client);

    await expect(persistence.persist(BASE)).resolves.toEqual({
      ok: false,
      code: expected,
    });
  });

  it("maps a null result without an error to INTERNAL_ERROR", async () => {
    const { client } = mockClient({ data: null, error: null });
    const persistence = createBatchPersistence(client);

    await expect(persistence.persist(BASE)).resolves.toEqual({
      ok: false,
      code: "INTERNAL_ERROR",
    });
  });

  it("maps a rejected RPC by its SQLSTATE", async () => {
    const { client } = rejectingClient({ code: "P2002" });
    const persistence = createBatchPersistence(client);

    await expect(persistence.persist(BASE)).resolves.toEqual({
      ok: false,
      code: "PERSISTENCE_FAILED",
    });
  });

  it("maps an untyped rejection to INTERNAL_ERROR", async () => {
    const { client } = rejectingClient(new Error("network down"));
    const persistence = createBatchPersistence(client);

    await expect(persistence.persist(BASE)).resolves.toEqual({
      ok: false,
      code: "INTERNAL_ERROR",
    });
  });
});
