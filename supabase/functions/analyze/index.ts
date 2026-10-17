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
import type { AIProvider } from "../../../src/modules/analysis/worker/types.ts";
import type { AnalysisWorkerDb } from "../../../src/modules/analysis/worker/types.ts";

declare const Deno: {
  serve: (handler: (req: Request) => Promise<Response> | Response) => void;
  env: { get(key: string): string | undefined };
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
  createClientFn: (env: AnalyzeEnv) => AnalysisWorkerDb;
  runJobFn: (args: RunAnalysisJobArgs) => Promise<RunAnalysisJobResult>;
  fetchFn: (input: string, init?: RequestInit) => Promise<Response>;
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

/**
 * Analysis worker HTTP entrypoint (spec §4.1, §11 G2). Order: method →
 * token → body → readiness (factories only, no client, no claim) →
 * client → single batch → mapped response. Self-fetch continues to
 * the next batch fire-and-forget (spec §4.2); the sweep reclaims
 * anything this invocation leaves behind. Never logs tokens, bodies
 * or document content.
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
  let analysisId: string | null = null;
  let fakeOverrides: unknown = undefined;
  try {
    const body: unknown = await request.json();
    if (typeof body === "object" && body !== null) {
      const record = body as Record<string, unknown>;
      const candidate = record["analysisId"];
      if (typeof candidate === "string" && candidate.length > 0) {
        analysisId = candidate;
      }
      // Test-only per-request fake behavior. Honored only when the
      // isLocalTestEnv gate below is open; ignored otherwise.
      fakeOverrides = record["_fake"];
    }
  } catch {
    analysisId = null;
  }
  if (analysisId === null) {
    return json(400, { error: "invalid analysisId" });
  }

  let provider: AIProvider;
  let finalization: AnalysisFinalization;
  let client: AnalysisWorkerDb;
  try {
    client = deps.createClientFn(env);
  } catch {
    reportAnalysisFailure({
      module: "analysis",
      operation: "recover",
      code: "INTERNAL_ERROR",
    });
    return json(503, { error: "not ready" });
  }

  if (isLocalTestEnv(env)) {
    provider = createFakeProvider(
      env,
      parseFakeBehaviorSafe(fakeOverrides),
    );
    finalization = createTestFinalization(client);
  } else {
    try {
      provider = deps.createProviderFn();
      finalization = deps.createFinalizationFn();
    } catch {
      reportAnalysisFailure({
        module: "analysis",
        operation: "recover",
        code: "INTERNAL_ERROR",
      });
      return json(503, { error: "not ready" });
    }
  }

  let result: RunAnalysisJobResult;
  try {
    result = await deps.runJobFn({
      client,
      provider,
      finalization,
      analysisId,
    });
  } catch {
    reportAnalysisFailure({
      module: "analysis",
      operation: "recover",
      code: "INTERNAL_ERROR",
      analysis_id: analysisId,
    });
    return json(500, { error: "internal" });
  }

  if (result.kind === "has-more") {
    // NOTE: self-fetch chains the CLAIMED job, never the caller payload:
    // a directed claim may fall back to the FIFO sweep (§4.2/§5.1) and
    // chaining the payload id could strand another job mid-batches.
    // The response reports the claimed id for coherence.
    const continued = { analysisId: result.claimedId };
    void deps
      .fetchFn(request.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${env.analysisInternalToken ?? ""}`,
        },
        body: JSON.stringify(continued),
        signal: AbortSignal.timeout(2000),
      })
      .catch(() => {});
    return json(202, {
      ok: true,
      analysisId,
      claimedId: result.claimedId,
      continued: true,
    });
  }
  if (result.kind === "failed") {
    return json(200, {
      ok: true,
      analysisId,
      claimedId: result.claimedId,
      final: false,
      code: result.code,
    });
  }
  if (result.kind === "aborted") {
    return json(200, {
      ok: true,
      analysisId,
      claimedId: result.claimedId,
      final: false,
      aborted: true,
    });
  }
  if (result.kind === "idle") {
    return json(200, { ok: true, analysisId, claimed: false });
  }
  return json(200, {
    ok: true,
    analysisId,
    claimedId: result.claimedId,
    final: true,
  });
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
        fetchFn: (input, init) => fetch(input, init),
      },
    );
  });
}
