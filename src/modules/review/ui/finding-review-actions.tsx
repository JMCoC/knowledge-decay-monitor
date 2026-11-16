"use client";

import React, { useRef, useTransition } from "react";
import type { FindingReviewSnapshot, ReviewFindingStatus } from "@/types/review-contracts";
import { changeFinding } from "@/modules/review";
import { createIdempotencyKeyStore } from "./idempotency-keys";

export interface FindingReviewActionsProps {
  findingId: string;
  status: ReviewFindingStatus;
  revision: number;
  canChangeStatus: boolean;
  onUpdated?: (updated: FindingReviewSnapshot) => void;
  onFindingUpdated?: (updated: FindingReviewSnapshot) => void;
  onError?: (error: { code: string; message: string }) => void;
}

export function FindingReviewActions({
  findingId,
  status,
  revision,
  canChangeStatus,
  onUpdated,
  onFindingUpdated,
  onError,
}: FindingReviewActionsProps) {
  const [isPending, startTransition] = useTransition();
  const keyStore = useRef(createIdempotencyKeyStore());

  const handleTransition = (targetStatus: ReviewFindingStatus) => {
    startTransition(async () => {
      const signature = JSON.stringify(["change-status", findingId, revision, targetStatus]);
      try {
        const idempotencyKey = keyStore.current.forAttempt(signature);

        const result = await changeFinding({
          findingId,
          revision,
          idempotencyKey,
          change: { field: "status", value: targetStatus },
        });

        if (!result.ok) {
          keyStore.current.clear(signature);
          onError?.(result.error);
          return;
        }
        keyStore.current.clear(signature);

        onUpdated?.(result.data);
        onFindingUpdated?.(result.data);
      } catch {
        onError?.({
          code: "TRANSPORT_ERROR",
          message: "The status update response was lost. Retry this action to safely recover it.",
        });
      }
    });
  };

  const isDisabled = !canChangeStatus || isPending;

  if (status === "resolved") {
    return (
      <div className="inline-flex items-center" data-testid="finding-review-actions">
        <span
          className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-semibold bg-emerald-100 text-emerald-800 border border-emerald-300"
          title="Finding is resolved"
        >
          Resolved
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="finding-review-actions">
      {status === "pending_review" && (
        <>
          <button
            type="button"
            disabled={isDisabled}
            onClick={() => handleTransition("confirmed")}
            className="px-3 py-1 text-xs font-medium rounded-md bg-cyan-600 text-white hover:bg-cyan-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isPending ? "Updating..." : "Confirm"}
          </button>
          <button
            type="button"
            disabled={isDisabled}
            onClick={() => handleTransition("false_positive")}
            className="px-3 py-1 text-xs font-medium rounded-md bg-slate-100 text-slate-700 hover:bg-slate-200 border border-slate-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isPending ? "Updating..." : "Mark as False Positive"}
          </button>
        </>
      )}

      {status === "confirmed" && (
        <>
          <button
            type="button"
            disabled={isDisabled}
            onClick={() => handleTransition("update_planned")}
            className="px-3 py-1 text-xs font-medium rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isPending ? "Updating..." : "Plan Update"}
          </button>
          <button
            type="button"
            disabled={isDisabled}
            onClick={() => handleTransition("resolved")}
            className="px-3 py-1 text-xs font-medium rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isPending ? "Updating..." : "Resolve Manually"}
          </button>
        </>
      )}

      {(status === "false_positive" || status === "update_planned") && (
        <button
          type="button"
          disabled={isDisabled}
          onClick={() => handleTransition("resolved")}
          className="px-3 py-1 text-xs font-medium rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isPending ? "Updating..." : "Resolve Manually"}
        </button>
      )}
    </div>
  );
}
