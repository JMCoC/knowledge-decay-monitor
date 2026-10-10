"use client";

import { useState, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import type { ActionError, UploadSnapshot, UploadTarget } from "@/types/contracts";
import { OperationError } from "@/components/operation-error";
import { captureClientTransportFailure } from "@/lib/observability/client-failure";
import { finalizeUpload, getUploadState, recoverUpload, resumeUpload } from "../index";
import { canonicalMimeFor, extensionFromFileName } from "../validation";
import { createUploadReference } from "./upload-session";

function isTarget(value: UploadTarget | UploadSnapshot): value is UploadTarget {
  return "storagePath" in value;
}

function isSnapshot(value: UploadTarget | UploadSnapshot): value is UploadSnapshot {
  return !isTarget(value);
}

interface Props {
  versionId: string;
}

export function RecoverUploadButton({ versionId }: Props) {
  const router = useRouter();
  const [client] = useState(() => createBrowserSupabaseClient());
  const [isBusy, setIsBusy] = useState(false);
  const [needsFile, setNeedsFile] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<ActionError | null>(null);

  async function beginRecovery() {
    if (isBusy) return;
    setIsBusy(true);
    setMessage(null);
    setOperationError(null);
    try {
      const current = await getUploadState(versionId);
      if (!current.ok) {
        setOperationError(current.error);
        return;
      }
      if (current.data.uploadState === "confirmed") {
        setMessage("The original upload is confirmed.");
        router.refresh();
        return;
      }

      let snapshot = current.data;
      if (snapshot.canRecover) {
        const recovered = await recoverUpload(versionId);
        if (!recovered.ok) {
          setOperationError(recovered.error);
          return;
        }
        snapshot = recovered.data;
      }
      if (snapshot.uploadState === "confirmed") {
        setMessage("The original upload is confirmed.");
        router.refresh();
        return;
      }

      const resumed = await resumeUpload(versionId);
      if (!resumed.ok) {
        setOperationError(resumed.error);
        return;
      }
      if (isSnapshot(resumed.data) && resumed.data.uploadState === "confirmed") {
        setMessage("The original upload is confirmed.");
        router.refresh();
        return;
      }
      if (isTarget(resumed.data) || (isSnapshot(resumed.data) && resumed.data.canResume)) {
        setNeedsFile(true);
        setMessage("Select the original file to resume this upload.");
        return;
      }
      setMessage("This upload is still being verified. Try again shortly.");
    } catch {
      setOperationError(captureClientTransportFailure());
    } finally {
      setIsBusy(false);
    }
  }

  async function resumeWithFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || isBusy) return;

    setIsBusy(true);
    setMessage(null);
    setOperationError(null);
    try {
      const reference = await createUploadReference(file);
      let resumed = await resumeUpload(versionId, reference);
      if (!resumed.ok) {
        setOperationError({
          ...resumed.error,
          message: "The selected file does not match this upload or it can no longer be resumed.",
        });
        return;
      }
      if (isSnapshot(resumed.data) && resumed.data.uploadState === "confirmed") {
        setMessage("The original upload is confirmed.");
        router.refresh();
        return;
      }

      let target: UploadTarget | null = isTarget(resumed.data) ? resumed.data : null;
      if (!target && isSnapshot(resumed.data) && !resumed.data.canResume) {
        setMessage("This upload is still being verified. Try again shortly.");
        return;
      }
      if (!target) {
        resumed = await resumeUpload(versionId);
        if (!resumed.ok) {
          setOperationError(resumed.error);
          return;
        }
        if (isSnapshot(resumed.data) && resumed.data.uploadState === "confirmed") {
          setMessage("The original upload is confirmed.");
          router.refresh();
          return;
        }
        if (isTarget(resumed.data)) target = resumed.data;
      }
      if (!target) {
        setMessage("This upload is still being verified. Try again shortly.");
        return;
      }

      const extension = extensionFromFileName(file.name);
      if (!extension || canonicalMimeFor(extension) !== target.canonicalMimeType) {
        setMessage("The selected file type does not match this upload.");
        return;
      }

      const transfer = await client.storage.from("documents").upload(
        target.storagePath,
        file,
        { contentType: target.canonicalMimeType, upsert: false },
      );
      if (transfer.error) {
        const reconciled = await resumeUpload(versionId, reference).catch(() => null);
        if (reconciled?.ok && isSnapshot(reconciled.data) && reconciled.data.uploadState === "confirmed") {
          setMessage("The original upload is confirmed.");
          setNeedsFile(false);
          router.refresh();
        } else {
          setMessage("The transfer did not complete. You can select the original file to try again.");
          setOperationError(
            reconciled && !reconciled.ok ? reconciled.error : captureClientTransportFailure(),
          );
        }
        return;
      }

      const finalized = await finalizeUpload({ versionId, attemptId: target.attemptId });
      if (finalized.ok && finalized.data.uploadState === "confirmed") {
        setNeedsFile(false);
        setMessage("The original upload is confirmed.");
        router.refresh();
        return;
      }
      const reconciled = await resumeUpload(versionId, reference).catch(() => null);
      if (reconciled?.ok && isSnapshot(reconciled.data) && reconciled.data.uploadState === "confirmed") {
        setNeedsFile(false);
        setMessage("The original upload is confirmed.");
        router.refresh();
        return;
      }
      if (!finalized.ok) setOperationError(finalized.error);
      else if (!reconciled) setOperationError(captureClientTransportFailure());
      else if (!reconciled.ok) setOperationError(reconciled.error);
      setMessage("The upload is not confirmed yet. Try again shortly.");
    } catch {
      setOperationError(captureClientTransportFailure());
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <div className="inline-flex flex-col items-end gap-2">
      <button
        type="button"
        disabled={isBusy}
        onClick={() => void beginRecovery()}
        className="rounded border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-50 disabled:cursor-wait disabled:opacity-50"
      >
        {isBusy ? "Recovering…" : "Recover upload"}
      </button>
      {needsFile && (
        <label className="cursor-pointer text-xs font-medium text-blue-700 underline">
          Select original file
          <input
            type="file"
            accept=".pdf,.docx,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/markdown,text/plain"
            aria-label="Select original file"
            onChange={(event) => void resumeWithFile(event)}
            className="sr-only"
          />
        </label>
      )}
      {message && <span role="status" className="max-w-56 text-xs text-zinc-600">{message}</span>}
      {operationError && (
        <div className="max-w-56 text-xs text-red-700">
          <OperationError error={operationError} />
        </div>
      )}
    </div>
  );
}
