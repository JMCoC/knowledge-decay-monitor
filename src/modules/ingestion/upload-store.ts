import "server-only";

import { createHash } from "node:crypto";
import type {
  DocumentCategory,
  UploadItemInput,
  UploadReference,
  UploadSnapshot,
  UploadTarget,
} from "@/types/contracts";
import { createServiceClient } from "@/lib/supabase/service";
import { canonicalMimeFor, type AllowedExtension } from "./validation";
import { removeStorageObject, storageObjectExists } from "./storage";
import { UploadVerificationError, verifyAndPromote, type VerificationClaim } from "./verification";

export class UploadStoreError extends Error {
  constructor(readonly sqlstate?: string) {
    super("Upload persistence failed.");
    this.name = "UploadStoreError";
  }
}

export interface UploadReservationInput {
  userId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  name: string;
  category: DocumentCategory;
  ownerId: string;
  extension: AllowedExtension;
  sizeBytes: number;
  sha256: string;
}

export interface UploadReservation {
  documentId: string;
  versionId: string;
  attemptId: string;
  storagePath: string;
  canonicalMimeType: string;
  uploadState: UploadSnapshot["uploadState"];
}

async function rpcData<T>(request: () => PromiseLike<{
  data: T | null;
  error: { code: string } | null;
}>): Promise<T> {
  try {
    const { data, error } = await request();
    if (error) throw new UploadStoreError(error.code);
    if (data === null) throw new UploadStoreError();
    return data;
  } catch (error) {
    if (error instanceof UploadStoreError) throw error;
    throw new UploadStoreError();
  }
}

/** Stable server-side request digest; client filename, prefix and key are excluded. */
export async function computeRequestFingerprint(
  item: UploadItemInput,
  extension: AllowedExtension,
): Promise<string> {
  const normalized = [
    1,
    item.metadata.name.trim(),
    item.metadata.category,
    item.metadata.ownerId,
    extension,
    canonicalMimeFor(extension),
    item.sizeBytes,
    item.sha256,
  ];
  return createHash("sha256").update(JSON.stringify(normalized), "utf8").digest("hex");
}

export async function reserveUploadRecord(input: UploadReservationInput): Promise<UploadReservation> {
  const data = await rpcData(() => createServiceClient().rpc("reserve_document_upload", {
      p_user_id: input.userId,
      p_idempotency_key: input.idempotencyKey,
      p_request_fingerprint: input.requestFingerprint,
      p_name: input.name,
      p_category: input.category,
      p_owner_id: input.ownerId,
      p_extension: input.extension,
      p_size_bytes: input.sizeBytes,
      p_expected_sha256: input.sha256,
    }));
  const row = data[0];
  if (!row || row.upload_state !== "pending") throw new UploadStoreError("40001");
  return {
    documentId: row.document_id,
    versionId: row.version_id,
    attemptId: row.attempt_id,
    storagePath: row.storage_path,
    canonicalMimeType: row.canonical_mime_type,
    uploadState: row.upload_state,
  };
}

export async function getUploadSnapshot(userId: string, versionId: string): Promise<UploadSnapshot | null> {
  const data = await rpcData(() => createServiceClient().rpc("get_document_upload_state", {
      p_user_id: userId,
      p_version_id: versionId,
    }));
  const row = data[0];
  if (!row) return null;
  return snapshotFromRow(row);
}

function snapshotFromRow(row: {
  version_id: string;
  upload_state: UploadSnapshot["uploadState"];
  attempt_id: string | null;
  can_open: boolean;
  can_resume: boolean;
  can_recover: boolean;
}): UploadSnapshot {
  return {
    versionId: row.version_id,
    uploadState: row.upload_state,
    attemptId: row.attempt_id,
    canOpen: row.can_open,
    canResume: row.can_resume,
    canRecover: row.can_recover,
  };
}

async function claimUploadVerification(
  userId: string,
  versionId: string,
  attemptId: string,
): Promise<VerificationClaim | UploadSnapshot> {
  const data = await rpcData(() => createServiceClient().rpc("claim_upload_verification", {
    p_user_id: userId,
    p_version_id: versionId,
    p_attempt_id: attemptId,
  }));
  const row = data[0];
  if (!row) throw new UploadStoreError("P0002");
  if (row.upload_state === "confirmed") {
    const snapshot = await getUploadSnapshot(userId, versionId);
    if (!snapshot) throw new UploadStoreError("P0002");
    return snapshot;
  }
  if (row.upload_state !== "verifying" || !row.operation_id) throw new UploadStoreError();
  return {
    versionId: row.version_id,
    attemptId: row.attempt_id,
    operationId: row.operation_id,
    workspaceId: row.workspace_id,
    temporaryPath: row.temporary_path,
    canonicalPath: row.canonical_path,
    expectedSha256: row.expected_sha256,
    expectedSizeBytes: row.expected_size_bytes,
    canonicalMimeType: row.canonical_mime_type,
    uploadState: row.upload_state,
  };
}

async function finishUploadVerification(
  userId: string,
  claim: VerificationClaim,
  result: "confirmed" | "rejected" | "pending",
): Promise<UploadSnapshot> {
  const operationId = claim.operationId;
  if (!operationId) throw new UploadStoreError("40001");
  const data = await rpcData(() => createServiceClient().rpc("finish_upload_verification", {
    p_user_id: userId,
    p_version_id: claim.versionId,
    p_attempt_id: claim.attemptId,
    p_operation_id: operationId,
    p_result: result,
  }));
  const row = data[0];
  if (!row) throw new UploadStoreError("P0002");
  return snapshotFromRow(row);
}

