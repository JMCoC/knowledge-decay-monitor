import type {
  ActionResult,
  EligibleOwner,
  FindingEvidenceItem,
  FindingSeverity,
  FindingSummary,
  ProcessingStatus,
  UploadItemInput,
  UploadReference,
  UploadSnapshot,
  UploadTarget,
  VersionStatus,
} from "./contracts";

export type ReviewFindingStatus =
  | "pending_review"
  | "confirmed"
  | "false_positive"
  | "update_planned"
  | "resolved";

export type CorrectionRoundMode = "assigned_findings" | "administrative";

export type CorrectionSubmissionState = "reserved" | "confirmed" | "expired" | "invalidated";

export type CorrectionSelectionKind = "direct" | "consolidated";

export type CorrectionRoundStatus =
  | "draft"
  | "collecting"
  | "consolidating"
  | "candidate_processing"
  | "candidate_failed"
  | "pending_approval"
  | "approved"
  | "cancelled";

export type CorrectionCandidateStatus =
  | "reserved"
  | "selected"
  | "processing"
  | "failed"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "invalidated";

export type MemberAssignmentPhase =
  | "waiting"
  | "consolidating"
  | "processing"
  | "review"
  | "approved";

/** Review lists default to 1 / 25 and cap pageSize at 100 when implemented. */
export interface ReviewPageQuery {
  page?: number;
  pageSize?: number;
}

export interface ReviewPage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export type ChangeFindingInput = {
  findingId: string;
  revision: number;
  idempotencyKey: string;
} & (
  | { change: { field: "status"; value: ReviewFindingStatus } }
  | { change: { field: "severity"; value: FindingSeverity } }
);

export interface AssignFindingInput {
  findingId: string;
  revision: number;
  assigneeId: string | null;
  idempotencyKey: string;
}

export type ListAssigneesInput = ReviewPageQuery;

export type PrepareRoundInput =
  | {
      documentId: string;
      mode: "assigned_findings";
      /** Non-empty and duplicate-free after boundary validation. */
      findingIds: [string, ...string[]];
      idempotencyKey: string;
    }
  | {
      documentId: string;
      mode: "administrative";
      idempotencyKey: string;
    };

export interface OpenRoundInput {
  roundId: string;
  revision: number;
  idempotencyKey: string;
}

export interface CancelRoundInput {
  roundId: string;
  revision: number;
  /** Private reason; trim and limit to 2,000 characters at the owning boundary. */
  reason: string;
  idempotencyKey: string;
}

/** S1 transfer declarations; the server owns storage paths and persisted hashes. */
export type CorrectionFileInput = Pick<
  UploadItemInput,
  "fileName" | "declaredMimeType" | "sizeBytes" | "signature" | "sha256"
>;

export interface ReserveCorrectionInput {
  roundId: string;
  baseActiveVersionId: string;
  /** Non-empty and duplicate-free after boundary validation. */
  findingIds: [string, ...string[]];
  /** Keys must match findingIds exactly; the ingestion boundary validates both. */
  expectedRevisions: Record<string, number>;
  file: CorrectionFileInput;
  idempotencyKey: string;
}

export interface FinalizeCorrectionInput {
  submissionId: string;
  versionId: string;
  attemptId: string;
}

export interface ResumeCorrectionInput {
  submissionId: string;
  reference?: UploadReference;
}

export interface SelectFinalCandidateInput {
  roundId: string;
  revision: number;
  submissionId: string;
  idempotencyKey: string;
}

export interface ReserveConsolidatedFileInput {
  roundId: string;
  revision: number;
  file: CorrectionFileInput;
  idempotencyKey: string;
}

export interface FinalizeConsolidatedFileInput {
  candidateId: string;
  versionId: string;
  attemptId: string;
  expectedCoverageRevision: number;
}

export interface RetryCorrectionCandidateInput {
  candidateId: string;
  revision: number;
  idempotencyKey: string;
}

export interface ReturnRoundItemsInput {
  roundId: string;
  revision: number;
  items: {
    itemId: string;
    expectedRevision: number;
    /** Private to the recipient; trim and validate at the owning boundary. */
    reason: string;
  }[];
  idempotencyKey: string;
}

export interface RejectAdministrativeCandidateInput {
  candidateId: string;
  revision: number;
  /** Private reason; trim and limit to 2,000 characters at the owning boundary. */
  reason: string;
  idempotencyKey: string;
}

export interface ApproveCorrectionInput {
  candidateId: string;
  revision: number;
  retention: "retain" | "delete";
  idempotencyKey: string;
}

export type FindingReviewSnapshot = Omit<FindingSummary, "status"> & {
  status: ReviewFindingStatus;
  revision: number;
  canChangeStatus: boolean;
  canChangeSeverity: boolean;
  canAssign: boolean;
  canPrepareRound: boolean;
};

export interface CorrectionRoundSnapshot {
  roundId: string;
  documentId: string;
  mode: CorrectionRoundMode;
  baseActiveVersionId: string;
  status: CorrectionRoundStatus;
  revision: number;
  createdAt: string;
  openedAt: string | null;
}

export interface CorrectionRoundItemSnapshot {
  itemId: string;
  finding: FindingReviewSnapshot;
  initialAssignee: EligibleOwner | null;
  assignee: EligibleOwner | null;
  revision: number;
  currentSubmissionId: string | null;
}

