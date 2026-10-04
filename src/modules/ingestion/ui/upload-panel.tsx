"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type { DocumentCategory, EligibleOwner } from "@/types/contracts";
import {
  finalizeUpload,
  getUploadState,
  recoverUpload,
  reserveUpload,
  resumeUpload,
} from "@/modules/ingestion";
import { MAX_FILE_SIZE_BYTES } from "@/modules/ingestion";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { getSupabaseEnv } from "@/lib/supabase/env";
import {
  clearOtherPendingUploadNamespaces,
  createPendingUploadPersistence,
  pendingUploadStorageKey,
  prepareUpload,
  readPendingUploads,
  runUploadBatch,
  type PendingUploadRecord,
  type UploadSessionStatus,
} from "./upload-session";

const CATEGORIES: DocumentCategory[] = [
  "SOP",
  "Policy",
  "Manual",
  "QA Process",
  "Security",
  "Engineering Guideline",
  "Other",
];

interface DraftFile {
  file: File;
  idempotencyKey: string;
  name: string;
  category: DocumentCategory | "";
  ownerId: string;
  status: UploadSessionStatus | null;
}

interface Props {
  userId: string;
  owners: EligibleOwner[];
  ownersError?: string;
}

const STATUS_LABELS: Record<UploadSessionStatus, string> = {
  preparing: "Preparing",
  uploading: "Uploading",
  verifying: "Verifying",
  upload_incomplete: "Upload incomplete",
  upload_rejected: "Upload rejected",
  recovering: "Recovering",
  uploaded_processing_pending: "Uploaded — processing pending",
  needs_reconciliation: "Needs reconciliation",
};

function displayName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "").slice(0, 200);
}

