import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../../src/types/contracts";
import type { AnalysisExecutionManifest } from "../../src/types/analysis-internal";

const mocks = vi.hoisted(() => ({
  IdentityError: class IdentityError extends Error {
    constructor(readonly code: "UNAUTHENTICATED" | "FORBIDDEN" | "WORKSPACE_REQUIRED" | "INTERNAL_ERROR") {
      super(code);
    }
  },
  AnalysisQueryError: class AnalysisQueryError extends Error {
    constructor(readonly code: string) { super("The estimate query failed."); }
  },
  requireDocumentActor: vi.fn(),
  createAnalysisEstimate: vi.fn(),
  readAnalysisExecutionManifest: vi.fn(),
  captureOperationFailure: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("../../src/modules/identity", () => ({
  IdentityError: mocks.IdentityError,
  requireDocumentActor: mocks.requireDocumentActor,
}));
vi.mock("../../src/lib/observability/operation-events", () => ({
  captureOperationFailure: mocks.captureOperationFailure,
}));
vi.mock("../../src/modules/analysis/queries", () => ({
  AnalysisQueryError: mocks.AnalysisQueryError,
  createAnalysisEstimate: mocks.createAnalysisEstimate,
}));
vi.mock("../../src/modules/analysis/execution-config", () => ({
  readAnalysisExecutionManifest: mocks.readAnalysisExecutionManifest,
}));

import { estimateAnalysis } from "../../src/modules/analysis/actions";

const admin: Actor = {
  userId: "10000000-0000-4000-8000-000000000001",
  workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  role: "Admin",
};
const vid = (n: number) =>
  `30000000-0000-4000-8000-0000000000${n.toString(16).padStart(2, "0")}`;
const ESTIMATE_ID = "90000000-0000-4000-8000-000000000001";
const MANIFEST: AnalysisExecutionManifest = {
  fingerprintVersion: "s2-05-v2",
  pricingVersion: "s2-04-v1",
  promptVersion: "prompt-test-v1",
  outputSchemaVersion: "schema-test-v1",
  providers: {
    primary: { provider: "provider-a", model: "model-a" },
    fallback: { provider: "provider-b", model: "model-b" },
  },
};

function mockHappyPath() {
  mocks.requireDocumentActor.mockResolvedValue(admin);
  mocks.readAnalysisExecutionManifest.mockReturnValue(MANIFEST);
  mocks.createAnalysisEstimate.mockResolvedValue({
    estimateRef: ESTIMATE_ID,
    sourceVersionIds: [vid(1), vid(2)],
    comparisonVersionIds: [vid(3), vid(4)],
    fixedCost: 3,
    expiresAt: "2026-10-17T12:30:00.000Z",
  });
}

beforeEach(() => vi.resetAllMocks());

describe("estimateAnalysis authorization and configuration", () => {
  it("rejects callers without a session", async () => {
    mocks.requireDocumentActor.mockRejectedValue(new mocks.IdentityError("UNAUTHENTICATED"));
    const result = await estimateAnalysis({ sourceVersionIds: [vid(1)], comparisonVersionIds: [] });
    expect(result).toEqual({
      ok: false,
      error: { code: "UNAUTHENTICATED", message: "Please sign in to continue." },
    });
    expect(mocks.createAnalysisEstimate).not.toHaveBeenCalled();
  });

  it("rejects workspace members", async () => {
    mocks.requireDocumentActor.mockRejectedValue(new mocks.IdentityError("FORBIDDEN"));
    const result = await estimateAnalysis({ sourceVersionIds: [vid(1)], comparisonVersionIds: [] });
    expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(mocks.createAnalysisEstimate).not.toHaveBeenCalled();
  });

  it("fails closed without a valid private manifest and creates no estimate", async () => {
    mocks.requireDocumentActor.mockResolvedValue(admin);
    mocks.readAnalysisExecutionManifest.mockReturnValue(null);
    const result = await estimateAnalysis({ sourceVersionIds: [vid(1)], comparisonVersionIds: [] });
    expect(result).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
    expect(mocks.createAnalysisEstimate).not.toHaveBeenCalled();
    expect(mocks.captureOperationFailure).toHaveBeenCalledWith(expect.objectContaining({
      module: "analysis", operation: "estimate", code: "INTERNAL_ERROR",
    }));
  });
});

describe("estimateAnalysis input validation", () => {
  it("rejects malformed UUIDs", async () => {
    mocks.requireDocumentActor.mockResolvedValue(admin);
    const result = await estimateAnalysis({ sourceVersionIds: ["not-a-uuid"], comparisonVersionIds: [] });
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });

  it("rejects an empty source list", async () => {
    mocks.requireDocumentActor.mockResolvedValue(admin);
    const result = await estimateAnalysis({ sourceVersionIds: [], comparisonVersionIds: [] });
    expect(result).toEqual({
      ok: false,
      error: { code: "INVALID_INPUT", message: "Select between 1 and 20 source documents." },
    });
  });

  it("rejects more than 20 distinct versions", async () => {
    mocks.requireDocumentActor.mockResolvedValue(admin);
    const result = await estimateAnalysis({
      sourceVersionIds: Array.from({ length: 11 }, (_, i) => vid(i + 1)),
      comparisonVersionIds: Array.from({ length: 10 }, (_, i) => vid(i + 20)),
    });
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(mocks.createAnalysisEstimate).not.toHaveBeenCalled();
  });

  it("rejects duplicates within either list", async () => {
    mocks.requireDocumentActor.mockResolvedValue(admin);
    const result = await estimateAnalysis({ sourceVersionIds: [vid(1), vid(1)], comparisonVersionIds: [] });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT", message: "Duplicates within the same list are not allowed." },
    });
  });

  it("rejects duplicates inside the comparison list", async () => {
    mocks.requireDocumentActor.mockResolvedValue(admin);
    const result = await estimateAnalysis({
      sourceVersionIds: [vid(1)],
      comparisonVersionIds: [vid(2), vid(2)],
    });
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });

  it("allows the same version in both scope roles", async () => {
    mockHappyPath();
    await estimateAnalysis({ sourceVersionIds: [vid(1)], comparisonVersionIds: [vid(1)] });
    expect(mocks.createAnalysisEstimate).toHaveBeenCalledWith(
      admin.userId,
      { sourceVersionIds: [vid(1)], comparisonVersionIds: [vid(1)] },
      MANIFEST,
    );
  });
});

describe("estimateAnalysis SQL boundary", () => {
  it("sends the trusted actor, normalized scope, and private manifest to the estimate RPC adapter", async () => {
    mockHappyPath();
    const result = await estimateAnalysis({
      sourceVersionIds: [vid(2), vid(1)],
      comparisonVersionIds: [vid(4), vid(3)],
    });
    expect(result).toMatchObject({
      ok: true,
      data: { estimateRef: ESTIMATE_ID, fixedCost: 3, sourceVersionIds: [vid(1), vid(2)] },
    });
    expect(mocks.createAnalysisEstimate).toHaveBeenCalledWith(
      admin.userId,
      { sourceVersionIds: [vid(1), vid(2)], comparisonVersionIds: [vid(3), vid(4)] },
      MANIFEST,
    );
    expect(mocks.readAnalysisExecutionManifest).toHaveBeenCalledTimes(1);
  });

  it("maps an ineligible or stale selected version without exposing SQL details", async () => {
    mocks.requireDocumentActor.mockResolvedValue(admin);
    mocks.readAnalysisExecutionManifest.mockReturnValue(MANIFEST);
    mocks.createAnalysisEstimate.mockRejectedValue(new mocks.AnalysisQueryError("22023"));
    const result = await estimateAnalysis({ sourceVersionIds: [vid(1)], comparisonVersionIds: [] });
    expect(result).toEqual({
      ok: false,
      error: { code: "NOT_FOUND", message: "The selected documents are no longer available." },
    });
  });

  it("maps SQL reauthorization failures to FORBIDDEN", async () => {
    mocks.requireDocumentActor.mockResolvedValue(admin);
    mocks.readAnalysisExecutionManifest.mockReturnValue(MANIFEST);
    mocks.createAnalysisEstimate.mockRejectedValue(new mocks.AnalysisQueryError("42501"));
    const result = await estimateAnalysis({ sourceVersionIds: [vid(1)], comparisonVersionIds: [] });
    expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(mocks.captureOperationFailure).not.toHaveBeenCalled();
  });

  it("reports unexpected RPC failures with a safe correlation id", async () => {
    mocks.requireDocumentActor.mockResolvedValue(admin);
    mocks.readAnalysisExecutionManifest.mockReturnValue(MANIFEST);
    mocks.createAnalysisEstimate.mockRejectedValue(new mocks.AnalysisQueryError("57014"));
    const result = await estimateAnalysis({ sourceVersionIds: [vid(1)], comparisonVersionIds: [] });
    expect(result).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
    expect(JSON.stringify(result)).not.toContain("57014");
    expect(mocks.captureOperationFailure).toHaveBeenCalledTimes(1);
  });
});
