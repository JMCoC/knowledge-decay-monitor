"use client";

import React from "react";
import type { AnalysisSelectionItem, DocumentCategory } from "@/types/contracts";

interface DocumentSelectionTableProps {
  items: AnalysisSelectionItem[];
  total: number;
  page: number;
  pageSize: number;
  selectedVersionIds: Set<string>;
  otherListVersionIds: Set<string>;
  onToggleVersion: (versionId: string) => void;
  onSelectAllFiltered: () => void;
  onClearSelection: () => void;
  onPageChange: (newPage: number) => void;
  onFilterChange: (filters: { name?: string; category?: DocumentCategory; ownerId?: string | null }) => void;
  stepRole: "source" | "comparison";
  eligibleOwners: Array<{ id: string; fullName: string }>;
  isBulkLoading?: boolean;
  onSelectEntireRepository?: () => void;
}

export function DocumentSelectionTable({
  items,
  total,
  page,
  pageSize,
  selectedVersionIds,
  otherListVersionIds,
  onToggleVersion,
  onSelectAllFiltered,
  onClearSelection,
  onPageChange,
  onFilterChange,
  stepRole,
  eligibleOwners,
  isBulkLoading = false,
  onSelectEntireRepository,
}: DocumentSelectionTableProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="flex flex-col gap-4">
      {/* Filter and Search Bar */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <input
          type="text"
          placeholder="Search documents by name…"
          onChange={(e) => onFilterChange({ name: e.target.value })}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-cyan-600 focus:outline-none focus:ring-1 focus:ring-cyan-600"
        />
        <select
          aria-label="Filter by category"
          onChange={(e) =>
            onFilterChange({ category: (e.target.value as DocumentCategory) || undefined })
          }
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-cyan-600 focus:outline-none focus:ring-1 focus:ring-cyan-600"
        >
          <option value="">All Categories</option>
          <option value="SOP">SOP</option>
          <option value="Policy">Policy</option>
          <option value="Manual">Manual</option>
          <option value="QA Process">QA Process</option>
          <option value="Security">Security</option>
          <option value="Engineering Guideline">Engineering Guideline</option>
          <option value="Other">Other</option>
        </select>
        <select
          aria-label="Filter by owner"
          onChange={(e) => {
            const val = e.target.value;
            onFilterChange({ ownerId: val === "unassigned" ? null : val || undefined });
          }}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-cyan-600 focus:outline-none focus:ring-1 focus:ring-cyan-600"
        >
          <option value="">All Owners</option>
          <option value="unassigned">Unassigned</option>
          {eligibleOwners.map((owner) => (
            <option key={owner.id} value={owner.id}>
              {owner.fullName}
            </option>
          ))}
        </select>
      </div>

      {/* Action Bar */}
      <div className="flex items-center justify-between border-b border-slate-200 pb-3">
        <div className="text-sm text-slate-600">
          Showing <span className="font-semibold">{items.length}</span> of <span className="font-semibold">{total}</span> eligible documents
        </div>
        <div className="flex gap-2">
          {stepRole === "comparison" && onSelectEntireRepository && (
            <button
              type="button"
              onClick={onSelectEntireRepository}
              disabled={isBulkLoading}
              className="rounded-md border border-cyan-700 px-3 py-1.5 text-xs font-semibold text-cyan-800 hover:bg-cyan-50 disabled:opacity-50"
            >
              Compare against entire repository
            </button>
          )}
          <button
            type="button"
            onClick={onSelectAllFiltered}
            disabled={isBulkLoading || total === 0}
            className="rounded-md bg-cyan-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-cyan-800 disabled:opacity-50"
          >
            {isBulkLoading ? "Selecting…" : "Select all filtered"}
          </button>
          <button
            type="button"
            onClick={onClearSelection}
            disabled={selectedVersionIds.size === 0}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Clear selection
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
          <thead className="bg-slate-50 text-xs font-semibold uppercase text-slate-500">
            <tr>
              <th className="w-12 px-4 py-3 text-center">Select</th>
              <th className="px-4 py-3">Document Name</th>
              <th className="px-4 py-3">Category</th>
              <th className="px-4 py-3">Owner</th>
              <th className="px-4 py-3">Role Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.length === 0 ? (
              <tr>
                <td colSpan={5} className="p-8 text-center text-sm text-slate-500">
                  No eligible active documents match the filters.
                </td>
              </tr>
            ) : (
              items.map((item) => {
                const isSelected = selectedVersionIds.has(item.versionId);
                const isAlsoInOther = otherListVersionIds.has(item.versionId);

                return (
                  <tr key={item.versionId} className="hover:bg-slate-50">
                    <td className="px-4 py-3 text-center">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => onToggleVersion(item.versionId)}
                        className="h-4 w-4 rounded border-slate-300 text-cyan-700 focus:ring-cyan-600"
                        aria-label={`Select ${item.name}`}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-900">{item.name}</div>
                      <span className="text-xs text-slate-500">v{item.versionNumber}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700 capitalize">
                        {item.category}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {item.owner ? item.owner.fullName : <span className="italic text-slate-400">Unassigned</span>}
                    </td>
                    <td className="px-4 py-3">
                      {isAlsoInOther && (
                        <span className="rounded bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 border border-amber-200">
                          {stepRole === "source" ? "Also in Comparisons" : "Also in Sources"}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between pt-2">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
        >
          Previous
        </button>
        <span className="text-xs text-slate-600">
          Page {page} of {totalPages}
        </span>
        <button
          type="button"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </div>
  );
}
