import React from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/modules/review", () => ({
  openRound: vi.fn(),
  prepareRound: vi.fn(),
}));

import { renderToStaticMarkup } from "react-dom/server";
import { RoundPreparationModal } from "./round-preparation-modal";

describe("RoundPreparationModal", () => {
  const callbacks = { onClose: vi.fn(), onRoundOpened: vi.fn() };

  it("does not render while closed", () => {
    const html = renderToStaticMarkup(
      <RoundPreparationModal
        isOpen={false}
        documentId="doc-1"
        documentName="Policy.pdf"
        findings={[]}
        {...callbacks}
      />,
    );
    expect(html).toBe("");
  });

  it("explains the frozen set and does not expose confidence", () => {
    const html = renderToStaticMarkup(
      <RoundPreparationModal
        isOpen
        documentId="doc-1"
        documentName="Policy.pdf"
        findings={[]}
        {...callbacks}
      />,
    );
    expect(html).toContain("Policy.pdf");
    expect(html).toContain("Opening this round freezes this set of findings");
    expect(html).toContain("Prepare round");
    expect(html.toLowerCase()).not.toContain("confidence");
  });
});
