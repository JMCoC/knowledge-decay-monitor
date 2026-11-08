import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalysisExecutionManifest } from "../../src/types/analysis-internal";

const mocks = vi.hoisted(() => ({
  createServiceClient: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
}));

import {
  AnalysisCommandError,
  submitRetryCommand,
  submitRunCommand,
} from "@/modules/analysis/application/run-queries";

const actorId = "10000000-0000-4000-8000-000000000001";
const estimateRef = "90000000-0000-4000-8000-000000000001";
const failedAnalysisId = "90000000-0000-4000-8000-000000000002";
const analysisId = "90000000-0000-4000-8000-000000000003";
const manifest: AnalysisExecutionManifest = {
  fingerprintVersion: "s2-05-v2",
  pricingVersion: "s2-04-v1",
  promptVersion: "prompt-v1",
  outputSchemaVersion: "schema-v1",
  providers: {
    primary: { provider: "cerebras", model: "model-a" },
    fallback: { provider: "groq", model: "model-b" },
  },
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.createServiceClient.mockReturnValue({ rpc: mocks.rpc });
});

describe("S2-05 service-only Run/Retry RPC adapters", () => {
  it("calls run_analysis with the trusted actor, estimate, key, and manifest", async () => {
    mocks.rpc.mockResolvedValue({
      data: [{ analysis_id: analysisId, status: "queued" }],
      error: null,
    });

    await expect(submitRunCommand(actorId, {
      estimateRef,
      idempotencyKey: "run-key-1",
    }, manifest)).resolves.toEqual({ analysisId, status: "queued" });

    expect(mocks.createServiceClient).toHaveBeenCalledOnce();
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("run_analysis", {
      p_actor_id: actorId,
      p_estimate_ref: estimateRef,
      p_idempotency_key: "run-key-1",
      p_current_manifest: manifest,
    });
  });

  it("calls retry_analysis with the failed parent and maps the new run link", async () => {
    mocks.rpc.mockResolvedValue({
      data: [{
        analysis_id: analysisId,
        status: "queued",
        retry_of_analysis_id: failedAnalysisId,
      }],
      error: null,
    });

    await expect(submitRetryCommand(actorId, {
      estimateRef,
      idempotencyKey: "retry-key-1",
      failedAnalysisId,
    }, manifest)).resolves.toEqual({
      analysisId,
      status: "queued",
      retryOfAnalysisId: failedAnalysisId,
    });

    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("retry_analysis", {
      p_actor_id: actorId,
      p_failed_analysis_id: failedAnalysisId,
      p_estimate_ref: estimateRef,
      p_idempotency_key: "retry-key-1",
      p_current_manifest: manifest,
    });
  });

  it("passes a missing current manifest as JSON null for SQL to identify a replay", async () => {
    mocks.rpc.mockResolvedValue({
      data: [{ analysis_id: analysisId, status: "processing" }],
      error: null,
    });

    await expect(submitRunCommand(actorId, {
      estimateRef,
      idempotencyKey: "run-key-1",
    }, null)).resolves.toEqual({ analysisId, status: "processing" });
    expect(mocks.rpc).toHaveBeenCalledWith("run_analysis", expect.objectContaining({
      p_current_manifest: null,
    }));
  });

  it("retains only SQLSTATE and reports a controlled error", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: "P2001", message: "private SQL detail" },
    });

    const error = await submitRunCommand(actorId, {
      estimateRef,
      idempotencyKey: "run-key-1",
    }, manifest).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(AnalysisCommandError);
    expect(error).toMatchObject({ code: "P2001", message: "The analysis command failed." });
    expect((error as Error).message).not.toContain("private SQL detail");
  });
});
