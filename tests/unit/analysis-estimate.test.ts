import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../../src/types/contracts";

const { IdentityError, requireDocumentActor, captureOperationFailure } =
  vi.hoisted(() => ({
    IdentityError: class IdentityError extends Error {
      constructor(
        readonly code:
          | "UNAUTHENTICATED"
          | "WORKSPACE_REQUIRED"
          | "FORBIDDEN"
          | "INTERNAL_ERROR",
      ) {
        super(code);
      }
    },
    requireDocumentActor: vi.fn(),
    captureOperationFailure: vi.fn(),
  }));

const { getEligibleVersions, callRetrieveCandidatePairs, insertEstimate } =
  vi.hoisted(() => ({
    getEligibleVersions: vi.fn(),
    callRetrieveCandidatePairs: vi.fn(),
    insertEstimate: vi.fn(),
  }));

vi.mock("server-only", () => ({}));
vi.mock("../../src/modules/identity", () => ({
  IdentityError,
  requireDocumentActor,
}));
vi.mock("../../src/lib/observability/operation-events", () => ({
  captureOperationFailure,
}));
vi.mock("../../src/modules/analysis/queries", () => ({
  getEligibleVersions,
  callRetrieveCandidatePairs,
  insertEstimate,
}));

import { estimateAnalysis } from "../../src/modules/analysis/actions";

const admin: Actor = {
  userId: "10000000-0000-4000-8000-000000000001",
  workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  role: "Admin",
};

const vid = (n: number) =>
  `30000000-0000-4000-8000-0000000000${n.toString(16).padStart(2, "0")}`;
const cid = (n: number) =>
  `40000000-0000-4000-8000-0000000000${n.toString(16).padStart(2, "0")}`;
const ESTIMATE_ID = "90000000-0000-4000-8000-000000000001";

/** Five disjoint pairs -> 10 unique chunks, 5 pairs -> fixedCost 3. */
const fivePairs = [1, 2, 3, 4, 5].map((i) => ({
  source_chunk_id: cid(i),
  source_version_id: vid(1),
  source_document_id: "20000000-0000-4000-8000-000000000001",
  source_text: `SECRET-CHUNK-TEXT-${i}`,
  comparison_chunk_id: cid(i + 10),
  comparison_version_id: vid(2),
  comparison_document_id: "20000000-0000-4000-8000-000000000002",
  comparison_text: `SECRET-CHUNK-TEXT-${i + 10}`,
  similarity: 1,
}));

