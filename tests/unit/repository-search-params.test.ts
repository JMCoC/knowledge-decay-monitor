import { describe, expect, it } from "vitest";
import { hasRepositoryFilters, parseRepositorySearchParams } from "@/modules/repository/utils/search-params";

describe("repository URL filters", () => {
  it("uses defaults for an empty query", () => {
    expect(parseRepositorySearchParams({})).toEqual({ page: 1, pageSize: 25 });
  });

  it("trims and maps supported URL values", () => {
    expect(parseRepositorySearchParams({
      name: "  incident  ", category: "Policy", ownerId: "unassigned", versionStatus: "not_active", page: "2", pageSize: "10",
    })).toEqual({ name: "incident", category: "Policy", ownerId: null, versionStatus: null, page: 2, pageSize: 10 });
  });

  it("drops malformed fields safely while retaining valid filters", () => {
    expect(parseRepositorySearchParams({ category: "invalid", name: "Runbook", page: "-2", ownerId: ["x", "y"] })).toEqual({ name: "Runbook", page: 1, pageSize: 25 });
  });

  it("distinguishes active filters from pagination", () => {
    expect(hasRepositoryFilters({ page: 3, pageSize: 25 })).toBe(false);
    expect(hasRepositoryFilters({ ownerId: null, page: 1, pageSize: 25 })).toBe(true);
  });
});
