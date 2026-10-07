"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { OperationError } from "@/components/operation-error";
import { captureClientTransportFailure } from "@/lib/observability/client-failure";
import type { ActionError } from "@/types/contracts";
import { retryProcessing } from "@/modules/ingestion";

interface Props {
  versionId: string;
}

export function RetryProcessingButton({ versionId }: Props) {
  const router = useRouter();
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function handleRetry() {
    if (isPending) return;
    setIsPending(true);
    setError(null);
    setMessage(null);
    try {
      const result = await retryProcessing(versionId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMessage(result.data.processingStatus === "ready"
        ? "Retry completed successfully."
        : "Retry started. Processing is in progress.");
      router.refresh();
    } catch {
      setError(captureClientTransportFailure());
    } finally {
      setIsPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={handleRetry}
        disabled={isPending}
        className="inline-flex items-center gap-1.5 rounded border border-rose-200 bg-white px-2.5 py-1 text-xs font-medium text-rose-700 shadow-sm transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isPending ? "Starting..." : "Retry Processing"}
      </button>
      {message && <p className="text-[11px] text-emerald-700" role="status">{message}</p>}
      {error && (
        <div className="text-[11px] font-medium text-red-600" role="alert">
          <OperationError error={error} />
        </div>
      )}
    </div>
  );
}
