"use client";

import { useState } from "react";
import type { ActionError } from "@/types/contracts";
import { OperationError } from "@/components/operation-error";
import { captureClientTransportFailure } from "@/lib/observability/client-failure";
import { getDocumentOriginalUrlAction } from "@/modules/repository";

interface Props {
    versionId: string | null;
    fileName: string;
}

export function OpenDocumentButton({ versionId, fileName }: Props) {
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<ActionError | null>(null);

    if (!versionId) {
        return <span className="text-xs text-zinc-400">—</span>;
    }

    async function handleOpen() {
        if (!versionId || isLoading) return;

        setError(null);

        const targetWindow = window.open("", "_blank");
        if (!targetWindow) {
            setError({
                code: "INTERNAL_ERROR",
                message: "Your browser blocked the new tab. Allow pop-ups and try again.",
            });
            return;
        }

        setIsLoading(true);

        try {
            const result = await getDocumentOriginalUrlAction(versionId);

            if (!result.ok) {
                targetWindow.close();
                setError(result.error);
                return;
            }

            targetWindow.location.href = result.data.url;
        } catch {
            targetWindow.close();
            setError(captureClientTransportFailure());
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
                aria-label={`Open file ${fileName}`}
                className="inline-flex items-center gap-1.5 rounded border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 shadow-sm transition hover:bg-zinc-50 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
            >
                {isLoading ? (
                    <>
                        <span className="h-3 w-3 animate-spin rounded-full border-2 border-zinc-500 border-t-transparent" />
                        Opening...
                    </>
                ) : (
                    "Open file"
                )}
            </button>
            {error && (
                <div className="text-[11px] text-red-600 font-medium">
                    <OperationError error={error} />
                </div>
            )}
        </div>
    );
}
