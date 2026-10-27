import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DEFAULT_PORT = 54321;

export interface EdgeFakeProviderOptions {
  latencyMs?: number;
  failAtCallIndex?: number;
  failCode?: string;
  throwCode?: string;
}

export interface StartAnalysisEdgeOptions {
  token: string;
  supabaseUrl: string;
  serviceRoleKey: string;
  fakeProvider?: EdgeFakeProviderOptions;
  analysisFakeFinalization?: string;
  analysisFakePersistence?: string;
  port?: number;
  readinessTimeoutMs?: number;
}

export interface AnalysisEdgeHandle {
  baseUrl: string;
  token: string;
  stop: (opts?: { force?: boolean }) => Promise<void>;
  diagnostics: () => string;
}

const EDGE_RUNTIME_CONTAINER =
  "supabase_edge_runtime_knowledge-decay-monitor-s1-02";

/**
 * Kills ONLY the Edge worker container (simulates a worker crash).
 * Unlike removing it, killing leaves the container record so the next
 * serve restarts cleanly. Local-only; never used outside tests.
 */
export async function killEdgeWorkerContainer(): Promise<void> {
  const { execFileSync } = await import("node:child_process");
  try {
    execFileSync("docker", ["kill", EDGE_RUNTIME_CONTAINER], {
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
  } catch {
    throw new Error("Local Edge worker container is not running.");
  }
}

function definedEnv(value: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Serves the real analysis Edge Function locally with an explicit child
 * environment. Follows tests/support/ingestion-worker.ts (spawn +
 * readiness poll + SIGTERM/SIGKILL) with two deliberate differences:
 * worker env travels via --env-file (the serve process does not forward
 * its OS environment into Edge workers — verified: spawn env alone
 * yields 401 on a fresh token) and INGESTION_INTERNAL_TOKEN is never
 * inherited anywhere. Tokens and keys are never logged.
 */
export async function startAnalysisEdge(
  opts: StartAnalysisEdgeOptions,
): Promise<AnalysisEdgeHandle> {
  const port = opts.port ?? DEFAULT_PORT;
  const readinessTimeoutMs = opts.readinessTimeoutMs ?? 30_000;
  const baseUrl = `http://127.0.0.1:${port}/functions/v1/analyze`;

  const scratchDir = mkdtempSync(join(tmpdir(), "kdm-edge-"));
  const envFile = join(scratchDir, "analyze.env");
  const workerEnv: string[] = [
    `ANALYSIS_SUPABASE_URL=${opts.supabaseUrl}`,
    `ANALYSIS_SUPABASE_SERVICE_ROLE_KEY=${opts.serviceRoleKey}`,
    `ANALYSIS_INTERNAL_TOKEN=${opts.token}`,
  ];
  if (opts.fakeProvider !== undefined) {
    workerEnv.push("ANALYSIS_FAKE_PROVIDER=1");
    const latency = definedEnv(opts.fakeProvider.latencyMs?.toString());
    const failAtCallIndex = definedEnv(
      opts.fakeProvider.failAtCallIndex?.toString(),
    );
    if (latency !== undefined) {
      workerEnv.push(`ANALYSIS_FAKE_LATENCY_MS=${latency}`);
    }
    if (failAtCallIndex !== undefined) {
      workerEnv.push(`ANALYSIS_FAKE_FAIL_AT_CALL_INDEX=${failAtCallIndex}`);
    }
    if (opts.fakeProvider.failCode !== undefined) {
      workerEnv.push(`ANALYSIS_FAKE_FAIL_CODE=${opts.fakeProvider.failCode}`);
    }
    if (opts.fakeProvider.throwCode !== undefined) {
      workerEnv.push(
        `ANALYSIS_FAKE_THROW_CODE=${opts.fakeProvider.throwCode}`,
      );
    }
  }
  if (opts.analysisFakeFinalization !== undefined) {
    workerEnv.push(
      `ANALYSIS_FAKE_FINALIZATION=${opts.analysisFakeFinalization}`,
    );
  }
  if (opts.analysisFakePersistence !== undefined) {
    workerEnv.push(
      `ANALYSIS_FAKE_PERSISTENCE=${opts.analysisFakePersistence}`,
    );
  }
  writeFileSync(envFile, `${workerEnv.join("\n")}\n`);

  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv["INGESTION_INTERNAL_TOKEN"];
  delete childEnv["SUPABASE_URL"];
  delete childEnv["SUPABASE_SERVICE_ROLE_KEY"];
  delete childEnv["SUPABASE_ANON_KEY"];
  delete childEnv["ANALYSIS_INTERNAL_TOKEN"];
  delete childEnv["ANALYSIS_SUPABASE_URL"];
  delete childEnv["ANALYSIS_SUPABASE_SERVICE_ROLE_KEY"];
  delete childEnv["ANALYSIS_FAKE_PROVIDER"];
  delete childEnv["ANALYSIS_FAKE_FINALIZATION"];
  delete childEnv["ANALYSIS_FAKE_PERSISTENCE"];
  delete childEnv["ANALYSIS_FAKE_LATENCY_MS"];
  delete childEnv["ANALYSIS_FAKE_FAIL_AT_CALL_INDEX"];
  delete childEnv["ANALYSIS_FAKE_FAIL_CODE"];
  delete childEnv["ANALYSIS_FAKE_THROW_CODE"];

  let child: ChildProcess | undefined;
  const stderrTail: string[] = [];
  const stdoutTail: string[] = [];
  const recordOutput = (target: string[], chunk: Buffer) => {
    target.push(...chunk.toString("utf8").split(/\r?\n/).filter(Boolean));
    while (target.join("\n").length > 4000) target.shift();
  };
  const diagnostics = () => {
    const relevant = [...stdoutTail, ...stderrTail]
      .filter((line) => /error|exception|panic|failed|warning/i.test(line))
      .join("\n")
      .replaceAll(opts.token, "[redacted]")
      .replaceAll(opts.serviceRoleKey, "[redacted]")
      .replace(/eyJ[A-Za-z0-9._-]{20,}/g, "[redacted-token]")
      .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "[uuid]")
      .slice(-2000);
    return relevant || "(no runtime error output)";
  };
  const stop = async (stopOpts?: { force?: boolean }) => {
    try {
      if (
        child &&
        child.exitCode === null &&
        child.signalCode === null
      ) {
        const exited = new Promise<void>((resolveExit) =>
          child!.once("exit", () => resolveExit()),
        );
        child.kill(stopOpts?.force === true ? "SIGKILL" : "SIGTERM");
        await Promise.race([
          exited,
          new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
        ]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await Promise.race([
        exited,
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
      }
    } finally {
      child = undefined;
      rmSync(scratchDir, { recursive: true, force: true });
    }
  };

  child = spawn(
    process.execPath,
    [
      resolve(process.cwd(), "node_modules/supabase/dist/supabase.js"),
      "functions",
      "serve",
      "analyze",
      "--no-verify-jwt",
      "--env-file",
      envFile,
    ],
    {
      cwd: process.cwd(),
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  child.on("error", () => undefined);
  child.stdout?.on("data", (chunk: Buffer) => recordOutput(stdoutTail, chunk));
  child.stderr?.on("data", (chunk: Buffer) => recordOutput(stderrTail, chunk));
  const deadline = Date.now() + readinessTimeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      const tail = stderrTail.join("").slice(-2000);
      await stop();
      throw new Error(
        `Local analysis Edge exited before readiness. Tail: ${tail}`,
      );
    }
    try {
      // Fake-worker readiness uses a valid token plus a deliberately invalid
      // UUID. The handler acknowledges it, while PostgREST rejects claim before
      // the SQL sweep fallback can select a fixture job. For a production-seam
      // worker, a valid random UUID reaches factories that return 503 before
      // any claim; both probes distinguish Edge from a gateway auth response.
      const productionSeamProbe = opts.fakeProvider === undefined;
      const response = await fetch(baseUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${opts.token}`,
        },
        body: JSON.stringify(
          productionSeamProbe
            ? { analysisId: randomUUID() }
            : { analysisId: "invalid-local-readiness-id" },
        ),
        signal: AbortSignal.timeout(1_000),
      });
      const responseBody = await response.text().catch(() => "");
      const isHandlerAccepted =
        response.status === 202 && responseBody === '{"ok":true,"accepted":true}';
      if (
        (productionSeamProbe && response.status === 503) ||
        (!productionSeamProbe && isHandlerAccepted)
      ) {
        return { baseUrl, token: opts.token, stop, diagnostics };
      }
    } catch {
      // Wait for the Edge runtime to bind.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const tail = stderrTail.join("").slice(-2000);
  await stop();
  throw new Error(`Local analysis Edge readiness timed out. Tail: ${tail}`);
}

export async function startEdgeConFake(
  opts: {
    latencyMs?: number;
    failAtCallIndex?: number;
    failCode?: string;
    analysisFakeFinalization?: string;
    analysisFakePersistence?: string;
    token?: string;
  } = {},
): Promise<AnalysisEdgeHandle> {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl = process.env.KDM_LOCAL_SUPABASE_URL;
  if (
    supabaseUrl !== `http://127.0.0.1:${DEFAULT_PORT}` ||
    typeof serviceRoleKey !== "string" ||
    serviceRoleKey.length === 0
  ) {
    throw new Error("Local Supabase service test configuration is missing.");
  }
  return startAnalysisEdge({
    token: opts.token ?? randomUUID(),
    supabaseUrl,
    serviceRoleKey,
    fakeProvider: {
      latencyMs: opts.latencyMs,
      ...(opts.failAtCallIndex !== undefined
        ? { failAtCallIndex: opts.failAtCallIndex }
        : {}),
      ...(opts.failCode !== undefined ? { failCode: opts.failCode } : {}),
    },
    ...(opts.analysisFakeFinalization !== undefined
      ? { analysisFakeFinalization: opts.analysisFakeFinalization }
      : {}),
    ...(opts.analysisFakePersistence !== undefined
      ? { analysisFakePersistence: opts.analysisFakePersistence }
      : {}),
  });
}
