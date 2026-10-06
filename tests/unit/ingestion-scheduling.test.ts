import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  fetch: vi.fn(),
  getAppOrigin: vi.fn(),
  single: vi.fn(),
  finalize: vi.fn(),
  captureOperationFailure: vi.fn(),
  actor: { userId: "10000000-0000-4000-8000-000000000001" },
}));

vi.mock("next/server", () => ({
  after: (task: unknown) => mocks.after(task),
}));

vi.mock("@/lib/app-origin", () => ({
  getAppOrigin: (...args: unknown[]) => mocks.getAppOrigin(...args),
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ single: mocks.single }) }) }),
  }),
}));

vi.mock("@/lib/observability/operation-events", () => ({
  captureOperationFailure: mocks.captureOperationFailure,
}));

vi.mock("@/modules/identity", () => ({
  IdentityError: class IdentityError extends Error {},
  requireDocumentActor: async () => mocks.actor,
}));

vi.mock("@/modules/ingestion/upload-store", () => ({
  UploadStoreError: class UploadStoreError extends Error {},
  reserveUploadRecord: vi.fn(),
  getUploadSnapshot: vi.fn(),
  finalizeUploadRecord: (...args: unknown[]) => mocks.finalize(...args),
  resumeUploadRecord: vi.fn(),
  recoverUploadRecord: vi.fn(),
  computeRequestFingerprint: vi.fn(),
}));

import { finalizeUpload } from "@/modules/ingestion/actions";
import type { UploadSnapshot } from "@/types/contracts";

const VERSION_ID = "30000000-0000-4000-8000-000000000010";
const ATTEMPT_ID = "50000000-0000-4000-8000-000000000010";
const TOKEN = "test-internal-token-0123456789";
const ORIGIN = "http://127.0.0.1:3000";

const snapshot = (uploadState: UploadSnapshot["uploadState"]): UploadSnapshot => ({
  versionId: VERSION_ID,
  uploadState,
  attemptId: ATTEMPT_ID,
  canOpen: uploadState === "confirmed",
  canResume: uploadState !== "confirmed",
  canRecover: false,
});

function mockProcessingStatus(processingStatus: string | null) {
  mocks.single.mockResolvedValue({ data: { processing_status: processingStatus }, error: null });
}

beforeEach(() => {
  vi.stubEnv("INGESTION_INTERNAL_TOKEN", TOKEN);
  mocks.after.mockReset().mockImplementation((task: unknown) => {
    (task as () => void)();
  });
  mocks.fetch.mockReset().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.getAppOrigin.mockReset().mockReturnValue(ORIGIN);
  mocks.finalize.mockReset().mockResolvedValue(snapshot("confirmed"));
  mockProcessingStatus("uploaded");
  mocks.captureOperationFailure.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("finalizeUpload processing scheduling", () => {
  it("schedules the worker when confirmed + uploaded with token and origin", async () => {
    const result = await finalizeUpload({ versionId: VERSION_ID, attemptId: ATTEMPT_ID });

    expect(result).toEqual({ ok: true, data: snapshot("confirmed") });
    expect(mocks.after).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledWith(
      `${ORIGIN}/api/ingestion/process`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-token": TOKEN },
        body: JSON.stringify({ versionId: VERSION_ID }),
      },
    );
  });

  it("does not schedule when already processing", async () => {
    mockProcessingStatus("processing");

    const result = await finalizeUpload({ versionId: VERSION_ID, attemptId: ATTEMPT_ID });

    expect(result).toEqual({ ok: true, data: snapshot("confirmed") });
    expect(mocks.after).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("does not schedule when processing already failed", async () => {
    mockProcessingStatus("processing_failed");

    const result = await finalizeUpload({ versionId: VERSION_ID, attemptId: ATTEMPT_ID });

    expect(result).toEqual({ ok: true, data: snapshot("confirmed") });
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("does not schedule when already ready", async () => {
    mockProcessingStatus("ready");

    const result = await finalizeUpload({ versionId: VERSION_ID, attemptId: ATTEMPT_ID });

    expect(result).toEqual({ ok: true, data: snapshot("confirmed") });
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("does not re-read the version when the upload is still pending", async () => {
    mocks.finalize.mockResolvedValue(snapshot("pending"));

    const result = await finalizeUpload({ versionId: VERSION_ID, attemptId: ATTEMPT_ID });

    expect(result).toEqual({ ok: true, data: snapshot("pending") });
    expect(mocks.single).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("does not schedule when the upload was rejected", async () => {
    mocks.finalize.mockResolvedValue(snapshot("rejected"));

    const result = await finalizeUpload({ versionId: VERSION_ID, attemptId: ATTEMPT_ID });

    expect(result).toEqual({ ok: true, data: snapshot("rejected") });
    expect(mocks.single).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("does not schedule when the internal token is missing", async () => {
    vi.stubEnv("INGESTION_INTERNAL_TOKEN", "");

    const result = await finalizeUpload({ versionId: VERSION_ID, attemptId: ATTEMPT_ID });

    expect(result).toEqual({ ok: true, data: snapshot("confirmed") });
    expect(mocks.after).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("returns the snapshot intact when the origin cannot be resolved", async () => {
    mocks.getAppOrigin.mockImplementation(() => {
      throw new Error("APP_ORIGIN is required on Vercel");
    });

    const result = await finalizeUpload({ versionId: VERSION_ID, attemptId: ATTEMPT_ID });

    expect(result).toEqual({ ok: true, data: snapshot("confirmed") });
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("schedules exactly once across a double finalize once the claim lands", async () => {
    mocks.single
      .mockResolvedValueOnce({ data: { processing_status: "uploaded" }, error: null })
      .mockResolvedValueOnce({ data: { processing_status: "processing" }, error: null });

    const first = await finalizeUpload({ versionId: VERSION_ID, attemptId: ATTEMPT_ID });
    const second = await finalizeUpload({ versionId: VERSION_ID, attemptId: ATTEMPT_ID });

    expect(first).toEqual({ ok: true, data: snapshot("confirmed") });
    expect(second).toEqual({ ok: true, data: snapshot("confirmed") });
    expect(mocks.after).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the snapshot byte-identical whether or not it schedules", async () => {
    const scheduled = await finalizeUpload({ versionId: VERSION_ID, attemptId: ATTEMPT_ID });
    mockProcessingStatus("ready");
    const skipped = await finalizeUpload({ versionId: VERSION_ID, attemptId: ATTEMPT_ID });

    expect(scheduled).toEqual({ ok: true, data: snapshot("confirmed") });
    expect(skipped).toEqual({ ok: true, data: snapshot("confirmed") });
    expect(JSON.stringify(scheduled)).toBe(JSON.stringify(skipped));
  });
});