async function markAttemptCleanup(
  versionId: string,
  attemptId: string,
  objectAbsent: boolean,
): Promise<void> {
  const marked = await rpcData(() => createServiceClient().rpc("mark_upload_attempt_cleanup", {
    p_version_id: versionId,
    p_attempt_id: attemptId,
    p_object_absent: objectAbsent,
  }));
  if (marked !== true) throw new UploadStoreError();
}

export async function finalizeUploadRecord(
  userId: string,
  versionId: string,
  attemptId: string,
): Promise<UploadSnapshot> {
  const claimed = await claimUploadVerification(userId, versionId, attemptId);
  if (!("temporaryPath" in claimed)) return claimed;

  const verification = await verifyAndPromote(claimed);
  const snapshot = await finishUploadVerification(userId, claimed, verification.state);
  if (verification.error) throw new UploadVerificationError(verification.error);

  if (snapshot.uploadState === "confirmed" && snapshot.canOpen) {
    let objectAbsent = false;
    try {
      objectAbsent = await removeStorageObject(claimed.temporaryPath);
    } catch {
      objectAbsent = false;
    }
    try {
      await markAttemptCleanup(claimed.versionId, claimed.attemptId, objectAbsent);
    } catch {
      // Confirmation remains valid; maintenance can safely retry the retired path.
    }
  }
  return snapshot;
}

async function getUploadResumeTarget(
  userId: string,
  versionId: string,
): Promise<{
  versionId: string;
  attemptId: string | null;
  storagePath: string;
  canonicalMimeType: string;
  uploadState: UploadSnapshot["uploadState"];
}> {
  const data = await rpcData(() => createServiceClient().rpc("get_upload_resume_target", {
    p_user_id: userId,
    p_version_id: versionId,
  }));
  const row = data[0];
  if (!row) throw new UploadStoreError("P0002");
  return {
    versionId: row.version_id,
    attemptId: row.attempt_id,
    storagePath: row.storage_path,
    canonicalMimeType: row.canonical_mime_type,
    uploadState: row.upload_state,
  };
}

export async function resumeUploadRecord(
  userId: string,
  versionId: string,
  reference?: UploadReference,
): Promise<UploadTarget | UploadSnapshot | null> {
  const current = await getUploadSnapshot(userId, versionId);
  if (!current) return null;
  if (current.uploadState !== "pending" && current.uploadState !== null) return current;

  const target = await getUploadResumeTarget(userId, versionId);
  if (target.uploadState === null) {
    if (!reference) return current;
    if (await storageObjectExists(target.storagePath)) throw new UploadStoreError("55000");
    const data = await rpcData(() => createServiceClient().rpc("bind_legacy_upload_reference", {
      p_user_id: userId,
      p_version_id: versionId,
      p_size_bytes: reference.sizeBytes,
      p_expected_sha256: reference.sha256,
    }));
    const row = data[0];
    if (!row) throw new UploadStoreError("P0002");
    return snapshotFromRow(row);
  }

  if (target.uploadState !== "pending" || !target.attemptId) throw new UploadStoreError("40001");
  if (await storageObjectExists(target.storagePath)) {
    return finalizeUploadRecord(userId, versionId, target.attemptId);
  }
  if (reference) {
    const validation = await rpcData(() => createServiceClient().rpc("authorize_upload_resume_reference", {
      p_user_id: userId,
      p_version_id: versionId,
      p_size_bytes: reference.sizeBytes,
      p_expected_sha256: reference.sha256,
    }));
    if (validation[0]?.authorized !== true) throw new UploadStoreError("40001");
  }
  return {
    versionId: target.versionId,
    attemptId: target.attemptId,
    storagePath: target.storagePath,
    canonicalMimeType: target.canonicalMimeType,
  };
}

async function claimUploadRecovery(userId: string, versionId: string): Promise<VerificationClaim> {
  const data = await rpcData(() => createServiceClient().rpc("claim_upload_recovery", {
    p_user_id: userId,
    p_version_id: versionId,
  }));
  const row = data[0];
  if (!row) throw new UploadStoreError("P0002");
  if (row.upload_state !== "recovering" || !row.operation_id) throw new UploadStoreError("40001");
  return {
    versionId: row.version_id,
    attemptId: row.attempt_id,
    operationId: row.operation_id,
    workspaceId: row.workspace_id,
    temporaryPath: row.temporary_path,
    canonicalPath: row.canonical_path,
    expectedSha256: row.expected_sha256,
    expectedSizeBytes: row.expected_size_bytes,
    canonicalMimeType: row.canonical_mime_type,
    uploadState: row.upload_state,
  };
}

export async function recoverUploadRecord(userId: string, versionId: string): Promise<UploadSnapshot> {
  const claim = await claimUploadRecovery(userId, versionId);
  let objectAbsent: boolean;
  try {
    objectAbsent = await removeStorageObject(claim.temporaryPath);
  } catch {
    // Keep the recovery lease: a later call can take over after it expires.
    throw new UploadVerificationError("INTERNAL_ERROR");
  }

  const operationId = claim.operationId;
  if (!operationId) throw new UploadStoreError("40001");
  const data = await rpcData(() => createServiceClient().rpc("finish_upload_recovery", {
    p_user_id: userId,
    p_version_id: claim.versionId,
    p_attempt_id: claim.attemptId,
    p_operation_id: operationId,
    p_object_absent: objectAbsent,
  }));
  const row = data[0];
  if (!row) throw new UploadStoreError("P0002");
  return snapshotFromRow(row);
}
