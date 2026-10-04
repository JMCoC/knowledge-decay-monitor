"use client";

import { useState, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import type { UploadSnapshot, UploadTarget } from "@/types/contracts";
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

  async function beginRecovery() {
    if (isBusy) return;
    setIsBusy(true);
    setMessage(null);
    try {
      const current = await getUploadState(versionId);
      if (!current.ok) {
        setMessage(current.error.message);
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
          setMessage(recovered.error.message);
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
        setMessage(resumed.error.message);
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
      setMessage("We couldn't recover this upload. Try again.");
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
    try {
      const reference = await createUploadReference(file);
      let resumed = await resumeUpload(versionId, reference);
      if (!resumed.ok) {
        setMessage("The selected file does not match this upload or it can no longer be resumed.");
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
          setMessage("We couldn't prepare this upload for recovery. Try again.");
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
      setMessage("The upload is not confirmed yet. Try again shortly.");
    } catch {
      setMessage("The selected file could not be prepared for recovery.");
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
    </div>
  );
}