export interface RoundCoverageSnapshot {
  revision: number;
  complete: boolean;
  coveredItemCount: number;
  requiredItemCount: number;
}

export interface CorrectionSubmissionSnapshot {
  submissionId: string;
  versionId: string;
  state: CorrectionSubmissionState;
  submitter: EligibleOwner;
  itemIds: string[];
  upload: UploadSnapshot;
  confirmedAt: string | null;
}

export interface CorrectionCandidateSnapshot {
  candidateId: string;
  versionId: string;
  selectionKind: CorrectionSelectionKind;
  status: CorrectionCandidateStatus;
  processingStatus: ProcessingStatus;
  versionStatus: VersionStatus | null;
  revision: number;
  coverageRevision: number;
  itemIds: string[];
}

export interface ReviewRound extends CorrectionRoundSnapshot {
  items: CorrectionRoundItemSnapshot[];
  submissions: CorrectionSubmissionSnapshot[];
  coverage: RoundCoverageSnapshot;
  candidate: CorrectionCandidateSnapshot | null;
}

export interface CorrectionReturnForMember {
  itemId: string;
  reason: string;
  createdAt: string;
}

export interface MemberAssignment {
  finding: FindingReviewSnapshot;
  evidence: FindingEvidenceItem[];
  document: {
    documentId: string;
    name: string;
    activeVersionId: string;
    activeVersionNumber: number;
  };
  round: {
    roundId: string;
    phase: MemberAssignmentPhase;
  };
  ownSubmissions: CorrectionSubmissionSnapshot[];
  returns: CorrectionReturnForMember[];
  canSubmit: boolean;
}

export interface OwnApprovalItem {
  approvalId: string;
  documentId: string;
  approvedAt: string;
  ownItemCount: number;
}

export interface CorrectionApprovalSnapshot {
  approvalId: string;
  documentId: string;
  activeVersionId: string;
  analysisStatus: "pending_reanalysis";
  retention: "retain" | "delete";
  approvedAt: string;
}

export interface CorrectionUploadReservation {
  submissionId: string;
  target: UploadTarget;
}

export interface ConsolidatedFileReservation {
  candidateId: string;
  target: UploadTarget;
}

export interface ListAssignmentsInput extends ReviewPageQuery {
  status?: ReviewFindingStatus;
}

export interface ListCorrectionRoundsInput extends ReviewPageQuery {
  documentId?: string;
  status?: CorrectionRoundStatus;
}

export type ListOwnApprovalsInput = ReviewPageQuery;

export interface ReviewApi {
  changeFinding(input: ChangeFindingInput): Promise<ActionResult<FindingReviewSnapshot>>;
  assignFinding(input: AssignFindingInput): Promise<ActionResult<FindingReviewSnapshot>>;
  listAssignees(input: ListAssigneesInput): Promise<ActionResult<ReviewPage<EligibleOwner>>>;
  prepareRound(input: PrepareRoundInput): Promise<ActionResult<CorrectionRoundSnapshot>>;
  openRound(input: OpenRoundInput): Promise<ActionResult<ReviewRound>>;
  cancelRound(input: CancelRoundInput): Promise<ActionResult<CorrectionRoundSnapshot>>;
}

export interface CorrectionIngestionApi {
  reserveCorrection(input: ReserveCorrectionInput): Promise<ActionResult<CorrectionUploadReservation>>;
  finalizeCorrection(input: FinalizeCorrectionInput): Promise<ActionResult<CorrectionSubmissionSnapshot>>;
  resumeCorrection(input: ResumeCorrectionInput): Promise<ActionResult<UploadTarget | UploadSnapshot>>;
  selectFinalCandidate(input: SelectFinalCandidateInput): Promise<ActionResult<CorrectionCandidateSnapshot>>;
  reserveConsolidatedFile(input: ReserveConsolidatedFileInput): Promise<ActionResult<ConsolidatedFileReservation>>;
  finalizeConsolidatedFile(input: FinalizeConsolidatedFileInput): Promise<ActionResult<CorrectionCandidateSnapshot>>;
  retryCorrectionCandidate(input: RetryCorrectionCandidateInput): Promise<ActionResult<CorrectionCandidateSnapshot>>;
  returnRoundItems(input: ReturnRoundItemsInput): Promise<ActionResult<CorrectionRoundSnapshot>>;
  rejectAdministrativeCandidate(input: RejectAdministrativeCandidateInput): Promise<ActionResult<CorrectionCandidateSnapshot>>;
  approveCorrection(input: ApproveCorrectionInput): Promise<ActionResult<CorrectionApprovalSnapshot>>;
}

export interface ReviewRepositoryApi {
  listAssignments(input: ListAssignmentsInput): Promise<ActionResult<ReviewPage<MemberAssignment>>>;
  getAssignment(findingId: string): Promise<ActionResult<MemberAssignment>>;
  listCorrectionRounds(input: ListCorrectionRoundsInput): Promise<ActionResult<ReviewPage<ReviewRound>>>;
  getCorrectionRound(roundId: string): Promise<ActionResult<ReviewRound>>;
  listOwnApprovals(input: ListOwnApprovalsInput): Promise<ActionResult<ReviewPage<OwnApprovalItem>>>;
  getWorkflowOriginalUrl(versionId: string): Promise<ActionResult<{ url: string; expiresAt: string }>>;
}
