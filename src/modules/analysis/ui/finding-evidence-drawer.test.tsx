import React from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/modules/repository", () => ({
  getDocumentOriginalUrlAction: vi.fn(),
}));
vi.mock("@/modules/review", () => ({
  assignFinding: vi.fn(),
  changeFinding: vi.fn(),
  getFindingReview: vi.fn(),
  listAssignees: vi.fn(),
  openRound: vi.fn(),
  prepareRound: vi.fn(),
}));
vi.mock("@/modules/analysis", () => ({
  listFindingsForDocumentAction: vi.fn(),
}));

import { renderToStaticMarkup } from "react-dom/server";
import { FindingEvidenceDrawer } from "./finding-evidence-drawer";
import type { FindingDetail } from "@/types/contracts";
import type { FindingReviewSnapshot } from "@/types/review-contracts";

const mockFinding: FindingDetail = {
  id: "f-1",
  analysisId: "a-1",
  type: "contradiction",
  explanation: "SOP-1 contradicts Policy-2 regarding retention periods.",
  severityOriginal: "High",
  severityCurrent: "High",
  status: "pending_review",
  assignee: null,
  createdAt: "2026-10-27T10:00:00Z",
  evidence: [
    {
      id: "ev-1",
      documentId: "d-1",
      documentName: "Data-Retention-SOP.pdf",
      versionId: "v-1",
      versionNumber: 1,
      chunkId: "c-1",
      pageNumber: 4,
      section: "Section 2.1",
      sectionHeading: "Retention Duration",
      snapshot: "Records must be retained for 3 years. <script>alert('xss')</script>",
    },
    {
      id: "ev-2",
      documentId: "d-2",
      documentName: "Security-Policy.docx",
      versionId: "v-2",
      versionNumber: 2,
      chunkId: "c-2",
      pageNumber: 12,
      section: "Section 5.3",
      sectionHeading: "Compliance Rule",
      snapshot: "All records must be permanently deleted after 12 months.",
    },
  ],
};

const mockReview: FindingReviewSnapshot = {
  ...mockFinding,
  revision: 1,
  canChangeStatus: true,
  canChangeSeverity: true,
  canAssign: false,
  canPrepareRound: false,
};

describe("FindingEvidenceDrawer", () => {
  it("renderiza comparación side-by-side de 2 evidencias con nombres de documentos y versiones", () => {
    const html = renderToStaticMarkup(<FindingEvidenceDrawer finding={mockFinding} onClose={vi.fn()} />);
    expect(html).toContain("Data-Retention-SOP.pdf");
    expect(html).toContain("Security-Policy.docx");
    expect(html).toContain("v1");
    expect(html).toContain("v2");
  });

  it("renderiza texto de snapshot de forma segura sin interpretar HTML ni ejecutar scripts", () => {
    const html = renderToStaticMarkup(<FindingEvidenceDrawer finding={mockFinding} onClose={vi.fn()} />);
    expect(html).toContain("Records must be retained for 3 years");
    expect(html).not.toContain("<script>alert('xss')</script>");
    expect(html).toContain("&lt;script&gt;alert(&#x27;xss&#x27;)&lt;/script&gt;");
  });

  it("integra controles de revisión autorizados y conserva la severidad original", () => {
    const html = renderToStaticMarkup(
      <FindingEvidenceDrawer finding={mockFinding} initialReview={mockReview} onClose={vi.fn()} />,
    );
    expect(html).toContain("AI Proposed: High");
    expect(html).toContain("Current:");
    expect(html).toContain("Confirm");
    expect(html).toContain("Mark as False Positive");
    expect(html).not.toContain("Resolve Manually");
    expect(html).toContain("Assignee:");
    expect(html.toLowerCase()).not.toContain("confidence");
  });
});

