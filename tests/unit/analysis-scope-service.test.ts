import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  calculateDistinctScopeUnion,
  resolveFilteredScopeService,
  validateScopeLimit,
} from "../../src/modules/analysis/application/analysis.service";

function mockScopeClient(responses: Array<Array<{ version_id: string }>>) {
  let requestIndex = 0;
  return {
    from: vi.fn(() => {
      const data = responses[requestIndex++] ?? [];
      const chain: Record<string, unknown> = {};
      for (const method of ["select", "in", "range", "ilike", "eq", "is"]) {
        chain[method] = vi.fn(() => chain);
      }
      chain.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve({ data, error: null, count: data.length }).then(resolve, reject);
      return chain;
    }),
  };
}

describe("Analysis Scope Service", () => {
  it("counts overlapping documents in sources and comparisons exactly once", () => {
    const sources = ["doc-1", "doc-2"];
    const comparisons = ["doc-2", "doc-3"];
    const union = calculateDistinctScopeUnion(sources, comparisons);
    expect(union).toEqual(["doc-1", "doc-2", "doc-3"]);
    expect(union.length).toBe(3);
  });

  it("permits 20 distinct versions and rejects 21 distinct versions", () => {
    const pass20 = Array.from({ length: 20 }, (_, i) => `id-${i}`);
    expect(validateScopeLimit(pass20).ok).toBe(true);

    const fail21 = Array.from({ length: 21 }, (_, i) => `id-${i}`);
    const result = validateScopeLimit(fail21);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
      expect(result.error.message).toMatch(/exceeds the maximum limit of 20 distinct versions/i);
    }
  });

  it("handles empty comparison as valid internal-only scope", () => {
    const sources = ["id-1"];
    const comparisons: string[] = [];
    const union = calculateDistinctScopeUnion(sources, comparisons);
    expect(union).toEqual(["id-1"]);
    expect(validateScopeLimit(union).ok).toBe(true);
  });

  it("rejects bulk selection when existing items plus matching results exceed 20", async () => {
    const uuid = (id: number) => `550e8400-e29b-41d4-a716-${id.toString().padStart(12, "0")}`;
    const currentSourceIds = Array.from({ length: 10 }, (_, index) => uuid(index + 1));
    const filteredIds = Array.from({ length: 11 }, (_, index) => uuid(index + 101));
    const client = mockScopeClient([
      currentSourceIds.map((version_id) => ({ version_id })),
      filteredIds.map((version_id) => ({ version_id })),
    ]);

    const result = await resolveFilteredScopeService(client as never, {
      query: {},
      targetRole: "source",
      currentSourceVersionIds: currentSourceIds,
      currentComparisonVersionIds: [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_INPUT");
  });

  it("rejects a client supplied current ID that is not eligible in the session tenant", async () => {
    const foreignId = "550e8400-e29b-41d4-a716-446655440099";
    const client = mockScopeClient([[]]);

    const result = await resolveFilteredScopeService(client as never, {
      query: {},
      targetRole: "comparison",
      currentSourceVersionIds: [foreignId],
      currentComparisonVersionIds: [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/not eligible/i);
    expect(client.from).toHaveBeenCalledTimes(1);
  });
});
