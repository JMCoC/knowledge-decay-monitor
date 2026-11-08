import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { sortFindingsBySeverityAndDate, mapFindingRowToSummary } from "./analysis.service";


describe("findings service logic", () => {
  it("ordena estrictamente High -> Medium -> Low con desempate por fecha descendente y id", () => {
    const items = [
      { id: "1", severityCurrent: "Low" as const, createdAt: "2026-10-27T10:00:00Z" },
      { id: "2", severityCurrent: "High" as const, createdAt: "2026-10-27T09:00:00Z" },
      { id: "3", severityCurrent: "Medium" as const, createdAt: "2026-10-27T11:00:00Z" },
      { id: "4", severityCurrent: "High" as const, createdAt: "2026-10-27T10:00:00Z" },
    ];
    const sorted = sortFindingsBySeverityAndDate(items);
    expect(sorted.map((item) => item.id)).toEqual(["4", "2", "3", "1"]);
  });

  it("garantiza que el DTO resultante jamás contiene la propiedad confidence", () => {
    const rawRow = {
      id: "f-1",
      workspace_id: "w-1",
      analysis_id: "a-1",
      type: "contradiction" as const,
      explanation: "Expl",
      severity_original: "High" as const,
      severity_current: "High" as const,
      status: "pending_review" as const,
      created_at: "2026-10-27T10:00:00Z",
      updated_at: "2026-10-27T10:00:00Z",
      confidence: 0.95, // Raw data simulator
    };
    const summary = mapFindingRowToSummary(
      rawRow as unknown as Parameters<typeof mapFindingRowToSummary>[0],
    );
    expect("confidence" in summary).toBe(false);
    expect(summary.assignee).toBeNull();
    expect(summary.severityCurrent).toBe("High");
  });
});
