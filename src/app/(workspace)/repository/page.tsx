import { listRepositoryDocuments } from "@/modules/repository/application/repository.actions";
import { ProcessingStatusBadge } from "@/modules/repository/ui/processing-status-badge";
import { OpenDocumentButton } from "@/modules/repository/ui/open-document-button";

export default async function RepositoryPage() {
    const result = await listRepositoryDocuments();

    if ("error" in result) {
        return (
            <div className="mx-auto w-full max-w-6xl">
                <h1 className="text-2xl font-semibold text-slate-900">Repositorio</h1>

                <div className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">
                    {result.error}
                </div>
            </div>
        );
    }

    return (
        <div className="mx-auto w-full max-w-6xl">
            <div>
                <h1 className="text-3xl font-semibold text-slate-900">Repositorio</h1>
                <p className="mt-2 text-sm text-zinc-600">
                    Documentos disponibles en tu Workspace
                </p>
            </div>

            <div className="mt-8 overflow-hidden rounded-lg border bg-white">
                <table className="w-full text-left text-sm">
                    <thead className="border-b bg-zinc-50">
                        <tr>
                            <th className="px-4 py-3 font-medium">Documento</th>
                            <th className="px-4 py-3 font-medium">Categoría</th>
                            <th className="px-4 py-3 font-medium">Propietario</th>
                            <th className="px-4 py-3 font-medium">Versión</th>
                            <th className="px-4 py-3 font-medium">Estado</th>
                            <th className="px-4 py-3 font-medium text-right">Acciones</th>
                        </tr>
                    </thead>

                    <tbody className="divide-y divide-zinc-100">
                        {result.items.map((document) => (
                            <tr key={document.id} className="hover:bg-zinc-50/50">
                                <td className="px-4 py-4 font-medium text-zinc-900">
                                    {document.name}
                                </td>

                                <td className="px-4 py-4 text-zinc-600">
                                    {document.category}
                                </td>

                                <td className="px-4 py-4 text-zinc-600">
                                    {document.owner?.full_name ?? "Sin propietario"}
                                </td>

                                <td className="px-4 py-4 text-zinc-600">
                                    {document.latestVersion
                                        ? `v${document.latestVersion.version_number}`
                                        : "—"}
                                </td>

                                <td className="px-4 py-4">
                                    <ProcessingStatusBadge
                                        status={
                                            document.latestVersion?.processing_status ?? null
                                        }
                                    />
                                </td>

                                <td className="px-4 py-4 text-right">
                                    <OpenDocumentButton
                                        versionId={document.latestVersion?.id ?? null}
                                        fileName={document.name}
                                    />
                                </td>
                            </tr>
                        ))}

                        {result.items.length === 0 && (
                            <tr>
                                <td
                                    colSpan={6}
                                    className="px-4 py-8 text-center text-zinc-500"
                                >
                                    No hay documentos disponibles.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}