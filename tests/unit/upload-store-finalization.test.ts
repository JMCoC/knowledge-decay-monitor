import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  verifyAndPromote: vi.fn(),
  removeStorageObject: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({ rpc: mocks.rpc }),
}));
vi.mock("@/modules/ingestion/verification", () => ({
  verifyAndPromote: mocks.verifyAndPromote,
  UploadVerificationError: class UploadVerificationError extends Error {
    constructor(readonly code: string) { super("Upload verification failed."); }
  },
}));
vi.mock("@/modules/ingestion/storage", () => ({
  removeStorageObject: mocks.removeStorageObject,
}));

import { finalizeUploadRecord, UploadStoreError } from "@/modules/ingestion/upload-store";

const versionId = "30000000-0000-4000-8000-000000000010";
const attemptId = "50000000-0000-4000-8000-000000000010";
const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const temporaryPath = `${workspaceId}/20000000-0000-4000-8000-000000000010/${versionId}/attempts/${attemptId}/original.md`;
const canonicalPath = `${workspaceId}/20000000-0000-4000-8000-000000000010/${versionId}/original.md`;

const claimRow = {
  version_id: versionId,
  attempt_id: attemptId,
  operation_id: "60000000-0000-4000-8000-000000000010",
  workspace_id: workspaceId,
  temporary_path: temporaryPath,
  canonical_path: canonicalPath,
  expected_sha256: "b".repeat(64),
  expected_size_bytes: 1,
  canonical_mime_type: "text/markdown",
  upload_state: "verifying",
};

const snapshotRow = {
  version_id: versionId,
  upload_state: "confirmed",
  attempt_id: attemptId,
  can_open: true,
  can_resume: false,
  can_recover: false,
};

function rpcResult(data: unknown) {
  return Promise.resolve({ data, error: null });
}

describe("upload finalization store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyAndPromote.mockResolvedValue({ state: "confirmed" });
    mocks.removeStorageObject.mockResolvedValue(true);
  });

  it("claims, verifies, finishes with CAS, and marks only the temporary attempt cleaned", async () => {
    mocks.rpc
      .mockImplementationOnce(() => rpcResult([claimRow]))
      .mockImplementationOnce(() => rpcResult([snapshotRow]))
      .mockImplementationOnce(() => rpcResult(true));

    await expect(finalizeUploadRecord("10000000-0000-4000-8000-000000000001", versionId, attemptId))
      .resolves.toEqual({
        versionId,
        uploadState: "confirmed",
        attemptId,
        canOpen: true,
        canResume: false,
        canRecover: false,
      });

    expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
      "claim_upload_verification",
      "finish_upload_verification",
      "mark_upload_attempt_cleanup",
    ]);
    expect(mocks.verifyAndPromote).toHaveBeenCalledWith({
      versionId,
      attemptId,
      operationId: claimRow.operation_id,
      workspaceId,
      temporaryPath,
      canonicalPath,
      expectedSha256: claimRow.expected_sha256,
      expectedSizeBytes: 1,
      canonicalMimeType: "text/markdown",
      uploadState: "verifying",
    });
    expect(mocks.removeStorageObject).toHaveBeenCalledWith(temporaryPath);
    expect(mocks.rpc.mock.calls[2]?.[1]).toMatchObject({
      p_version_id: versionId,
      p_attempt_id: attemptId,
      p_object_absent: true,
    });
  });

  it("returns already-confirmed state without Storage I/O, even for an older attempt argument", async () => {
    mocks.rpc
      .mockImplementationOnce(() => rpcResult([{ ...claimRow, attempt_id: attemptId, operation_id: null, upload_state: "confirmed" }]))
      .mockImplementationOnce(() => rpcResult([snapshotRow]));

    await expect(finalizeUploadRecord("10000000-0000-4000-8000-000000000001", versionId, "50000000-0000-4000-8000-000000000099"))
      .resolves.toMatchObject({ uploadState: "confirmed", canOpen: true });
    expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
      "claim_upload_verification",
      "get_document_upload_state",
    ]);
    expect(mocks.verifyAndPromote).not.toHaveBeenCalled();
    expect(mocks.removeStorageObject).not.toHaveBeenCalled();
  });

  it("finishes unavailable Storage as pending and returns a controlled error", async () => {
    mocks.verifyAndPromote.mockResolvedValue({ state: "pending", error: "INTERNAL_ERROR" });
    mocks.rpc
      .mockImplementationOnce(() => rpcResult([claimRow]))
      .mockImplementationOnce(() => rpcResult([{ ...snapshotRow, upload_state: "pending", can_open: false, can_resume: true }]));

    await expect(finalizeUploadRecord("10000000-0000-4000-8000-000000000001", versionId, attemptId))
      .rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
      "claim_upload_verification",
      "finish_upload_verification",
    ]);
    expect(mocks.rpc.mock.calls[1]?.[1]).toMatchObject({ p_result: "pending" });
    expect(mocks.removeStorageObject).not.toHaveBeenCalled();
  });

  it("keeps confirmed state when temporary cleanup fails and records the failed cleanup", async () => {
    mocks.removeStorageObject.mockResolvedValue(false);
    mocks.rpc
      .mockImplementationOnce(() => rpcResult([claimRow]))
      .mockImplementationOnce(() => rpcResult([snapshotRow]))
      .mockImplementationOnce(() => rpcResult(true));

    await expect(finalizeUploadRecord("10000000-0000-4000-8000-000000000001", versionId, attemptId))
      .resolves.toMatchObject({ uploadState: "confirmed", canOpen: true });
    expect(mocks.rpc.mock.calls[2]?.[1]).toMatchObject({ p_object_absent: false });
  });
});
