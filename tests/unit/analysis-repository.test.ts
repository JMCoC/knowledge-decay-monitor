import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  findEligibleDocuments,
  resolveEligibleVersionIds,
  verifyVersionsEligibility,
  escapeLikeLiteral,
} from "../../src/modules/analysis/infrastructure/analysis.repository";

function mockSupabase(data: unknown[], count: number | null = null, error: unknown = null) {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "order", "range", "ilike", "eq", "is", "in"]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve({ data, count: count ?? data.length, error }).then(resolve, reject);
  return {
    from: vi.fn(() => chain),
    _chain: chain,
  };
}

describe("Analysis infrastructure repository", () => {
  it("escapes LIKE special characters correctly", () => {
    expect(escapeLikeLiteral("100%_guideline")).toBe("100\\%\\_guideline");
  });

  it("escapes LIKE special characters and executes paginated query", async () => {
    const fakeRows = [
      {
        document_id: "doc-1",
        version_id: "ver-1",
        version_number: 1,
        name: "Security Guide 100%",
        category: "Policy",
        owner_profile_id: "user-1",
        owner_full_name: "Alice",
        analysis_status: null,
        created_at: "2026-10-11T00:00:00Z",
      },
    ];
    const client = mockSupabase(fakeRows, 1);
    const result = await findEligibleDocuments(client as never, { name: "100%", page: 1, pageSize: 25 });

    expect(client.from).toHaveBeenCalledWith("eligible_analysis_documents");
    expect(result.data).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it("resolves matching version IDs for bulk filter selection", async () => {
    const client = mockSupabase([{ version_id: "ver-1" }, { version_id: "ver-2" }]);
    const ids = await resolveEligibleVersionIds(client as never, { category: "Policy" });
    expect(ids).toEqual(["ver-1", "ver-2"]);
  });

  it("verifies eligibility of given version IDs in database", async () => {
    const client = mockSupabase([{ version_id: "ver-1" }, { version_id: "ver-2" }]);
    const eligibleIds = await verifyVersionsEligibility(client as never, ["ver-1", "ver-2"]);
    expect(eligibleIds).toEqual(["ver-1", "ver-2"]);
  });
});
