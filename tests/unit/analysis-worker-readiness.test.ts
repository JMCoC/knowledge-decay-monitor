import { describe, expect, it, vi } from "vitest";

import {
  handleAnalyzeRequest,
  isLocalTestEnv,
} from "../../supabase/functions/analyze/index";
import type {
  AnalyzeEnv,
  AnalyzeHandlerDeps,
} from "../../supabase/functions/analyze/index";
import type {
  AIProvider,
  AnalysisBatchPersistence,
  AnalysisWorkerDb,
} from "../../src/modules/analysis/worker/types";
import { createBatchPersistence } from "../../src/modules/analysis/worker/batch-persistence";
import { createFinalization } from "../../src/modules/analysis/worker/finalization";
import type { AnalysisFinalization } from "../../src/modules/analysis/worker/finalization";
import { createProvider } from "../../src/modules/analysis/worker/provider";
import { FakeAnalysisProvider } from "../../supabase/functions/analyze/_test_doubles/analysis-provider.fake";
import { FakeAnalysisBatchPersistence } from "../../supabase/functions/analyze/_test_doubles/analysis-batch-persistence.fake";

const ENV: AnalyzeEnv = {
  analysisInternalToken: "test-token",
  supabaseUrl: "http://127.0.0.1:54321",
  supabaseServiceRoleKey: "service-key",
  analysisSupabaseUrl: "http://127.0.0.1:54321",
  analysisFakeProvider: undefined,
  analysisFakeFinalization: undefined,
  analysisFakePersistence: undefined,
  analysisFakeLatencyMs: undefined,
  analysisFakeFailAtCallIndex: undefined,
  analysisFakeFailCode: undefined,
  analysisFakeThrowCode: undefined,
};

function throwingProvider(): never {
  throw new Error("provider unavailable");
}

function throwingFinalization(): never {
  throw new Error("S2-08 not merged: AnalysisFinalization unavailable.");
}

function throwingPersistence(): AnalysisBatchPersistence {
  throw new Error("S2-08 not merged: analysis batch staging unavailable.");
}

function ready() {
  return {} as never;
}

