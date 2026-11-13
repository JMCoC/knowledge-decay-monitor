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

export interface ReviewAuditMetadata {
  previousStatus?: ReviewFindingStatus;
  status?: ReviewFindingStatus;
  previousSeverity?: FindingSeverity;
  severity?: FindingSeverity;
  assigneeId?: string | null;
  roundId?: string;
  submissionId?: string;
  candidateId?: string;
  outcome?: CorrectionDecisionOutcome;
  retention?: "retain" | "delete";
}

export interface ReviewAuditAppend {
  context: VerifiedReviewContext;
  action: ReviewAuditAction;
  entityType:
    | "finding"
    | "correction_round"
    | "correction_submission"
    | "correction_candidate";
  entityId: string;
  eventId: string;
  metadata: ReviewAuditMetadata;
}

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
