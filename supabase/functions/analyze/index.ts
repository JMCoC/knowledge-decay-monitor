import { createFinalization } from "../../../src/modules/analysis/worker/finalization.ts";
import type { AnalysisFinalization } from "../../../src/modules/analysis/worker/finalization.ts";
import {
  runAnalysisJob,
} from "../../../src/modules/analysis/worker/process-analysis.ts";
import type {
  RunAnalysisJobArgs,
  RunAnalysisJobResult,
} from "../../../src/modules/analysis/worker/process-analysis.ts";
import { createProvider } from "../../../src/modules/analysis/worker/provider.ts";
import { createBatchPersistence } from "../../../src/modules/analysis/worker/batch-persistence.ts";
import { reportAnalysisFailure } from "../../../src/modules/analysis/worker/telemetry.ts";
// Static import (not dynamic) so Deno bundles the test doubles: the
// edge runtime only preloads the static graph, and tests/ is outside
// its bundle root. The isLocalTestEnv gate below decides USE; without
// the gate these modules are loaded but never instantiated.
import {
  createFakeProvider,
  parseFakeBehaviorSafe,
} from "./_test_doubles/analysis-provider.fake.ts";
import { createTestFinalization } from "./_test_doubles/analysis-finalization.test-shim.ts";
import { FakeAnalysisBatchPersistence } from "./_test_doubles/analysis-batch-persistence.fake.ts";
import type { AIProvider } from "../../../src/modules/analysis/worker/types.ts";
import type {
  AnalysisBatchPersistence,
  AnalysisWorkerDb,
} from "../../../src/modules/analysis/worker/types.ts";

declare const Deno: {
  serve: (handler: (req: Request) => Promise<Response> | Response) => void;
  env: { get(key: string): string | undefined };
};

declare const EdgeRuntime: {
  waitUntil: (promise: Promise<unknown>) => void;
};

export interface AnalyzeEnv {
  analysisInternalToken: string | undefined;
  supabaseUrl: string | undefined;
  supabaseServiceRoleKey: string | undefined;
  analysisSupabaseUrl: string | undefined;
  analysisFakeProvider: string | undefined;
  analysisFakeLatencyMs: string | undefined;
  analysisFakeFailAtCallIndex: string | undefined;
  analysisFakeFailCode: string | undefined;
  analysisFakeThrowCode: string | undefined;
}

