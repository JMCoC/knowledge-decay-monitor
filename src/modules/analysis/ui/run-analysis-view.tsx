"use client";

import React, { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { AnalysisSelectionItem, AnalysisEstimate, EligibleDocumentsQuery } from "@/types/contracts";
import { DocumentSelectionTable } from "./document-selection-table";
import { ScopeSummarySidebar } from "./scope-summary-sidebar";
import { listEligibleDocumentsAction, resolveFilteredScopeAction, estimateAnalysisAction, getActiveAnalysisAction } from "../application/analysis.actions";
import { runAnalysis } from "../application/run-actions";

interface RunAnalysisViewProps {
  initialItems: AnalysisSelectionItem[];
  initialTotal: number;
  eligibleOwners: Array<{ id: string; fullName: string }>;
}

type AnalysisSelectionFilters = Pick<EligibleDocumentsQuery, "name" | "category" | "ownerId">;

export function mergeAnalysisSelectionFilters(
  current: AnalysisSelectionFilters,
  patch: AnalysisSelectionFilters,
): AnalysisSelectionFilters {
  const next = { ...current, ...patch };
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined || value === "") delete next[key as keyof AnalysisSelectionFilters];
  }
  return next;
}

export function RunAnalysisView({
  initialItems,
  initialTotal,
  eligibleOwners,
}: RunAnalysisViewProps) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<"sources" | "comparisons">("sources");
  const [items, setItems] = useState<AnalysisSelectionItem[]>(initialItems);
  const [total, setTotal] = useState(initialTotal);
  const [selectedSources, setSelectedSources] = useState<Map<string, AnalysisSelectionItem>>(new Map());
  const [selectedComparisons, setSelectedComparisons] = useState<Map<string, AnalysisSelectionItem>>(new Map());
  const [estimate, setEstimate] = useState<AnalysisEstimate | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isEstimating, setIsEstimating] = useState(false);
  const [isBulkLoading, setIsBulkLoading] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const idempotencyKey = useRef<string | null>(null);
  const [page, setPage] = useState(1);
  const [currentFilters, setCurrentFilters] = useState<AnalysisSelectionFilters>({});
  const scopeRevision = useRef(0);

  const sourceVersionIds = new Set(selectedSources.keys());
  const comparisonVersionIds = new Set(selectedComparisons.keys());

  function invalidateEstimate() {
    scopeRevision.current += 1;
    setEstimate(null);
    setShowConfirmation(false);
    setRunError(null);
    idempotencyKey.current = null;
    try { window.sessionStorage.removeItem("pending-analysis-run"); } catch { /* Storage can be disabled. */ }
  }

  async function confirmRun() {
    if (!estimate || Date.parse(estimate.expiresAt) <= Date.now()) {
      setEstimate(null);
      setRunError("This estimate expired. Calculate a new estimate before running.");
      setShowConfirmation(false);
      return;
    }
    idempotencyKey.current ??= crypto.randomUUID();
    try {
      window.sessionStorage.setItem("pending-analysis-run", JSON.stringify({ estimateRef: estimate.estimateRef, idempotencyKey: idempotencyKey.current }));
    } catch { /* Storage can be disabled; retain the key in memory. */ }
    setIsStarting(true);
    setRunError(null);
    try {
      const result = await runAnalysis({ estimateRef: estimate.estimateRef, idempotencyKey: idempotencyKey.current });
      if (!result.ok) {
        setRunError(result.error.message);
        if (result.error.code === "ESTIMATE_EXPIRED" || result.error.code === "ESTIMATE_STALE") {
          setEstimate(null);
          try { window.sessionStorage.removeItem("pending-analysis-run"); } catch { /* Storage can be disabled. */ }
        }
        return;
      }
      try { window.sessionStorage.removeItem("pending-analysis-run"); } catch { /* Storage can be disabled. */ }
      router.push(`/analysis/${result.data.analysisId}`);
    } catch {
      // Keep the idempotency key so retrying the same confirmation safely replays the command.
      setRunError("We couldn't confirm whether the analysis started. Retry this confirmation to safely recover it.");
    } finally {
      setIsStarting(false);
    }
  }

  useEffect(() => {
    let active = true;
    try {
      const raw = window.sessionStorage.getItem("pending-analysis-run");
      const pendingRun = raw ? JSON.parse(raw) as { estimateRef?: unknown; idempotencyKey?: unknown } : null;
      if (typeof pendingRun?.estimateRef === "string" && typeof pendingRun.idempotencyKey === "string") {
        void runAnalysis({ estimateRef: pendingRun.estimateRef, idempotencyKey: pendingRun.idempotencyKey }).then((result) => {
          if (active && result.ok) {
            window.sessionStorage.removeItem("pending-analysis-run");
            router.replace(`/analysis/${result.data.analysisId}`);
          }
        }).catch(() => undefined);
      }
    } catch { /* Session storage may be unavailable or contain invalid data. */ }
    void getActiveAnalysisAction().then((result) => {
      if (active && result.ok && result.data) router.replace(`/analysis/${result.data.analysisId}`);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [router]);

  useEffect(() => {
    let active = true;
    void listEligibleDocumentsAction({ ...currentFilters, page, pageSize: 25 })
      .then((result) => {
        if (!active) return;
        if (result.ok) {
          setItems(result.data.items);
          setTotal(result.data.total);
        } else {
          setValidationError(result.error.message);
        }
      })
      .catch(() => {
        if (active) setValidationError("We couldn't load eligible documents. Please try again.");
      });
    return () => { active = false; };
  }, [currentFilters, page]);

  function toggleVersion(versionId: string) {
    invalidateEstimate();
    setValidationError(null);
    const item = items.find((i) => i.versionId === versionId);
    if (!item) return;

    const activeSelection = activeTab === "sources" ? selectedSources : selectedComparisons;
    const otherSelection = activeTab === "sources" ? selectedComparisons : selectedSources;
    const alreadySelected = activeSelection.has(versionId);
    const alreadyInUnion = otherSelection.has(versionId);
    const distinctCount = new Set([...selectedSources.keys(), ...selectedComparisons.keys()]).size;
    if (!alreadySelected && !alreadyInUnion && distinctCount >= 20) {
      setValidationError("Analysis scope cannot exceed 20 distinct versions.");
      setEstimate(null);
      return;
    }

    if (activeTab === "sources") {
      const next = new Map(selectedSources);
      if (next.has(versionId)) next.delete(versionId);
      else next.set(versionId, item);
      setSelectedSources(next);
    } else {
      const next = new Map(selectedComparisons);
      if (next.has(versionId)) next.delete(versionId);
      else next.set(versionId, item);
      setSelectedComparisons(next);
    }
  }

  async function handleSelectAllFiltered(entireRepository = false) {
    invalidateEstimate();
    const revision = scopeRevision.current;
    setIsBulkLoading(true);
    setValidationError(null);
    try {
      const query = entireRepository ? {} : currentFilters;
      const result = await resolveFilteredScopeAction({
        query,
        targetRole: activeTab === "sources" ? "source" : "comparison",
        currentSourceVersionIds: Array.from(sourceVersionIds),
        currentComparisonVersionIds: Array.from(comparisonVersionIds),
      });
      if (!result.ok) {
        setValidationError(result.error.message);
        return;
      }

      const pageResult = await listEligibleDocumentsAction({ ...query, page: 1, pageSize: 100 });
      if (!pageResult.ok) {
        setValidationError(pageResult.error.message);
        return;
      }
      if (revision !== scopeRevision.current) return;
      const byId = new Map([...items, ...pageResult.data.items].map((item) => [item.versionId, item]));
      const matchingItems = result.data.versionIds.flatMap((id) => {
        const item = byId.get(id);
        return item ? [item] : [];
      });
      if (matchingItems.length !== result.data.versionIds.length) {
        setValidationError("The eligible document list changed. Refresh the selection and try again.");
        return;
      }
      if (activeTab === "sources") {
        const next = new Map(selectedSources);
        matchingItems.forEach((i) => next.set(i.versionId, i));
        setSelectedSources(next);
      } else {
        const next = new Map(selectedComparisons);
        matchingItems.forEach((i) => next.set(i.versionId, i));
        setSelectedComparisons(next);
      }
    } catch {
      setValidationError("We couldn't select eligible documents. Please try again.");
    } finally {
      setIsBulkLoading(false);
    }
  }

  function handleClearSelection() {
    invalidateEstimate();
    setValidationError(null);
    if (activeTab === "sources") setSelectedSources(new Map());
    else setSelectedComparisons(new Map());
  }

  async function handleCalculateEstimate() {
    const revision = scopeRevision.current;
    setIsEstimating(true);
    setValidationError(null);
    try {
      const result = await estimateAnalysisAction({
        sourceVersionIds: Array.from(sourceVersionIds),
        comparisonVersionIds: Array.from(comparisonVersionIds),
      });
      if (!result.ok) {
        if (revision === scopeRevision.current) setValidationError(result.error.message);
        return;
      }
      if (revision === scopeRevision.current) setEstimate(result.data);
    } catch {
      if (revision === scopeRevision.current) {
        setValidationError("We couldn't calculate an estimate. Please try again.");
      }
    } finally {
      setIsEstimating(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_22rem]">
      <div className="flex flex-col gap-6">
        {/* Navigation Tabs */}
        <div className="flex border-b border-slate-200" role="tablist">
          <button
            role="tab"
            aria-selected={activeTab === "sources"}
            onClick={() => setActiveTab("sources")}
            className={`border-b-2 px-4 py-3 text-sm font-semibold transition-colors ${
              activeTab === "sources"
                ? "border-cyan-700 text-cyan-900"
                : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            1. Documents to analyze ({selectedSources.size})
          </button>
          <button
            role="tab"
            aria-selected={activeTab === "comparisons"}
            onClick={() => setActiveTab("comparisons")}
            className={`border-b-2 px-4 py-3 text-sm font-semibold transition-colors ${
              activeTab === "comparisons"
                ? "border-cyan-700 text-cyan-900"
                : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            2. Compare against ({selectedComparisons.size})
          </button>
        </div>

        {/* Tab Description */}
        <div className="text-xs text-slate-500">
          {activeTab === "sources" ? (
            <p>Select the baseline documents you want to analyze for decay, contradictions, or obsolescence.</p>
          ) : (
            <p>Optionally select comparative documents. If none are selected, analysis runs for internal contradictions only.</p>
          )}
        </div>

        {/* Document Selection Table */}
        <DocumentSelectionTable
          items={items}
          total={total}
          page={page}
          pageSize={25}
          selectedVersionIds={activeTab === "sources" ? sourceVersionIds : comparisonVersionIds}
          otherListVersionIds={activeTab === "sources" ? comparisonVersionIds : sourceVersionIds}
          onToggleVersion={toggleVersion}
          onSelectAllFiltered={handleSelectAllFiltered}
          onClearSelection={handleClearSelection}
          onPageChange={setPage}
          onFilterChange={(filters) => {
            setCurrentFilters((current) => mergeAnalysisSelectionFilters(current, filters));
            setPage(1);
          }}
          stepRole={activeTab === "sources" ? "source" : "comparison"}
          eligibleOwners={eligibleOwners}
          isBulkLoading={isBulkLoading}
          onSelectEntireRepository={() => handleSelectAllFiltered(true)}
        />
      </div>

      {/* Sidebar Summary */}
      <ScopeSummarySidebar
        sources={Array.from(selectedSources.values())}
        comparisons={Array.from(selectedComparisons.values())}
        onRemoveSource={(id) => {
          invalidateEstimate();
          const next = new Map(selectedSources);
          next.delete(id);
          setSelectedSources(next);
        }}
        onRemoveComparison={(id) => {
          invalidateEstimate();
          const next = new Map(selectedComparisons);
          next.delete(id);
          setSelectedComparisons(next);
        }}
        estimate={estimate}
        onCalculateEstimate={handleCalculateEstimate}
        onProceedToRun={() => { setRunError(null); setShowConfirmation(true); }}
        isEstimating={isEstimating}
        validationError={validationError}
      />
      {showConfirmation ? (
        <div role="dialog" aria-modal="true" aria-labelledby="run-confirmation-title" className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
          <section className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <h2 id="run-confirmation-title" className="text-lg font-semibold">Confirm analysis</h2>
            <p className="mt-3 text-sm text-slate-700">Estimated cost: {estimate?.fixedCost ?? 0} credits</p>
            {runError ? <p role="alert" className="mt-3 text-sm text-rose-700">{runError}</p> : null}
            <div className="mt-6 flex justify-end gap-3">
              <button type="button" disabled={isStarting} onClick={() => setShowConfirmation(false)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm">Cancel</button>
              <button type="button" disabled={isStarting || !estimate} onClick={() => void confirmRun()} className="rounded-lg bg-cyan-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{isStarting ? "Starting…" : "Confirm and run"}</button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
