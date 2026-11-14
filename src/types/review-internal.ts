import type { WorkspaceRole } from "./contracts";
import type { FindingSeverity } from "./contracts";
import type {
  ReviewFindingStatus,
} from "./review-contracts";

/** Built on the server from verified Auth and the persisted Profile. */
export interface VerifiedReviewContext {
  userId: string;
  workspaceId: string;
  role: WorkspaceRole;
}

/** Snapshot used by a transaction to prove which confirmed files cover a round. */
export interface CoverageSnapshot {
  roundId: string;
  revision: number;
  items: {
    itemId: string;
    submissionId: string;
    revision: number;
  }[];
}

export type CorrectionDecisionOutcome = "approved" | "rejected" | "invalidated";

export type ReviewAuditAction =
  | "finding_status_changed"
  | "finding_severity_changed"
  | "finding_assigned"
  | "correction_round_prepared"
  | "correction_round_opened"
  | "correction_round_cancelled"
  | "correction_submission_confirmed"
  | "correction_candidate_selected"
  | "correction_items_returned"
  | "correction_candidate_approved"
  | "correction_candidate_rejected"
  | "correction_candidate_invalidated";

export type ReviewAuditMetadata =
  | { previousStatus: ReviewFindingStatus; status: ReviewFindingStatus }
  | { previousSeverity: FindingSeverity; severity: FindingSeverity }
  | { assigneeId: string | null }
  | { roundId: string }
  | { roundId: string; outcome: Exclude<CorrectionDecisionOutcome, "approved"> }
  | { roundId: string; submissionId: string }
  | { candidateId: string; roundId: string }
  | { candidateId: string; outcome: "approved"; retention: "retain" | "delete" }
  | { candidateId: string; outcome: Exclude<CorrectionDecisionOutcome, "approved"> };

interface ReviewAuditAppendBase {
  context: VerifiedReviewContext;
  entityId: string;
  eventId: string;
}

export type ReviewAuditAppend = ReviewAuditAppendBase & (
  | {
      action: "finding_status_changed";
      entityType: "finding";
      metadata: { previousStatus: ReviewFindingStatus; status: ReviewFindingStatus };
    }
  | {
      action: "finding_severity_changed";
      entityType: "finding";
      metadata: { previousSeverity: FindingSeverity; severity: FindingSeverity };
    }
  | {
      action: "finding_assigned";
      entityType: "finding";
      metadata: { assigneeId: string | null };
    }
  | {
      action: "correction_round_prepared" | "correction_round_opened" | "correction_round_cancelled";
      entityType: "correction_round";
      metadata: { roundId: string };
    }
  | {
      action: "correction_submission_confirmed";
      entityType: "correction_submission";
      metadata: { roundId: string; submissionId: string };
    }
  | {
      action: "correction_candidate_selected";
      entityType: "correction_candidate";
      metadata: { candidateId: string; roundId: string };
    }
  | {
      action: "correction_items_returned";
      entityType: "correction_round";
      metadata: { roundId: string; outcome: "rejected" | "invalidated" };
    }
  | {
      action: "correction_candidate_approved";
      entityType: "correction_candidate";
      metadata: { candidateId: string; outcome: "approved"; retention: "retain" | "delete" };
    }
  | {
      action: "correction_candidate_rejected";
      entityType: "correction_candidate";
      metadata: { candidateId: string; outcome: "rejected" };
    }
  | {
      action: "correction_candidate_invalidated";
      entityType: "correction_candidate";
      metadata: { candidateId: string; outcome: "invalidated" };
    }
);

export type WorkflowNotificationKind =
  | "assignment"
  | "version_approved"
  | "version_rejected";

/** Reference only; recipient email, document text, and delivery leases stay private. */
export interface WorkflowNotificationRef {
  eventId: string;
  workspaceId: string;
  recipientId: string;
  kind: WorkflowNotificationKind;
}

/** Context for S3-10 to unlink an approved replacement's retained predecessor. */
export interface VersionWithdrawalContext {
  workspaceId: string;
  documentId: string;
  withdrawnVersionId: string;
  replacementVersionId: string;
  approvalId: string;
}
