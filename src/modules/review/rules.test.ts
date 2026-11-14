import { describe, expect, it } from "vitest";
import { getFindingReviewCapabilities, isFindingTransitionAllowed } from "./rules";
import type { ReviewFindingStatus } from "@/types/review-contracts";

const statuses: ReviewFindingStatus[] = [
  "pending_review", "confirmed", "false_positive", "update_planned", "resolved",
];

describe("review finding rules", () => {
  it("allows only the six PRD status transitions", () => {
    const allowed: [ReviewFindingStatus, ReviewFindingStatus][] = [
      ["pending_review", "confirmed"],
      ["pending_review", "false_positive"],
      ["confirmed", "update_planned"],
      ["confirmed", "resolved"],
      ["update_planned", "resolved"],
      ["false_positive", "resolved"],
    ];

    for (const from of statuses) {
      for (const to of statuses) {
        expect(isFindingTransitionAllowed(from, to), `${from} -> ${to}`).toBe(
          allowed.some(([source, target]) => source === from && target === to),
        );
      }
    }
  });

  it("does not treat a status no-op as a transition", () => {
    for (const status of statuses) {
      expect(isFindingTransitionAllowed(status, status)).toBe(false);
    }
  });

  it("keeps only severity changes available after resolution", () => {
    expect(getFindingReviewCapabilities("resolved")).toEqual({
      canChangeStatus: false,
      canChangeSeverity: true,
      canAssign: false,
    });
  });

  it("exposes status and assignment changes only in operable states", () => {
    expect(getFindingReviewCapabilities("confirmed")).toEqual({
      canChangeStatus: true,
      canChangeSeverity: true,
      canAssign: true,
    });
    expect(getFindingReviewCapabilities("false_positive")).toEqual({
      canChangeStatus: true,
      canChangeSeverity: true,
      canAssign: false,
    });
  });
});
