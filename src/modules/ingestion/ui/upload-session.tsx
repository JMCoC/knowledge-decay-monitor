import type {
  ActionError,
  ActionResult,
  UploadItemInput,
  UploadItemResult,
  UploadReference,
  UploadSnapshot,
  UploadTarget,
  UploadMetadata,
} from "@/types/contracts";
import {
  canonicalMimeFor,
  extensionFromFileName,
  isValidFileSize,
} from "../validation";

export const MAX_PARALLEL_UPLOADS = 2;

export type UploadSessionStatus =
  | "preparing"
  | "uploading"
  | "verifying"
  | "upload_incomplete"
  | "upload_rejected"
  | "recovering"
  | "uploaded_processing_pending"
  | "needs_reconciliation";

export interface PreparedUpload {
  file: File;
  metadata: UploadMetadata;
  idempotencyKey: string;
  reference: UploadReference;
}

export interface PendingUploadRecord {
  idempotencyKey: string;
  documentId?: string;
  versionId?: string;
  attemptId?: string;
}

export interface UploadSessionDependencies {
  reserveUpload(items: UploadItemInput[]): Promise<ActionResult<UploadItemResult[]>>;
  uploadToStorage(target: UploadTarget, file: File): Promise<void>;
  finalizeUpload(input: { versionId: string; attemptId: string }): Promise<ActionResult<UploadSnapshot>>;
  getUploadState(versionId: string): Promise<ActionResult<UploadSnapshot>>;
  resumeUpload(
    versionId: string,
    reference?: UploadReference,
  ): Promise<ActionResult<UploadTarget | UploadSnapshot>>;
  recoverUpload(versionId: string): Promise<ActionResult<UploadSnapshot>>;
  savePending(record: PendingUploadRecord): void;
  clearPending(idempotencyKey: string): void;
  setStatus?(index: number, status: UploadSessionStatus, error?: ActionError): void;
  captureTransportFailure?(): ActionError;
}

export interface UploadBatchResult {
  index: number;
  status: UploadSessionStatus;
  error?: ActionError;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function createUploadReference(file: File): Promise<UploadReference> {
  const extension = extensionFromFileName(file.name);
  if (!extension || !isValidFileSize(file.size)) {
    throw new Error("The selected file cannot be uploaded.");
  }

  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const prefix = new Uint8Array(await file.slice(0, Math.min(8, file.size)).arrayBuffer());
  return {
    sizeBytes: file.size,
    sha256: Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join(""),
    signature: toBase64(prefix),
  };
}

/** Computes only a short prefix and a full in-memory digest; file bytes never leave the browser for an Action. */
export async function prepareUpload(
  file: File,
  metadata: UploadMetadata,
  idempotencyKey: string,
): Promise<PreparedUpload> {
  if (!UUID.test(idempotencyKey)) {
    throw new Error("The selected file cannot be uploaded.");
  }

  return {
    file,
    metadata,
    idempotencyKey,
    reference: await createUploadReference(file),
  };
}

export function pendingUploadStorageKey(projectUrl: string, userId: string): string {
  if (!UUID.test(userId)) throw new Error("The authenticated user identifier is invalid.");
  const url = new URL(projectUrl);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("The Supabase project URL is invalid.");
  }
  return `kdm:pending-uploads:${url.origin}:${userId}`;
}

function isSafeRecord(value: unknown): value is PendingUploadRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const allowed = new Set(["idempotencyKey", "documentId", "versionId", "attemptId"]);
  return Object.keys(record).every((key) => allowed.has(key))
    && typeof record.idempotencyKey === "string" && UUID.test(record.idempotencyKey)
    && (record.documentId === undefined || (typeof record.documentId === "string" && UUID.test(record.documentId)))
    && (record.versionId === undefined || (typeof record.versionId === "string" && UUID.test(record.versionId)))
    && (record.attemptId === undefined || (typeof record.attemptId === "string" && UUID.test(record.attemptId)));
}

