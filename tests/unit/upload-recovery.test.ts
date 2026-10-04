import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  storageObjectExists: vi.fn(),
  removeStorageObject: vi.fn(),
  verifyAndPromote: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({ rpc: mocks.rpc }) }));
vi.mock("@/modules/ingestion/storage", () => ({
  storageObjectExists: mocks.storageObjectExists,
  removeStorageObject: mocks.removeStorageObject,
}));
vi.mock("@/modules/ingestion/verification", () => ({
  verifyAndPromote: mocks.verifyAndPromote,
  UploadVerificationError: class UploadVerificationError extends Error {
    constructor(readonly code: string) { super("Upload verification failed."); }
  },
}));

import {
  recoverUploadRecord,
  resumeUploadRecord,
} from "@/modules/ingestion/upload-store";

const userId = "10000000-0000-4000-8000-000000000001";
const versionId = "30000000-0000-4000-8000-000000000010";
const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const attemptA = "50000000-0000-4000-8000-000000000010";
const attemptB = "50000000-0000-4000-8000-000000000011";
const operationId = "60000000-0000-4000-8000-000000000010";
const temporaryPathA = `${workspaceId}/20000000-0000-4000-8000-000000000010/${versionId}/attempts/${attemptA}/original.md`;
const canonicalPath = `${workspaceId}/20000000-0000-4000-8000-000000000010/${versionId}/original.md`;

const verificationClaimRow = {
  version_id: versionId,
  attempt_id: attemptA,
  operation_id: operationId,
  workspace_id: workspaceId,
  temporary_path: temporaryPathA,
  canonical_path: canonicalPath,
  expected_sha256: "b".repeat(64),
  expected_size_bytes: 1,
  canonical_mime_type: "text/markdown",
  upload_state: "verifying",
};

const recoveryClaimRow = {
  ...verificationClaimRow,
  upload_state: "recovering",
};

const pendingSnapshot = {
  version_id: versionId,
  upload_state: "pending",
  attempt_id: attemptB,
  can_open: false,
  can_resume: true,
  can_recover: false,
};

const rpcResult = (data: unknown) => Promise.resolve({ data, error: null });

