import { describe, expect, it, vi } from "vitest";

import { createTestFinalization } from "../../supabase/functions/analyze/_test_doubles/analysis-finalization.test-shim";
import type { AnalysisWorkerDb } from "../../src/modules/analysis/worker/types";
import type { InternalFinding } from "../../src/types/analysis-internal";

const ANALYSIS_ID = "b0000000-0000-4000-8000-000000000001";
const OPERATION_ID = "c0000000-0000-4000-8000-000000000001";

const FINDINGS: InternalFinding[] = [
  {
    type: "contradiction",
    severity: "High",
    confidence: 0.91,
    explanation: "The source contradicts the comparison.",
    evidence: [],
  },
  {
    type: "obsolescence",
    severity: "Medium",
    confidence: 0.82,
    explanation: "The comparison is outdated.",
    evidence: [],
  },
];

type RpcResult = {
  data: unknown;
  error: { message: string; code?: string } | null;
};

function mockClient(result: RpcResult = { data: null, error: null }) {
  const rpc = vi.fn(async () => result);
  return {
    client: { rpc } as unknown as AnalysisWorkerDb,
    rpc,
  };
}

function rejectingClient(error: unknown) {
  const rpc = vi.fn(async () => {
    throw error;
  });
  return {
    client: { rpc } as unknown as AnalysisWorkerDb,
    rpc,
  };
}

function completedInput() {
  return {
    analysisId: ANALYSIS_ID,
    operationId: OPERATION_ID,
    outcome: { kind: "completed" as const, findings: FINDINGS },
  };
}

describe("analysis finalization test shim", () => {
  it("calls finalize_analysis_success with the completed findings count", async () => {
    const { client, rpc } = mockClient();
    const finalization = createTestFinalization(client);

    await expect(finalization.finalize(completedInput())).resolves.toEqual({
      ok: true,
    });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("finalize_analysis_success", {
      p_analysis_id: ANALYSIS_ID,
      p_operation_id: OPERATION_ID,
      p_reported_findings_count: FINDINGS.length,
    });
  });

  it("reports success for zero findings", async () => {
    const { client, rpc } = mockClient();
    const finalization = createTestFinalization(client);

    await expect(
      finalization.finalize({
        analysisId: ANALYSIS_ID,
        operationId: OPERATION_ID,
        outcome: { kind: "completed", findings: [] },
      }),
    ).resolves.toEqual({ ok: true });

    expect(rpc).toHaveBeenCalledWith("finalize_analysis_success", {
      p_analysis_id: ANALYSIS_ID,
      p_operation_id: OPERATION_ID,
      p_reported_findings_count: 0,
    });
  });

  it.each([
    ["22023", "superseded"],
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
    const finalization = createTestFinalization(client);

    await expect(finalization.finalize(completedInput())).resolves.toEqual({
      ok: false,
      code: expected,
    });
  });

  it("maps a rejected RPC by its SQLSTATE", async () => {
    const { client } = rejectingClient({ code: "P2002" });
    const finalization = createTestFinalization(client);

    await expect(finalization.finalize(completedInput())).resolves.toEqual({
      ok: false,
      code: "PERSISTENCE_FAILED",
    });
  });

  it("keeps the failure branch on fail_analysis", async () => {
    const { client, rpc } = mockClient({ data: "failed", error: null });
    const finalization = createTestFinalization(client);

    await expect(
      finalization.finalize({
        analysisId: ANALYSIS_ID,
        operationId: OPERATION_ID,
        outcome: { kind: "failed", code: "PROVIDER_UNAVAILABLE" },
      }),
    ).resolves.toEqual({ ok: true });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("fail_analysis", {
      p_analysis_id: ANALYSIS_ID,
      p_operation_id: OPERATION_ID,
      p_retryable: true,
      p_error_code: "PROVIDER_UNAVAILABLE",
    });
  });

  it("returns superseded when fail_analysis reports a stale operation", async () => {
    const { client } = mockClient({ data: "superseded", error: null });
    const finalization = createTestFinalization(client);

    await expect(
      finalization.finalize({
        analysisId: ANALYSIS_ID,
        operationId: OPERATION_ID,
        outcome: { kind: "failed", code: "PROVIDER_UNAVAILABLE" },
      }),
    ).resolves.toEqual({ ok: false, code: "superseded" });
  });
});