export function readPendingUploads(storage: Pick<Storage, "getItem">, key: string): PendingUploadRecord[] {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return [];
  }
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || !value.every(isSafeRecord)) return [];
    return value.map((record) => ({
      idempotencyKey: record.idempotencyKey,
      ...(record.documentId ? { documentId: record.documentId } : {}),
      ...(record.versionId ? { versionId: record.versionId } : {}),
      ...(record.attemptId ? { attemptId: record.attemptId } : {}),
    }));
  } catch {
    return [];
  }
}

export function createPendingUploadPersistence(storage: Storage, key: string) {
  function write(records: PendingUploadRecord[]) {
    storage.setItem(key, JSON.stringify(records));
  }

  return {
    read: () => readPendingUploads(storage, key),
    save(record: PendingUploadRecord) {
      const safeRecord: PendingUploadRecord = {
        idempotencyKey: record.idempotencyKey,
        ...(record.documentId ? { documentId: record.documentId } : {}),
        ...(record.versionId ? { versionId: record.versionId } : {}),
        ...(record.attemptId ? { attemptId: record.attemptId } : {}),
      };
      if (!isSafeRecord(safeRecord)) throw new Error("The pending upload reference is invalid.");
      const records = readPendingUploads(storage, key).filter(
        (existing) => existing.idempotencyKey !== safeRecord.idempotencyKey,
      );
      write([...records, safeRecord]);
    },
    clear(idempotencyKey: string) {
      write(readPendingUploads(storage, key).filter((record) => record.idempotencyKey !== idempotencyKey));
    },
    clearAll() {
      storage.removeItem(key);
    },
  };
}

export function clearOtherPendingUploadNamespaces(
  storage: Storage,
  projectUrl: string,
  currentKey: string,
) {
  const projectOrigin = new URL(projectUrl).origin;
  const prefix = `kdm:pending-uploads:${projectOrigin}:`;
  const staleKeys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(prefix) && key !== currentKey) staleKeys.push(key);
  }
  for (const key of staleKeys) storage.removeItem(key);
}

function isTarget(value: UploadTarget | UploadSnapshot): value is UploadTarget {
  return "storagePath" in value;
}

function statusForSnapshot(snapshot: UploadSnapshot): UploadSessionStatus {
  if (snapshot.uploadState === "confirmed") return "uploaded_processing_pending";
  if (snapshot.uploadState === "rejected") return "upload_rejected";
  if (snapshot.uploadState === null) return "needs_reconciliation";
  if (snapshot.uploadState === "recovering" || snapshot.canRecover) return "recovering";
  return "upload_incomplete";
}

type ReconcileResult =
  | { kind: "complete"; status: UploadSessionStatus }
  | { kind: "retry"; target: UploadTarget }
  | { kind: "stop"; status: UploadSessionStatus; error?: ActionError };

function transportFailure(deps: UploadSessionDependencies): ActionError {
  try {
    return deps.captureTransportFailure?.() ?? {
      code: "INTERNAL_ERROR",
      message: "We couldn't confirm the operation. Refresh and try again.",
    };
  } catch {
    return {
      code: "INTERNAL_ERROR",
      message: "We couldn't confirm the operation. Refresh and try again.",
    };
  }
}

