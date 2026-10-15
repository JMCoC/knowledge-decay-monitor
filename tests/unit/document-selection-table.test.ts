import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DocumentSelectionTable } from "@/modules/analysis/ui/document-selection-table";
import type { AnalysisSelectionItem } from "@/types/contracts";

const testItems: AnalysisSelectionItem[] = [
  {
    documentId: "doc-1",
    versionId: "ver-1",
    versionNumber: 1,
    name: "Engineering Policy",
    category: "Policy",
    owner: { id: "user-1", fullName: "Alice" },
  },
  {
    documentId: "doc-2",
    versionId: "ver-2",
    versionNumber: 2,
    name: "QA Runbook",
    category: "Manual",
    owner: null,
  },
];

describe("DocumentSelectionTable Component", () => {
  it("renders search, category selector, table rows and badges", () => {
    const markup = renderToStaticMarkup(
      createElement(DocumentSelectionTable, {
        items: testItems,
        total: 2,
        page: 1,
        pageSize: 25,
        selectedVersionIds: new Set(["ver-1"]),
        otherListVersionIds: new Set(["ver-1"]),
        onToggleVersion: vi.fn(),
        onSelectAllFiltered: vi.fn(),
        onClearSelection: vi.fn(),
        onPageChange: vi.fn(),
        onFilterChange: vi.fn(),
        stepRole: "source",
        eligibleOwners: [{ id: "user-1", fullName: "Alice" }],
      })
    );

    expect(markup).toContain("Search documents by name");
    expect(markup).toContain("Engineering Policy");
    expect(markup).toContain("QA Runbook");
    expect(markup).toContain("Also in Comparisons");
    expect(markup).toContain("Select all filtered");
  });

  it("renders empty state message when no items match filters", () => {
    const markup = renderToStaticMarkup(
      createElement(DocumentSelectionTable, {
        items: [],
        total: 0,
        page: 1,
        pageSize: 25,
        selectedVersionIds: new Set<string>(),
        otherListVersionIds: new Set<string>(),
        onToggleVersion: vi.fn(),
        onSelectAllFiltered: vi.fn(),
        onClearSelection: vi.fn(),
        onPageChange: vi.fn(),
        onFilterChange: vi.fn(),
        stepRole: "comparison",
        eligibleOwners: [],
      })
    );

    expect(markup).toContain("No eligible active documents match the filters");
  });

  it("keeps entire-repository comparison available when current filters return no rows", () => {
    const markup = renderToStaticMarkup(
      createElement(DocumentSelectionTable, {
        items: [],
        total: 0,
        page: 1,
        pageSize: 25,
        selectedVersionIds: new Set<string>(),
        otherListVersionIds: new Set<string>(),
        onToggleVersion: vi.fn(),
        onSelectAllFiltered: vi.fn(),
        onSelectEntireRepository: vi.fn(),
        onClearSelection: vi.fn(),
        onPageChange: vi.fn(),
        onFilterChange: vi.fn(),
        stepRole: "comparison",
        eligibleOwners: [],
      })
    );
    const button = markup.match(/<button[^>]*>Compare against entire repository<\/button>/)?.[0];
    expect(button).toBeDefined();
    expect(button).not.toMatch(/\sdisabled(?:=|>)/);
  });
});
