"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import type { FindingReviewSnapshot, ReviewRound } from "@/types/review-contracts";
import type { EligibleOwner } from "@/types/contracts";
import { assignFinding, getFindingReview, listAssignees, openRound, prepareRound } from "@/modules/review";
import { AssigneeSelector } from "./assignee-selector";
import { createIdempotencyKeyStore } from "./idempotency-keys";

interface RoundPreparationModalProps {
  isOpen: boolean;
  documentId: string;
  documentName: string;
  findings: FindingReviewSnapshot[];
  onClose: () => void;
  onRoundOpened: (round: ReviewRound) => void;
  onFindingUpdated?: (finding: FindingReviewSnapshot) => void;
}

export function RoundPreparationModal({
  isOpen,
  documentId,
  documentName,
  findings,
  onClose,
  onRoundOpened,
  onFindingUpdated,
}: RoundPreparationModalProps) {
  const [draft, setDraft] = useState<{ roundId: string; revision: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentFindings, setCurrentFindings] = useState(findings);
  const [selectedIds, setSelectedIds] = useState<string[]>(findings.map((finding) => finding.id));
  const [assignees, setAssignees] = useState<EligibleOwner[]>([]);
  const [bulkAssigneeId, setBulkAssigneeId] = useState("");
  const [isPending, startTransition] = useTransition();
  const keyStore = useRef(createIdempotencyKeyStore());

  useEffect(() => {
    let active = true;
    async function loadAssignees() {
      try {
        const all: EligibleOwner[] = [];
        let page = 1;
        let total = 0;
        do {
          const result = await listAssignees({ page, pageSize: 100 });
          if (!result.ok) {
            if (active) setError(result.error.message);
            return;
          }
          all.push(...result.data.items);
          total = result.data.total;
          page += 1;
        } while (all.length < total);
        if (active) setAssignees(all);
      } catch {
        if (active) setError("Eligible Members could not be loaded.");
      }
    }
    void loadAssignees();
    return () => { active = false; };
  }, []);

  if (!isOpen) return null;

  const eligibleFindings = currentFindings.filter(
    (finding) => finding.status === "confirmed" || finding.status === "update_planned",
  );
  const selectedFindings = eligibleFindings.filter((finding) => selectedIds.includes(finding.id));

  function toggleFinding(findingId: string) {
    setSelectedIds((current) => current.includes(findingId)
      ? current.filter((id) => id !== findingId)
      : [...current, findingId]);
  }

  function updateFinding(updated: FindingReviewSnapshot) {
    setCurrentFindings((current) => current.map((finding) => finding.id === updated.id ? updated : finding));
    onFindingUpdated?.(updated);
  }

  function assignSelectedToMember() {
    if (!bulkAssigneeId || selectedFindings.length === 0) return;
    setError(null);
    startTransition(async () => {
      for (const finding of selectedFindings) {
        if (finding.assignee?.id === bulkAssigneeId) continue;
        const signature = JSON.stringify(["assign", finding.id, finding.revision, bulkAssigneeId]);
        try {
          const result = await assignFinding({
            findingId: finding.id,
            revision: finding.revision,
            assigneeId: bulkAssigneeId,
            idempotencyKey: keyStore.current.forAttempt(signature),
          });
          if (!result.ok) {
            keyStore.current.clear(signature);
            setError(result.error.code === "CONFLICT"
              ? "A finding changed during assignment. Refresh its review state before opening this round."
              : result.error.message);
            if (result.error.code === "CONFLICT") {
              const latest = await getFindingReview({ findingId: finding.id });
              if (latest.ok) updateFinding(latest.data);
            }
            return;
          }
          keyStore.current.clear(signature);
          updateFinding(result.data);
        } catch {
          setError("The assignment response was lost. Retry the same assignment to safely recover it.");
          return;
        }
      }
      setError(null);
    });
  }

  function handlePrepare() {
    if (!selectedFindings.length || selectedFindings.some((finding) => !finding.assignee)) return;
    setError(null);
    startTransition(async () => {
      const findingIds = selectedFindings.map((finding) => finding.id);
      const signature = JSON.stringify(["prepare-round", documentId, findingIds]);
      try {
        const result = await prepareRound({
          documentId,
          mode: "assigned_findings",
          findingIds: findingIds as [string, ...string[]],
          idempotencyKey: keyStore.current.forAttempt(signature),
        });
        if (!result.ok) {
          keyStore.current.clear(signature);
          setError(result.error.message);
          return;
        }
        keyStore.current.clear(signature);
        setDraft({ roundId: result.data.roundId, revision: result.data.revision });
      } catch {
        setError("The correction round could not be prepared. Please try again.");
      }
    });
  }

  function handleOpen() {
    if (!draft) return;
    setError(null);
    startTransition(async () => {
      const signature = JSON.stringify(["open-round", draft.roundId, draft.revision]);
      try {
        const result = await openRound({
          ...draft,
          idempotencyKey: keyStore.current.forAttempt(signature),
        });
        if (!result.ok) {
          keyStore.current.clear(signature);
          setError(result.error.message);
          return;
        }
        keyStore.current.clear(signature);
        onRoundOpened(result.data);
        onClose();
      } catch {
        setError("The correction round could not be opened. Please try again.");
      }
    });
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="round-modal-title" className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/40 p-4">
      <section className="w-full max-w-xl space-y-4 rounded-xl bg-white p-6 shadow-xl">
        <div>
          <h2 id="round-modal-title" className="text-lg font-semibold text-slate-900">Prepare correction round</h2>
          <p className="mt-1 text-sm text-slate-600">{documentName}</p>
        </div>
        <ul aria-label="Findings included in this round" className="max-h-48 space-y-2 overflow-auto">
          {eligibleFindings.map((finding) => (
            <li key={finding.id} className="space-y-2 rounded border border-slate-200 p-2 text-sm">
              <label className="flex items-start gap-2">
                <input type="checkbox" checked={selectedIds.includes(finding.id)} onChange={() => toggleFinding(finding.id)} disabled={isPending || Boolean(draft)} />
                <span><span className="font-medium">{finding.severityCurrent}</span> · {finding.explanation}</span>
              </label>
              <AssigneeSelector
                findingId={finding.id}
                currentAssignee={finding.assignee}
                revision={finding.revision}
                canAssign={finding.canAssign && !draft}
                affectedDocuments={[{ documentId, name: documentName }]}
                assignees={assignees}
                onUpdated={updateFinding}
                onError={(assignmentError) => {
                  if (assignmentError.code === "CONFLICT") {
                    setError("This finding changed during assignment. Its latest state has been refreshed.");
                    void getFindingReview({ findingId: finding.id }).then((result) => {
                      if (result.ok) updateFinding(result.data);
                    });
                  } else {
                    setError(assignmentError.message);
                  }
                }}
              />
            </li>
          ))}
          {eligibleFindings.length === 0 && <li className="text-sm text-slate-600">No confirmed findings are available for this document.</li>}
        </ul>
        {!draft && eligibleFindings.length > 1 && (
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-sm" htmlFor="bulk-assignee">Assign selected to</label>
            <select id="bulk-assignee" value={bulkAssigneeId} onChange={(event) => setBulkAssigneeId(event.target.value)} className="rounded border border-slate-300 px-2 py-1 text-sm">
              <option value="">Choose a Member</option>
              {assignees.map((member) => <option key={member.id} value={member.id}>{member.fullName}</option>)}
            </select>
            <button type="button" onClick={assignSelectedToMember} disabled={isPending || !bulkAssigneeId || selectedFindings.length === 0} className="rounded border px-2 py-1 text-sm disabled:opacity-50">Assign selected</button>
          </div>
        )}
        <p className="text-sm text-amber-800">Opening this round freezes this set of findings for correction. Future findings will require a new round.</p>
        {error && <p role="alert" className="text-sm text-rose-700">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={isPending} className="rounded border px-3 py-2 text-sm">Cancel</button>
          {!draft ? (
            <button type="button" onClick={handlePrepare} disabled={isPending || selectedFindings.length === 0 || selectedFindings.some((finding) => !finding.assignee)} className="rounded bg-cyan-700 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">{isPending ? "Preparing…" : "Prepare round"}</button>
          ) : (
            <button type="button" onClick={handleOpen} disabled={isPending} className="rounded bg-cyan-700 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">{isPending ? "Opening…" : "Open round"}</button>
          )}
        </div>
      </section>
    </div>
  );
}
