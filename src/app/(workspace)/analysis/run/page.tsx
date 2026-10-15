import { requireDocumentActor } from "@/modules/identity";
import { listEligibleDocumentsAction } from "@/modules/analysis";
import { listEligibleOwners } from "@/modules/workspace";
import { RunAnalysisView } from "@/modules/analysis/ui/run-analysis-view";
import { OperationError } from "@/components/operation-error";

export const runtime = "nodejs";

export default async function RunAnalysisPage() {
  const actor = await requireDocumentActor().catch(() => null);

  if (!actor) {
    return (
      <div className="mx-auto w-full max-w-4xl p-6">
        <OperationError
          error={{
            code: "FORBIDDEN",
            message: "You don't have permission to perform document analysis.",
          }}
        />
      </div>
    );
  }

  const [docsResult, ownersResult] = await Promise.all([
    listEligibleDocumentsAction({ page: 1, pageSize: 25 }),
    listEligibleOwners(),
  ]);

  if (!docsResult.ok) {
    return (
      <div className="mx-auto w-full max-w-4xl p-6">
        <OperationError error={docsResult.error} />
      </div>
    );
  }

  const owners = ownersResult.ok ? ownersResult.data : [];

  return (
    <div className="mx-auto w-full max-w-7xl">
      <div className="mb-6">
        <h1 className="text-3xl font-semibold text-slate-900">Run Analysis</h1>
        <p className="mt-1 text-sm text-slate-600">
          Select documentation to analyze and compare for contradictions and obsolescence.
        </p>
      </div>

      <RunAnalysisView
        initialItems={docsResult.data.items}
        initialTotal={docsResult.data.total}
        eligibleOwners={owners}
      />
    </div>
  );
}
