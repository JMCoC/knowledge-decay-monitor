"use client";

import { useCallback, useEffect, useState } from "react";
import type { FindingDetail, ActionError } from "@/types/contracts";
import { getDocumentOriginalUrlAction } from "@/modules/repository";
import { getFindingReview } from "@/modules/review";
import { listFindingsForDocumentAction } from "@/modules/analysis";
import type { FindingReviewSnapshot } from "@/types/review-contracts";
import { SeverityControl } from "@/modules/review/ui/severity-control";
import { FindingReviewActions } from "@/modules/review/ui/finding-review-actions";
import { AssigneeSelector } from "@/modules/review/ui/assignee-selector";
import { RoundPreparationModal } from "@/modules/review/ui/round-preparation-modal";
import type { ReviewRound } from "@/types/review-contracts";
import { captureClientTransportFailure } from "@/lib/observability/client-failure";

interface FindingEvidenceDrawerProps {
  finding: FindingDetail | null;
  initialReview?: FindingReviewSnapshot | null;
  initialReviewError?: string | null;
  onClose: () => void;
  onReviewUpdated?: (updated: FindingReviewSnapshot) => void;
}

export function FindingEvidenceDrawer({ finding, initialReview = null, initialReviewError = null, onClose, onReviewUpdated }: FindingEvidenceDrawerProps) {
  const [openingVersionId, setOpeningVersionId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<{ versionId: string; error: ActionError } | null>(null);
  const [review, setReview] = useState<FindingReviewSnapshot | null>(initialReview);
  const [reviewError, setReviewError] = useState<string | null>(initialReviewError);
  const [roundDocumentId, setRoundDocumentId] = useState("");
  const [isRoundModalOpen, setIsRoundModalOpen] = useState(false);
  const [roundNotice, setRoundNotice] = useState<string | null>(null);
  const [roundFindings, setRoundFindings] = useState<FindingReviewSnapshot[]>([]);
  const [roundLoading, setRoundLoading] = useState(false);

  const refreshReview = useCallback(async () => {
    if (!finding) return;
    try {
      const result = await getFindingReview({ findingId: finding.id });
      if (result.ok) setReview(result.data);
      else setReviewError(result.error.message);
    } catch {
      setReviewError("The latest review state could not be loaded.");
    }
  }, [finding]);

  function handleReviewError(error: { code: string; message: string }) {
    if (error.code === "CONFLICT") {
      setReviewError("This finding was modified by another reviewer. Current state has been refreshed.");
      void refreshReview();
      return;
    }
    setReviewError(error.message);
  }

  function handleReviewUpdated(updated: FindingReviewSnapshot) {
    setReview(updated);
    setReviewError(null);
    onReviewUpdated?.(updated);
  }

  function handleRoundOpened(round: ReviewRound) {
    setRoundDocumentId(round.documentId);
    setRoundNotice("Correction round opened. Its finding set is now fixed.");
  }

  async function handlePrepareRound() {
    if (!finding) return;
    const target = finding.evidence.find((item) => item.documentId === roundDocumentId) ?? finding.evidence[0];
    if (!target) return;
    setRoundLoading(true);
    setReviewError(null);
    try {
      const candidates = await listFindingsForDocumentAction({
        analysisId: finding.analysisId,
        documentId: target.documentId,
      });
      if (!candidates.ok) {
        setReviewError(candidates.error.message);
        return;
      }
      const snapshots: FindingReviewSnapshot[] = [];
      for (const candidate of candidates.data) {
        const snapshot = await getFindingReview({ findingId: candidate.id });
        if (!snapshot.ok) {
          setReviewError(snapshot.error.message);
          return;
        }
        if (snapshot.data.canPrepareRound) snapshots.push(snapshot.data);
      }
      if (!snapshots.length) {
        setReviewError("This document has no confirmed findings available for a correction round.");
        return;
      }
      setRoundFindings(snapshots);
      setIsRoundModalOpen(true);
    } catch {
      setReviewError("Findings for this document could not be loaded. Please try again.");
    } finally {
      setRoundLoading(false);
    }
  }

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  if (!finding) return null;

  async function handleOpenDocument(versionId: string) {
    if (openingVersionId) return;
    setOpenError(null);

    const targetWindow = window.open("", "_blank");
    if (!targetWindow) {
      setOpenError({
        versionId,
        error: {
          code: "INTERNAL_ERROR",
          message: "Your browser blocked the new tab. Allow pop-ups and try again.",
        },
      });
      return;
    }

    setOpeningVersionId(versionId);

    try {
      const result = await getDocumentOriginalUrlAction(versionId);
      if (!result.ok) {
        targetWindow.close();
        setOpenError({ versionId, error: result.error });
        return;
      }
      targetWindow.location.href = result.data.url;
    } catch {
      targetWindow.close();
      setOpenError({ versionId, error: captureClientTransportFailure() });
    } finally {
      setOpeningVersionId(null);
    }
  }

  const severityBadgeClass =
    finding.severityCurrent === "High"
      ? "bg-rose-100 text-rose-800 border-rose-300"
      : finding.severityCurrent === "Medium"
      ? "bg-amber-100 text-amber-800 border-amber-300"
      : "bg-slate-100 text-slate-800 border-slate-300";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="evidence-drawer-title"
      className="fixed inset-0 z-50 overflow-hidden bg-slate-900/40 backdrop-blur-sm flex justify-end"
    >
      <div className="w-full max-w-4xl bg-white h-full shadow-2xl flex flex-col border-l border-slate-200">
        {/* Header */}
        <div className="p-6 border-b border-slate-200 flex items-start justify-between bg-slate-50">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span
                className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border ${severityBadgeClass}`}
              >
                {finding.severityCurrent}
              </span>
              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-slate-200 text-slate-700 capitalize">
                {finding.type}
              </span>
                <span className="text-xs text-slate-500">Status: {(review?.status ?? finding.status).replaceAll("_", " ")}</span>
            </div>
            <h2 id="evidence-drawer-title" className="text-lg font-semibold text-slate-900">
              Evidence & Document Comparison
            </h2>
            <p className="text-sm text-slate-600 mt-1">{finding.explanation}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close evidence panel"
            className="rounded-md p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-200 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          <section aria-label="Human review" className="space-y-3 rounded-lg border border-slate-200 p-4">
            <h3 className="text-sm font-semibold text-slate-900">Review decision</h3>
            {reviewError && <p role="alert" className="text-sm text-amber-800">{reviewError}</p>}
            {!review && !reviewError && <p role="status" className="text-sm text-slate-500">Review controls are not available.</p>}
            {review && (
              <>
                <SeverityControl
                  findingId={review.id}
                  severityOriginal={review.severityOriginal}
                  severityCurrent={review.severityCurrent}
                  revision={review.revision}
                  canChangeSeverity={review.canChangeSeverity}
                  onUpdated={handleReviewUpdated}
                  onError={handleReviewError}
                />
                <FindingReviewActions
                  findingId={review.id}
                  status={review.status}
                  revision={review.revision}
                  canChangeStatus={review.canChangeStatus}
                  onUpdated={handleReviewUpdated}
                  onError={handleReviewError}
                />
                <AssigneeSelector
                  findingId={review.id}
                  currentAssignee={review.assignee}
                  revision={review.revision}
                  canAssign={review.canAssign}
                  affectedDocuments={finding.evidence.map(({ documentId, documentName }) => ({ documentId, name: documentName }))}
                  onUpdated={handleReviewUpdated}
                  onError={handleReviewError}
                />
                {review.canPrepareRound && (
                  <div className="flex flex-wrap items-center gap-2">
                    {finding.evidence.length > 1 && (
                      <label className="text-xs text-slate-700">
                        Document to correct
                        <select
                          aria-label="Document to correct"
                          value={roundDocumentId}
                          onChange={(event) => setRoundDocumentId(event.target.value)}
                          className="ml-2 rounded border border-slate-300 px-2 py-1"
                        >
                          <option value="">Choose a document</option>
                          {finding.evidence.map((item) => (
                            <option key={item.documentId} value={item.documentId}>{item.documentName}</option>
                          ))}
                        </select>
                      </label>
                    )}
                    <button
                      type="button"
                      disabled={roundLoading || (finding.evidence.length > 1 && !roundDocumentId)}
                      onClick={() => {
                        setRoundNotice(null);
                        void handlePrepareRound();
                      }}
                      className="rounded border border-cyan-700 px-3 py-1.5 text-xs font-medium text-cyan-800 disabled:opacity-50"
                    >
                      {roundLoading ? "Loading findings…" : "Prepare Correction Round"}
                    </button>
                  </div>
                )}
                {roundNotice && <p role="status" className="text-sm text-emerald-800">{roundNotice}</p>}
              </>
            )}
          </section>

          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-500">
              Corroborating Evidence ({finding.evidence.length})
            </h3>
            <span className="text-xs text-slate-400">Exact analyzed versions</span>
          </div>

          <div
            className={
              finding.evidence.length === 2
                ? "grid grid-cols-1 lg:grid-cols-2 gap-4"
                : "flex flex-col gap-4"
            }
          >
            {finding.evidence.map((item, index) => (
              <div
                key={item.id}
                className="flex flex-col bg-slate-50 border border-slate-200 rounded-lg p-4 shadow-sm"
              >
                <div className="flex items-start justify-between gap-2 border-b border-slate-200 pb-3 mb-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-slate-500">#{index + 1}</span>
                      <span className="text-sm font-medium text-slate-900 truncate max-w-xs" title={item.documentName}>
                        {item.documentName}
                      </span>
                      <span className="text-xs bg-slate-200 text-slate-700 px-1.5 py-0.5 rounded font-mono">
                        v{item.versionNumber}
                      </span>
                    </div>
                    {(item.section || item.sectionHeading || item.pageNumber) && (
                      <div className="text-xs text-slate-500 mt-1">
                        {item.pageNumber ? `Page ${item.pageNumber}` : null}
                        {item.pageNumber && (item.section || item.sectionHeading) ? " • " : null}
                        {item.sectionHeading || item.section}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => handleOpenDocument(item.versionId)}
                    disabled={openingVersionId === item.versionId}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-indigo-600 hover:text-indigo-800 disabled:opacity-50 whitespace-nowrap bg-white px-2.5 py-1 rounded border border-slate-200 shadow-sm transition"
                  >
                    {openingVersionId === item.versionId ? "Opening..." : "Open original"}
                  </button>
                </div>

                {openError && openError.versionId === item.versionId && (
                  <div className="mb-3 p-2 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded">
                    {openError.error.message}
                  </div>
                )}

                {/* Safe plain text snapshot container (No dangerouslySetInnerHTML) */}
                <div className="flex-1">
                  <div className="text-xs font-semibold text-slate-500 mb-1">Passage Quote:</div>
                  <pre className="whitespace-pre-wrap font-mono text-xs text-slate-800 bg-white p-3 rounded border border-slate-200 max-h-96 overflow-y-auto select-text leading-relaxed">
                    {item.snapshot}
                  </pre>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-200 bg-slate-50 flex items-center justify-between text-xs text-slate-500">
          <span>AI proposed contradiction/obsolescence based strictly on cited passages.</span>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-white border border-slate-300 rounded-md shadow-sm font-medium text-slate-700 hover:bg-slate-50 transition"
          >
            Close
          </button>
        </div>
      </div>
      {review && isRoundModalOpen && (() => {
        const selectedEvidence = finding.evidence.find((item) => item.documentId === roundDocumentId) ?? finding.evidence[0];
        if (!selectedEvidence) return null;
        return (
          <RoundPreparationModal
            isOpen
            documentId={selectedEvidence.documentId}
            documentName={selectedEvidence.documentName}
            findings={roundFindings}
            onClose={() => setIsRoundModalOpen(false)}
            onRoundOpened={handleRoundOpened}
            onFindingUpdated={handleReviewUpdated}
          />
        );
      })()}
    </div>
  );
}