export interface AnalyzeHandlerDeps {
  createProviderFn: () => AIProvider;
  createFinalizationFn: () => AnalysisFinalization;
  createBatchPersistenceFn: (
    client: AnalysisWorkerDb,
  ) => AnalysisBatchPersistence;
  createClientFn: (env: AnalyzeEnv) => AnalysisWorkerDb;
  runJobFn: (args: RunAnalysisJobArgs) => Promise<RunAnalysisJobResult>;
  fetchFn: (input: string, init?: RequestInit) => Promise<Response>;
  waitUntilFn: (promise: Promise<unknown>) => void;
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function isAuthorized(request: Request, env: AnalyzeEnv): boolean {
  const expected = env.analysisInternalToken;
  if (typeof expected !== "string" || expected.length === 0) return false;
  return request.headers.get("authorization") === `Bearer ${expected}`;
}

/**
 * Test-only gate: the fake provider and the v1 test finalization load
 * only when BOTH hold: (a) ANALYSIS_FAKE_PROVIDER === "1" AND (b) the
 * harness-declared Supabase URL parses to a loopback hostname. The
 * platform reserves the SUPABASE_* prefix (env-file values are skipped),
 * so the gate reads the dedicated ANALYSIS_SUPABASE_URL instead of the
 * runtime-injected connectivity URL. Never compare against an exact
 * URL string; unparsable URLs fail closed.
 */
function isLoopback(url: string | undefined): boolean {
  try {
    const hostname = new URL(url ?? "").hostname.toLowerCase();
    return (
      hostname === "127.0.0.1" ||
      hostname === "localhost" ||
      hostname === "::1" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

function looksLikeHostedSupabase(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return (
      hostname.endsWith(".supabase.co") ||
      hostname.endsWith(".supabase.in")
    );
  } catch {
    return false;
  }
}

export function isLocalTestEnv(env: AnalyzeEnv): boolean {
  if (env.analysisFakeProvider !== "1") return false;
  if (!isLoopback(env.analysisSupabaseUrl)) return false;
  if (looksLikeHostedSupabase(env.supabaseUrl)) return false;
  return true;
}

interface AnalyzeRequestBody {
  analysisId: string | null;
  continuationBudget: number;
  fakeOverrides: unknown;
}

function parseAnalyzeRequestBody(body: unknown): AnalyzeRequestBody | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  const rawId = record["analysisId"];
  if (rawId !== undefined && (typeof rawId !== "string" || rawId.length === 0)) {
    return null;
  }
  const rawBudget = record["continuationBudget"];
  const continuationBudget = rawBudget === undefined ? 10 : rawBudget;
  if (
    typeof continuationBudget !== "number" ||
    !Number.isInteger(continuationBudget) ||
    continuationBudget < 0 ||
    continuationBudget > 10
  ) {
    return null;
  }
  return {
    analysisId: typeof rawId === "string" ? rawId : null,
    continuationBudget,
    fakeOverrides: record["_fake"],
  };
}

async function continueAcceptedWork(
  request: Request,
  env: AnalyzeEnv,
  deps: AnalyzeHandlerDeps,
  args: RunAnalysisJobArgs,
  continuationBudget: number,
): Promise<void> {
  let result: RunAnalysisJobResult;
  try {
    result = await deps.runJobFn(args);
  } catch {
    reportAnalysisFailure({
      module: "analysis",
      operation: "recover",
      code: "INTERNAL_ERROR",
      ...(args.analysisId ? { analysis_id: args.analysisId } : {}),
    });
    return;
  }
  if (result.kind !== "has-more" || continuationBudget <= 0) return;
  try {
    await deps.fetchFn(request.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.analysisInternalToken ?? ""}`,
      },
      body: JSON.stringify({
        analysisId: result.claimedId,
        continuationBudget: continuationBudget - 1,
      }),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // Durable queued work remains available to the recovery sweep.
  }
}

/**
 * Analysis worker HTTP entrypoint. A 202 acknowledges only that the
 * background task was registered; it does not promise a claim or result.
 * Readiness is checked before the task may claim a job.
 */
export async function handleAnalyzeRequest(
  request: Request,
  env: AnalyzeEnv,
  deps: AnalyzeHandlerDeps,
): Promise<Response> {
  if (request.method !== "POST") {
    return json(405, { error: "method not allowed" });
  }
  if (!isAuthorized(request, env)) {
    return json(401, { error: "unauthorized" });
  }
  let body: AnalyzeRequestBody | null = null;
  try {
    body = parseAnalyzeRequestBody(await request.json());
  } catch {
    body = null;
  }
  if (body === null) {
    return json(400, { error: "invalid request" });
  }

  let provider: AIProvider;
  let finalization: AnalysisFinalization;
  let persistence: AnalysisBatchPersistence;
  let client: AnalysisWorkerDb;
  try {
    client = deps.createClientFn(env);
    if (isLocalTestEnv(env)) {
      provider = createFakeProvider(
        env,
        parseFakeBehaviorSafe(body.fakeOverrides),
      );
      finalization = createTestFinalization(client);
      persistence = new FakeAnalysisBatchPersistence(client);
    } else {
      provider = deps.createProviderFn();
      finalization = deps.createFinalizationFn();
      persistence = deps.createBatchPersistenceFn(client);
    }
  } catch {
    reportAnalysisFailure({
      module: "analysis",
      operation: "recover",
      code: "INTERNAL_ERROR",
    });
    return json(503, { error: "not ready" });
  }

  const jobArgs: RunAnalysisJobArgs = {
    client,
    provider,
    finalization,
    persistence,
    analysisId: body.analysisId,
  };
  let registered = false;
  const work = Promise.resolve().then(() =>
    registered
      ? continueAcceptedWork(
          request,
          env,
          deps,
          jobArgs,
          body.continuationBudget,
        )
      : undefined,
  );
  try {
    deps.waitUntilFn(work);
    registered = true;
  } catch {
    reportAnalysisFailure({
      module: "analysis",
      operation: "recover",
      code: "INTERNAL_ERROR",
    });
    return json(503, { error: "not ready" });
  }
  return json(202, { ok: true, accepted: true });
}

// S2-05 uses a dedicated analysis token, separate from INGESTION_INTERNAL_TOKEN.
if (typeof Deno !== "undefined" && typeof Deno.serve === "function") {
  Deno.serve(async (req: Request): Promise<Response> => {
    // @ts-expect-error TS2307 — Deno npm: specifier; tsc cannot resolve it. Executes only in Edge.
    const { createClient } = await import("npm:@supabase/supabase-js");
    const env: AnalyzeEnv = {
      analysisInternalToken: Deno.env.get("ANALYSIS_INTERNAL_TOKEN"),
      supabaseUrl:
        Deno.env.get("SUPABASE_URL") ??
        Deno.env.get("ANALYSIS_SUPABASE_URL"),
      supabaseServiceRoleKey:
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
        Deno.env.get("ANALYSIS_SUPABASE_SERVICE_ROLE_KEY"),
      analysisSupabaseUrl: Deno.env.get("ANALYSIS_SUPABASE_URL"),
      analysisFakeProvider: Deno.env.get("ANALYSIS_FAKE_PROVIDER"),
      analysisFakeLatencyMs: Deno.env.get("ANALYSIS_FAKE_LATENCY_MS"),
      analysisFakeFailAtCallIndex: Deno.env.get("ANALYSIS_FAKE_FAIL_AT_CALL_INDEX"),
      analysisFakeFailCode: Deno.env.get("ANALYSIS_FAKE_FAIL_CODE"),
      analysisFakeThrowCode: Deno.env.get("ANALYSIS_FAKE_THROW_CODE"),
    };
    return handleAnalyzeRequest(
      req,
      env,
      {
        createProviderFn: createProvider,
        createFinalizationFn: createFinalization,
        createClientFn: (e) =>
          createClient(
            e.supabaseUrl ?? "",
            e.supabaseServiceRoleKey ?? "",
          ) as unknown as AnalysisWorkerDb,
        runJobFn: (args) => runAnalysisJob(args),
        createBatchPersistenceFn: (db) => createBatchPersistence(db),
        fetchFn: (input, init) => fetch(input, init),
        waitUntilFn: (promise) => EdgeRuntime.waitUntil(promise),
      },
    );
  });
}