async function reconcileAmbiguousUpload(
  item: PreparedUpload,
  target: UploadTarget,
  index: number,
  deps: UploadSessionDependencies,
): Promise<ReconcileResult> {
  let state = await deps.getUploadState(target.versionId).catch(() => null);
  if (!state) return { kind: "stop", status: "upload_incomplete", error: transportFailure(deps) };
  if (!state.ok) return { kind: "stop", status: "upload_incomplete", error: state.error };
  if (state.data.uploadState === "confirmed") {
    deps.clearPending(item.idempotencyKey);
    return { kind: "complete", status: "uploaded_processing_pending" };
  }
  if (state.data.uploadState === null) {
    return {
      kind: "stop",
      status: "needs_reconciliation",
      error: {
        code: "INTERNAL_ERROR",
        message: "We couldn't confirm the operation. Refresh and try again.",
      },
    };
  }
  if (state.data.uploadState === "rejected") return { kind: "stop", status: "upload_rejected" };

  if (state.data.canRecover) {
    deps.setStatus?.(index, "recovering");
    const recovered = await deps.recoverUpload(target.versionId).catch(() => null);
    if (!recovered) return { kind: "stop", status: "upload_incomplete", error: transportFailure(deps) };
    if (!recovered.ok) return { kind: "stop", status: "upload_incomplete", error: recovered.error };
    state = recovered;
    if (state.data.uploadState === "confirmed") {
      deps.clearPending(item.idempotencyKey);
      return { kind: "complete", status: "uploaded_processing_pending" };
    }
    return { kind: "stop", status: statusForSnapshot(state.data) };
  }

  if (!state.data.canResume) return { kind: "stop", status: statusForSnapshot(state.data) };
  const resumed = await deps.resumeUpload(target.versionId, item.reference).catch(() => null);
  if (!resumed) return { kind: "stop", status: "upload_incomplete", error: transportFailure(deps) };
  if (!resumed.ok) return { kind: "stop", status: "upload_incomplete", error: resumed.error };
  if (isTarget(resumed.data)) return { kind: "retry", target: resumed.data };
  if (resumed.data.uploadState === "confirmed") {
    deps.clearPending(item.idempotencyKey);
    return { kind: "complete", status: "uploaded_processing_pending" };
  }
  if (resumed.data.canRecover) {
    deps.setStatus?.(index, "recovering");
    const recovered = await deps.recoverUpload(target.versionId).catch(() => null);
    if (recovered?.ok && recovered.data.uploadState === "confirmed") {
      deps.clearPending(item.idempotencyKey);
      return { kind: "complete", status: "uploaded_processing_pending" };
    }
    return {
      kind: "stop",
      status: recovered?.ok ? statusForSnapshot(recovered.data) : "upload_incomplete",
      error: recovered ? (recovered.ok ? undefined : recovered.error) : transportFailure(deps),
    };
  }
  return { kind: "stop", status: statusForSnapshot(resumed.data) };
}

