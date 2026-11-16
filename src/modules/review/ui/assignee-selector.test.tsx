import React from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/modules/review", () => ({
  assignFinding: vi.fn(),
  listAssignees: vi.fn().mockResolvedValue({
    ok: true,
    data: { items: [], total: 0, page: 1, pageSize: 25 },
  }),
}));

import { renderToStaticMarkup } from "react-dom/server";
import { AssigneeSelector } from "./assignee-selector";
import type { EligibleOwner } from "@/types/contracts";

describe("AssigneeSelector", () => {
  const mockAssignees: EligibleOwner[] = [
    { id: "usr-1", fullName: "Alice Engineer" },
    { id: "usr-2", fullName: "Bob Lead" },
  ];

  it("muestra 'Unassigned' cuando currentAssignee es null", () => {
    const html = renderToStaticMarkup(
      <AssigneeSelector
        findingId="f-1"
        currentAssignee={null}
        revision={1}
        canAssign={true}
        affectedDocuments={[{ documentId: "doc-1", name: "Architecture Guide.pdf" }]}
        assignees={mockAssignees}
      />
    );

    expect(html).toContain("Unassigned");
    expect(html).toContain("Alice Engineer");
    expect(html).toContain("Bob Lead");
    // Multi-document banner should not appear when affectedDocuments.length <= 1
    expect(html).not.toContain("spans multiple documents");
  });

  it("muestra el nombre del asignado actual cuando está definido", () => {
    const current: EligibleOwner = { id: "usr-2", fullName: "Bob Lead" };
    const html = renderToStaticMarkup(
      <AssigneeSelector
        findingId="f-1"
        currentAssignee={current}
        revision={2}
        canAssign={true}
        affectedDocuments={[{ documentId: "doc-1", name: "Doc1.pdf" }]}
        assignees={mockAssignees}
      />
    );

    expect(html).toContain("Bob Lead");
    expect(html).toContain('value="usr-2"');
  });

  it("deshabilita el selector cuando canAssign es false", () => {
    const html = renderToStaticMarkup(
      <AssigneeSelector
        findingId="f-1"
        currentAssignee={null}
        revision={1}
        canAssign={false}
        affectedDocuments={[{ documentId: "doc-1", name: "Doc1.pdf" }]}
        assignees={mockAssignees}
      />
    );

    expect(html).toContain("disabled");
  });

  it("mantiene el selector habilitado cuando canAssign es true", () => {
    const html = renderToStaticMarkup(
      <AssigneeSelector
        findingId="f-1"
        currentAssignee={null}
        revision={1}
        canAssign={true}
        affectedDocuments={[{ documentId: "doc-1", name: "Doc1.pdf" }]}
        assignees={mockAssignees}
      />
    );

    expect(html).not.toContain("disabled");
  });

  it("muestra el banner de advertencia multi-documento cuando affectedDocuments.length > 1", () => {
    const html = renderToStaticMarkup(
      <AssigneeSelector
        findingId="f-1"
        currentAssignee={null}
        revision={1}
        canAssign={true}
        affectedDocuments={[
          { documentId: "doc-1", name: "Service Agreement.docx" },
          { documentId: "doc-2", name: "Terms of Service.md" },
        ]}
        assignees={mockAssignees}
      />
    );

    expect(html).toContain("This finding spans Service Agreement.docx, Terms of Service.md");
    expect(html).toContain("Select the document that must be corrected");
  });

  it("no muestra el banner de orientación cuando affectedDocuments tiene solo 1 documento", () => {
    const html = renderToStaticMarkup(
      <AssigneeSelector
        findingId="f-1"
        currentAssignee={null}
        revision={1}
        canAssign={true}
        affectedDocuments={[{ documentId: "doc-1", name: "Service Agreement.docx" }]}
        assignees={mockAssignees}
      />
    );

    expect(html).not.toContain("spans multiple documents");
  });

  it("garantiza cero fuga del score o término confidence en el marcado HTML", () => {
    const html = renderToStaticMarkup(
      <AssigneeSelector
        findingId="f-1"
        currentAssignee={{ id: "usr-1", fullName: "Alice Engineer" }}
        revision={1}
        canAssign={true}
        affectedDocuments={[
          { documentId: "doc-1", name: "Doc1.pdf" },
          { documentId: "doc-2", name: "Doc2.pdf" },
        ]}
        assignees={mockAssignees}
      />
    );

    expect(html.toLowerCase()).not.toContain("confidence");
  });
});
