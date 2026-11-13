import type {
  CoverageSnapshot,
  ReviewAuditAppend,
  VersionWithdrawalContext,
  WorkflowNotificationRef,
} from "@/types/review-internal";

export const groupedCoverageFixture: CoverageSnapshot = {
  roundId: "00000000-0000-4000-8000-000000000701",
  revision: 3,
  items: [
    {
      itemId: "00000000-0000-4000-8000-000000000401",
      submissionId: "00000000-0000-4000-8000-000000000501",
      revision: 1,
    },
    {
      itemId: "00000000-0000-4000-8000-000000000402",
      submissionId: "00000000-0000-4000-8000-000000000501",
      revision: 1,
    },
    {
      itemId: "00000000-0000-4000-8000-000000000403",
      submissionId: "00000000-0000-4000-8000-000000000502",
      revision: 1,
    },
  ],
};

export const reviewAuditAppendFixture: ReviewAuditAppend = {
  context: {
    userId: "00000000-0000-4000-8000-000000000102",
    workspaceId: "00000000-0000-4000-8000-000000000001",
    role: "QA Lead",
  },
  action: "correction_items_returned",
  entityType: "correction_round",
  entityId: "00000000-0000-4000-8000-000000000701",
  eventId: "00000000-0000-4000-8000-000000000991",
  metadata: {
    roundId: "00000000-0000-4000-8000-000000000701",
    outcome: "rejected",
  },
};

export const assignmentNotificationRefFixture: WorkflowNotificationRef = {
  eventId: "00000000-0000-4000-8000-000000000992",
  workspaceId: "00000000-0000-4000-8000-000000000001",
  recipientId: "00000000-0000-4000-8000-000000000101",
  kind: "assignment",
};

export const versionWithdrawalContextFixture: VersionWithdrawalContext = {
  workspaceId: "00000000-0000-4000-8000-000000000001",
  documentId: "00000000-0000-4000-8000-000000000801",
  withdrawnVersionId: "00000000-0000-4000-8000-000000000901",
  replacementVersionId: "00000000-0000-4000-8000-000000000610",
  approvalId: "00000000-0000-4000-8000-000000000993",
};
