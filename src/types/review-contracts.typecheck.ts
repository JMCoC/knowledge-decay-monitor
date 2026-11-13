import type {
  CorrectionCandidateStatus,
  CorrectionIngestionApi,
  CorrectionSelectionKind,
  CorrectionRoundMode,
  CorrectionRoundStatus,
  CorrectionSubmissionState,
  MemberAssignment,
  ReviewFindingStatus,
  ReserveCorrectionInput,
} from "./review-contracts";
import type { CorrectionDecisionOutcome } from "./review-internal";
import type { Database } from "./database";

type Equal<Left, Right> = [Left] extends [Right]
  ? ([Right] extends [Left] ? true : false)
  : false;
type Assert<T extends true> = T;

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

declare const corrections: CorrectionIngestionApi;
declare const draft: ReserveCorrectionInput;
declare const memberView: MemberAssignment;

// @ts-expect-error tenant is derived from the verified session
void corrections.reserveCorrection({ ...draft, workspaceId: "foreign" });

// @ts-expect-error another contributor's files are private
void memberView.otherSubmissions;

// @ts-expect-error approval explicitly chooses retention
void corrections.approveCorrection({ candidateId: "candidate-id", revision: 1, idempotencyKey: "key" });
