"use client";

import { useTransition } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import type { FindingSummary, FindingDetail, AnalysisPage } from "@/types/contracts";
import { FindingEvidenceDrawer } from "./finding-evidence-drawer";

interface FindingsViewProps {
  analysisId: string;
  initialPage: AnalysisPage<FindingSummary>;
  totalAnalysisFindings: number;
  activeFindingDetail?: FindingDetail | null;
}

export function FindingsView({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  analysisId: _analysisId,
  initialPage,
  totalAnalysisFindings,
  activeFindingDetail = null,
}: FindingsViewProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const currentType = searchParams?.get("type") || "";
  const currentSeverity = searchParams?.get("severity") || "";
  const currentStatus = searchParams?.get("status") || "";
  const currentAssignee = searchParams?.get("assignee") || "all";
  const currentPage = Number(searchParams?.get("page") || initialPage.page || 1);

  function updateQuery(updates: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === "") {
        params.delete(key);
      } else {
        params.set(key, value);
      }
    }
    startTransition(() => {
      router.push(`${pathname}?${params.toString()}`);
    });
  }

  function handleFilterChange(key: string, value: string) {
    updateQuery({ [key]: value || null, page: "1" });
  }

  function handleClearFilters() {
    startTransition(() => {
      router.push(pathname);
    });
  }

  function handleOpenEvidence(findingId: string) {
    updateQuery({ findingId });
  }

  function handleCloseEvidence() {
    updateQuery({ findingId: null });
  }

  const hasActiveFilters = Boolean(
    currentType || currentSeverity || currentStatus || currentAssignee !== "all" ||
    (searchParams?.get("page") && currentPage > 1),
  );
  const isZeroFindingsInAnalysis = totalAnalysisFindings === 0;

  return (
    <div className="space-y-6">
      {/* Filters Bar */}
      {!isZeroFindingsInAnalysis && (
        <div className="flex flex-wrap items-center justify-between gap-4 p-4 bg-white rounded-lg border border-slate-200 shadow-sm">
          <div className="flex flex-wrap items-center gap-3">
            <div>
              <label htmlFor="filter-type" className="sr-only">Type</label>
              <select
                id="filter-type"
                value={currentType}
                onChange={(e) => handleFilterChange("type", e.target.value)}
                className="text-xs bg-slate-50 border border-slate-300 rounded-md px-3 py-1.5 font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-cyan-500"
              >
                <option value="">All Types</option>
                <option value="contradiction">Contradiction</option>
                <option value="obsolescence">Obsolescence</option>
              </select>
            </div>

            <div>
              <label htmlFor="filter-severity" className="sr-only">Severity</label>
              <select
                id="filter-severity"
                value={currentSeverity}
                onChange={(e) => handleFilterChange("severity", e.target.value)}
                className="text-xs bg-slate-50 border border-slate-300 rounded-md px-3 py-1.5 font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-cyan-500"
              >
                <option value="">All Severities</option>
                <option value="High">High</option>
                <option value="Medium">Medium</option>
                <option value="Low">Low</option>
              </select>
            </div>

            <div>
              <label htmlFor="filter-status" className="sr-only">Status</label>
              <select
                id="filter-status"
                value={currentStatus}
                onChange={(e) => handleFilterChange("status", e.target.value)}
                className="text-xs bg-slate-50 border border-slate-300 rounded-md px-3 py-1.5 font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-cyan-500"
              >
                <option value="">All Statuses</option>
                <option value="pending_review">Pending Review</option>
              </select>
            </div>

            <div>
              <label htmlFor="filter-assignee" className="sr-only">Assignee</label>
              <select
                id="filter-assignee"
                value={currentAssignee}
                onChange={(e) => handleFilterChange("assignee", e.target.value)}
                className="text-xs bg-slate-50 border border-slate-300 rounded-md px-3 py-1.5 font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-cyan-500"
              >
                <option value="all">All Assignees</option>
                <option value="unassigned">Unassigned</option>
              </select>
            </div>

            {hasActiveFilters && (
              <button
                type="button"
                onClick={handleClearFilters}
                className="text-xs text-cyan-700 hover:text-cyan-900 font-semibold underline"
              >
                Clear filters
              </button>
            )}
          </div>

          <div className="text-xs text-slate-500 font-medium">
            Showing {initialPage.items.length} of {initialPage.total} findings
          </div>
        </div>
      )}

      {/* Zero Findings in Analysis (Completed with no issues detected) */}
      {isZeroFindingsInAnalysis && (
        <div className="text-center py-16 bg-white rounded-xl border border-slate-200 p-8 shadow-sm">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-emerald-50 text-emerald-600 mb-4">
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h3 className="text-lg font-semibold text-slate-900">
            No contradictions or obsolescence issues detected
          </h3>
          <p className="text-sm text-slate-500 max-w-md mx-auto mt-2">
            The analyzed document versions are consistent with each other according to the AI rules.
          </p>
        </div>
      )}

      {/* Filtered Empty State */}
      {!isZeroFindingsInAnalysis && initialPage.items.length === 0 && (
        <div className="text-center py-12 bg-white rounded-xl border border-slate-200 p-8 shadow-sm">
          <h3 className="text-base font-semibold text-slate-900">
            No findings match your selected filters
          </h3>
          <p className="text-xs text-slate-500 mt-1">
            Try adjusting your type or severity filters to view more findings.
          </p>
          <button
            type="button"
            onClick={handleClearFilters}
            className="mt-4 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-md transition"
          >
            Clear filters
          </button>
        </div>
      )}

      {/* Findings Table */}
      {!isZeroFindingsInAnalysis && initialPage.items.length > 0 && (
        <div className="bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50">
              <tr>
                <th scope="col" className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Severity
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Type
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Explanation
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Status
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Assignee
                </th>
                <th scope="col" className="relative px-6 py-3">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 bg-white">
              {initialPage.items.map((finding) => {
                const severityBadgeClass =
                  finding.severityCurrent === "High"
                    ? "bg-rose-100 text-rose-800 border-rose-300"
                    : finding.severityCurrent === "Medium"
                    ? "bg-amber-100 text-amber-800 border-amber-300"
                    : "bg-slate-100 text-slate-800 border-slate-300";

                return (
                  <tr key={finding.id} className="hover:bg-slate-50 transition">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold border ${severityBadgeClass}`}>
                        {finding.severityCurrent}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-700 capitalize">
                        {finding.type}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <p className="text-xs text-slate-900 line-clamp-2 max-w-xl font-normal leading-relaxed">
                        {finding.explanation}
                      </p>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-xs text-slate-500">
                      {finding.status.replaceAll("_", " ")}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-xs text-slate-400 italic">
                      Unassigned
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-xs font-medium">
                      <button
                        type="button"
                        onClick={() => handleOpenEvidence(finding.id)}
                        className="text-cyan-700 hover:text-cyan-900 font-semibold"
                      >
                        View Evidence →
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Pagination */}
          {initialPage.total > initialPage.pageSize && (
            <div className="flex items-center justify-between px-6 py-3 border-t border-slate-200 bg-slate-50">
              <button
                type="button"
                disabled={currentPage <= 1 || isPending}
                onClick={() => updateQuery({ page: String(currentPage - 1) })}
                className="px-3 py-1 bg-white border border-slate-300 text-xs font-medium text-slate-700 rounded-md disabled:opacity-50 hover:bg-slate-100"
              >
                Previous
              </button>
              <span className="text-xs text-slate-500">
                Page {currentPage} of {Math.ceil(initialPage.total / initialPage.pageSize)}
              </span>
              <button
                type="button"
                disabled={currentPage * initialPage.pageSize >= initialPage.total || isPending}
                onClick={() => updateQuery({ page: String(currentPage + 1) })}
                className="px-3 py-1 bg-white border border-slate-300 text-xs font-medium text-slate-700 rounded-md disabled:opacity-50 hover:bg-slate-100"
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}

      {/* Drawer */}
      {activeFindingDetail && (
        <FindingEvidenceDrawer
          finding={activeFindingDetail}
          onClose={handleCloseEvidence}
        />
      )}
    </div>
  );
}
