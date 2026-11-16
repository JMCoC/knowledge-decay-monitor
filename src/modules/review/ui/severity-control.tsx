"use client";

import React, { useRef, useTransition } from "react";
import type { FindingSeverity } from "@/types/contracts";
import type { FindingReviewSnapshot } from "@/types/review-contracts";
import { changeFinding } from "@/modules/review";
import { createIdempotencyKeyStore } from "./idempotency-keys";

export interface SeverityControlProps {
  findingId: string;
  severityOriginal: FindingSeverity;
  severityCurrent: FindingSeverity;
  revision: number;
  canChangeSeverity: boolean;
  onUpdated?: (updated: FindingReviewSnapshot) => void;
  onFindingUpdated?: (updated: FindingReviewSnapshot) => void;
  onError?: (error: { code: string; message: string }) => void;
}

function getSeverityBadgeStyle(severity: FindingSeverity): string {
  switch (severity) {
    case "High":
      return "bg-rose-100 text-rose-800 border-rose-300";
    case "Medium":
      return "bg-amber-100 text-amber-800 border-amber-300";
    case "Low":
      return "bg-slate-100 text-slate-800 border-slate-300";
  }
}

export function SeverityControl({
  findingId,
  severityOriginal,
  severityCurrent,
  revision,
  canChangeSeverity,
  onUpdated,
  onFindingUpdated,
  onError,
}: SeverityControlProps) {
  const [isPending, startTransition] = useTransition();
  const keyStore = useRef(createIdempotencyKeyStore());

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newSeverity = e.target.value as FindingSeverity;
    if (newSeverity === severityCurrent) return;

    startTransition(async () => {
      const signature = JSON.stringify(["change-severity", findingId, revision, newSeverity]);
      try {
        const idempotencyKey = keyStore.current.forAttempt(signature);

        const result = await changeFinding({
          findingId,
          revision,
          idempotencyKey,
          change: { field: "severity", value: newSeverity },
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
          message: "The severity update response was lost. Retry this change to safely recover it.",
        });
      }
    });
  };

  const isDisabled = !canChangeSeverity || isPending;

  return (
    <div className="flex flex-wrap items-center gap-3" data-testid="severity-control">
      {/* Immutable AI Proposed Severity Badge */}
      <div className="inline-flex items-center gap-1.5">
        <span className="sr-only">AI: {severityOriginal}</span>
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold border ${getSeverityBadgeStyle(
            severityOriginal
          )}`}
          title={`AI Proposed: ${severityOriginal}`}
        >
          AI Proposed: {severityOriginal}
        </span>
      </div>

      {/* Current Severity Selector */}
      <div className="inline-flex items-center gap-1.5">
        <label
          htmlFor={`severity-select-${findingId}`}
          className="text-xs font-medium text-slate-700"
        >
          Current:
        </label>
        <span className="sr-only">Current: {severityCurrent}</span>
        <select
          id={`severity-select-${findingId}`}
          aria-label={`Current: ${severityCurrent}`}
          value={severityCurrent}
          disabled={isDisabled}
          onChange={handleChange}
          className={`text-xs font-semibold rounded-md border px-2.5 py-1 focus:outline-none focus:ring-2 focus:ring-cyan-500 transition-colors ${getSeverityBadgeStyle(
            severityCurrent
          )} ${isDisabled ? "opacity-60 cursor-not-allowed" : "cursor-pointer"}`}
        >
          <option value="High">High</option>
          <option value="Medium">Medium</option>
          <option value="Low">Low</option>
        </select>
      </div>
    </div>
  );
}
