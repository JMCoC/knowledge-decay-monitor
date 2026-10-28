import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { requireDocumentActor } from "@/modules/identity";
import { listFindingsAction, getFindingDetailAction, getAnalysisAction } from "@/modules/analysis";
import { FindingsView } from "@/modules/analysis/ui/findings-view";
import type { FindingSeverity, FindingStatus, FindingType } from "@/types/contracts";

interface FindingsPageProps {
  params: Promise<{ analysisId: string }>;
  searchParams: Promise<{
    type?: string;
    severity?: string;
    status?: string;
    assignee?: string;
    page?: string;
    findingId?: string;
  }>;
}

export default async function FindingsPage({ params, searchParams }: FindingsPageProps) {
  await requireDocumentActor();

  const { analysisId } = await params;
  const { type, severity, status, assignee, page, findingId } = await searchParams;

  // Verify analysis status
  const analysisResult = await getAnalysisAction(analysisId);
  if (!analysisResult.ok || !analysisResult.data) {
    notFound();
  }

  const analysis = analysisResult.data;
  if (analysis.status !== "completed") {
    // If not completed yet, redirect to general status page
    redirect(`/analysis/${analysisId}`);
  }

  const currentPage = Number(page) > 0 ? Number(page) : 1;

  // List filtered findings
  const findingsResult = await listFindingsAction({
    analysisId,
    type: type ? (type as FindingType) : undefined,
    severity: severity ? (severity as FindingSeverity) : undefined,
    status: status ? (status as FindingStatus) : undefined,
    assignee: assignee ? (assignee as "all" | "unassigned") : undefined,
    page: currentPage,
    pageSize: 10,
  });

  if (!findingsResult.ok) {
    notFound();
  }

  // Count total findings for this analysis (without filters) to distinguish empty states
  const totalFindingsCountResult = await listFindingsAction({
    analysisId,
    page: 1,
    pageSize: 1,
  });

  const totalAnalysisFindings = totalFindingsCountResult.ok ? totalFindingsCountResult.data.total : 0;

  // If a findingId is selected in searchParams, fetch its detail & corroborating evidence
  let activeFindingDetail = null;
  if (findingId) {
    const detailResult = await getFindingDetailAction(findingId);
    if (detailResult.ok) {
      activeFindingDetail = detailResult.data;
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-slate-200 pb-5">
        <div>
          <nav className="flex items-center gap-2 text-xs text-slate-500 mb-2">
            <Link href="/analysis" className="hover:text-slate-800 transition">
              Analysis
            </Link>
            <span>/</span>
            <Link href={`/analysis/${analysisId}`} className="hover:text-slate-800 transition">
              Status ({analysisId.slice(0, 8)})
            </Link>
            <span>/</span>
            <span className="text-slate-900 font-medium">Findings</span>
          </nav>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Analysis Findings & Evidence
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Ordered list of AI-detected contradictions and obsolescence with exact corroborating citations.
          </p>
        </div>

        <div>
          <Link
            href={`/analysis/${analysisId}`}
            className="inline-flex items-center gap-1 text-xs font-semibold text-slate-700 bg-white border border-slate-300 px-3 py-1.5 rounded-md hover:bg-slate-50 transition shadow-sm"
          >
            ← View Analysis Overview
          </Link>
        </div>
      </div>

      <FindingsView
        analysisId={analysisId}
        initialPage={findingsResult.data}
        totalAnalysisFindings={totalAnalysisFindings}
        activeFindingDetail={activeFindingDetail}
      />
    </div>
  );
}
