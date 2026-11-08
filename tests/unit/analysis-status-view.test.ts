import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/modules/analysis/application/analysis.actions", () => ({
  estimateAnalysisAction: vi.fn(),
  getAnalysisAction: vi.fn(),
}));
vi.mock("@/modules/analysis/application/run-actions", () => ({ retryAnalysis: vi.fn() }));

import { AnalysisStatusView } from "@/modules/analysis/ui/analysis-status-view";
import type { AnalysisSnapshot } from "@/types/contracts";

const failedAnalysis: AnalysisSnapshot = {
  analysisId: "00000000-0000-4000-8000-000000000001",
  status: "failed",
  fixedCost: 8,
  initiator: { id: "00000000-0000-4000-8000-000000000002", fullName: "QA Lead" },
  sources: [{
    documentId: "00000000-0000-4000-8000-000000000003",
    versionId: "00000000-0000-4000-8000-000000000004",
    versionNumber: 1,
    name: "Runbook",
    category: "SOP",
    owner: null,
  }],
  comparisons: [],
  createdAt: "2026-10-27T12:00:00.000Z",
  startedAt: "2026-10-27T12:00:01.000Z",
  finishedAt: "2026-10-27T12:00:02.000Z",
  retryOfAnalysisId: null,
  error: { code: "ANALYSIS_FAILED", message: "This analysis failed." },
  canRetry: false,
};

describe("AnalysisStatusView retry availability", () => {
  it("does not offer retry until the released reservation is verified", () => {
    const markup = renderToStaticMarkup(createElement(AnalysisStatusView, { initial: failedAnalysis }));

    expect(markup).toContain("Retry is unavailable until the failed reservation has been released.");
    expect(markup).not.toContain("Retry Analysis");
  });

  it("offers retry after the server confirms the released reservation", () => {
    const markup = renderToStaticMarkup(createElement(AnalysisStatusView, {
      initial: { ...failedAnalysis, canRetry: true },
    }));

    expect(markup).toContain("Retry Analysis");
    expect(markup).not.toContain("Retry is unavailable until the failed reservation has been released.");
  });
});
