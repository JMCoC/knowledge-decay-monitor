import React from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/modules/review", () => ({
  changeFinding: vi.fn(),
}));

import { renderToStaticMarkup } from "react-dom/server";
import { SeverityControl } from "./severity-control";

describe("SeverityControl", () => {
  it("muestra la severidad original propuesta por la IA de forma inmutable y las opciones de severidad actual", () => {
    const html = renderToStaticMarkup(
      <SeverityControl
        findingId="f-1"
        severityOriginal="High"
        severityCurrent="High"
        revision={1}
        canChangeSeverity={true}
      />
    );

    // Debe mostrar la severidad inmutable de la IA
    expect(html).toContain("AI Proposed: High");
    expect(html).toContain("AI: High");

    // Debe mostrar el selector para la severidad actual con sus opciones
    expect(html).toContain("Current: High");
    expect(html).toContain("<option");
    expect(html).toContain("High</option>");
    expect(html).toContain("Medium</option>");
    expect(html).toContain("Low</option>");
  });

  it("deshabilita el selector cuando canChangeSeverity es false", () => {
    const html = renderToStaticMarkup(
      <SeverityControl
        findingId="f-1"
        severityOriginal="High"
        severityCurrent="High"
        revision={1}
        canChangeSeverity={false}
      />
    );

    expect(html).toContain("disabled");
  });

  it("mantiene el selector habilitado cuando canChangeSeverity es true", () => {
    const html = renderToStaticMarkup(
      <SeverityControl
        findingId="f-1"
        severityOriginal="High"
        severityCurrent="High"
        revision={1}
        canChangeSeverity={true}
      />
    );

    expect(html).not.toContain("disabled");
  });

  it("muestra divergencia cuando la severidad actual difiere de la propuesta por la IA", () => {
    const html = renderToStaticMarkup(
      <SeverityControl
        findingId="f-1"
        severityOriginal="High"
        severityCurrent="Medium"
        revision={2}
        canChangeSeverity={true}
      />
    );

    // Original de la IA se mantiene visible e inmutable
    expect(html).toContain("AI Proposed: High");
    expect(html).toContain("AI: High");

    // Severidad actual refleja el cambio
    expect(html).toContain("Current: Medium");
  });

  it("garantiza cero fuga del score de confianza en el marcado HTML", () => {
    const html = renderToStaticMarkup(
      <SeverityControl
        findingId="f-1"
        severityOriginal="High"
        severityCurrent="Low"
        revision={1}
        canChangeSeverity={true}
      />
    );

    // Verificación estricta de cero fuga de confianza
    expect(html.toLowerCase()).not.toContain("confidence");
  });
});
