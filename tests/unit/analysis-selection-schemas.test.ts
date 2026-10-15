import { describe, expect, it } from "vitest";
import {
  eligibleDocumentsQuerySchema,
  analysisSelectionInputSchema,
  resolveFilteredScopeSchema,
} from "../../src/modules/analysis/schemas";

describe("Analysis selection schemas", () => {
  it("defaults pagination, trims names, and accepts valid categories and ownerIds", () => {
    const parsed = eligibleDocumentsQuerySchema.parse({ name: "  Policy Doc  " });
    expect(parsed).toEqual({
      name: "Policy Doc",
      page: 1,
      pageSize: 25,
    });
  });

  it("rejects invalid page, zero pageSize, or excessively long name", () => {
    expect(eligibleDocumentsQuerySchema.safeParse({ page: 0 }).success).toBe(false);
    expect(eligibleDocumentsQuerySchema.safeParse({ pageSize: 0 }).success).toBe(false);
    expect(eligibleDocumentsQuerySchema.safeParse({ pageSize: 101 }).success).toBe(false);
    expect(eligibleDocumentsQuerySchema.safeParse({ name: "a".repeat(201) }).success).toBe(false);
  });

  it("requires at least one source document in analysisSelectionInputSchema", () => {
    const valid = analysisSelectionInputSchema.safeParse({
      sourceVersionIds: ["550e8400-e29b-41d4-a716-446655440000"],
      comparisonVersionIds: [],
    });
    expect(valid.success).toBe(true);

    const emptySources = analysisSelectionInputSchema.safeParse({
      sourceVersionIds: [],
      comparisonVersionIds: [],
    });
    expect(emptySources.success).toBe(false);
    if (!emptySources.success) {
      expect(emptySources.error.issues[0].message).toMatch(/At least one source document is required/i);
    }
  });

  it("rejects malformed UUIDs in sources or comparisons", () => {
    expect(
      analysisSelectionInputSchema.safeParse({
        sourceVersionIds: ["not-a-uuid"],
        comparisonVersionIds: [],
      }).success
    ).toBe(false);
  });

  it("validates resolveFilteredScopeSchema with defaults", () => {
    const parsed = resolveFilteredScopeSchema.parse({ targetRole: "source" });
    expect(parsed.currentSourceVersionIds).toEqual([]);
    expect(parsed.currentComparisonVersionIds).toEqual([]);
    expect(parsed.query).toEqual({ page: 1, pageSize: 25 });
  });
});
