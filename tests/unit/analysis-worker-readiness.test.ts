import { describe, expect, it, vi } from "vitest";

import {
  handleAnalyzeRequest,
  isLocalTestEnv,
} from "../../supabase/functions/analyze/index";
import type {
  AnalyzeEnv,
  AnalyzeHandlerDeps,
} from "../../supabase/functions/analyze/index";
import type { AnalysisWorkerDb } from "../../src/modules/analysis/worker/types";
import { createFinalization } from "../../src/modules/analysis/worker/finalization";
import { createProvider } from "../../src/modules/analysis/worker/provider";

const ENV: AnalyzeEnv = {
  analysisInternalToken: "test-token",
  supabaseUrl: "http://127.0.0.1:54321",
  supabaseServiceRoleKey: "service-key",
  analysisSupabaseUrl: "http://127.0.0.1:54321",
  analysisFakeProvider: undefined,
  analysisFakeLatencyMs: undefined,
  analysisFakeFailAtCallIndex: undefined,
  analysisFakeFailCode: undefined,
  analysisFakeThrowCode: undefined,
};

function throwingProvider(): never {
  throw new Error("S2-07 not merged: AIProvider unavailable.");
}

function throwingFinalization(): never {
  throw new Error("S2-08 not merged: AnalysisFinalization unavailable.");
}

function readyProvider() {
  return {} as never;
}

function readyFinalization() {
  return {} as never;
}

function deps(
  overrides: Partial<AnalyzeHandlerDeps> = {},
): AnalyzeHandlerDeps {
  return {
    createProviderFn: throwingProvider,
    createFinalizationFn: throwingFinalization,
    createClientFn: vi.fn(
      (): AnalysisWorkerDb => ({ rpc: vi.fn() }) as unknown as AnalysisWorkerDb,
    ),
    runJobFn: vi.fn(async () => ({
      kind: "completed" as const,
      claimedId: "claimed-job",
    })),
    fetchFn: vi.fn(async () => new Response("ok")),
    ...overrides,
  };
}

function post(body: unknown, token?: string) {
  return new Request("http://localhost/functions/v1/analyze", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: JSON.stringify(body),
  });
}

