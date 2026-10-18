import { describe, expect, it, vi } from "vitest";

import { createBatchPersistence } from "../../src/modules/analysis/worker/batch-persistence";
import type {
  AnalysisBatchPersistenceInput,
  AnalysisWorkerDb,
} from "../../src/modules/analysis/worker/types";
import { FakeAnalysisBatchPersistence } from "../../supabase/functions/analyze/_test_doubles/analysis-batch-persistence.fake";

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

function mockClient(result: unknown = { data: true, error: null }) {
  const rpc = vi.fn(async () => result as never);
  return {
    client: { rpc } as unknown as AnalysisWorkerDb,
    rpc,
  };
}

describe("analysis batch persistence", () => {
  it("keeps the production seam closed until S2-08 staging exists", () => {
    expect(() => createBatchPersistence({ rpc: vi.fn() } as never)).toThrow(
      "S2-08 not merged: analysis batch staging unavailable.",
    );
  });

  it("persists a continuation with the expected cursor and operation", async () => {
    const { client, rpc } = mockClient({ data: true, error: null });
    const persistence = new FakeAnalysisBatchPersistence(client);
    await expect(persistence.persist(BASE)).resolves.toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith("yield_analysis_batch", {
      p_analysis_id: BASE.analysisId,
      p_operation_id: BASE.operationId,
      p_expected_processed_pairs: 10,
      p_checkpoint: BASE.checkpoint,
    });
    expect(persistence.calls).toEqual([BASE]);
  });

  it("does not report a failed compare-and-set as persisted", async () => {
    const { client } = mockClient({ data: false, error: null });
    const persistence = new FakeAnalysisBatchPersistence(client);
    await expect(persistence.persist(BASE)).resolves.toEqual({
      ok: false,
      code: "STALE_OPERATION",
    });
  });

  it("renews the current lease at the final page instead of yielding", async () => {
    const { client, rpc } = mockClient({ data: [{ lease_expires_at: "later" }], error: null });
    const persistence = new FakeAnalysisBatchPersistence(client);
    await expect(
      persistence.persist({ ...BASE, hasMore: false }),
    ).resolves.toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith("renew_analysis_lease", {
      p_analysis_id: BASE.analysisId,
      p_operation_id: BASE.operationId,
      p_expected_processed_pairs: 10,
      p_checkpoint: BASE.checkpoint,
    });
  });
});
