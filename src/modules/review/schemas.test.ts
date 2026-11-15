import { describe, expect, it } from "vitest";
import {
  cancelRoundSchema,
  prepareRoundSchema,
  reviewPageSchema,
  updateRoundDraftSchema,
} from "./schemas";

const id = (last: string) => `123e4567-e89b-42d3-a456-${last.padStart(12, "0")}`;

describe("review command schemas", () => {
  it("accepts draft sizes from one to one hundred and rejects empty, oversized, or duplicate sets", () => {
    const common = { documentId: id("1"), mode: "assigned_findings", idempotencyKey: "draft-key" };
    expect(prepareRoundSchema.safeParse({ ...common, findingIds: [id("2")] }).success).toBe(true);
    expect(prepareRoundSchema.safeParse({ ...common, findingIds: Array.from({ length: 100 }, (_, i) => id(String(i + 2))) }).success).toBe(true);
    expect(prepareRoundSchema.safeParse({ ...common, findingIds: [] }).success).toBe(false);
    expect(prepareRoundSchema.safeParse({ ...common, findingIds: Array.from({ length: 101 }, (_, i) => id(String(i + 2))) }).success).toBe(false);
    expect(prepareRoundSchema.safeParse({ ...common, findingIds: [id("2"), id("2")] }).success).toBe(false);
  });

  it("normalizes UUIDs and sorts draft finding IDs while preserving the idempotency key", () => {
    const parsed = updateRoundDraftSchema.safeParse({
      roundId: id("1"), revision: 1, findingIds: [id("3").toUpperCase(), id("2")], idempotencyKey: "unchanged",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.findingIds).toEqual([id("2"), id("3")]);
      expect(parsed.data.idempotencyKey).toBe("unchanged");
    }
  });

  it("rejects UUID duplicates after canonicalization", () => {
    const first = id("2");
    const second = first.toUpperCase();
    expect(updateRoundDraftSchema.safeParse({
      roundId: id("1"), revision: 1, findingIds: [first, second], idempotencyKey: "key",
    }).success).toBe(false);
  });

  it("rejects client supplied authorization fields and whitespace around idempotency keys", () => {
    expect(updateRoundDraftSchema.safeParse({
      roundId: id("1"), revision: 1, findingIds: [id("2")], idempotencyKey: "key", workspaceId: id("9"),
    }).success).toBe(false);
    expect(updateRoundDraftSchema.safeParse({
      roundId: id("1"), revision: 1, findingIds: [id("2")], idempotencyKey: " key ",
    }).success).toBe(false);
  });

  it("requires safe positive revisions and trims private cancellation reasons", () => {
    for (const revision of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(cancelRoundSchema.safeParse({ roundId: id("1"), revision, reason: "valid", idempotencyKey: "key" }).success).toBe(false);
    }
    expect(cancelRoundSchema.safeParse({ roundId: id("1"), revision: 1, reason: "   ", idempotencyKey: "key" }).success).toBe(false);
    const parsed = cancelRoundSchema.safeParse({ roundId: id("1"), revision: 1, reason: "  Duplicate  ", idempotencyKey: "key" });
    expect(parsed.success && parsed.data.reason).toBe("Duplicate");
  });

  it("uses page 1 and size 25 by default and caps page size at 100", () => {
    expect(reviewPageSchema.parse({})).toEqual({ page: 1, pageSize: 25 });
    expect(reviewPageSchema.safeParse({ pageSize: 100 }).success).toBe(true);
    expect(reviewPageSchema.safeParse({ pageSize: 101 }).success).toBe(false);
  });
});
