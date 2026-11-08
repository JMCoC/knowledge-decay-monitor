"use client";

import React from "react";
import type { AnalysisSelectionItem, AnalysisEstimate } from "@/types/contracts";

interface ScopeSummarySidebarProps {
  sources: AnalysisSelectionItem[];
  comparisons: AnalysisSelectionItem[];
  onRemoveSource: (versionId: string) => void;
  onRemoveComparison: (versionId: string) => void;
  estimate: AnalysisEstimate | null;
  onCalculateEstimate: () => void;
  onProceedToRun: () => void;
  isEstimating: boolean;
  validationError: string | null;
}

export function ScopeSummarySidebar({
  sources,
  comparisons,
  onRemoveSource,
  onRemoveComparison,
  estimate,
  onCalculateEstimate,
  onProceedToRun,
  isEstimating,
  validationError,
}: ScopeSummarySidebarProps) {
  const distinctIds = new Set([
    ...sources.map((s) => s.versionId),
    ...comparisons.map((c) => c.versionId),
  ]);
  const distinctCount = distinctIds.size;
  const isOverLimit = distinctCount > 20;
  const hasNoSources = sources.length === 0;

  return (
    <aside className="sticky top-6 flex flex-col gap-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      {/* Header & Counter */}
      <div>
        <h2 className="text-base font-semibold text-slate-900">Scope Summary</h2>
        <div className="mt-2 flex items-center justify-between text-sm">
          <span className="font-medium text-slate-600">Total Selection</span>
          <span className={`font-semibold ${isOverLimit ? "text-rose-600" : "text-cyan-900"}`}>
            {distinctCount} / 20 distinct versions
          </span>
        </div>
        {/* Progress bar */}
        <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-slate-100">
          <div
            className={`h-full transition-all duration-300 ${
              isOverLimit ? "bg-rose-500" : distinctCount >= 16 ? "bg-amber-500" : "bg-cyan-600"
            }`}
            style={{ width: `${Math.min(100, (distinctCount / 20) * 100)}%` }}
          />
        </div>
        <p className="mt-1.5 text-xs text-slate-400">
          Versions present in both lists count once toward the 20-version limit.
        </p>
      </div>

      {/* Validation Error Alert */}
      {validationError && (
        <div role="alert" className="rounded-lg bg-rose-50 p-3 text-xs text-rose-800 border border-rose-200">
          {validationError}
        </div>
      )}

      {/* Documents to Analyze List */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Documents to analyze ({sources.length})
        </h3>
        {sources.length === 0 ? (
          <p className="mt-1.5 text-xs italic text-slate-400">At least 1 source document required.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1.5 max-h-36 overflow-y-auto">
            {sources.map((item) => (
              <li
                key={item.versionId}
                className="flex items-center justify-between rounded bg-slate-50 px-2 py-1 text-xs text-slate-800"
              >
                <span className="truncate pr-2">{item.name} <span className="text-slate-400">v{item.versionNumber}</span></span>
                <button
                  type="button"
                  onClick={() => onRemoveSource(item.versionId)}
                  className="text-slate-400 hover:text-rose-600"
                  aria-label={`Remove ${item.name} from sources`}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Compare Against List */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Compare against ({comparisons.length})
        </h3>
        {comparisons.length === 0 ? (
          <div className="mt-1.5 rounded bg-cyan-50 p-2 text-xs text-cyan-900 border border-cyan-100">
            {hasNoSources
              ? "No comparisons selected."
              : "No comparison documents selected. Running internal contradiction analysis only."}
          </div>
        ) : (
          <ul className="mt-2 flex flex-col gap-1.5 max-h-36 overflow-y-auto">
            {comparisons.map((item) => (
              <li
                key={item.versionId}
                className="flex items-center justify-between rounded bg-slate-50 px-2 py-1 text-xs text-slate-800"
              >
                <span className="truncate pr-2">{item.name} <span className="text-slate-400">v{item.versionNumber}</span></span>
                <button
                  type="button"
                  onClick={() => onRemoveComparison(item.versionId)}
                  className="text-slate-400 hover:text-rose-600"
                  aria-label={`Remove ${item.name} from comparisons`}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Estimation Card */}
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-center">
        {estimate ? (
          <div>
            <span className="text-xs font-medium text-slate-500">Estimated Cost</span>
            <div className="mt-1 text-lg font-bold text-cyan-950">
              Estimated cost: {estimate.fixedCost} credits
            </div>
          </div>
        ) : (
          <div>
            <button
              type="button"
              disabled={hasNoSources || isOverLimit || isEstimating}
              onClick={onCalculateEstimate}
              className="w-full rounded-md bg-slate-800 py-2 text-xs font-semibold text-white hover:bg-slate-900 disabled:opacity-40"
            >
              {isEstimating ? "Calculating…" : "Calculate Estimated Cost"}
            </button>
            <p className="mt-1 text-xs text-slate-400">Recalculated whenever selection changes</p>
          </div>
        )}
      </div>

      {/* Proceed CTA */}
      <button
        type="button"
        disabled={hasNoSources || isOverLimit || !estimate}
        onClick={onProceedToRun}
        className="w-full rounded-lg bg-cyan-600 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-cyan-700 disabled:opacity-40"
      >
        Proceed to Run Analysis
      </button>
    </aside>
  );
}
