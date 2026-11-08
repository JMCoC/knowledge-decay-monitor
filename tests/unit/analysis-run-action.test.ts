import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireDocumentActor: vi.fn(),
  readAnalysisExecutionManifest: vi.fn(),
  submitRunCommand: vi.fn(),
  submitRetryCommand: vi.fn(),
  scheduleAnalysisTrigger: vi.fn(),
  captureOperationFailure: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/identity", () => ({
  IdentityError: class IdentityError extends Error {
    constructor(readonly code: string) { super(code); }
  },
  requireDocumentActor: mocks.requireDocumentActor,
}));
vi.mock("@/modules/analysis/execution-config", () => ({
  readAnalysisExecutionManifest: mocks.readAnalysisExecutionManifest,
}));
vi.mock("@/modules/analysis/application/run-queries", () => ({
  AnalysisCommandError: class AnalysisCommandError extends Error {
    constructor(readonly code: string) { super("The analysis command failed."); }
  },
  submitRunCommand: mocks.submitRunCommand,
  submitRetryCommand: mocks.submitRetryCommand,
}));
vi.mock("@/modules/analysis/application/worker-trigger", () => ({
  scheduleAnalysisTrigger: mocks.scheduleAnalysisTrigger,
}));
vi.mock("@/lib/observability/operation-events", () => ({
  captureOperationFailure: mocks.captureOperationFailure,
}));

import type { AnalysisExecutionManifest } from "../../src/types/analysis-internal";
import type {
  RetryAnalysisInput,
  RunAnalysisInput,
} from "../../src/types/contracts";
import { IdentityError } from "@/modules/identity";
import { AnalysisCommandError } from "@/modules/analysis/application/run-queries";
import { retryAnalysis, runAnalysis } from "@/modules/analysis/application/run-actions";

const estimateRef = "90000000-0000-4000-8000-000000000001";
const failedAnalysisId = "90000000-0000-4000-8000-000000000002";
const analysisId = "90000000-0000-4000-8000-000000000003";
const actor = {
  userId: "10000000-0000-4000-8000-000000000001",
  workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  role: "Admin" as const,
};
const manifest = {
  fingerprintVersion: "s2-05-v2",
  pricingVersion: "s2-04-v1",
  promptVersion: "prompt-v1",
  outputSchemaVersion: "schema-v1",
  providers: {
    primary: { provider: "cerebras", model: "model-a" },
    fallback: { provider: "groq", model: "model-b" },
  },
} as const satisfies AnalysisExecutionManifest;
const runInput: RunAnalysisInput = {
  estimateRef,
  idempotencyKey: "run-key-1",
};
const retryInput: RetryAnalysisInput = {
  ...runInput,
  idempotencyKey: "retry-key-1",
  failedAnalysisId,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireDocumentActor.mockResolvedValue(actor);
  mocks.readAnalysisExecutionManifest.mockReturnValue(manifest);
  mocks.submitRunCommand.mockResolvedValue({ analysisId, status: "queued" });
  mocks.submitRetryCommand.mockResolvedValue({
    analysisId,
    status: "queued",
    retryOfAnalysisId: failedAnalysisId,
  });
});