describe("analyze handler readiness", () => {
  it("rejects a missing token with 401 and zero RPCs", async () => {
    const d = deps({
      createProviderFn: readyProvider,
      createFinalizationFn: readyFinalization,
    });
    const response = await handleAnalyzeRequest(
      post({ analysisId: "a" }),
      ENV,
      d,
    );
    expect(response.status).toBe(401);
    expect(vi.mocked(d.createClientFn)).not.toHaveBeenCalled();
    expect(vi.mocked(d.runJobFn)).not.toHaveBeenCalled();
  });

  it("rejects a wrong token with 401 and zero RPCs", async () => {
    const d = deps({
      createProviderFn: readyProvider,
      createFinalizationFn: readyFinalization,
    });
    const response = await handleAnalyzeRequest(
      post({ analysisId: "a" }, "wrong-token"),
      ENV,
      d,
    );
    expect(response.status).toBe(401);
    expect(vi.mocked(d.createClientFn)).not.toHaveBeenCalled();
    expect(vi.mocked(d.runJobFn)).not.toHaveBeenCalled();
  });

  it("returns 503 without claiming when the provider is missing", async () => {
    const d = deps({ createFinalizationFn: readyFinalization });
    const response = await handleAnalyzeRequest(
      post({ analysisId: "a" }, "test-token"),
      ENV,
      d,
    );
    expect(response.status).toBe(503);
    expect(vi.mocked(d.createClientFn)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(d.runJobFn)).not.toHaveBeenCalled();
  });

  it("returns 503 without claiming when finalization is missing", async () => {
    const d = deps({ createProviderFn: readyProvider });
    const response = await handleAnalyzeRequest(
      post({ analysisId: "a" }, "test-token"),
      ENV,
      d,
    );
    expect(response.status).toBe(503);
    expect(vi.mocked(d.createClientFn)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(d.runJobFn)).not.toHaveBeenCalled();
  });

  it("rejects a body without analysisId with 400 and zero claims", async () => {
    const d = deps({
      createProviderFn: readyProvider,
      createFinalizationFn: readyFinalization,
    });
    const response = await handleAnalyzeRequest(
      post({}, "test-token"),
      ENV,
      d,
    );
    expect(response.status).toBe(400);
    expect(vi.mocked(d.runJobFn)).not.toHaveBeenCalled();
  });

  it("proceeds to the job on a valid request", async () => {
    const d = deps({
      createProviderFn: readyProvider,
      createFinalizationFn: readyFinalization,
    });
    const response = await handleAnalyzeRequest(
      post({ analysisId: "analysis-1" }, "test-token"),
      ENV,
      d,
    );
    expect(response.status).toBe(200);
    expect(vi.mocked(d.runJobFn)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(d.runJobFn).mock.calls[0]?.[0]).toMatchObject({
      analysisId: "analysis-1",
    });
  });

  it("rejects non-POST methods", async () => {
    const d = deps();
    const response = await handleAnalyzeRequest(
      new Request("http://localhost/functions/v1/analyze", {
        method: "GET",
      }),
      ENV,
      d,
    );
    expect(response.status).toBe(405);
    expect(vi.mocked(d.runJobFn)).not.toHaveBeenCalled();
  });

  it("self-fetches fire-and-forget when more batches remain", async () => {
    const SWEPT_ID = "c2222222-0000-4000-8000-000000000003";
    let resolveFetch!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const d = deps({
      createProviderFn: readyProvider,
      createFinalizationFn: readyFinalization,
      runJobFn: vi.fn(async () => ({
        kind: "has-more" as const,
        claimedId: SWEPT_ID,
      })),
      fetchFn: vi.fn(() => pending),
    });
    const response = await handleAnalyzeRequest(
      post({ analysisId: "analysis-1" }, "test-token"),
      ENV,
      d,
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      ok: true,
      analysisId: "analysis-1",
      claimedId: SWEPT_ID,
      continued: true,
    });
    expect(vi.mocked(d.fetchFn)).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(d.fetchFn).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/functions/v1/analyze");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      authorization: "Bearer test-token",
    });
    expect(String(init.body)).toBe(JSON.stringify({ analysisId: SWEPT_ID }));
    expect(init.signal).toBeInstanceOf(AbortSignal);
    resolveFetch(new Response("ok"));
  });

  it("maps failed and aborted outcomes without leaking internals", async () => {
    const failed = deps({
      createProviderFn: readyProvider,
      createFinalizationFn: readyFinalization,
      runJobFn: vi.fn(async () => ({
        kind: "failed" as const,
        code: "PROVIDER_UNAVAILABLE" as const,
        claimedId: "claimed-job",
      })),
    });
    const failedResponse = await handleAnalyzeRequest(
      post({ analysisId: "a" }, "test-token"),
      ENV,
      failed,
    );
    expect(failedResponse.status).toBe(200);
    expect(await failedResponse.json()).toEqual({
      ok: true,
      analysisId: "a",
      claimedId: "claimed-job",
      final: false,
      code: "PROVIDER_UNAVAILABLE",
    });

    const aborted = deps({
      createProviderFn: readyProvider,
      createFinalizationFn: readyFinalization,
      runJobFn: vi.fn(async () => ({ kind: "aborted" as const, claimedId: "claimed-job" })),
    });
    const abortedResponse = await handleAnalyzeRequest(
      post({ analysisId: "a" }, "test-token"),
      ENV,
      aborted,
    );
    expect(await abortedResponse.json()).toEqual({
      ok: true,
      analysisId: "a",
      claimedId: "claimed-job",
      final: false,
      aborted: true,
    });
  });

  it("echoes the claimed id on failed and aborted responses", async () => {
    const SWEPT_ID = "c2222222-0000-4000-8000-000000000003";
    const failedDeps = deps({
      createProviderFn: readyProvider,
      createFinalizationFn: readyFinalization,
      runJobFn: vi.fn(async () => ({
        kind: "failed" as const,
        code: "TIMEOUT" as const,
        claimedId: SWEPT_ID,
      })),
    });
    const failedResponse = await handleAnalyzeRequest(
      post({ analysisId: "payload-id" }, "test-token"),
      ENV,
      failedDeps,
    );
    expect(await failedResponse.json()).toEqual({
      ok: true,
      analysisId: "payload-id",
      claimedId: SWEPT_ID,
      final: false,
      code: "TIMEOUT",
    });

    const abortedDeps = deps({
      createProviderFn: readyProvider,
      createFinalizationFn: readyFinalization,
      runJobFn: vi.fn(async () => ({
        kind: "aborted" as const,
        claimedId: SWEPT_ID,
      })),
    });
    const abortedResponse = await handleAnalyzeRequest(
      post({ analysisId: "payload-id" }, "test-token"),
      ENV,
      abortedDeps,
    );
    expect(await abortedResponse.json()).toEqual({
      ok: true,
      analysisId: "payload-id",
      claimedId: SWEPT_ID,
      final: false,
      aborted: true,
    });
  });

  it("ignores body _fake overrides when the gate is closed", async () => {
    const env: AnalyzeEnv = {
      analysisInternalToken: "test-token",
      supabaseUrl: "http://127.0.0.1:54321",
      supabaseServiceRoleKey: "service-key",
      analysisSupabaseUrl: "http://127.0.0.1:54321",
      analysisFakeProvider: undefined,
      analysisFakeLatencyMs: undefined,
      analysisFakeFailAtCallIndex: undefined,
      analysisFakeFailCode: undefined,
      analysisFakeThrowCode: undefined,
    };
    const d = deps();
    const res = await handleAnalyzeRequest(
      new Request("http://x/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-token",
        },
        body: JSON.stringify({
          analysisId: "00000000-0000-4000-8000-000000000000",
          _fake: { latencyMs: 999999, failCode: "INTERNAL_ERROR" },
        }),
      }),
      env,
      d,
    );
    expect(res.status).toBe(503);
    expect(vi.mocked(d.runJobFn)).not.toHaveBeenCalled();
  });

  it("sanitizes unexpected failures to a 500 without internals", async () => {
    const d = deps({
      createProviderFn: readyProvider,
      createFinalizationFn: readyFinalization,
      runJobFn: vi.fn(async () => {
        throw new Error("connection string postgres://secret");
      }),
    });
    const response = await handleAnalyzeRequest(
      post({ analysisId: "a" }, "test-token"),
      ENV,
      d,
    );
    expect(response.status).toBe(500);
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain("postgres://secret");
    expect(body).not.toContain("test-token");
  });

  it("enables the test hook only with flag plus local URL", () => {
    const local = (flag: string | undefined, url: string | undefined) => ({
      analysisInternalToken: "test-token",
      supabaseUrl: url,
      supabaseServiceRoleKey: "service-key",
      analysisSupabaseUrl: url,
      analysisFakeProvider: flag,
      analysisFakeLatencyMs: undefined,
      analysisFakeFailAtCallIndex: undefined,
      analysisFakeFailCode: undefined,
      analysisFakeThrowCode: undefined,
    });
    expect(
      isLocalTestEnv(local("1", "http://127.0.0.1:54321")),
    ).toBe(true);
    expect(isLocalTestEnv(local("1", "http://localhost:54321"))).toBe(true);
    expect(isLocalTestEnv(local("1", "http://[::1]:54321"))).toBe(true);
    expect(isLocalTestEnv(local("1", "http://127.0.0.1:9999"))).toBe(true);
    expect(
      isLocalTestEnv(local("1", "https://abc.supabase.co")),
    ).toBe(false);
    expect(isLocalTestEnv(local(undefined, "http://127.0.0.1:54321"))).toBe(
      false,
    );
    expect(isLocalTestEnv(local("0", "http://127.0.0.1:54321"))).toBe(false);
    expect(isLocalTestEnv(local("1", "not-a-url"))).toBe(false);
    expect(isLocalTestEnv(local("1", undefined))).toBe(false);
  });

  it("keeps failing loud when the test gate is closed", () => {
    const closed = {
      analysisInternalToken: "test-token",
      supabaseUrl: "http://127.0.0.1:54321",
      supabaseServiceRoleKey: "service-key",
      analysisSupabaseUrl: "http://127.0.0.1:54321",
      analysisFakeProvider: undefined,
      analysisFakeLatencyMs: undefined,
      analysisFakeFailAtCallIndex: undefined,
      analysisFakeFailCode: undefined,
      analysisFakeThrowCode: undefined,
    };
    expect(isLocalTestEnv(closed)).toBe(false);
    expect(
      isLocalTestEnv({ ...closed, supabaseUrl: "https://remote.example.com" }),
    ).toBe(false);
    expect(() => createProvider()).toThrow(
      "S2-07 not merged: AIProvider unavailable.",
    );
    expect(() => createFinalization()).toThrow(
      "S2-08 not merged: AnalysisFinalization unavailable.",
    );
  });

  it("stays closed in hosted deployments even with spoofed analysis URL", () => {
    // Reinforced gate: a hosted runtime URL blocks the gate even when
    // the flag is set and the harness URL is loopback. Setting env vars
    // requires project-owner privilege; this closes the remaining hole
    // where the platform-injected URL is ignored.
    const spoofed: AnalyzeEnv = {
      analysisInternalToken: "test-token",
      supabaseUrl: "https://xyz.supabase.co",
      supabaseServiceRoleKey: "service-key",
      analysisSupabaseUrl: "http://127.0.0.1:54321",
      analysisFakeProvider: "1",
      analysisFakeLatencyMs: undefined,
      analysisFakeFailAtCallIndex: undefined,
      analysisFakeFailCode: undefined,
      analysisFakeThrowCode: undefined,
    };
    expect(isLocalTestEnv(spoofed)).toBe(false);
  });

  it("runs the fake branch end to end when the gate is open", async () => {
    const openEnv: AnalyzeEnv = {
      analysisInternalToken: "test-token",
      supabaseUrl: "http://127.0.0.1:54321",
      supabaseServiceRoleKey: "service-key",
      analysisSupabaseUrl: "http://127.0.0.1:54321",
      analysisFakeProvider: "1",
      analysisFakeLatencyMs: undefined,
      analysisFakeFailAtCallIndex: undefined,
      analysisFakeFailCode: undefined,
      analysisFakeThrowCode: undefined,
    };
    expect(isLocalTestEnv(openEnv)).toBe(true);
    const d = deps({
      runJobFn: vi.fn(async () => ({
        kind: "completed" as const,
        claimedId: "claimed-job",
      })),
    });
    const response = await handleAnalyzeRequest(
      post({ analysisId: "analysis-1" }, "test-token"),
      openEnv,
      d,
    );
    expect(response.status).toBe(200);
    expect(vi.mocked(d.createClientFn)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(d.runJobFn)).toHaveBeenCalledTimes(1);
  });

  it("parses per-request fake behavior without throwing", async () => {
    const { parseFakeBehaviorSafe } = await import(
      "../../supabase/functions/analyze/_test_doubles/analysis-provider.fake.ts"
    );
    expect(parseFakeBehaviorSafe(undefined)).toEqual({});
    expect(parseFakeBehaviorSafe(null)).toEqual({});
    expect(
      parseFakeBehaviorSafe({
        latencyMs: 400,
        failAtCallIndex: 0,
        failCode: "PROVIDER_UNAVAILABLE",
        throwCode: "bogus",
        injected: "dropped",
      }),
    ).toEqual({
      latencyMs: 400,
      failAtCallIndex: 0,
      failCode: "PROVIDER_UNAVAILABLE",
    });
    expect(parseFakeBehaviorSafe({ latencyMs: -1 })).toEqual({});
  });
});
