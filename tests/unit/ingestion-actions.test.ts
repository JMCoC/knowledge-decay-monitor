import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UploadItemInput, UploadSnapshot } from "@/types/contracts";
import {
  finalizeUpload,
  getUploadState,
  recoverUpload,
  reserveUpload,
  resumeUpload,
} from "@/modules/ingestion/actions";

const ids = vi.hoisted(() => ({
  admin: "10000000-0000-4000-8000-000000000001",
  workspace: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  document: "20000000-0000-4000-8000-000000000010",
  version: "30000000-0000-4000-8000-000000000010",
  attempt: "50000000-0000-4000-8000-000000000010",
}));

const mocks = vi.hoisted(() => {
  class IdentityError extends Error {
    constructor(readonly code: "UNAUTHENTICATED" | "WORKSPACE_REQUIRED" | "FORBIDDEN" | "INTERNAL_ERROR") {
      super("private identity detail");
    }
  }
  class UploadStoreError extends Error {
    constructor(readonly sqlstate?: string) {
      super("private database detail");
    }
  }
  return {
    actor: { userId: ids.admin, workspaceId: ids.workspace, role: "Admin" as const },
    identityError: null as IdentityError | null,
    reserve: vi.fn(),
    snapshot: vi.fn(),
    finalize: vi.fn(),
    resume: vi.fn(),
    recover: vi.fn(),
    reserveCalls: 0,
    IdentityError,
    UploadStoreError,
  };
});

vi.mock("@/modules/identity", () => ({
  IdentityError: mocks.IdentityError,
  requireDocumentActor: async () => {
    if (mocks.identityError) throw mocks.identityError;
    return mocks.actor;
  },
}));

vi.mock("server-only", () => ({}));

vi.mock("@/modules/ingestion/upload-store", () => ({
  UploadStoreError: mocks.UploadStoreError,
  computeRequestFingerprint: async () => "a".repeat(64),
  reserveUploadRecord: async (...args: unknown[]) => {
    mocks.reserveCalls += 1;
    return mocks.reserve(...args);
  },
  getUploadSnapshot: (...args: unknown[]) => mocks.snapshot(...args),
  finalizeUploadRecord: (...args: unknown[]) => mocks.finalize(...args),
  resumeUploadRecord: (...args: unknown[]) => mocks.resume(...args),
  recoverUploadRecord: (...args: unknown[]) => mocks.recover(...args),
}));

import { IdentityError } from "@/modules/identity";
import { UploadStoreError } from "@/modules/ingestion/upload-store";

const validPdf: UploadItemInput = {
  metadata: { name: "  Runbook  ", category: "SOP", ownerId: ids.admin },
  fileName: "runbook.pdf",
  declaredMimeType: "application/pdf",
  sizeBytes: 2048,
  signature: "JVBERi0xMjM=",
  idempotencyKey: "550e8400-e29b-41d4-a716-446655440000",
  sha256: "b".repeat(64),
};

const record = () => ({
  documentId: ids.document,
  versionId: ids.version,
  attemptId: ids.attempt,
  storagePath: `${ids.workspace}/${ids.document}/${ids.version}/attempts/${ids.attempt}/original.pdf`,
  canonicalMimeType: "application/pdf",
  uploadState: "pending" as const,
});

const snapshot = (): UploadSnapshot => ({
  versionId: ids.version,
  uploadState: "pending",
  attemptId: ids.attempt,
  canOpen: false,
  canResume: true,
  canRecover: false,
});

beforeEach(() => {
  mocks.actor = { userId: ids.admin, workspaceId: ids.workspace, role: "Admin" };
  mocks.identityError = null;
  mocks.reserve.mockReset().mockResolvedValue(record());
  mocks.snapshot.mockReset().mockResolvedValue(snapshot());
  mocks.finalize.mockReset().mockResolvedValue(snapshot());
  mocks.resume.mockReset().mockResolvedValue(snapshot());
  mocks.recover.mockReset().mockResolvedValue(snapshot());
  mocks.reserveCalls = 0;
});

