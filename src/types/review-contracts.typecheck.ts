import type {
  CorrectionCandidateStatus,
  CorrectionIngestionApi,
  CorrectionSelectionKind,
  CorrectionRoundMode,
  CorrectionRoundStatus,
  CorrectionSubmissionState,
  MemberAssignment,
  OwnApprovalItem,
  ReviewFindingStatus,
  ReserveCorrectionInput,
} from "./review-contracts";
import type {
  CorrectionDecisionOutcome,
  ReviewAuditAction,
  WorkflowNotificationKind,
} from "./review-internal";
import type { Database } from "./database";
import type { ActionErrorCode, ActionResult } from "./contracts";

type Equal<Left, Right> = [Left] extends [Right]
  ? ([Right] extends [Left] ? true : false)
  : false;
type Assert<T extends true> = T;
export type ReviewAccessErrorsRemainControlled = Assert<Equal<
  Extract<ActionErrorCode, "FORBIDDEN" | "NOT_FOUND">,
  "FORBIDDEN" | "NOT_FOUND"
>>;

export type ReviewFindingStatusMatchesDatabase = Assert<Equal<
  ReviewFindingStatus,
  Database["public"]["Enums"]["finding_status"]
>>;
export type CorrectionRoundModeMatchesDatabase = Assert<Equal<
  CorrectionRoundMode,
  Database["public"]["Enums"]["correction_round_mode"]
>>;
export type CorrectionRoundStatusMatchesDatabase = Assert<Equal<
  CorrectionRoundStatus,
  Database["public"]["Enums"]["correction_round_status"]
>>;
export type CorrectionCandidateStatusMatchesDatabase = Assert<Equal<
  CorrectionCandidateStatus,
  Database["public"]["Enums"]["correction_candidate_status"]
>>;
export type CorrectionSubmissionStateMatchesDatabase = Assert<Equal<
  CorrectionSubmissionState,
  Database["public"]["Enums"]["correction_submission_state"]
>>;
export type CorrectionSelectionKindMatchesDatabase = Assert<Equal<
  CorrectionSelectionKind,
  Database["public"]["Enums"]["correction_selection_kind"]
>>;
export type CorrectionDecisionOutcomeMatchesDatabase = Assert<Equal<
  CorrectionDecisionOutcome,
  Database["public"]["Enums"]["correction_decision_outcome"]
>>;
export type ReviewAuditActionMatchesDatabase = Assert<Equal<
  ReviewAuditAction,
  Database["public"]["Enums"]["review_audit_action"]
>>;
export type WorkflowNotificationKindMatchesDatabase = Assert<Equal<
  WorkflowNotificationKind,
  Database["public"]["Enums"]["workflow_notification_type"]
>>;

declare const corrections: CorrectionIngestionApi;
declare const draft: ReserveCorrectionInput;
declare const memberView: MemberAssignment;
declare const ownApproval: OwnApprovalItem;
declare const accessResult: ActionResult<void>;

// @ts-expect-error tenant is derived from the verified session
void corrections.reserveCorrection({ ...draft, workspaceId: "foreign" });

// @ts-expect-error another contributor's files are private
void memberView.otherSubmissions;

// @ts-expect-error a return DTO omits the prior submission/file reference
void memberView.returns[0].previousSubmissionId;

// @ts-expect-error an approval summary never restores a source file
void ownApproval.versionId;

// @ts-expect-error an approval summary does not identify individual findings
void ownApproval.findingId;

if (!accessResult.ok) {
  // @ts-expect-error database and provider diagnostics are not public errors
  void accessResult.error.sqlState;
}

// @ts-expect-error approval explicitly chooses retention
void corrections.approveCorrection({ candidateId: "candidate-id", revision: 1, idempotencyKey: "key" });
