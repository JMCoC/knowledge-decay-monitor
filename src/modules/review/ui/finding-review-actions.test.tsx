import React from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/modules/review", () => ({
  changeFinding: vi.fn(),
}));

import { renderToStaticMarkup } from "react-dom/server";
import { FindingReviewActions } from "./finding-review-actions";

describe("FindingReviewActions", () => {
  it("cuando status es pending_review, renderiza botones Confirm y Mark as False Positive, pero NO Resolve", () => {
    const html = renderToStaticMarkup(
      <FindingReviewActions
        findingId="f-1"
        status="pending_review"
        revision={1}
        canChangeStatus={true}
      />
    );

    expect(html).toContain("Confirm");
    expect(html).toContain("Mark as False Positive");
    expect(html).not.toContain("Resolve");
    expect(html).not.toContain("Plan Update");
  });

  it("cuando status es confirmed, renderiza Plan Update y Resolve Manually", () => {
    const html = renderToStaticMarkup(
      <FindingReviewActions
        findingId="f-1"
        status="confirmed"
        revision={2}
        canChangeStatus={true}
      />
    );

    expect(html).toContain("Plan Update");
    expect(html).toContain("Resolve Manually");
    expect(html).not.toContain("Confirm");
    expect(html).not.toContain("Mark as False Positive");
  });

  it("cuando status es false_positive, renderiza Resolve Manually", () => {
    const html = renderToStaticMarkup(
      <FindingReviewActions
        findingId="f-1"
        status="false_positive"
        revision={2}
        canChangeStatus={true}
      />
    );

    expect(html).toContain("Resolve Manually");
    expect(html).not.toContain("Plan Update");
    expect(html).not.toContain("Confirm");
  });

  it("cuando status es update_planned, renderiza Resolve Manually", () => {
    const html = renderToStaticMarkup(
      <FindingReviewActions
        findingId="f-1"
        status="update_planned"
        revision={3}
        canChangeStatus={true}
      />
    );

    expect(html).toContain("Resolve Manually");
    expect(html).not.toContain("Plan Update");
    expect(html).not.toContain("Confirm");
  });

  it("cuando status es resolved (terminal), renderiza badge de Resolved y ningún botón de acción", () => {
    const html = renderToStaticMarkup(
      <FindingReviewActions
        findingId="f-1"
        status="resolved"
        revision={4}
        canChangeStatus={false}
      />
    );

    expect(html).toContain("Resolved");
    expect(html).not.toContain("<button");
  });

  it("deshabilita los botones de acción cuando canChangeStatus es false", () => {
    const html = renderToStaticMarkup(
      <FindingReviewActions
        findingId="f-1"
        status="pending_review"
        revision={1}
        canChangeStatus={false}
      />
    );

    expect(html).toContain("disabled");
  });

  it("garantiza cero fuga del score de confianza en el marcado HTML", () => {
    const html = renderToStaticMarkup(
      <FindingReviewActions
        findingId="f-1"
        status="pending_review"
        revision={1}
        canChangeStatus={true}
      />
    );

    expect(html.toLowerCase()).not.toContain("confidence");
  });
});
