import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { sortFindingsBySeverityAndDate, mapFindingRowToSummary } from "./analysis.service";
import { findFindingWithEvidence, findFindingsByAnalysis } from "../infrastructure/analysis.repository";

function findingRow(overrides: Record<string, unknown> = {}) {
  return {
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
    review_revision: 1,
    assignee_id: null as string | null,
    assignee_full_name: null as string | null,
    ...overrides,
  } as unknown as Parameters<typeof mapFindingRowToSummary>[0];
}

function createListQuery(rows: Record<string, unknown>[]) {
  let filteredRows = [...rows];
  let filteredCount = filteredRows.length;
  let selectedColumns = "";
  const isFilters: Array<[string, null]> = [];
  const eqFilters: Array<[string, unknown]> = [];
  const builder: Record<string, unknown> = {};
  builder.select = (columns: string) => {
    selectedColumns = columns;
    return builder;
  };
  builder.eq = (column: string, value: unknown) => {
    eqFilters.push([column, value]);
    if (column === "assignee_id") {
      filteredRows = filteredRows.filter((row) => row[column] === value);
      filteredCount = filteredRows.length;
    }
    return builder;
  };
  builder.is = (column: string, value: null) => {
    isFilters.push([column, value]);
    filteredRows = filteredRows.filter((row) => row[column] === value);
    filteredCount = filteredRows.length;
    return builder;
  };
  builder.order = () => builder;
  builder.range = (start: number, end: number) => {
    filteredRows = filteredRows.slice(start, end + 1);
    return builder;
  };
  builder.then = (resolve: (result: unknown) => unknown) =>
    Promise.resolve(resolve({ data: filteredRows, error: null, count: filteredCount }));

  return {
    client: { from: () => builder } as never,
    isFilters,
    eqFilters,
    selectedColumns: () => selectedColumns,
  };
}


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
    const rawRow = { ...findingRow(), confidence: 0.95 };
    const summary = mapFindingRowToSummary(
      rawRow as unknown as Parameters<typeof mapFindingRowToSummary>[0],
    );
    expect("confidence" in summary).toBe(false);
    expect(summary.assignee).toBeNull();
    expect(summary.severityCurrent).toBe("High");
  });

  it("assigned_finding_maps_persisted_member", () => {
    const summary = mapFindingRowToSummary(findingRow({
      assignee_id: "member-1",
      assignee_full_name: "Ana Pérez",
    }));

    expect(summary.assignee).toEqual({ id: "member-1", fullName: "Ana Pérez" });
  });

  it("rejects an assigned finding whose profile projection is incomplete", () => {
    expect(() => mapFindingRowToSummary(findingRow({
      assignee_id: "member-1",
      assignee_full_name: null,
    }))).toThrow("Finding assignee projection is incomplete.");
  });

  it("unassigned_filter_excludes_assigned_even_if_member_name_missing", async () => {
    const query = createListQuery([
      { id: "assigned", assignee_id: "member-1", assignee_full_name: null },
      { id: "unassigned", assignee_id: null, assignee_full_name: null },
    ]);

    const result = await findFindingsByAnalysis(query.client, {
      workspaceId: "w-1",
      analysisId: "a-1",
      assignee: "unassigned",
      offset: 0,
      limit: 10,
    });

    expect(query.isFilters).toContainEqual(["assignee_id", null]);
    expect(query.selectedColumns()).toContain("review_revision");
    expect(query.selectedColumns()).toContain("assignee_id");
    expect(query.selectedColumns()).toContain("assignee_full_name");
    expect(result.data.map((row) => row.id)).toEqual(["unassigned"]);
    expect(result.total).toBe(1);
  });

  it("filters findings by a selected workspace assignee UUID", async () => {
    const query = createListQuery([
      { id: "assigned-a", assignee_id: "member-a", assignee_full_name: "Ana Pérez" },
      { id: "assigned-b", assignee_id: "member-b", assignee_full_name: "Luis Díaz" },
    ]);

    const result = await findFindingsByAnalysis(query.client, {
      workspaceId: "w-1",
      analysisId: "a-1",
      assignee: "member-b",
      offset: 0,
      limit: 10,
    });

    expect(query.eqFilters).toContainEqual(["assignee_id", "member-b"]);
    expect(result.data.map((row) => row.id)).toEqual(["assigned-b"]);
  });

  it("preserves the mixed-assignment total when all findings are paginated", async () => {
    const query = createListQuery([
      { id: "assigned-a", assignee_id: "member-a", assignee_full_name: "Ana Pérez" },
      { id: "unassigned", assignee_id: null, assignee_full_name: null },
      { id: "assigned-b", assignee_id: "member-b", assignee_full_name: "Luis Díaz" },
    ]);

    const result = await findFindingsByAnalysis(query.client, {
      workspaceId: "w-1",
      analysisId: "a-1",
      assignee: "all",
      offset: 1,
      limit: 1,
    });

    expect(query.isFilters).toEqual([]);
    expect(result.data.map((row) => row.id)).toEqual(["unassigned"]);
    expect(result.total).toBe(3);
  });

  it("keeps persisted assignee columns in the finding detail projection", async () => {
    const selectCalls: string[] = [];
    const findingBuilder: Record<string, unknown> = {};
    findingBuilder.select = (columns: string) => {
      selectCalls.push(columns);
      return findingBuilder;
    };
    findingBuilder.eq = () => findingBuilder;
    findingBuilder.maybeSingle = async () => ({
      data: findingRow({ assignee_id: "member-1", assignee_full_name: "Ana Pérez" }),
      error: null,
    });
    const evidenceBuilder: Record<string, unknown> = {};
    evidenceBuilder.select = (columns: string) => {
      selectCalls.push(columns);
      return evidenceBuilder;
    };
    evidenceBuilder.eq = () => evidenceBuilder;
    evidenceBuilder.then = (resolve: (result: unknown) => unknown) =>
      Promise.resolve(resolve({ data: [], error: null }));
    const client = {
      from: (table: string) => table === "analysis_findings" ? findingBuilder : evidenceBuilder,
    } as never;

    const result = await findFindingWithEvidence(client, { workspaceId: "w-1", findingId: "f-1" });

    expect(result).not.toBeNull();
    expect(result?.finding.assignee_id).toBe("member-1");
    expect(result?.finding.assignee_full_name).toBe("Ana Pérez");
    expect(selectCalls[0]).toContain("review_revision");
    expect(selectCalls[0]).toContain("assignee_id");
    expect(selectCalls[0]).toContain("assignee_full_name");
  });
});