describe("S2-05 Run and Retry Server Actions", () => {
  it.each([
    { label: "invalid estimate UUID", input: { ...runInput, estimateRef: "estimate" } },
    { label: "empty key", input: { ...runInput, idempotencyKey: "" } },
    { label: "key over 128 characters", input: { ...runInput, idempotencyKey: "k".repeat(129) } },
    { label: "leading or trailing spaces", input: { ...runInput, idempotencyKey: " run-key " } },
    { label: "unexpected client fields", input: { ...runInput, workspaceId: actor.workspaceId } },
  ])("rejects $label before privileged work", async ({ input }) => {
    const result = await runAnalysis(input as RunAnalysisInput);

    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(mocks.submitRunCommand).not.toHaveBeenCalled();
    expect(mocks.scheduleAnalysisTrigger).not.toHaveBeenCalled();
  });

  it("does not allow a Member to reach the RPC", async () => {
    mocks.requireDocumentActor.mockRejectedValue(new IdentityError("FORBIDDEN"));

    const result = await runAnalysis(runInput);

    expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(mocks.submitRunCommand).not.toHaveBeenCalled();
  });

  it("does not allow an anonymous request to reach the RPC", async () => {
    mocks.requireDocumentActor.mockRejectedValue(new IdentityError("UNAUTHENTICATED"));

    const result = await retryAnalysis(retryInput);

    expect(result).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
    expect(mocks.submitRetryCommand).not.toHaveBeenCalled();
  });

  it("submits the trusted Run and schedules one trigger after the RPC succeeds", async () => {
    const result = await runAnalysis(runInput);

    expect(result).toEqual({ ok: true, data: { analysisId, status: "queued" } });
    expect(mocks.submitRunCommand).toHaveBeenCalledExactlyOnceWith(actor.userId, runInput, manifest);
    expect(mocks.scheduleAnalysisTrigger).toHaveBeenCalledExactlyOnceWith(analysisId);
  });

  it("still submits an exact replay when the current execution manifest is unavailable", async () => {
    mocks.readAnalysisExecutionManifest.mockReturnValue(null);

    const result = await runAnalysis(runInput);

    expect(result).toMatchObject({ ok: true, data: { analysisId } });
    expect(mocks.submitRunCommand).toHaveBeenCalledExactlyOnceWith(actor.userId, runInput, null);
    expect(mocks.scheduleAnalysisTrigger).toHaveBeenCalledExactlyOnceWith(analysisId);
  });

  it("maps a reservation failure and does not schedule a trigger", async () => {
    mocks.submitRunCommand.mockRejectedValue(new AnalysisCommandError("P2001"));

    const result = await runAnalysis(runInput);

    expect(result).toMatchObject({ ok: false, error: { code: "INSUFFICIENT_CREDITS" } });
    expect(mocks.scheduleAnalysisTrigger).not.toHaveBeenCalled();
  });

  it.each([
    ["P0002", "NOT_FOUND"],
    ["42501", "FORBIDDEN"],
    ["22023", "INVALID_INPUT"],
    ["P2001", "INSUFFICIENT_CREDITS"],
    ["P2002", "CONFLICT"],
    ["P2101", "ESTIMATE_EXPIRED"],
    ["P2102", "ESTIMATE_STALE"],
    ["23505", "INTERNAL_ERROR"],
  ] as const)("maps SQLSTATE %s to %s without exposing it", async (sqlstate, code) => {
    mocks.submitRunCommand.mockRejectedValue(new AnalysisCommandError(sqlstate));

    const result = await runAnalysis(runInput);

    expect(result).toMatchObject({ ok: false, error: { code } });
    expect(JSON.stringify(result)).not.toContain(sqlstate);
    expect(mocks.scheduleAnalysisTrigger).not.toHaveBeenCalled();
  });

  it("submits Retry with the failed parent and current actor's new estimate", async () => {
    mocks.requireDocumentActor.mockResolvedValue({ ...actor, role: "QA Lead" });

    const result = await retryAnalysis(retryInput);

    expect(result).toEqual({
      ok: true,
      data: { analysisId, status: "queued", retryOfAnalysisId: failedAnalysisId },
    });
    expect(mocks.submitRetryCommand).toHaveBeenCalledExactlyOnceWith(actor.userId, retryInput, manifest);
    expect(mocks.scheduleAnalysisTrigger).toHaveBeenCalledExactlyOnceWith(analysisId);
  });

  it("preserves a committed result if trigger registration throws and reports only safe metadata", async () => {
    mocks.scheduleAnalysisTrigger.mockImplementation(() => { throw new Error("secret trigger detail"); });

    const result = await runAnalysis(runInput);

    expect(result).toEqual({ ok: true, data: { analysisId, status: "queued" } });
    expect(mocks.captureOperationFailure).toHaveBeenCalledWith({
      module: "analysis",
      operation: "trigger",
      code: "INTERNAL_ERROR",
      correlationId: expect.any(String),
    });
    expect(JSON.stringify(mocks.captureOperationFailure.mock.calls)).not.toContain("secret trigger detail");
  });
});
