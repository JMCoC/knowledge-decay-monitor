import type { FindingReviewSnapshot, ReviewFindingStatus } from "@/types/review-contracts";

const transitions: Record<ReviewFindingStatus, readonly ReviewFindingStatus[]> = {
  pending_review: ["confirmed", "false_positive"],
  confirmed: ["update_planned", "resolved"],
  false_positive: ["resolved"],
  update_planned: ["resolved"],
  resolved: [],
};

export function isFindingTransitionAllowed(
  from: ReviewFindingStatus,
  to: ReviewFindingStatus,
): boolean {
  return transitions[from].includes(to);
}

export function getFindingReviewCapabilities(
  status: ReviewFindingStatus,
): Pick<FindingReviewSnapshot, "canChangeStatus" | "canChangeSeverity" | "canAssign"> {
  return {
    canChangeStatus: transitions[status].length > 0,
    canChangeSeverity: true,
    canAssign: status === "confirmed" || status === "update_planned",
  };
}
