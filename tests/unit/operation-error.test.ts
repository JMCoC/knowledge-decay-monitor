import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OperationError } from "../../src/components/operation-error";

describe("OperationError", () => {
  it("renders only the controlled message and optional support reference", () => {
    const markup = renderToStaticMarkup(createElement(OperationError, {
      error: {
        code: "INTERNAL_ERROR",
        message: "We couldn't confirm the operation. Refresh and try again.",
        correlationId: "40000000-0000-4000-8000-000000000009",
      },
    }));

    expect(markup).toContain("role=\"alert\"");
    expect(markup).toContain("We couldn&#x27;t confirm the operation. Refresh and try again.");
    expect(markup).toContain("Reference:");
    expect(markup).toContain("40000000-0000-4000-8000-000000000009");
  });

  it("does not invent a reference when the action has none", () => {
    const markup = renderToStaticMarkup(createElement(OperationError, {
      error: { code: "FORBIDDEN", message: "You don't have access." },
    }));

    expect(markup).not.toContain("Reference:");
  });
});
