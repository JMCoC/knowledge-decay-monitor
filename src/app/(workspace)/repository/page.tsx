import { listRepositoryDocuments } from "@/modules/repository";
import { OperationError } from "@/components/operation-error";
import { ProcessingStatusBadge } from "@/modules/repository/ui/processing-status-badge";
import { OpenDocumentButton } from "@/modules/repository/ui/open-document-button";
import { requireDocumentActor } from "@/modules/identity";
import { listEligibleOwners } from "@/modules/workspace";
import { UploadPanel } from "@/modules/ingestion/ui/upload-panel";
import { RecoverUploadButton } from "@/modules/ingestion/ui/recover-upload-button";
import { RetryProcessingButton } from "@/modules/repository/ui/retry-processing-button";
import { ProcessingLeaseRefresh } from "@/modules/repository/ui/processing-lease-refresh";
import { processingRecoveryAction } from "@/modules/repository/ui/processing-recovery";
import { RepositoryFilters } from "@/modules/repository/ui/repository-filters";
import { hasRepositoryFilters, parseRepositorySearchParams } from "@/modules/repository/utils/search-params";

type PageProps = {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export const runtime = "nodejs";
export const maxDuration = 90;

export default async function RepositoryPage({ searchParams }: PageProps) {
    const params = await searchParams;
    const query = parseRepositorySearchParams(params);
    const [result, ownersResult] = await Promise.all([
        listRepositoryDocuments(query),
        listEligibleOwners(),
    ]);

    if (!result.ok) {
        return (
            <div className="mx-auto w-full max-w-6xl">
                <h1 className="text-2xl font-semibold text-slate-900">Repository</h1>

                <div
                    role="alert"
                    className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4 text-red-700"
                >
                    <OperationError error={result.error} />
                </div>
            </div>
        );
    }

    const actor = await requireDocumentActor().catch(() => null);
    const nowMs = result.data.asOfMs;
    const hasProcessingInFlight = result.data.items.some(
        (document) => document.latestVersion?.processing_status === "processing",
    );

    return (
        <div className="mx-auto w-full max-w-6xl">
            <div>
                <h1 className="text-3xl font-semibold text-slate-900">Repository</h1>
                <p className="mt-2 text-sm text-zinc-600">
                    Documents available in your workspace
                </p>
            </div>

            {actor && (
                <UploadPanel
                    userId={actor.userId}
                    owners={ownersResult?.ok ? ownersResult.data : []}
                    ownersError={ownersResult && !ownersResult.ok ? ownersResult.error : undefined}
                />
            )}

            <RepositoryFilters owners={ownersResult?.ok ? ownersResult.data : []} />
            <ProcessingLeaseRefresh enabled={hasProcessingInFlight} />

            <p className="mt-4 text-sm text-zinc-500" aria-live="polite">
                {result.data.total} {result.data.total === 1 ? "document" : "documents"}
            </p>

            <div className="mt-8 overflow-hidden rounded-lg border bg-white">
                <table className="w-full text-left text-sm">
                    <thead className="border-b bg-zinc-50">
                        <tr>
                            <th className="px-4 py-3 font-medium">Document</th>
                            <th className="px-4 py-3 font-medium">Category</th>
                            <th className="px-4 py-3 font-medium">Owner</th>
                            <th className="px-4 py-3 font-medium">Version</th>
                            <th className="px-4 py-3 font-medium">Status</th>
                            <th className="px-4 py-3 font-medium text-right">Actions</th>
                        </tr>
                    </thead>

                    <tbody className="divide-y divide-zinc-100">
                        {result.data.items.map((document) => {
                            const latestVersion = document.latestVersion;
                            const recoveryAction = latestVersion
                                ? processingRecoveryAction(latestVersion, nowMs)
                                : null;

                            return (
                            <tr key={document.id} className="hover:bg-zinc-50/50">
                                <td className="px-4 py-4 font-medium text-zinc-900">
                                    {document.name}
                                </td>

                                <td className="px-4 py-4 text-zinc-600">
                                    {document.category}
                                </td>

                                <td className="px-4 py-4 text-zinc-600">
                                    {document.owner?.full_name ?? "Unassigned"}
                                </td>

                                <td className="px-4 py-4 text-zinc-600">
                                    {document.latestVersion
                                        ? `v${document.latestVersion.version_number}`
                                        : "—"}
                                </td>

                                <td className="px-4 py-4">
                                    <ProcessingStatusBadge
                                        hasVersion={latestVersion !== null}
                                        processingStatus={latestVersion?.processing_status ?? null}
                                        uploadState={latestVersion?.uploadState ?? null}
                                    />
                                </td>

                                <td className="px-4 py-4 text-right">
                                    <div className="flex flex-col items-end gap-1">
                                        {recoveryAction && latestVersion
                                            ? <RetryProcessingButton versionId={latestVersion.id} action={recoveryAction} />
                                            : null}
                                        {latestVersion?.canOpen
                                            ? <OpenDocumentButton versionId={latestVersion.id} fileName={document.name} />
                                            : !recoveryAction && latestVersion && latestVersion.uploadState !== null
                                                ? <RecoverUploadButton versionId={latestVersion.id} />
                                                : null}
                                    </div>
                                </td>
                            </tr>
                            );
                        })}

                        {result.data.items.length === 0 && (
                            <tr>
                                <td
                                    colSpan={6}
                                    className="px-4 py-8 text-center text-zinc-500"
                                >
                                    {hasRepositoryFilters(query) ? (
                                        <span className="inline-flex flex-col items-center gap-2">
                                            <span className="font-medium text-zinc-700">No documents found</span>
                                            <span>No documents match the selected filters.</span>
                                            <a href="/repository" className="font-medium text-blue-700 hover:underline">Clear filters</a>
                                        </span>
                                    ) : result.data.total > 0 ? (
                                        <span className="font-medium text-zinc-700">No documents on this page.</span>
                                    ) : (
                                        <span className="inline-flex flex-col items-center gap-2">
                                            <span className="font-medium text-zinc-700">No documents in your workspace yet.</span>
                                            <span>Upload your first document above to get started.</span>
                                        </span>
                                    )}
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
