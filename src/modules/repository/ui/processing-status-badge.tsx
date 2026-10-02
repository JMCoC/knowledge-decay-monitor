import type { ProcessingStatus } from "@/types/contracts";

interface Props {
    status: ProcessingStatus | null;
}

export function ProcessingStatusBadge({ status }: Props) {
    if (!status) {
        return <span className="text-xs text-zinc-400">Sin versión</span>;
    }

    switch (status) {
        case "ready":
            return (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-600/20">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    Listo
                </span>
            );
        case "processing":
            return (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-inset ring-amber-600/20">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
                    Procesando...
                </span>
            );
        case "processing_failed":
            return (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-50 px-2.5 py-0.5 text-xs font-medium text-rose-700 ring-1 ring-inset ring-rose-600/20">
                    <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />
                    Falló
                </span>
            );
        case "uploaded":
            return (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-50 px-2.5 py-0.5 text-xs font-medium text-zinc-700 ring-1 ring-inset ring-zinc-600/20">
                    <span className="h-1.5 w-1.5 rounded-full bg-zinc-400" />
                    Cargado
                </span>
            );
    }
}