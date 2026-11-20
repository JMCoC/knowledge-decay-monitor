import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  parseAssigneesPage,
  parseCorrectionRoundSnapshot,
  parseFindingReviewSnapshot,
  parseMemberAssignment,
  parseMemberAssignmentsPage,
  parseOwnApprovalsPage,
  parseReviewRound,
  parseRoundDraftSnapshot,
} from "./mappers";

const findingId = "10000000-0000-4000-8000-000000000001";
const roundId = "20000000-0000-4000-8000-000000000001";
const documentId = "30000000-0000-4000-8000-000000000001";
const versionId = "40000000-0000-4000-8000-000000000001";
const ownerId = "50000000-0000-4000-8000-000000000001";
const assignmentSnapshot = {
  finding: {
    id: findingId,
    analysisId: "60000000-0000-4000-8000-000000000001",
    type: "contradiction",
    explanation: "The synthetic clauses disagree.",
    severityOriginal: "High",
    severityCurrent: "Medium",
    status: "confirmed",
    assignee: { id: ownerId, fullName: "Synthetic Member" },
    createdAt: "2026-11-18T00:00:00Z",
    revision: 2,
    canChangeStatus: false,
    canChangeSeverity: false,
    canAssign: false,
    canPrepareRound: false,
  },
  evidence: [],
  documents: [
    {
      documentId,
      name: "Primary policy",
      activeVersionId: versionId,
      activeVersionNumber: 2,
      canSubmit: true,
    },
    {
      documentId: "30000000-0000-4000-8000-000000000002",
      name: "Secondary policy",
      activeVersionId: null,
      activeVersionNumber: null,
      canSubmit: false,
    },
  ],
  rounds: [{
    roundId,
    documentId,
    phase: "processing_failed",
    ownCoverage: { complete: false, coveredItemCount: 1, requiredItemCount: 2 },
  }],
  ownSubmissions: [],
  returns: [],
};

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

  it("maps multidocument Member assignments with only own coverage and strips private fields", () => {
    const result = parseMemberAssignment({
      ...assignmentSnapshot,
      confidence: 0.99,
      storagePath: "PRIVATE_STORAGE_PATH",
      otherSubmissions: [{ id: "PRIVATE_SUBMISSION" }],
      rounds: [{
        ...assignmentSnapshot.rounds[0],
        otherMemberCount: 4,
      }],
    });

    expect(result.documents).toHaveLength(2);
    expect(result.documents[1]?.activeVersionId).toBeNull();
    expect(result.rounds[0]?.phase).toBe("processing_failed");
    expect(result.rounds[0]?.ownCoverage).toEqual({
      complete: false,
      coveredItemCount: 1,
      requiredItemCount: 2,
    });
    expect(result).not.toHaveProperty("confidence");
    expect(result).not.toHaveProperty("storagePath");
    expect(result).not.toHaveProperty("otherSubmissions");
    expect(result.rounds[0]).not.toHaveProperty("otherMemberCount");
  });

  it("validates pages and the minimal own approval history projection", () => {
    const result = parseMemberAssignmentsPage({
      items: [assignmentSnapshot],
      total: 1,
      page: 1,
      pageSize: 25,
      workspaceId: "PRIVATE_WORKSPACE",
    });
    expect(result.items).toHaveLength(1);
    expect(result).not.toHaveProperty("workspaceId");

    const approvals = parseOwnApprovalsPage({
      items: [{
        approvalId: roundId,
        documentId,
        approvedAt: "2026-11-18T00:00:00Z",
        ownItemCount: 2,
        versionId: "PRIVATE_VERSION",
        findingId: "PRIVATE_FINDING",
      }],
      total: 1,
      page: 1,
      pageSize: 25,
    });
    expect(approvals.items[0]).not.toHaveProperty("versionId");
    expect(approvals.items[0]).not.toHaveProperty("findingId");
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
