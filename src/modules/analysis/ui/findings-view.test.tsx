import React from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/modules/repository", () => ({
  getDocumentOriginalUrlAction: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/analysis/a-1/findings",
  useSearchParams: () => new URLSearchParams(),
}));

import { renderToStaticMarkup } from "react-dom/server";
import { FindingsView } from "./findings-view";

describe("FindingsView", () => {
  it("muestra empty state cuando el análisis completed no tiene hallazgos", () => {
    const html = renderToStaticMarkup(
      <FindingsView
        analysisId="a-1"
        initialPage={{ items: [], total: 0, page: 1, pageSize: 10 }}
        totalAnalysisFindings={0}
      />
    );
    expect(html).toContain("No contradictions or obsolescence issues");
  });

  it("muestra empty state diferenciado cuando los filtros no arrojan resultados", () => {
    const html = renderToStaticMarkup(
      <FindingsView
        analysisId="a-1"
        initialPage={{ items: [], total: 0, page: 1, pageSize: 10 }}
        totalAnalysisFindings={5}
      />
    );
    expect(html).toContain("No findings match your selected filters");
    expect(html).toContain("Clear filters");
  });
});