function deps(
  overrides: Partial<AnalyzeHandlerDeps> = {},
): AnalyzeHandlerDeps {
  return {
    createProviderFn: throwingProvider,
    createFinalizationFn: throwingFinalization,
    createBatchPersistenceFn: throwingPersistence,
    createClientFn: vi.fn(
      (): AnalysisWorkerDb => ({ rpc: vi.fn() }) as unknown as AnalysisWorkerDb,
    ),
    runJobFn: vi.fn(async () => ({
      kind: "completed" as const,
      claimedId: "claimed-job",
    })),
    fetchFn: vi.fn(async () => new Response("ok")),
    waitUntilFn: vi.fn(() => {}),
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

describe("analyze handler readiness and async acknowledgement", () => {
  it("rejects missing or wrong tokens before creating a client", async () => {
    for (const token of [undefined, "wrong-token"]) {
      const d = deps({ createProviderFn: ready, createFinalizationFn: ready, createBatchPersistenceFn: ready });
      const response = await handleAnalyzeRequest(post({}, token), ENV, d);
      expect(response.status).toBe(401);
      expect(d.createClientFn).not.toHaveBeenCalled();
      expect(d.runJobFn).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["provider", throwingProvider, ready, ready],
    ["finalization", ready, throwingFinalization, ready],
    ["batch persistence", ready, ready, throwingPersistence],
  ])("returns 503 without a claim when %s is missing", async (_label, provider, finalization, persistence) => {
    const d = deps({
      createProviderFn: provider,
      createFinalizationFn: finalization,
      createBatchPersistenceFn: persistence,
    });
    const response = await handleAnalyzeRequest(
      post({ analysisId: "analysis-1" }, "test-token"),
      ENV,
      d,
    );
    expect(response.status).toBe(503);
    expect(d.createClientFn).toHaveBeenCalledTimes(1);
    expect(d.runJobFn).not.toHaveBeenCalled();
  });

  it("requires waitUntil registration before the job can claim", async () => {
    const d = deps({
      createProviderFn: ready,
      createFinalizationFn: ready,
      createBatchPersistenceFn: ready,
      waitUntilFn: vi.fn(() => {
        throw new Error("no background runtime");
      }),
    });
    const response = await handleAnalyzeRequest(
      post({ analysisId: "analysis-1" }, "test-token"),
      ENV,
      d,
    );
    await Promise.resolve();
    expect(response.status).toBe(503);
    expect(d.runJobFn).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid JSON shape or continuation budget", async () => {
    const d = deps({ createProviderFn: ready, createFinalizationFn: ready, createBatchPersistenceFn: ready });
    const invalidShape = await handleAnalyzeRequest(post([], "test-token"), ENV, d);
    const invalidBudget = await handleAnalyzeRequest(
      post({ continuationBudget: 11 }, "test-token"),
      ENV,
      d,
    );
    expect(invalidShape.status).toBe(400);
    expect(invalidBudget.status).toBe(400);
    expect(d.runJobFn).not.toHaveBeenCalled();
  });

  it("accepts a directed run and acknowledges before background work completes", async () => {
    let resolveJob!: (result: { kind: "completed"; claimedId: string }) => void;
    let background: Promise<unknown> | undefined;
    const d = deps({
      createProviderFn: ready,
      createFinalizationFn: ready,
      createBatchPersistenceFn: ready,
      waitUntilFn: vi.fn((promise) => {
        background = promise;
      }),
      runJobFn: vi.fn(() => new Promise<{ kind: "completed"; claimedId: string }>((resolve) => {
        resolveJob = resolve;
      })),
    });
    const response = await handleAnalyzeRequest(
      post({ analysisId: "analysis-1" }, "test-token"),
      ENV,
      d,
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, accepted: true });
    expect(d.waitUntilFn).toHaveBeenCalledTimes(1);
    expect(d.runJobFn).toHaveBeenCalledTimes(1);
    resolveJob({ kind: "completed", claimedId: "analysis-1" });
    await background;
  });

  it("accepts an empty sweep request and passes a null analysis id", async () => {
    let background: Promise<unknown> | undefined;
    const d = deps({
      createProviderFn: ready,
      createFinalizationFn: ready,
      createBatchPersistenceFn: ready,
      waitUntilFn: vi.fn((promise) => {
        background = promise;
      }),
    });
    const response = await handleAnalyzeRequest(post({}, "test-token"), ENV, d);
    expect(response.status).toBe(202);
    await background;
    expect(d.runJobFn).toHaveBeenCalledWith(expect.objectContaining({ analysisId: null }));
  });

  it("self-fetches the claimed job with a decreasing bounded continuation budget", async () => {
    let background: Promise<unknown> | undefined;
    const d = deps({
      createProviderFn: ready,
      createFinalizationFn: ready,
      createBatchPersistenceFn: ready,
      waitUntilFn: vi.fn((promise) => {
        background = promise;
      }),
      runJobFn: vi.fn(async () => ({
        kind: "has-more" as const,
        claimedId: "claimed-job",
      })),
    });
    const response = await handleAnalyzeRequest(
      post({ analysisId: "payload-job" }, "test-token"),
      ENV,
      d,
    );
    expect(response.status).toBe(202);
    await background;
    expect(d.fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(d.fetchFn).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/functions/v1/analyze");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ authorization: "Bearer test-token" });
    expect(JSON.parse(String(init.body))).toEqual({
      analysisId: "claimed-job",
      continuationBudget: 9,
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("leaves a yielded continuation queued when its budget is exhausted", async () => {
    let background: Promise<unknown> | undefined;
    const d = deps({
      createProviderFn: ready,
      createFinalizationFn: ready,
      createBatchPersistenceFn: ready,
      waitUntilFn: vi.fn((promise) => {
        background = promise;
      }),
      runJobFn: vi.fn(async () => ({
        kind: "has-more" as const,
        claimedId: "claimed-job",
      })),
    });
    const response = await handleAnalyzeRequest(
      post({ analysisId: "analysis-1", continuationBudget: 0 }, "test-token"),
      ENV,
      d,
    );
    expect(response.status).toBe(202);
    await background;
    expect(d.fetchFn).not.toHaveBeenCalled();
  });

  it("stays fail-closed for the test fake gate in hosted runtimes", () => {
    const local = (flag: string | undefined, analysisUrl: string | undefined, runtimeUrl?: string) => ({
      ...ENV,
      supabaseUrl: runtimeUrl ?? analysisUrl,
      analysisSupabaseUrl: analysisUrl,
      analysisFakeProvider: flag,
    });
    expect(isLocalTestEnv(local("1", "http://127.0.0.1:54321"))).toBe(true);
    expect(isLocalTestEnv(local("1", "https://abc.supabase.co"))).toBe(false);
    expect(isLocalTestEnv(local("1", "http://127.0.0.1:54321", "https://abc.supabase.co"))).toBe(false);
    expect(isLocalTestEnv(local(undefined, "http://127.0.0.1:54321"))).toBe(false);
  });

  it("does not put an internal failure into the acknowledgement response", async () => {
    let background: Promise<unknown> | undefined;
    const d = deps({
      createProviderFn: ready,
      createFinalizationFn: ready,
      createBatchPersistenceFn: ready,
      waitUntilFn: vi.fn((promise) => {
        background = promise;
      }),
      runJobFn: vi.fn(async () => {
        throw new Error("connection string postgres://secret");
      }),
    });
    const response = await handleAnalyzeRequest(
      post({ analysisId: "analysis-1" }, "test-token"),
      ENV,
      d,
    );
    expect(response.status).toBe(202);
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain("postgres://secret");
    expect(body).not.toContain("test-token");
    await background;
  });

  it("runs fake work only when the test gate is open", async () => {
    let background: Promise<unknown> | undefined;
    const env: AnalyzeEnv = {
      ...ENV,
      analysisFakeProvider: "1",
    };
    const d = deps({
      waitUntilFn: vi.fn((promise) => {
        background = promise;
      }),
    });
    const response = await handleAnalyzeRequest(
      post({ analysisId: "analysis-1" }, "test-token"),
      env,
      d,
    );
    expect(response.status).toBe(202);
    await background;
    expect(d.createClientFn).toHaveBeenCalledTimes(1);
    expect(d.runJobFn).toHaveBeenCalledTimes(1);
    expect(d.runJobFn).toHaveBeenCalledWith(expect.objectContaining({ persistence: expect.anything() }));
  });

  it("builds a real provider and both factories with a stub client", () => {
    vi.stubEnv("CEREBRAS_API_KEY", "test-cerebras-key");
    vi.stubEnv("GROQ_API_KEY", "test-groq-key");
    vi.stubEnv("CEREBRAS_BASE_URL", "https://cerebras.test/v1");
    vi.stubEnv("GROQ_BASE_URL", "https://groq.test/openai/v1");
    try {
      const provider = createProvider();
      expect(provider).not.toBeInstanceOf(Promise);
      expect(typeof provider.analyzePair).toBe("function");
      const client = { rpc: vi.fn() } as unknown as AnalysisWorkerDb;
      expect(() => createFinalization(client)).not.toThrow();
      expect(() => createBatchPersistence(client)).not.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("returns 503 without a claim when provider credentials are missing", async () => {
    vi.stubEnv("CEREBRAS_API_KEY", "");
    vi.stubEnv("GROQ_API_KEY", "");
    vi.stubEnv("CEREBRAS_BASE_URL", "");
    vi.stubEnv("GROQ_BASE_URL", "");
    try {
      const d = deps({
        createProviderFn: createProvider,
        createFinalizationFn: ready,
        createBatchPersistenceFn: ready,
      });
      const response = await handleAnalyzeRequest(
        post({ analysisId: "analysis-1" }, "test-token"),
        ENV,
        d,
      );
      expect(response.status).toBe(503);
      expect(d.runJobFn).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("parses fake behavior without allowing unsupported values", async () => {
    const { parseFakeBehaviorSafe } = await import(
      "../../supabase/functions/analyze/_test_doubles/analysis-provider.fake"
    );
    expect(parseFakeBehaviorSafe(undefined)).toEqual({});
    expect(parseFakeBehaviorSafe({ latencyMs: 400, failCode: "PROVIDER_UNAVAILABLE", injected: true })).toEqual({
      latencyMs: 400,
      failCode: "PROVIDER_UNAVAILABLE",
    });
    expect(parseFakeBehaviorSafe({ latencyMs: -1 })).toEqual({});
  });
});

const realProvider = {
  analyzePair: vi.fn(),
} as unknown as AIProvider;
const realFinalization = {
  finalize: vi.fn(),
  real: true,
} as unknown as AnalysisFinalization;
const realPersistence = {
  persist: vi.fn(),
  real: true,
} as unknown as AnalysisBatchPersistence;

type ComponentExpectation = "fake" | "real";

interface FlagCase {
  name: string;
  env: AnalyzeEnv;
  expected: {
    provider: ComponentExpectation;
    finalization: ComponentExpectation;
    persistence: ComponentExpectation;
  };
}

function localEnv(overrides: Partial<AnalyzeEnv> = {}): AnalyzeEnv {
  return {
    ...ENV,
    analysisFakeProvider: "1",
    ...overrides,
  } as AnalyzeEnv;
}

async function selectComponents(
  env: AnalyzeEnv,
  body: unknown = { analysisId: "analysis-1" },
) {
  let background: Promise<unknown> | undefined;
  const createProviderFn = vi.fn(() => realProvider);
  const createFinalizationFn = vi.fn(() => realFinalization);
  const createBatchPersistenceFn = vi.fn(() => realPersistence);
  const d = deps({
    createProviderFn,
    createFinalizationFn,
    createBatchPersistenceFn,
    waitUntilFn: vi.fn((promise) => {
      background = promise;
    }),
  });
  const response = await handleAnalyzeRequest(
    post(body, "test-token"),
    env,
    d,
  );
  expect(response.status).toBe(202);
  await background;
  const job = vi.mocked(d.runJobFn).mock.calls[0]?.[0];
  if (!job) throw new Error("analysis job was not started");
  return {
    job,
    createProviderFn,
    createFinalizationFn,
    createBatchPersistenceFn,
  };
}

const flagCases: FlagCase[] = [
  {
    name: "finalization absent inherits the local gate",
    env: localEnv(),
    expected: { provider: "fake", finalization: "fake", persistence: "fake" },
  },
  {
    name: "finalization 1 keeps the fake",
    env: localEnv({ analysisFakeFinalization: "1" }),
    expected: { provider: "fake", finalization: "fake", persistence: "fake" },
  },
  {
    name: "finalization 0 forces the real implementation",
    env: localEnv({ analysisFakeFinalization: "0" }),
    expected: { provider: "fake", finalization: "real", persistence: "fake" },
  },
  {
    name: "finalization empty string inherits the local gate",
    env: localEnv({ analysisFakeFinalization: "" }),
    expected: { provider: "fake", finalization: "fake", persistence: "fake" },
  },
  {
    name: "finalization true inherits the local gate",
    env: localEnv({ analysisFakeFinalization: "true" }),
    expected: { provider: "fake", finalization: "fake", persistence: "fake" },
  },
  {
    name: "finalization yes inherits the local gate",
    env: localEnv({ analysisFakeFinalization: "yes" }),
    expected: { provider: "fake", finalization: "fake", persistence: "fake" },
  },
  {
    name: "finalization on inherits the local gate",
    env: localEnv({ analysisFakeFinalization: "on" }),
    expected: { provider: "fake", finalization: "fake", persistence: "fake" },
  },
  {
    name: "persistence 0 forces the real implementation",
    env: localEnv({ analysisFakePersistence: "0" }),
    expected: { provider: "fake", finalization: "fake", persistence: "real" },
  },
  {
    name: "persistence empty string inherits the local gate",
    env: localEnv({ analysisFakePersistence: "" }),
    expected: { provider: "fake", finalization: "fake", persistence: "fake" },
  },
  {
    name: "persistence true inherits the local gate",
    env: localEnv({ analysisFakePersistence: "true" }),
    expected: { provider: "fake", finalization: "fake", persistence: "fake" },
  },
  {
    name: "persistence yes inherits the local gate",
    env: localEnv({ analysisFakePersistence: "yes" }),
    expected: { provider: "fake", finalization: "fake", persistence: "fake" },
  },
  {
    name: "both component overrides stay independent",
    env: localEnv({
      analysisFakeFinalization: "0",
      analysisFakePersistence: "0",
    }),
    expected: { provider: "fake", finalization: "real", persistence: "real" },
  },
  {
    name: "provider 0 closes the base gate",
    env: localEnv({ analysisFakeProvider: "0" }),
    expected: { provider: "real", finalization: "real", persistence: "real" },
  },
  {
    name: "provider absent closes the base gate",
    env: localEnv({ analysisFakeProvider: undefined }),
    expected: { provider: "real", finalization: "real", persistence: "real" },
  },
  {
    name: "hosted runtime with all flags 1 keeps all components real",
    env: localEnv({
      supabaseUrl: "https://abc.supabase.co",
      analysisFakeFinalization: "1",
      analysisFakePersistence: "1",
    }),
    expected: { provider: "real", finalization: "real", persistence: "real" },
  },
  {
    name: "hosted runtime with 0 overrides keeps all components real",
    env: localEnv({
      supabaseUrl: "https://abc.supabase.co",
      analysisFakeFinalization: "0",
      analysisFakePersistence: "0",
    }),
    expected: { provider: "real", finalization: "real", persistence: "real" },
  },
  {
    name: "loopback with provider 0 and finalization 1 stays all real",
    env: localEnv({
      analysisFakeProvider: "0",
      analysisFakeFinalization: "1",
    }),
    expected: { provider: "real", finalization: "real", persistence: "real" },
  },
];

describe("independent fake component flags", () => {
  it.each(flagCases)("$name", async ({ env, expected }) => {
    const {
      job,
      createProviderFn,
      createFinalizationFn,
      createBatchPersistenceFn,
    } = await selectComponents(env);

    expect(job.provider instanceof FakeAnalysisProvider).toBe(
      expected.provider === "fake",
    );
    expect(job.provider === realProvider).toBe(expected.provider === "real");
    expect(job.finalization === realFinalization).toBe(
      expected.finalization === "real",
    );
    expect("real" in job.finalization).toBe(
      expected.finalization === "real",
    );
    expect(job.persistence instanceof FakeAnalysisBatchPersistence).toBe(
      expected.persistence === "fake",
    );
    expect(job.persistence === realPersistence).toBe(
      expected.persistence === "real",
    );
    expect(createProviderFn).toHaveBeenCalledTimes(
      expected.provider === "real" ? 1 : 0,
    );
    expect(createFinalizationFn).toHaveBeenCalledTimes(
      expected.finalization === "real" ? 1 : 0,
    );
    expect(createBatchPersistenceFn).toHaveBeenCalledTimes(
      expected.persistence === "real" ? 1 : 0,
    );
  });

  it("does not instantiate the fake provider under hosted with findings overrides", async () => {
    const { job } = await selectComponents(
      localEnv({
        supabaseUrl: "https://abc.supabase.co",
        analysisFakeFinalization: "1",
        analysisFakePersistence: "1",
      }),
      {
        analysisId: "analysis-1",
        _fake: {
          findings: [
            {
              type: "contradiction",
              severity: "High",
              confidence: 0.9,
              explanation: "hosted must not honor fake findings",
              evidence: [],
            },
          ],
        },
      },
    );

    expect(job.provider).toBe(realProvider);
    expect(job.provider).not.toBeInstanceOf(FakeAnalysisProvider);
  });
});
