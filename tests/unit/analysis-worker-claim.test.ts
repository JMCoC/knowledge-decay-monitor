import { describe, expect, it } from "vitest";

import {
  compareByCreatedAtId,
  parseClaimedRow,
} from "../../src/modules/analysis/worker/claim";
import { AnalysisWorkerError } from "../../src/modules/analysis/worker/types";

function validRow() {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    workspace_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    initiator_id: "10000000-0000-4000-8000-000000000001",
    operation_id: "c0000000-0000-4000-8000-000000000001",
    attempt_count: 1,
    lease_expires_at: "2026-10-15T00:03:00.000Z",
    next_attempt_at: null,
  };
}

describe("claim helpers", () => {
  it("orders candidates by created_at ascending then id ascending", () => {
    const rows = [
      { created_at: "2026-10-15T00:02:00.000Z", id: "b" },
      { created_at: "2026-10-15T00:01:00.000Z", id: "c" },
      { created_at: "2026-10-15T00:01:00.000Z", id: "a" },
    ];
    expect([...rows].sort(compareByCreatedAtId).map((r) => r.id)).toEqual([
      "a",
      "c",
      "b",
    ]);
  });

  it("parses a claimed row with the seven RPC fields", () => {
    const parsed = parseClaimedRow(validRow());
    expect(parsed).toEqual({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      workspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      initiatorId: "10000000-0000-4000-8000-000000000001",
      operationId: "c0000000-0000-4000-8000-000000000001",
      attemptCount: 1,
      leaseExpiresAt: "2026-10-15T00:03:00.000Z",
      nextAttemptAt: null,
    });
  });

  it("rejects a row missing operation_id", () => {
    expect(() =>
      parseClaimedRow({ ...validRow(), operation_id: undefined }),
    ).toThrow(AnalysisWorkerError);
  });

  it("rejects a row with a non-numeric attempt_count", () => {
    expect(() =>
      parseClaimedRow({ ...validRow(), attempt_count: "1" }),
    ).toThrow(AnalysisWorkerError);
  });

  it("rejects a non-object row", () => {
    expect(() => parseClaimedRow(null)).toThrow(AnalysisWorkerError);
    expect(() => parseClaimedRow("claimed")).toThrow(AnalysisWorkerError);
  });
});