export async function runUploadBatch(
  items: PreparedUpload[],
  deps: UploadSessionDependencies,
): Promise<UploadBatchResult[]> {
  const results: UploadBatchResult[] = items.map((_, index) => ({ index, status: "preparing" }));
  const setStatus = (index: number, status: UploadSessionStatus, error?: ActionError) => {
    results[index] = { index, status, ...(error ? { error } : {}) };
    deps.setStatus?.(index, status, error);
  };
  const finishAll = (status: UploadSessionStatus, error?: ActionError) => items.map((_, index) => {
    setStatus(index, status, error);
    return results[index]!;
  });

  if (items.length < 1 || items.length > 10) {
    return finishAll("upload_rejected");
  }

  try {
    for (const item of items) deps.savePending({ idempotencyKey: item.idempotencyKey });
  } catch {
    return finishAll("upload_incomplete");
  }

  let reservation: ActionResult<UploadItemResult[]>;
  try {
    reservation = await deps.reserveUpload(items.map((item) => {
      const extension = extensionFromFileName(item.file.name);
      if (!extension || !isValidFileSize(item.file.size) || item.reference.sizeBytes !== item.file.size) {
        throw new Error("The selected file cannot be uploaded.");
      }
      return {
        metadata: item.metadata,
        fileName: item.file.name,
        declaredMimeType: item.file.type || canonicalMimeFor(extension),
        sizeBytes: item.reference.sizeBytes,
        signature: item.reference.signature,
        idempotencyKey: item.idempotencyKey,
        sha256: item.reference.sha256,
      };
    }));
  } catch {
    return finishAll("upload_incomplete", transportFailure(deps));
  }
  if (!reservation.ok) return finishAll("upload_incomplete", reservation.error);

  const entries = new Map(reservation.data.map((entry) => [entry.index, entry.outcome]));
  let finalizationQueue = Promise.resolve();
  const finalizeSerially = <T,>(operation: () => Promise<T>) => {
    const next = finalizationQueue.then(operation, operation);
    finalizationQueue = next.then(() => undefined, () => undefined);
    return next;
  };

  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(MAX_PARALLEL_UPLOADS, items.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      const item = items[index];
      if (!item) return;
      const outcome = entries.get(index);
      if (!outcome) {
        setStatus(index, "upload_incomplete", transportFailure(deps));
        continue;
      }
      if (!outcome.ok) {
        setStatus(
          index,
          outcome.error.code === "INVALID_INPUT" ? "upload_rejected" : "upload_incomplete",
          outcome.error,
        );
        continue;
      }

      const target = outcome.target;
      try {
        deps.savePending({
          idempotencyKey: item.idempotencyKey,
          documentId: outcome.documentId,
          versionId: target.versionId,
          attemptId: target.attemptId,
        });
      } catch {
        setStatus(index, "upload_incomplete");
        continue;
      }
      let currentTarget = target;
      let uploadSucceeded = false;
      setStatus(index, "uploading");
      try {
        await deps.uploadToStorage(currentTarget, item.file);
        uploadSucceeded = true;
      } catch {
        const reconciled = await reconcileAmbiguousUpload(item, currentTarget, index, deps).catch(() => ({
          kind: "stop" as const,
          status: "upload_incomplete" as const,
          error: transportFailure(deps),
        }));
        if (reconciled.kind === "complete") {
          setStatus(index, reconciled.status);
          continue;
        }
        if (reconciled.kind !== "retry") {
          setStatus(index, reconciled.status, reconciled.error ?? transportFailure(deps));
          continue;
        }
        currentTarget = reconciled.target;
        setStatus(index, "uploading");
        try {
          await deps.uploadToStorage(currentTarget, item.file);
          uploadSucceeded = true;
        } catch {
          const afterRetry = await reconcileAmbiguousUpload(item, currentTarget, index, deps).catch(() => ({
            kind: "stop" as const,
            status: "upload_incomplete" as const,
            error: transportFailure(deps),
          }));
          if (afterRetry.kind === "complete") setStatus(index, afterRetry.status);
          else setStatus(
            index,
            afterRetry.kind === "stop" ? afterRetry.status : "upload_incomplete",
            afterRetry.kind === "stop" ? afterRetry.error ?? transportFailure(deps) : transportFailure(deps),
          );
          continue;
        }
      }

      if (!uploadSucceeded) {
        setStatus(index, "upload_incomplete");
        continue;
      }

      setStatus(index, "verifying");
      const finalized = await finalizeSerially(() =>
        deps.finalizeUpload({ versionId: currentTarget.versionId, attemptId: currentTarget.attemptId }),
      ).catch(() => null);
      if (finalized?.ok) {
        const finalStatus = statusForSnapshot(finalized.data);
        if (finalized.data.uploadState === "confirmed") deps.clearPending(item.idempotencyKey);
        setStatus(index, finalStatus);
        continue;
      }

      const reconciled = await reconcileAmbiguousUpload(item, currentTarget, index, deps).catch(() => ({
        kind: "stop" as const,
        status: "upload_incomplete" as const,
        error: transportFailure(deps),
      }));
      if (reconciled.kind === "complete") setStatus(index, reconciled.status);
      else setStatus(
        index,
        reconciled.kind === "stop" ? reconciled.status : "upload_incomplete",
        reconciled.kind === "stop"
          ? reconciled.error ?? (finalized ? finalized.error : transportFailure(deps))
          : transportFailure(deps),
      );
    }
  });
  await Promise.all(workers);
  return results;
}
