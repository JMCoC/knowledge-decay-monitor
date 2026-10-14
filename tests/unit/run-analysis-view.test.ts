import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { mergeAnalysisSelectionFilters, RunAnalysisView } from "@/modules/analysis/ui/run-analysis-view";
import type { AnalysisSelectionItem } from "@/types/contracts";

const testItems: AnalysisSelectionItem[] = [
  {
    documentId: "doc-1",
    versionId: "ver-1",
    versionNumber: 1,
    name: "Standard Protocol",
    category: "SOP",
    owner: { id: "u-1", fullName: "Bob" },
  },
  {
    documentId: "doc-2",
    versionId: "ver-2",
    versionNumber: 1,
    name: "Compliance Doc",
    category: "Policy",
    owner: null,
  },
];

describe("RunAnalysisView Container", () => {
  it("preserves active filters and removes only the field cleared by the user", () => {
    const current = { name: "security", category: "Policy" as const, ownerId: "u-1" };
    expect(mergeAnalysisSelectionFilters(current, { category: undefined })).toEqual({
      name: "security",
      ownerId: "u-1",
    });
    expect(mergeAnalysisSelectionFilters(current, { ownerId: null })).toEqual({
      name: "security",
      category: "Policy",
      ownerId: null,
    });
  });

  it("renders tabs for Steps 1 and 2 and Scope Summary sidebar", () => {
    const markup = renderToStaticMarkup(
      createElement(RunAnalysisView, {
        initialItems: testItems,
        initialTotal: 2,
        eligibleOwners: [{ id: "u-1", fullName: "Bob" }],
      })
    );

    expect(markup).toContain("1. Documents to analyze");
    expect(markup).toContain("2. Compare against");
    expect(markup).toContain("Scope Summary");
    expect(markup).toContain("0 / 20 distinct versions");
    expect(markup).toContain("Calculate Estimated Cost");
  });
});
