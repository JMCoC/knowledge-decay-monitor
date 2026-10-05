import { listRepositoryDocuments } from "@/modules/repository";
import { OperationError } from "@/components/operation-error";
import { ProcessingStatusBadge } from "@/modules/repository/ui/processing-status-badge";
import { OpenDocumentButton } from "@/modules/repository/ui/open-document-button";
import { requireDocumentActor } from "@/modules/identity";
import { listEligibleOwners } from "@/modules/workspace";
import { UploadPanel } from "@/modules/ingestion/ui/upload-panel";
import { RecoverUploadButton } from "@/modules/ingestion/ui/recover-upload-button";

export const runtime = "nodejs";
export const maxDuration = 90;

export default async function RepositoryPage() {
    const result = await listRepositoryDocuments();

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
    const ownersResult = actor ? await listEligibleOwners() : null;

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
                        {result.data.items.map((document) => (
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
                                        hasVersion={document.latestVersion !== null}
                                        processingStatus={document.latestVersion?.processing_status ?? null}
                                        uploadState={document.latestVersion?.uploadState ?? null}
                                    />
                                </td>

                                <td className="px-4 py-4 text-right">
                                    {document.latestVersion?.canOpen
                                        ? <OpenDocumentButton versionId={document.latestVersion.id} fileName={document.name} />
                                        : document.latestVersion && document.latestVersion.uploadState !== null
                                            ? <RecoverUploadButton versionId={document.latestVersion.id} />
                                            : null}
                                </td>
                            </tr>
                        ))}

                        {result.data.items.length === 0 && (
                            <tr>
                                <td
                                    colSpan={6}
                                    className="px-4 py-8 text-center text-zinc-500"
                                >
                                    No documents found.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
