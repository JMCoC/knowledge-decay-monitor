import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireDocumentActor: vi.fn(),
  createReadOnlyClient: vi.fn(),
  validateAnalysisScopeService: vi.fn(),
  estimateAnalysis: vi.fn(),
  captureOperationFailure: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("../../src/modules/identity", () => ({
  IdentityError: class IdentityError extends Error {
    constructor(readonly code: string) { super(code); }
  },
  requireDocumentActor: mocks.requireDocumentActor,
}));
vi.mock("../../src/lib/supabase/server", () => ({ createReadOnlyClient: mocks.createReadOnlyClient }));
vi.mock("../../src/lib/observability/operation-events", () => ({
  captureOperationFailure: mocks.captureOperationFailure,
}));
vi.mock("../../src/modules/analysis/actions", () => ({ estimateAnalysis: mocks.estimateAnalysis }));
vi.mock("../../src/modules/analysis/application/analysis.service", () => ({
  listEligibleDocumentsService: vi.fn(),
  resolveFilteredScopeService: vi.fn(),
  validateAnalysisScopeService: mocks.validateAnalysisScopeService,
}));

import { estimateAnalysisAction } from "../../src/modules/analysis/application/analysis.actions";

const input = {
  sourceVersionIds: ["550e8400-e29b-41d4-a716-446655440000"],
  comparisonVersionIds: [],
};

describe("S2-03 estimate action integration", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireDocumentActor.mockResolvedValue({
      userId: "10000000-0000-4000-8000-000000000001",
      workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      role: "Admin",
    });
    mocks.createReadOnlyClient.mockResolvedValue({});
    mocks.validateAnalysisScopeService.mockResolvedValue({
      ok: true,
      data: { distinctCount: 1, isInternalOnly: true },
    });
    mocks.estimateAnalysis.mockResolvedValue({
      ok: true,
      data: {
        ...input,
        estimateRef: "90000000-0000-4000-8000-000000000001",
        fixedCost: 3,
        expiresAt: "2026-10-14T12:30:00.000Z",
      },
    });
  });

  it("preserves S2-03 scope validation and delegates pricing to S2-04", async () => {
    const result = await estimateAnalysisAction(input);

    expect(result).toMatchObject({ ok: true, data: { fixedCost: 3 } });
    expect(mocks.validateAnalysisScopeService).toHaveBeenCalledWith({}, input);
    expect(mocks.estimateAnalysis).toHaveBeenCalledWith(input);
  });

  it("does not invoke S2-04 when the S2-03 union limit rejects the scope", async () => {
    mocks.validateAnalysisScopeService.mockResolvedValue({
      ok: false,
      error: { code: "INVALID_INPUT", message: "Analysis scope cannot exceed 20 distinct versions." },
    });

    const result = await estimateAnalysisAction(input);

    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(mocks.estimateAnalysis).not.toHaveBeenCalled();
  });
});
