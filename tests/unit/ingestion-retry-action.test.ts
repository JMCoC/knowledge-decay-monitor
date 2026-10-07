import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => {
  class IdentityError extends Error {
    constructor(readonly code: "UNAUTHENTICATED" | "WORKSPACE_REQUIRED" | "FORBIDDEN" | "INTERNAL_ERROR") {
      super("private identity details");
    }
  }
  return {
    actor: {
      userId: "10000000-0000-4000-8000-000000000001",
      workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      role: "QA Lead" as const,
    },
    identityError: null as InstanceType<typeof IdentityError> | null,
    IdentityError,
    claim: vi.fn(),
    capture: vi.fn(),
    maybeSingle: vi.fn(),
    fetch: vi.fn(),
  };
});

vi.mock("@/modules/identity", () => ({
  IdentityError: mocks.IdentityError,
  requireDocumentActor: async () => {
    if (mocks.identityError) throw mocks.identityError;
    return mocks.actor;
  },
}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => {
    const query = {
      select: () => query,
      eq: () => query,
      maybeSingle: mocks.maybeSingle,
    };
    return { from: () => query };
  },
}));
vi.mock("@/lib/app-origin", () => ({ getAppOrigin: () => "http://127.0.0.1:3000" }));
vi.mock("@/lib/observability/operation-events", () => ({
  captureOperationFailure: mocks.capture,
}));
vi.mock("@/modules/ingestion/processing-retry", () => ({
  claimProcessingRetry: mocks.claim,
}));
vi.mock("@/modules/ingestion/upload-store", () => ({
  UploadStoreError: class UploadStoreError extends Error {},
  computeRequestFingerprint: vi.fn(),
  finalizeUploadRecord: vi.fn(),
  getUploadSnapshot: vi.fn(),
  reserveUploadRecord: vi.fn(),
  recoverUploadRecord: vi.fn(),
  resumeUploadRecord: vi.fn(),
}));
vi.mock("next/server", () => ({ after: vi.fn() }));

import { IdentityError } from "@/modules/identity";
import { retryProcessing } from "@/modules/ingestion/actions";

const VERSION_ID = "30000000-0000-4000-8000-000000000010";
const OPERATION_ID = "60000000-0000-4000-8000-000000000010";
const TOKEN = "internal-token-never-returned";

beforeEach(() => {
  vi.stubEnv("INGESTION_INTERNAL_TOKEN", TOKEN);
  vi.stubGlobal("crypto", { randomUUID: () => OPERATION_ID });
  mocks.actor = {
    userId: "10000000-0000-4000-8000-000000000001",
    workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    role: "QA Lead",
  };
  mocks.identityError = null;
  mocks.claim.mockReset().mockResolvedValue({ kind: "claimed", operationId: OPERATION_ID });
  mocks.capture.mockReset();
  mocks.maybeSingle.mockReset().mockResolvedValue({
    data: { processing_status: "ready", processing_operation_id: null },
    error: null,
  });
  mocks.fetch.mockReset().mockResolvedValue(Response.json({ status: "processing" }));
  vi.stubGlobal("fetch", mocks.fetch);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("retryProcessing", () => {
  it("reauthorizes and claims with the verified workspace before dispatching", async () => {
    const result = await retryProcessing(VERSION_ID);

    expect(result).toEqual({ ok: true, data: { versionId: VERSION_ID, processingStatus: "ready" } });
    expect(mocks.claim).toHaveBeenCalledWith({
      workspaceId: mocks.actor.workspaceId,
      versionId: VERSION_ID,
      operationId: OPERATION_ID,
    });
    expect(mocks.fetch).toHaveBeenCalledWith("http://127.0.0.1:3000/api/ingestion/process", {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": TOKEN },
      body: JSON.stringify({ versionId: VERSION_ID, operationId: OPERATION_ID, operation: "retry" }),
    });
  });

  it("returns PROCESSING_FAILED when the real worker finishes in a failed state", async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: { processing_status: "processing_failed", processing_operation_id: null },
      error: null,
    });

    const result = await retryProcessing(VERSION_ID);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "PROCESSING_FAILED", message: expect.stringContaining("Processing failed") },
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("returns processing when the route accepted the operation but it remains active", async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: { processing_status: "processing", processing_operation_id: OPERATION_ID },
      error: null,
    });

    expect(await retryProcessing(VERSION_ID)).toEqual({
      ok: true,
      data: { versionId: VERSION_ID, processingStatus: "processing" },
    });
  });

  it("rejects malformed IDs and denied roles before claiming or dispatching", async () => {
    expect(await retryProcessing("bad-id")).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    mocks.identityError = new IdentityError("FORBIDDEN");
    expect(await retryProcessing(VERSION_ID)).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("maps invisible versions and concurrent/noneligible claims to controlled results", async () => {
    mocks.claim.mockResolvedValueOnce({ kind: "not_found" });
    expect(await retryProcessing(VERSION_ID)).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    mocks.claim.mockResolvedValueOnce({ kind: "conflict" });
    expect(await retryProcessing(VERSION_ID)).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("does not claim if the internal dispatch configuration is missing", async () => {
    vi.stubEnv("INGESTION_INTERNAL_TOKEN", "");

    const result = await retryProcessing(VERSION_ID);

    expect(result).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("returns a conflict if another operation replaced the claimed one", async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: { processing_status: "processing", processing_operation_id: "60000000-0000-4000-8000-000000000011" },
      error: null,
    });

    expect(await retryProcessing(VERSION_ID)).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  });
});
