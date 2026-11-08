import { OperationError } from "@/components/operation-error";
import { getAnalysisAction } from "@/modules/analysis";
import { AnalysisStatusView } from "@/modules/analysis/ui/analysis-status-view";

export const runtime = "nodejs";

export default async function AnalysisStatusPage({ params }: { params: Promise<{ analysisId: string }> }) {
  const { analysisId } = await params;
  const result = await getAnalysisAction(analysisId);
  if (!result.ok) return <OperationError error={result.error} />;
  return <AnalysisStatusView initial={result.data} />;
}
