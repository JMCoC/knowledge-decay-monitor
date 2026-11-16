"use client";

import React, { useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { EligibleOwner } from "@/types/contracts";
import type { FindingReviewSnapshot } from "@/types/review-contracts";
import { assignFinding, listAssignees } from "@/modules/review";
import { createIdempotencyKeyStore } from "./idempotency-keys";

export interface AssigneeSelectorProps {
  findingId: string;
  currentAssignee: EligibleOwner | null;
  revision: number;
  canAssign: boolean;
  affectedDocuments: { documentId: string; name: string }[];
  assignees?: EligibleOwner[];
  onUpdated?: (updated: FindingReviewSnapshot) => void;
  onFindingUpdated?: (updated: FindingReviewSnapshot) => void;
  onError?: (error: { code: string; message: string }) => void;
}

export function AssigneeSelector({
  findingId,
  currentAssignee,
  revision,
  canAssign,
  affectedDocuments,
  assignees,
  onUpdated,
  onFindingUpdated,
  onError,
}: AssigneeSelectorProps) {
  const [loadedAssignees, setLoadedAssignees] = useState<EligibleOwner[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const keyStore = useRef(createIdempotencyKeyStore());

  useEffect(() => {
    if (!canAssign) return;
    if (assignees !== undefined) return;

    let mounted = true;
    async function load() {
      try {
        const all: EligibleOwner[] = [];
        let page = 1;
        let total = 0;
        do {
          const result = await listAssignees({ page, pageSize: 100 });
          if (!result.ok) {
            if (mounted) setLoadError(result.error.message);
            return;
          }
          all.push(...result.data.items);
          total = result.data.total;
          page += 1;
        } while (all.length < total);
        if (mounted) setLoadedAssignees(all);
      } catch {
        if (mounted) setLoadError("Eligible Members could not be loaded.");
      }
    }
    void load();

    return () => {
      mounted = false;
    };
  }, [assignees, canAssign]);

  const availableAssignees = useMemo(() => {
    const base = assignees && assignees.length > 0 ? assignees : loadedAssignees;
    if (!currentAssignee) return base;
    if (base.some((item) => item.id === currentAssignee.id)) return base;
    return [currentAssignee, ...base];
  }, [assignees, loadedAssignees, currentAssignee]);

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const rawValue = e.target.value;
    const newAssigneeId = rawValue === "" ? null : rawValue;
    if (newAssigneeId === (currentAssignee?.id ?? null)) return;

    startTransition(async () => {
      const signature = JSON.stringify(["assign", findingId, revision, newAssigneeId]);
      try {
        const idempotencyKey = keyStore.current.forAttempt(signature);

        const result = await assignFinding({
          findingId,
          revision,
          assigneeId: newAssigneeId,
          idempotencyKey,
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
          message: "The assignment response was lost. Retry this assignment to safely recover it.",
        });
      }
    });
  };

  const isDisabled = !canAssign || isPending;

  return (
    <div className="space-y-2" data-testid="assignee-selector">
      {loadError && <p role="alert" className="text-xs text-rose-700">{loadError}</p>}
      {affectedDocuments.length > 1 && (
        <div
          role="status"
          className="p-2.5 rounded-md text-xs bg-amber-50 text-amber-900 border border-amber-200"
          data-testid="multi-document-guidance"
        >
          <p className="font-semibold text-amber-950">Multi-document finding</p>
          <p className="mt-0.5 text-amber-800">
            This finding spans {affectedDocuments.map((document) => document.name).join(", ")}. Select the document that must be corrected when preparing its correction round.
          </p>
        </div>
      )}

      <div className="flex items-center gap-2">
        <label
          htmlFor={`assignee-select-${findingId}`}
          className="text-xs font-medium text-slate-700"
        >
          Assignee:
        </label>
        <select
          id={`assignee-select-${findingId}`}
          aria-label="Assignee"
          value={currentAssignee?.id ?? ""}
          disabled={isDisabled}
          onChange={handleChange}
          className={`text-xs font-medium rounded-md border border-slate-300 bg-white px-2.5 py-1 text-slate-900 focus:outline-none focus:ring-2 focus:ring-cyan-500 transition-colors ${
            isDisabled ? "opacity-60 cursor-not-allowed bg-slate-50" : "cursor-pointer"
          }`}
        >
          <option value="">Unassigned</option>
          {availableAssignees.map((assignee) => (
            <option key={assignee.id} value={assignee.id}>
              {assignee.fullName}
            </option>
          ))}
        </select>
        {isPending && (
          <span className="text-xs text-slate-500 italic">Updating...</span>
        )}
      </div>
    </div>
  );
}
