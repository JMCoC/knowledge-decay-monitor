import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ScopeSummarySidebar } from "@/modules/analysis/ui/scope-summary-sidebar";
import type { AnalysisSelectionItem } from "@/types/contracts";

const sourceItem: AnalysisSelectionItem = {
  documentId: "doc-1",
  versionId: "ver-1",
  versionNumber: 1,
  name: "Policy A",
  category: "Policy",
  owner: null,
};

describe("ScopeSummarySidebar Component", () => {
  it("renders distinct versions count, source items, and internal contradiction note when comparison is empty", () => {
    const markup = renderToStaticMarkup(
      createElement(ScopeSummarySidebar, {
        sources: [sourceItem],
        comparisons: [],
        onRemoveSource: vi.fn(),
        onRemoveComparison: vi.fn(),
        estimate: null,
        onCalculateEstimate: vi.fn(),
        onProceedToRun: vi.fn(),
        isEstimating: false,
        validationError: null,
      })
    );

    expect(markup).toContain("1 / 20 distinct versions");
    expect(markup).toContain("Policy A");
    expect(markup).toContain("Running internal contradiction analysis only");
  });

  it("displays estimate cost when available", () => {
    const markup = renderToStaticMarkup(
      createElement(ScopeSummarySidebar, {
        sources: [sourceItem],
        comparisons: [],
        onRemoveSource: vi.fn(),
        onRemoveComparison: vi.fn(),
        estimate: {
          sourceVersionIds: ["ver-1"],
          comparisonVersionIds: [],
          estimateRef: "est_123",
          fixedCost: 3,
          expiresAt: "2026-10-11T12:00:00Z",
        },
        onCalculateEstimate: vi.fn(),
        onProceedToRun: vi.fn(),
        isEstimating: false,
        validationError: null,
      })
    );

    expect(markup).toContain("Estimated cost: 3 credits");
  });
});
