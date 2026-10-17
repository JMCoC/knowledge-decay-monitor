import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalysisExecutionManifest } from "../../src/types/analysis-internal";

const mocks = vi.hoisted(() => ({
  createServiceClient: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("../../src/lib/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
}));

import { AnalysisQueryError, createAnalysisEstimate } from "../../src/modules/analysis/queries";

const manifest: AnalysisExecutionManifest = {
  fingerprintVersion: "s2-05-v2",
  pricingVersion: "s2-04-v1",
  promptVersion: "prompt-v1",
  outputSchemaVersion: "schema-v1",
  providers: {
    primary: { provider: "provider-a", model: "model-a" },
    fallback: { provider: "provider-b", model: "model-b" },
  },
};
const input = {
  sourceVersionIds: ["30000000-0000-4000-8000-000000000001"],
  comparisonVersionIds: [],
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.createServiceClient.mockReturnValue({ rpc: mocks.rpc });
});

describe("createAnalysisEstimate service RPC adapter", () => {
  it("calls the private server client with persisted actor identity and returns only the public DTO", async () => {
    mocks.rpc.mockResolvedValue({
      data: [{
        estimate_ref: "90000000-0000-4000-8000-000000000001",
        fixed_cost: 2,
        expires_at: "2026-10-17T12:30:00.000Z",
        source_version_ids: input.sourceVersionIds,
        comparison_version_ids: [],
      }],
      error: null,
    });

    await expect(createAnalysisEstimate(
      "10000000-0000-4000-8000-000000000001",
      input,
      manifest,
    )).resolves.toEqual({
      estimateRef: "90000000-0000-4000-8000-000000000001",
      fixedCost: 2,
      expiresAt: "2026-10-17T12:30:00.000Z",
      sourceVersionIds: input.sourceVersionIds,
      comparisonVersionIds: [],
    });
    expect(mocks.createServiceClient).toHaveBeenCalledOnce();
    expect(mocks.rpc).toHaveBeenCalledWith("create_analysis_estimate", {
      p_actor_id: "10000000-0000-4000-8000-000000000001",
      p_source_version_ids: input.sourceVersionIds,
      p_comparison_version_ids: [],
      p_manifest: manifest,
    });
  });

  it("retains only the SQLSTATE and never forwards the raw database message", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: "22023", message: "private SQL detail" },
    });
    const error = await createAnalysisEstimate(
      "10000000-0000-4000-8000-000000000001",
      input,
      manifest,
    ).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(AnalysisQueryError);
    expect(error).toMatchObject({ code: "22023", message: "The estimate query failed." });
    expect((error as Error).message).not.toContain("private SQL detail");
  });
});
