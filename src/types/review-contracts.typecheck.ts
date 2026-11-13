import type {
  CorrectionIngestionApi,
  MemberAssignment,
  ReserveCorrectionInput,
} from "./review-contracts";

declare const corrections: CorrectionIngestionApi;
declare const draft: ReserveCorrectionInput;
declare const memberView: MemberAssignment;

// @ts-expect-error tenant is derived from the verified session
void corrections.reserveCorrection({ ...draft, workspaceId: "foreign" });

// @ts-expect-error another contributor's files are private
void memberView.otherSubmissions;

// @ts-expect-error approval explicitly chooses retention
void corrections.approveCorrection({ candidateId: "candidate-id", revision: 1, idempotencyKey: "key" });
