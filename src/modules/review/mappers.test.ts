import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  parseAssigneesPage,
  parseCorrectionRoundSnapshot,
  parseFindingReviewSnapshot,
  parseReviewRound,
  parseRoundDraftSnapshot,
} from "./mappers";

const findingId = "10000000-0000-4000-8000-000000000001";
const roundId = "20000000-0000-4000-8000-000000000001";
const documentId = "30000000-0000-4000-8000-000000000001";
const versionId = "40000000-0000-4000-8000-000000000001";
const ownerId = "50000000-0000-4000-8000-000000000001";

const roundSnapshot = {
  roundId,
  documentId,
  mode: "assigned_findings",
  baseActiveVersionId: versionId,
  status: "draft",
  revision: 1,
  createdAt: "2026-11-14T00:00:00Z",
  openedAt: null,
};

describe("review projection mappers", () => {
  it("omits confidence and unknown RPC fields from finding snapshots", () => {
    const result = parseFindingReviewSnapshot({
      id: findingId,
      analysisId: "60000000-0000-4000-8000-000000000001",
      type: "contradiction",
      explanation: "The synthetic clauses disagree.",
      severityOriginal: "High",
      severityCurrent: "Medium",
      status: "confirmed",
      assignee: { id: ownerId, fullName: "Ana Reviewer", email: "PRIVATE_EMAIL" },
      createdAt: "2026-11-14T00:00:00Z",
      revision: 4,
      canChangeStatus: true,
      canChangeSeverity: true,
      canAssign: true,
      canPrepareRound: true,
      confidence: 0.99,
      fingerprint: "PRIVATE_FINGERPRINT",
      storagePath: "PRIVATE_STORAGE_PATH",
      unexpectedRpcField: "PRIVATE_RPC_FIELD",
    });

    expect(result.assignee).toEqual({ id: ownerId, fullName: "Ana Reviewer" });
    expect(result).not.toHaveProperty("confidence");
    expect(result).not.toHaveProperty("fingerprint");
    expect(result).not.toHaveProperty("unexpectedRpcField");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  });

  it("validates the authorized assignee total and page metadata", () => {
    const result = parseAssigneesPage({
      items: [{ id: ownerId, fullName: "Ana Reviewer", email: "PRIVATE_EMAIL" }],
      total: 27,
      page: 2,
      pageSize: 25,
      workspaceId: "PRIVATE_WORKSPACE",
    });

    expect(result).toEqual({
      items: [{ id: ownerId, fullName: "Ana Reviewer" }],
      total: 27,
      page: 2,
      pageSize: 25,
    });
  });

  it("maps round and draft projections without copying unrecognized fields", () => {
    expect(parseCorrectionRoundSnapshot({ ...roundSnapshot, privateReason: "PRIVATE_REASON" })).toEqual(roundSnapshot);
    expect(parseRoundDraftSnapshot({ ...roundSnapshot, findingIds: [findingId], privateReason: "PRIVATE_REASON" }))
      .toEqual({ ...roundSnapshot, findingIds: [findingId] });
  });

  it("accepts a complete review-round projection and drops provider-only fields", () => {
    const result = parseReviewRound({
      ...roundSnapshot,
      status: "collecting",
      openedAt: "2026-11-14T01:00:00Z",
      items: [],
      submissions: [],
      coverage: { revision: 3, complete: false, coveredItemCount: 0, requiredItemCount: 1 },
      candidate: null,
      confidence: 0.99,
      evidenceHash: "PRIVATE_HASH",
    });

    expect(result).not.toHaveProperty("confidence");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_HASH");
  });

  it("does not include malformed RPC payloads in projection errors", () => {
    expect(() => parseFindingReviewSnapshot({ id: "PRIVATE_MALFORMED_PAYLOAD" })).toThrow();
    try {
      parseRoundDraftSnapshot({ ...roundSnapshot, findingIds: "PRIVATE_SELECTION" });
    } catch (error) {
      expect(String(error)).not.toContain("PRIVATE_SELECTION");
      return;
    }
    throw new Error("Expected a controlled projection parsing error.");
  });
});
