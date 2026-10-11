import { describe, expect, it } from "vitest";
import {
  creditLedgerPageSchema,
  creditLedgerQuerySchema,
  creditSnapshotSchema,
} from "../../src/modules/credits/schemas";

const item = {
  id: "10000000-0000-4000-8000-000000000001",
  type: "Promotional",
  amount: 50,
  analysisId: null,
  createdAt: "2026-10-10T12:00:00.000Z",
};

describe("credit DTO schemas", () => {
  it("defaults page input and allows the documented maximums", () => {
    expect(creditLedgerQuerySchema.parse({})).toEqual({ page: 1, pageSize: 25 });
    expect(creditLedgerQuerySchema.parse({ page: Number.MAX_SAFE_INTEGER, pageSize: 100 })).toEqual({
      page: Number.MAX_SAFE_INTEGER,
      pageSize: 100,
    });
  });

  it.each([
    { page: 0 },
    { page: 1.5 },
    { pageSize: 0 },
    { pageSize: 101 },
    { page: Number.MAX_SAFE_INTEGER + 1 },
    { workspaceId: "foreign" },
  ])("rejects invalid ledger input %j", (input) => {
    expect(creditLedgerQuerySchema.safeParse(input).success).toBe(false);
  });

  it.each([
    { available: -1, reserved: 0 },
    { available: 1.5, reserved: 0 },
    { available: Number.MAX_SAFE_INTEGER + 1, reserved: 0 },
    { available: 50, reserved: 0, workspaceId: "foreign" },
  ])("rejects unsafe snapshots %j", (snapshot) => {
    expect(creditSnapshotSchema.safeParse(snapshot).success).toBe(false);
  });

  it("accepts an empty page while preserving its total and requested page", () => {
    expect(creditLedgerPageSchema.safeParse({
      items: [],
      total: 51,
      page: 3,
      pageSize: 25,
    })).toEqual({
      success: true,
      data: { items: [], total: 51, page: 3, pageSize: 25 },
    });
  });

  it("accepts a valid ledger item and rejects malformed timestamps and unsafe amounts", () => {
    expect(creditLedgerPageSchema.safeParse({
      items: [item], total: 1, page: 1, pageSize: 25,
    }).success).toBe(true);
    expect(creditLedgerPageSchema.safeParse({
      items: [{ ...item, createdAt: "yesterday" }], total: 1, page: 1, pageSize: 25,
    }).success).toBe(false);
    expect(creditLedgerPageSchema.safeParse({
      items: [{ ...item, amount: Number.MAX_SAFE_INTEGER + 1 }], total: 1, page: 1, pageSize: 25,
    }).success).toBe(false);
  });
});