describe("upload resume and recovery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.storageObjectExists.mockResolvedValue(false);
    mocks.removeStorageObject.mockResolvedValue(true);
    mocks.verifyAndPromote.mockResolvedValue({ state: "confirmed" });
  });

  it("returns only the current target after proving the registered temporary object is absent", async () => {
    mocks.rpc
      .mockImplementationOnce(() => rpcResult([{
        version_id: versionId, upload_state: "pending", attempt_id: attemptA,
        can_open: false, can_resume: true, can_recover: false,
      }]))
      .mockImplementationOnce(() => rpcResult([{
        version_id: versionId, upload_state: "pending", attempt_id: attemptA,
        storage_path: temporaryPathA, canonical_mime_type: "text/markdown",
      }]));

    await expect(resumeUploadRecord(userId, versionId)).resolves.toEqual({
      versionId,
      attemptId: attemptA,
      storagePath: temporaryPathA,
      canonicalMimeType: "text/markdown",
    });
    expect(mocks.storageObjectExists).toHaveBeenCalledWith(temporaryPathA);
    expect(mocks.removeStorageObject).not.toHaveBeenCalled();
  });

  it("finalizes an existing current object instead of asking the user to send it again", async () => {
    mocks.storageObjectExists.mockResolvedValue(true);
    mocks.rpc
      .mockImplementationOnce(() => rpcResult([{
        version_id: versionId, upload_state: "pending", attempt_id: attemptA,
        can_open: false, can_resume: true, can_recover: false,
      }]))
      .mockImplementationOnce(() => rpcResult([{
        version_id: versionId, upload_state: "pending", attempt_id: attemptA,
        storage_path: temporaryPathA, canonical_mime_type: "text/markdown",
      }]))
      .mockImplementationOnce(() => rpcResult([verificationClaimRow]))
      .mockImplementationOnce(() => rpcResult([{
        version_id: versionId, upload_state: "confirmed", attempt_id: attemptA,
        can_open: true, can_resume: false, can_recover: false,
      }]))
      .mockImplementationOnce(() => rpcResult(true));

    await expect(resumeUploadRecord(userId, versionId)).resolves.toMatchObject({
      uploadState: "confirmed",
      canOpen: true,
    });
    expect(mocks.verifyAndPromote).toHaveBeenCalledTimes(1);
    expect(mocks.removeStorageObject).toHaveBeenCalledWith(temporaryPathA);
  });

  it("returns a non-actionable snapshot for active work without probing Storage", async () => {
    mocks.rpc.mockImplementationOnce(() => rpcResult([{
      version_id: versionId, upload_state: "verifying", attempt_id: attemptA,
      can_open: false, can_resume: false, can_recover: false,
    }]));

    await expect(resumeUploadRecord(userId, versionId)).resolves.toMatchObject({ uploadState: "verifying" });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.storageObjectExists).not.toHaveBeenCalled();
  });

  it("binds a legacy reference only after a confirmed absence and returns safe state", async () => {
    const legacyTarget = `${workspaceId}/20000000-0000-4000-8000-000000000001/${versionId}/original.md`;
    mocks.rpc
      .mockImplementationOnce(() => rpcResult([{
        version_id: versionId, upload_state: null, attempt_id: null,
        can_open: false, can_resume: true, can_recover: false,
      }]))
      .mockImplementationOnce(() => rpcResult([{
        version_id: versionId, upload_state: null, attempt_id: null,
        storage_path: legacyTarget, canonical_mime_type: "text/markdown",
      }]))
      .mockImplementationOnce(() => rpcResult([pendingSnapshot]));

    await expect(resumeUploadRecord(userId, versionId, {
      sizeBytes: 1,
      sha256: "b".repeat(64),
      signature: "YQ==",
    })).resolves.toMatchObject({ uploadState: "pending", attemptId: attemptB, canResume: true });
    expect(mocks.storageObjectExists).toHaveBeenCalledWith(legacyTarget);
    expect(mocks.rpc.mock.calls[2]?.[0]).toBe("bind_legacy_upload_reference");
    expect(mocks.rpc.mock.calls[2]?.[1]).toMatchObject({ p_size_bytes: 1, p_expected_sha256: "b".repeat(64) });
  });

  it("refuses ordinary legacy replacement when the canonical original exists", async () => {
    mocks.storageObjectExists.mockResolvedValue(true);
    mocks.rpc
      .mockImplementationOnce(() => rpcResult([{
        version_id: versionId, upload_state: null, attempt_id: null,
        can_open: false, can_resume: true, can_recover: false,
      }]))
      .mockImplementationOnce(() => rpcResult([{
        version_id: versionId, upload_state: null, attempt_id: null,
        storage_path: canonicalPath, canonical_mime_type: "text/markdown",
      }]));

    await expect(resumeUploadRecord(userId, versionId, {
      sizeBytes: 1, sha256: "b".repeat(64), signature: "YQ==",
    })).rejects.toMatchObject({ sqlstate: "55000" });
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });

  it("removes only retired attempt A before finish creates replacement B", async () => {
    mocks.rpc
      .mockImplementationOnce(() => rpcResult([recoveryClaimRow]))
      .mockImplementationOnce(() => rpcResult([pendingSnapshot]));

    await expect(recoverUploadRecord(userId, versionId)).resolves.toMatchObject({
      uploadState: "pending",
      attemptId: attemptB,
      canResume: true,
    });
    expect(mocks.removeStorageObject).toHaveBeenCalledTimes(1);
    expect(mocks.removeStorageObject).toHaveBeenCalledWith(temporaryPathA);
    expect(mocks.removeStorageObject).not.toHaveBeenCalledWith(canonicalPath);
    expect(mocks.rpc.mock.calls[1]?.[0]).toBe("finish_upload_recovery");
    expect(mocks.rpc.mock.calls[1]?.[1]).toMatchObject({
      p_attempt_id: attemptA,
      p_operation_id: operationId,
      p_object_absent: true,
    });
  });

  it("leaves the recovery lease for safe takeover when Storage cannot prove absence", async () => {
    mocks.removeStorageObject.mockRejectedValue(new Error("provider detail"));
    mocks.rpc.mockImplementationOnce(() => rpcResult([recoveryClaimRow]));

    await expect(recoverUploadRecord(userId, versionId)).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.removeStorageObject).toHaveBeenCalledWith(temporaryPathA);
  });

  it("keeps the version recoverable when delete returns but the temporary object remains", async () => {
    mocks.removeStorageObject.mockResolvedValue(false);
    mocks.rpc
      .mockImplementationOnce(() => rpcResult([recoveryClaimRow]))
      .mockImplementationOnce(() => rpcResult([{
        ...pendingSnapshot,
        upload_state: "rejected",
        attempt_id: attemptA,
        can_resume: false,
        can_recover: true,
      }]));

    await expect(recoverUploadRecord(userId, versionId)).resolves.toMatchObject({
      uploadState: "rejected",
      canRecover: true,
    });
    expect(mocks.rpc.mock.calls[1]?.[1]).toMatchObject({ p_object_absent: false });
  });
});
