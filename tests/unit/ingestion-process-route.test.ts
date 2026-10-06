import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  runProcessing: vi.fn(),
  captureOperationFailure: vi.fn(),
  from: vi.fn(),
  update: vi.fn(),
  eq: vi.fn(),
  select: vi.fn(),
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({ from: mocks.from }),
}));

vi.mock("@/modules/ingestion/processing", () => ({
  runProcessing: mocks.runProcessing,
}));

vi.mock("@/lib/observability/operation-events", () => ({
  captureOperationFailure: mocks.captureOperationFailure,
}));

import { POST } from "@/app/api/ingestion/process/route";

const TOKEN = "test-internal-token-0123456789";
const VERSION_ID = "30000000-0000-4000-8000-000000000010";
const OPERATION_ID = "60000000-0000-4000-8000-000000000010";

function request(versionId: unknown, token?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) headers["x-internal-token"] = token;
  return new Request("http://localhost/api/ingestion/process", {
    method: "POST",
    headers,
    body: JSON.stringify({ versionId }),
  });
}

function mockCas(result: { data: unknown; error: unknown }) {
  const chain = { eq: mocks.eq, select: mocks.select };
  mocks.from.mockReturnValue({ update: mocks.update });
  mocks.update.mockReturnValue({ eq: mocks.eq });
  mocks.eq.mockReturnValue(chain);
  mocks.select.mockResolvedValue(result);
}

beforeEach(() => {
  vi.stubEnv("INGESTION_INTERNAL_TOKEN", TOKEN);
  mocks.runProcessing.mockReset().mockResolvedValue(undefined);
  mocks.captureOperationFailure.mockReset();
  mocks.from.mockReset();
  mocks.update.mockReset();
  mocks.eq.mockReset();
  mocks.select.mockReset();
  // Default: CAS claim succeeds.
  mockCas({ data: [{ processing_operation_id: OPERATION_ID }], error: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/ingestion/process auth", () => {
  it("returns 401 without the internal token", async () => {
    const response = await POST(request(VERSION_ID));
    expect(response.status).toBe(401);
    expect(mocks.runProcessing).not.toHaveBeenCalled();
  });

  it("returns 401 with a wrong same-length token and leaks nothing", async () => {
    const wrong = `x${TOKEN.slice(1)}`;
    expect(wrong).toHaveLength(TOKEN.length);
    const response = await POST(request(VERSION_ID, wrong));
    expect(response.status).toBe(401);
    expect(mocks.runProcessing).not.toHaveBeenCalled();
    expect(JSON.stringify({ status: response.status })).not.toContain(TOKEN);
  });

  it("returns 401 with a different-length token instead of crashing", async () => {
    const response = await POST(request(VERSION_ID, "short"));
    expect(response.status).toBe(401);
    expect(mocks.runProcessing).not.toHaveBeenCalled();
  });

  it("returns 500 when INGESTION_INTERNAL_TOKEN is missing", async () => {
    vi.stubEnv("INGESTION_INTERNAL_TOKEN", "");
    const response = await POST(request(VERSION_ID, TOKEN));
    expect(response.status).toBe(500);
    expect(mocks.runProcessing).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-UUID versionId", async () => {
    const response = await POST(request("not-a-uuid", TOKEN));
    expect(response.status).toBe(400);
    expect(mocks.runProcessing).not.toHaveBeenCalled();
  });
});

describe("POST /api/ingestion/process CAS", () => {
  it("returns 204 without invoking the worker when already processing", async () => {
    mockCas({ data: [], error: null });
    const response = await POST(request(VERSION_ID, TOKEN));
    expect(response.status).toBe(204);
    expect(mocks.runProcessing).not.toHaveBeenCalled();
  });

  it("returns 204 without invoking the worker when the upload is not confirmed", async () => {
    // Same empty RETURNING as the already-processing case: the CAS admits
    // only uploaded + confirmed, so both reasons land here without a worker.
    mockCas({ data: [], error: null });
    const otherVersion = "30000000-0000-4000-8000-000000000011";
    const response = await POST(request(otherVersion, TOKEN));
    expect(response.status).toBe(204);
    expect(mocks.runProcessing).not.toHaveBeenCalled();
  });

  it("claims once and dispatches runProcessing with the returned operation_id", async () => {
    const response = await POST(request(VERSION_ID, TOKEN));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "processing" });
    await vi.waitFor(() => expect(mocks.runProcessing).toHaveBeenCalledTimes(1));
    expect(mocks.runProcessing).toHaveBeenCalledWith(VERSION_ID, OPERATION_ID);

    // CAS scope: only uploaded + confirmed rows are claimable.
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ processing_status: "processing" }),
    );
    expect(mocks.eq).toHaveBeenCalledWith("id", VERSION_ID);
    expect(mocks.eq).toHaveBeenCalledWith("processing_status", "uploaded");
    expect(mocks.eq).toHaveBeenCalledWith("upload_state", "confirmed");
  });

  it("awaits runProcessing instead of returning before it settles", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.runProcessing.mockReturnValue(gate);

    let settled = false;
    const pending = POST(request(VERSION_ID, TOKEN)).then((response) => {
      settled = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.runProcessing).toHaveBeenCalledTimes(1);
    // A fire-and-forget handler would have settled by now; the awaited
    // one must still be waiting on the worker (frozen serverless risk).
    expect(settled).toBe(false);

    release();
    const response = await pending;
    expect(response.status).toBe(200);
  });

  it("reports a worker throw as PERSISTENCE_FAILED and still returns 200", async () => {
    mocks.runProcessing.mockRejectedValue(new Error("private worker defect"));
    const response = await POST(request(VERSION_ID, TOKEN));

    expect(response.status).toBe(200);
    const leaked = await response.clone().text();
    expect(await response.json()).toEqual({ status: "processing" });
    expect(mocks.captureOperationFailure).toHaveBeenCalledWith({
      module: "ingestion",
      operation: "process",
      code: "PERSISTENCE_FAILED",
      correlationId: expect.any(String),
    });
    expect(leaked).not.toContain("private worker defect");
    expect(leaked).not.toContain(TOKEN);
  });

  it("reports an unexpected DB failure as PERSISTENCE_FAILED with a generic 500", async () => {
    mockCas({ data: null, error: { message: "private db detail" } });
    const response = await POST(request(VERSION_ID, TOKEN));

    expect(response.status).toBe(500);
    expect(mocks.runProcessing).not.toHaveBeenCalled();
    expect(mocks.captureOperationFailure).toHaveBeenCalledWith({
      module: "ingestion",
      operation: "process",
      code: "PERSISTENCE_FAILED",
      correlationId: expect.any(String),
    });
    const body = await response.text();
    expect(body).not.toContain("private db detail");
    expect(body).not.toContain(TOKEN);
  });
});