describe("reserveUpload", () => {
  it("returns the server-created temporary target, not a client-built canonical path", async () => {
    const result = await reserveUpload([validPdf]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0].outcome).toEqual({
      ok: true,
      documentId: ids.document,
      target: {
        versionId: ids.version,
        attemptId: ids.attempt,
        storagePath: record().storagePath,
        canonicalMimeType: "application/pdf",
      },
    });
  });

  it("uses the validated UUID key and never supplies client-selected document or version ids", async () => {
    await reserveUpload([validPdf]);
    const [input] = mocks.reserve.mock.calls[0] as [Record<string, unknown>];
    expect(input.idempotencyKey).toBe(validPdf.idempotencyKey);
    expect(input.requestFingerprint).toBe("a".repeat(64));
    expect(input).not.toHaveProperty("documentId");
    expect(input).not.toHaveProperty("versionId");
    expect(input).not.toHaveProperty("storagePath");
  });

  it("keeps stable IDs when an idempotent retry returns the same server record", async () => {
    mocks.reserve.mockResolvedValue(record());
    const first = await reserveUpload([validPdf]);
    const second = await reserveUpload([validPdf]);
    expect(first).toEqual(second);
    expect(mocks.reserveCalls).toBe(2);
  });

  it("does not construct or call the privileged store when identity denies access", async () => {
    mocks.identityError = new IdentityError("FORBIDDEN");
    const result = await reserveUpload([validPdf]);
    expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(mocks.reserveCalls).toBe(0);
  });

  it("maps a foreign workspace owner without revealing which validation failed", async () => {
    mocks.reserve.mockRejectedValue(new UploadStoreError("22023"));
    const result = await reserveUpload([validPdf]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0].outcome).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT", message: "The selected owner is not available." },
    });
    expect(JSON.stringify(result)).not.toMatch(/workspace|tenant|10000000/i);
  });

  it("maps SQL idempotency conflicts to CONFLICT", async () => {
    mocks.reserve.mockRejectedValue(new UploadStoreError("23505"));
    const result = await reserveUpload([validPdf]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0].outcome).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  });

  it("hides unknown database errors and provider details", async () => {
    mocks.reserve.mockRejectedValue(new UploadStoreError("XX000"));
    const result = await reserveUpload([validPdf]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0].outcome).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
    expect(JSON.stringify(result)).not.toContain("private database detail");
  });

  it("isolates an invalid item and still reserves other valid items", async () => {
    const result = await reserveUpload([
      validPdf,
      { ...validPdf, role: "Admin" } as UploadItemInput,
      { ...validPdf, metadata: { ...validPdf.metadata, name: "Second" } },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(3);
    expect(result.data[0].outcome.ok).toBe(true);
    expect(result.data[1].outcome.ok).toBe(false);
    expect(result.data[2].outcome.ok).toBe(true);
    expect(mocks.reserveCalls).toBe(2);
  });
});

describe("getUploadState and finalizeUpload", () => {
  it("returns safe state and maps a missing or cross-tenant version to NOT_FOUND", async () => {
    mocks.snapshot.mockResolvedValueOnce(null);
    const result = await getUploadState(ids.version);
    expect(result).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("does not return an error payload when the state store is unavailable", async () => {
    mocks.snapshot.mockRejectedValue(new UploadStoreError("08006"));
    const result = await getUploadState(ids.version);
    expect(result).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
    expect(JSON.stringify(result)).not.toContain("08006");
  });

  it("accepts only a version and attempt, then reauthorizes before finalization", async () => {
    const result = await finalizeUpload({ versionId: ids.version, attemptId: ids.attempt });
    expect(mocks.finalize).toHaveBeenCalledWith(ids.admin, ids.version, ids.attempt);
    expect(result).toMatchObject({ ok: true, data: snapshot() });
  });

  it("rejects paths, roles, and malformed IDs before touching the store", async () => {
    const malformed = await finalizeUpload({
      versionId: "not-a-uuid",
      attemptId: ids.attempt,
      storagePath: "attacker-controlled",
    } as { versionId: string; attemptId: string });
    expect(malformed).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(mocks.finalize).not.toHaveBeenCalled();
  });

  it("authorizes and validates a legacy file reference before asking to resume", async () => {
    const reference = { sizeBytes: 1, sha256: "a".repeat(64), signature: "YQ==" };
    const result = await resumeUpload(ids.version, reference);

    expect(result).toMatchObject({ ok: true, data: snapshot() });
    expect(mocks.resume).toHaveBeenCalledWith(ids.admin, ids.version, reference);
    expect(JSON.stringify(result)).not.toMatch(/workspace|sha256|signature/i);
  });

  it("rejects a malformed reference and a denied actor before recovery or resume I/O", async () => {
    const invalidReference = await resumeUpload(ids.version, {
      sizeBytes: 1,
      sha256: "not-a-hash",
      signature: "not-base64",
    });
    expect(invalidReference).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(mocks.resume).not.toHaveBeenCalled();

    mocks.identityError = new IdentityError("FORBIDDEN");
    const denied = await recoverUpload(ids.version);
    expect(denied).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(mocks.recover).not.toHaveBeenCalled();
  });

  it("maps Storage recovery failures to controlled internal errors", async () => {
    mocks.recover.mockRejectedValue(new Error("private provider payload"));

    const result = await recoverUpload(ids.version);
    expect(result).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
    expect(JSON.stringify(result)).not.toContain("private provider payload");
  });
});
