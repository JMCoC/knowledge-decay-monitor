import type { ProcessingStatus, UploadState } from "@/types/contracts";

interface Props {
    hasVersion: boolean;
    processingStatus: ProcessingStatus | null;
    uploadState: UploadState | null;
    processingQueued?: boolean;
}

export function ProcessingStatusBadge({ hasVersion, processingStatus, uploadState, processingQueued }: Props) {
    if (!hasVersion) {
        return <span className="text-xs text-zinc-400">No version</span>;
    }

    if (uploadState === null) {
        return <span className="text-xs text-amber-700">Needs reconciliation</span>;
    }

    switch (uploadState) {
        case "pending":
            return <span className="text-xs text-amber-700">Upload incomplete</span>;
        case "verifying":
            return <span className="text-xs text-amber-700">Verifying</span>;
        case "rejected":
            return <span className="text-xs text-rose-700">Upload rejected</span>;
        case "recovering":
            return <span className="text-xs text-amber-700">Recovering</span>;
        case "confirmed":
            break;
    }

    switch (processingStatus) {
        case "uploaded":
            if (processingQueued) return <span className="text-xs text-amber-700">Queued</span>;
            return <span className="text-xs text-amber-700">Uploaded</span>;
        case "ready":
            return (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-600/20">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    Ready
                </span>
            );
        case "processing":
            return (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-inset ring-amber-600/20">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
                    Processing
                </span>
            );
        case "processing_failed":
            return (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-50 px-2.5 py-0.5 text-xs font-medium text-rose-700 ring-1 ring-inset ring-rose-600/20">
                    <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />
                    Processing failed
                </span>
            );
        default:
            return <span className="text-xs text-amber-700">Needs reconciliation</span>;
    }
}