export function UploadPanel({ userId, owners, ownersError }: Props) {
  const browserClient = useMemo(() => createBrowserSupabaseClient(), []);
  const projectUrl = getSupabaseEnv().url;
  const storageKey = useMemo(() => pendingUploadStorageKey(projectUrl, userId), [projectUrl, userId]);
  const persistenceRef = useRef<ReturnType<typeof createPendingUploadPersistence> | null>(null);
  const [drafts, setDrafts] = useState<DraftFile[]>([]);
  const [pendingData, setPendingData] = useState<{ key: string; records: PendingUploadRecord[] }>({ key: "", records: [] });
  const [fileError, setFileError] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const pendingUploads = pendingData.key === storageKey ? pendingData.records : [];

  useEffect(() => {
    let persistence: ReturnType<typeof createPendingUploadPersistence>;
    try {
      persistence = createPendingUploadPersistence(window.localStorage, storageKey);
      persistenceRef.current = persistence;
      clearOtherPendingUploadNamespaces(window.localStorage, projectUrl, storageKey);
    } catch {
      const timer = window.setTimeout(
        () => setStorageError("Pending upload recovery is unavailable in this browser."),
        0,
      );
      return () => window.clearTimeout(timer);
    }

    const loadTimer = window.setTimeout(
      () => setPendingData({ key: storageKey, records: persistence.read() }),
      0,
    );
    const { data: { subscription } } = browserClient.auth.onAuthStateChange((_event, session) => {
      if (!session || session.user.id !== userId) {
        try {
          persistence.clearAll();
        } catch {
          // The next identity receives a different storage namespace.
        }
        setPendingData({ key: storageKey, records: [] });
        setDrafts([]);
      }
    });

    return () => {
      window.clearTimeout(loadTimer);
      subscription.unsubscribe();
    };
  }, [browserClient, projectUrl, storageKey, userId]);

  function updatePending(record: PendingUploadRecord) {
    const persistence = persistenceRef.current;
    if (!persistence) throw new Error("Pending upload storage is unavailable.");
    persistence.save(record);
    setPendingData({ key: storageKey, records: persistence.read() });
  }

  function clearPending(idempotencyKey: string) {
    const persistence = persistenceRef.current;
    if (!persistence) return;
    persistence.clear(idempotencyKey);
    setPendingData({ key: storageKey, records: persistence.read() });
  }

  function selectFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    setFileError(null);
    if (files.length > 10) {
      setDrafts([]);
      setFileError("Choose between 1 and 10 files.");
      return;
    }

    setDrafts(files.map((file) => ({
      file,
      idempotencyKey: crypto.randomUUID(),
      name: displayName(file.name),
      category: "",
      ownerId: owners[0]?.id ?? "",
      status: file.size > MAX_FILE_SIZE_BYTES ? "upload_rejected" : null,
    })));
    if (files.some((file) => file.size > MAX_FILE_SIZE_BYTES)) {
      setFileError("Each file must be 10 MiB or smaller.");
    }
  }

  function updateDraft(index: number, update: Partial<DraftFile>) {
    setDrafts((current) => current.map((draft, row) => row === index ? { ...draft, ...update } : draft));
  }

  async function submit(resumePending: boolean) {
    if (isSubmitting || drafts.length === 0) return;
    setFileError(null);
    if (drafts.length > 10) {
      setFileError("Choose between 1 and 10 files.");
      return;
    }
    if (drafts.some((draft) => draft.file.size > MAX_FILE_SIZE_BYTES)) {
      setFileError("Each file must be 10 MiB or smaller.");
      setDrafts((current) => current.map((draft) => draft.file.size > MAX_FILE_SIZE_BYTES
        ? { ...draft, status: "upload_rejected" }
        : draft));
      return;
    }
    if (drafts.some((draft) => !draft.name.trim() || !draft.category || !draft.ownerId)) {
      setFileError("Add a document name, category, and owner for every file.");
      return;
    }
    if (owners.length === 0 || ownersError) {
      setFileError(ownersError ?? "No eligible workspace owners are available.");
      return;
    }
    if (!persistenceRef.current) {
      setFileError(storageError ?? "Pending upload recovery is unavailable in this browser.");
      return;
    }

    setIsSubmitting(true);
    setDrafts((current) => current.map((draft) => ({ ...draft, status: "preparing" })));
    try {
      const prepared = [];
      for (const [index, draft] of drafts.entries()) {
        const pendingKey = resumePending ? pendingUploads[index]?.idempotencyKey : undefined;
        const idempotencyKey = pendingKey ?? draft.idempotencyKey;
        if (pendingKey) updateDraft(index, { idempotencyKey });
        prepared.push(await prepareUpload(
          draft.file,
          { name: draft.name, category: draft.category as DocumentCategory, ownerId: draft.ownerId },
          idempotencyKey,
        ));
      }

      const outcomes = await runUploadBatch(prepared, {
        reserveUpload,
        uploadToStorage: async (target, file) => {
          const { error } = await browserClient.storage.from("documents").upload(
            target.storagePath,
            file,
            { contentType: target.canonicalMimeType, upsert: false },
          );
          if (error) throw new Error("The Storage upload did not complete.");
        },
        finalizeUpload,
        getUploadState,
        resumeUpload,
        recoverUpload,
        savePending: updatePending,
        clearPending,
        setStatus: (index, status) => updateDraft(index, { status }),
      });
      setDrafts((current) => current.map((draft, index) => ({
        ...draft,
        status: outcomes[index]?.status ?? "upload_incomplete",
      })));
    } catch {
      setFileError("The upload could not be prepared. Check the file and try again.");
      setDrafts((current) => current.map((draft) => ({ ...draft, status: "upload_rejected" })));
    } finally {
      try {
        setPendingData({ key: storageKey, records: readPendingUploads(window.localStorage, storageKey) });
      } catch {
        setStorageError("Pending upload recovery is unavailable in this browser.");
      }
      setIsSubmitting(false);
    }
  }

  const canSubmit = drafts.length > 0
    && drafts.every((draft) => draft.file.size <= MAX_FILE_SIZE_BYTES)
    && !isSubmitting && !ownersError && owners.length > 0;

  return (
    <section aria-labelledby="upload-heading" className="mt-8 rounded-lg border bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="upload-heading" className="text-xl font-semibold text-slate-900">Upload documents</h2>
          <p className="mt-1 text-sm text-zinc-600">Choose 1 to 10 PDF, DOCX, or Markdown files, up to 10 MiB each.</p>
        </div>
        <label className="inline-flex cursor-pointer items-center rounded border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50">
          Choose files
          <input
            type="file"
            multiple
            accept=".pdf,.docx,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/markdown,text/plain"
            aria-label="Choose PDF, DOCX, or Markdown files"
            onChange={selectFiles}
            className="sr-only"
          />
        </label>
      </div>

      {pendingUploads.length > 0 && (
        <p className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          {pendingUploads.length} upload{pendingUploads.length === 1 ? "" : "s"} may need attention. Select the same files and choose Resume selected files, or choose Upload files for new documents.
        </p>
      )}
      {ownersError && <p role="alert" className="mt-4 text-sm text-red-700">{ownersError}</p>}
      {storageError && <p role="alert" className="mt-4 text-sm text-red-700">{storageError}</p>}
      {fileError && <p role="alert" className="mt-4 text-sm text-red-700">{fileError}</p>}

      {drafts.length > 0 && (
        <div className="mt-5 space-y-4">
          {drafts.map((draft, index) => (
            <article key={`${draft.idempotencyKey}-${index}`} className="rounded-md border border-zinc-200 p-4">
              <p className="truncate text-sm font-medium text-zinc-900">{draft.file.name}</p>
              <p className="mt-1 text-xs text-zinc-500">{draft.file.size.toLocaleString()} bytes</p>
              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <div>
                  <label htmlFor={`upload-name-${index}`} className="mb-1 block text-xs font-medium text-zinc-700">Document name</label>
                  <input
                    id={`upload-name-${index}`}
                    value={draft.name}
                    maxLength={200}
                    onChange={(event) => updateDraft(index, { name: event.currentTarget.value })}
                    className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label htmlFor={`upload-category-${index}`} className="mb-1 block text-xs font-medium text-zinc-700">Category</label>
                  <select
                    id={`upload-category-${index}`}
                    value={draft.category}
                    onChange={(event) => updateDraft(index, { category: event.currentTarget.value as DocumentCategory | "" })}
                    className="w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm"
                  >
                    <option value="">Select a category</option>
                    {CATEGORIES.map((category) => <option key={category} value={category}>{category}</option>)}
                  </select>
                </div>
                <div>
                  <label htmlFor={`upload-owner-${index}`} className="mb-1 block text-xs font-medium text-zinc-700">Owner</label>
                  <select
                    id={`upload-owner-${index}`}
                    value={draft.ownerId}
                    onChange={(event) => updateDraft(index, { ownerId: event.currentTarget.value })}
                    className="w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm"
                  >
                    <option value="">Select an owner</option>
                    {owners.map((owner) => <option key={owner.id} value={owner.id}>{owner.fullName}</option>)}
                  </select>
                </div>
              </div>
              {draft.status && (
                <p className="mt-3 text-sm text-zinc-700" role="status" aria-live="polite">
                  {STATUS_LABELS[draft.status]}
                </p>
              )}
            </article>
          ))}
        </div>
      )}

      <div className="mt-5 flex flex-wrap gap-3">
        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => void submit(false)}
          className="rounded bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Upload files
        </button>
        {pendingUploads.length > 0 && (
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => void submit(true)}
            className="rounded border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-800 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Resume selected files
          </button>
        )}
      </div>
    </section>
  );
}