function mockHappyPath() {
  requireDocumentActor.mockResolvedValue(admin);
  getEligibleVersions.mockImplementation(async (ids: string[]) => new Set(ids));
  callRetrieveCandidatePairs.mockResolvedValue(fivePairs);
  insertEstimate.mockResolvedValue({ id: ESTIMATE_ID });
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("estimateAnalysis auth", () => {
  it("rejects callers without a session", async () => {
    requireDocumentActor.mockRejectedValue(
      new IdentityError("UNAUTHENTICATED"),
    );
    const result = await estimateAnalysis({
      sourceVersionIds: [vid(1)],
      comparisonVersionIds: [],
    });
    expect(result).toEqual({
      ok: false,
      error: { code: "UNAUTHENTICATED", message: "Please sign in to continue." },
    });
  });

  it("rejects workspace members", async () => {
    requireDocumentActor.mockRejectedValue(new IdentityError("FORBIDDEN"));
    const result = await estimateAnalysis({
      sourceVersionIds: [vid(1)],
      comparisonVersionIds: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FORBIDDEN");
    }
    expect(requireDocumentActor).toHaveBeenCalledTimes(1);
  });
});

describe("estimateAnalysis input validation", () => {
  it("rejects malformed UUIDs", async () => {
    requireDocumentActor.mockResolvedValue(admin);
    const result = await estimateAnalysis({
      sourceVersionIds: ["not-a-uuid"],
      comparisonVersionIds: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_INPUT");
  });

  it("rejects an empty source list", async () => {
    requireDocumentActor.mockResolvedValue(admin);
    const result = await estimateAnalysis({
      sourceVersionIds: [],
      comparisonVersionIds: [],
    });
    expect(result).toEqual({
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "Select between 1 and 20 source documents.",
      },
    });
  });

  it("rejects more than 20 ids", async () => {
    requireDocumentActor.mockResolvedValue(admin);
    const result = await estimateAnalysis({
      sourceVersionIds: Array.from({ length: 21 }, (_, i) => vid(i + 1)),
      comparisonVersionIds: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_INPUT");
  });

  it("rejects a source/comparison union over 20 even when each list is within its cap", async () => {
    requireDocumentActor.mockResolvedValue(admin);
    const result = await estimateAnalysis({
      sourceVersionIds: Array.from({ length: 11 }, (_, i) => vid(i + 1)),
      comparisonVersionIds: Array.from({ length: 10 }, (_, i) => vid(i + 20)),
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "Analysis scope cannot exceed 20 distinct versions.",
      },
    });
    expect(getEligibleVersions).not.toHaveBeenCalled();
  });

  it("rejects duplicates inside the source list (D4a)", async () => {
    requireDocumentActor.mockResolvedValue(admin);
    const result = await estimateAnalysis({
      sourceVersionIds: [vid(1), vid(1)],
      comparisonVersionIds: [],
    });
    expect(result).toEqual({
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "Duplicates within the same list are not allowed.",
      },
    });
  });

  it("rejects duplicates inside the comparison list (D4a)", async () => {
    requireDocumentActor.mockResolvedValue(admin);
    const result = await estimateAnalysis({
      sourceVersionIds: [vid(1)],
      comparisonVersionIds: [vid(2), vid(2)],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
      expect(result.error.message).toBe(
        "Duplicates within the same list are not allowed.",
      );
    }
  });

  it("allows the same id in both lists (D4b)", async () => {
    mockHappyPath();
    const result = await estimateAnalysis({
      sourceVersionIds: [vid(2)],
      comparisonVersionIds: [vid(2)],
    });
    expect(result.ok).toBe(true);
  });
});

describe("estimateAnalysis scope and failures", () => {
  it("maps partially eligible scopes to NOT_FOUND", async () => {
    requireDocumentActor.mockResolvedValue(admin);
    getEligibleVersions.mockResolvedValue(new Set([vid(1)]));
    const result = await estimateAnalysis({
      sourceVersionIds: [vid(1)],
      comparisonVersionIds: [vid(9)],
    });
    expect(result).toEqual({
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: "The selected documents are no longer available.",
      },
    });
  });

  it("maps retrieval failures to INTERNAL_ERROR with telemetry", async () => {
    requireDocumentActor.mockResolvedValue(admin);
    getEligibleVersions.mockImplementation(async (ids: string[]) => new Set(ids));
    callRetrieveCandidatePairs.mockRejectedValue(new Error("db down"));
    const result = await estimateAnalysis({
      sourceVersionIds: [vid(1)],
      comparisonVersionIds: [vid(2)],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL_ERROR");
      expect(result.error.correlationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
    expect(captureOperationFailure).toHaveBeenCalledTimes(1);
    expect(captureOperationFailure).toHaveBeenCalledWith({
      module: "analysis",
      operation: "estimate",
      code: "INTERNAL_ERROR",
      correlationId: expect.any(String),
    });
  });

  it("never sends chunk text to telemetry", async () => {
    requireDocumentActor.mockResolvedValue(admin);
    getEligibleVersions.mockImplementation(async (ids: string[]) => new Set(ids));
    callRetrieveCandidatePairs.mockRejectedValue(new Error("db down"));
    await estimateAnalysis({
      sourceVersionIds: [vid(1)],
      comparisonVersionIds: [vid(2)],
    });
    const payload = JSON.stringify(captureOperationFailure.mock.calls);
    expect(payload).not.toContain("SECRET-CHUNK-TEXT");
    expect(payload).not.toContain("embedding");
  });
});

describe("estimateAnalysis happy path", () => {
  it("returns the persisted estimate with normalized lists", async () => {
    mockHappyPath();
    const before = Date.now();
    const result = await estimateAnalysis({
      sourceVersionIds: [vid(2), vid(1)],
      comparisonVersionIds: [vid(4), vid(3)],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.estimateRef).toBe(ESTIMATE_ID);
    expect(result.data.fixedCost).toBe(3);
    expect(result.data.sourceVersionIds).toEqual([vid(1), vid(2)]);
    expect(result.data.comparisonVersionIds).toEqual([vid(3), vid(4)]);
    const expiresMs = Date.parse(result.data.expiresAt);
    expect(expiresMs).toBeGreaterThanOrEqual(before + 29 * 60 * 1000);
    expect(expiresMs).toBeLessThanOrEqual(Date.now() + 31 * 60 * 1000);
    expect(insertEstimate).toHaveBeenCalledTimes(1);
    const insertArg = insertEstimate.mock.calls[0]?.[0] as
      | { expiresAt: string; fixedCost: number }
      | undefined;
    expect(insertArg?.fixedCost).toBe(3);
    expect(insertArg?.expiresAt).toBe(result.data.expiresAt);
  });

  it("sorts output lists ascending", async () => {
    mockHappyPath();
    const result = await estimateAnalysis({
      sourceVersionIds: [vid(1)],
      comparisonVersionIds: [vid(2), vid(1)],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sorted = [...result.data.comparisonVersionIds].sort();
    expect(result.data.comparisonVersionIds).toEqual(sorted);
  });

  it("prices 10 chunks and 5 pairs to 3 credits", async () => {
    mockHappyPath();
    const result = await estimateAnalysis({
      sourceVersionIds: [vid(1)],
      comparisonVersionIds: [vid(2)],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.fixedCost).toBe(3);
  });
});
