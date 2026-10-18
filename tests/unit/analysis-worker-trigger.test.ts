import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  getServiceSupabaseConfig: vi.fn(),
  captureOperationFailure: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/lib/supabase/service", () => ({
  getServiceSupabaseConfig: mocks.getServiceSupabaseConfig,
}));
vi.mock("@/lib/observability/operation-events", () => ({
  captureOperationFailure: mocks.captureOperationFailure,
}));

import { scheduleAnalysisTrigger } from "@/modules/analysis/application/worker-trigger";

const analysisId = "90000000-0000-4000-8000-000000000003";
const endpoint = "http://127.0.0.1:54321/functions/v1/analyze";
let fetchMock: ReturnType<typeof vi.fn>;

async function runRegisteredCallback(): Promise<void> {
  const callback = mocks.after.mock.calls[0]?.[0] as (() => Promise<void>) | undefined;
  if (!callback) throw new Error("The trigger callback was not registered.");
  await callback();
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-sentinel");
  vi.stubEnv("ANALYSIS_INTERNAL_TOKEN", "analysis-token-sentinel");
  vi.stubEnv("INGESTION_INTERNAL_TOKEN", "ingestion-token-sentinel");
  mocks.getServiceSupabaseConfig.mockReturnValue({
    url: new URL("http://127.0.0.1:54321"),
    urlText: "http://127.0.0.1:54321",
    serviceRoleKey: "service-role-sentinel",
  });
  fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("post-commit analysis worker trigger", () => {
  it("registers after() and sends only the analysis ID with a 2-second timeout", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);

    scheduleAnalysisTrigger(analysisId);
    expect(mocks.after).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();

    await runRegisteredCallback();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string | URL, RequestInit];
    expect(url.toString()).toBe(endpoint);
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        authorization: "Bearer analysis-token-sentinel",
        "content-type": "application/json",
      },
      body: JSON.stringify({ analysisId }),
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(timeoutSpy).toHaveBeenCalledExactlyOnceWith(2000);
    expect(mocks.captureOperationFailure).not.toHaveBeenCalled();
  });

  it.each([
    { label: "401", response: new Response("secret unauthorized body", { status: 401 }) },
    { label: "503", response: new Response("secret readiness body", { status: 503 }) },
  ])("contains an HTTP $label trigger failure", async ({ response }) => {
    fetchMock.mockResolvedValue(response);

    scheduleAnalysisTrigger(analysisId);
    await runRegisteredCallback();

    expect(mocks.captureOperationFailure).toHaveBeenCalledWith({
      module: "analysis",
      operation: "trigger",
      code: "INTERNAL_ERROR",
      correlationId: expect.any(String),
    });
    expect(JSON.stringify(mocks.captureOperationFailure.mock.calls)).not.toContain("secret");
  });

  it("contains network and timeout failures without serializing the error", async () => {
    fetchMock.mockRejectedValue(new Error("secret socket/timeout detail"));

    scheduleAnalysisTrigger(analysisId);
    await runRegisteredCallback();

    expect(mocks.captureOperationFailure).toHaveBeenCalledWith({
      module: "analysis",
      operation: "trigger",
      code: "INTERNAL_ERROR",
      correlationId: expect.any(String),
    });
    expect(JSON.stringify(mocks.captureOperationFailure.mock.calls)).not.toContain("secret");
  });

  it("uses a dedicated analysis token and fails closed when it is missing", async () => {
    vi.stubEnv("ANALYSIS_INTERNAL_TOKEN", "");

    scheduleAnalysisTrigger(analysisId);
    await runRegisteredCallback();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.captureOperationFailure).toHaveBeenCalledWith(expect.objectContaining({
      module: "analysis",
      operation: "trigger",
      code: "INTERNAL_ERROR",
    }));
  });

  it("does not fail the caller when after() itself cannot register the callback", () => {
    mocks.after.mockImplementation(() => { throw new Error("secret request context"); });

    expect(() => scheduleAnalysisTrigger(analysisId)).not.toThrow();
    expect(mocks.captureOperationFailure).toHaveBeenCalledWith(expect.objectContaining({
      module: "analysis",
      operation: "trigger",
      code: "INTERNAL_ERROR",
    }));
    expect(JSON.stringify(mocks.captureOperationFailure.mock.calls)).not.toContain("secret");
  });
});
