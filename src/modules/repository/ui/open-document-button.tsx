"use client";

import { useState } from "react";
import { getDocumentOriginalUrlAction } from "../application/repository.actions";

interface Props {
    versionId: string | null;
    fileName: string;
}

export function OpenDocumentButton({ versionId, fileName }: Props) {
    const [isLoading, setIsLoading] = useState(false);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);

    if (!versionId) {
        return <span className="text-xs text-zinc-400">—</span>;
    }

    async function handleOpen() {
        if (!versionId || isLoading) return;

        setErrorMsg(null);

        // 1. Abrir la ventana en el contexto síncrono del clic
        const targetWindow = window.open("", "_blank");

        setIsLoading(true);

        try {
            const result = await getDocumentOriginalUrlAction(versionId);

            if (!result.ok) {
                // Si la acción falla o no está autorizado, cerramos la pestaña huérfana
                targetWindow?.close();
                setErrorMsg(result.error.message);
                return;
            }

            // 2. Si es exitoso, redirigimos la pestaña a la signed URL generada
            if (targetWindow) {
                targetWindow.location.href = result.data.url;
            }
        } catch {
            targetWindow?.close();
            setErrorMsg("Error de conexión al abrir el archivo");
        } finally {
            setIsLoading(false);
        }
    }

    return (
        <div className="flex flex-col items-end gap-1">
            <button
                type="button"
                onClick={handleOpen}
                disabled={isLoading}
                aria-label={`Abrir archivo ${fileName}`}
                className="inline-flex items-center gap-1.5 rounded border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 shadow-sm transition hover:bg-zinc-50 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
            >
                {isLoading ? (
                    <>
                        <span className="h-3 w-3 animate-spin rounded-full border-2 border-zinc-500 border-t-transparent" />
                        Abriendo...
                    </>
                ) : (
                    "Abrir archivo"
                )}
            </button>
            {errorMsg && (
                <span className="text-[11px] text-red-600 font-medium">{errorMsg}</span>
            )}
        </div>
    );
}