import { execFileSync, spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOCAL_API_URL,
  PROJECT_ROOT,
  readLocalSupabaseRuntime,
} from "./local-supabase.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
const MAX_DIAGNOSTIC_WINDOW_MS = 60 * 60 * 1000;

function isValidUtcTimestamp(value, nowMs) {
  if (typeof value !== "string") return false;
  const parts = UTC_TIMESTAMP_PATTERN.exec(value);
  if (!parts) return false;

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= nowMs || timestamp - nowMs > MAX_DIAGNOSTIC_WINDOW_MS) {
    return false;
  }

  const date = new Date(timestamp);
  return (
    date.getUTCFullYear() === Number(parts[1]) &&
    date.getUTCMonth() + 1 === Number(parts[2]) &&
    date.getUTCDate() === Number(parts[3]) &&
    date.getUTCHours() === Number(parts[4]) &&
    date.getUTCMinutes() === Number(parts[5]) &&
    date.getUTCSeconds() === Number(parts[6])
  );
}

function validateDiagnosticEnvironment(env, nowMs) {
  const operatorIds = env.KDM_SENTRY_DIAGNOSTICS_OPERATOR_IDS
    ?.split(",")
    .map((id) => id.trim());
  if (
    env.KDM_SENTRY_DIAGNOSTICS_ENABLED !== "1" ||
    !operatorIds?.length ||
    !operatorIds.every((id) => UUID_PATTERN.test(id)) ||
    !isValidUtcTimestamp(env.KDM_SENTRY_DIAGNOSTICS_EXPIRES_AT, nowMs)
  ) {
    throw new Error("Local Sentry diagnostics require an operator allowlist and a UTC expiry within one hour.");
  }
}

function validateLocalRuntime(runtime) {
  if (
    runtime?.apiUrl !== LOCAL_API_URL ||
    typeof runtime?.publishableKey !== "string" ||
    !runtime.publishableKey
  ) {
    throw new Error("Refusing to run diagnostics against a non-local Supabase project.");
  }
}

/**
 * @param {object} options
 * @param {Record<string, string | undefined>} [options.env]
 * @param {number} [options.nowMs]
 * @param {typeof readLocalSupabaseRuntime} [options.runtimeReader]
 * @param {typeof execFileSync} [options.commandRunner]
 * @param {typeof spawn} [options.spawnProcess]
 */
export function runSentryLocalSmoke({
  env = process.env,
  nowMs = Date.now(),
  runtimeReader = readLocalSupabaseRuntime,
  commandRunner = execFileSync,
  spawnProcess = spawn,
} = {}) {
  let runtime;
  try {
    runtime = runtimeReader();
  } catch {
    throw new Error("Local Supabase is unavailable. Start the project stack first.");
  }
  validateLocalRuntime(runtime);
  validateDiagnosticEnvironment(env, nowMs);

  let revision;
  let workingTree;
  try {
    revision = commandRunner("git", ["rev-parse", "HEAD"], {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }).trim();
    workingTree = commandRunner("git", ["status", "--porcelain"], {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    throw new Error("Unable to read local release metadata.");
  }

  if (!/^[0-9a-f]{40}$/i.test(revision)) {
    throw new Error("Unable to read a valid local release SHA.");
  }

  const release = `${revision.toLowerCase()}${workingTree.trim() ? "-dirty" : ""}`;
  const childEnv = {
    ...env,
    NEXT_PUBLIC_SUPABASE_URL: LOCAL_API_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: runtime.publishableKey,
    KDM_LOCAL_SUPABASE_URL: LOCAL_API_URL,
    NEXT_PUBLIC_KDM_SENTRY_TARGET: "development",
    NEXT_PUBLIC_KDM_RELEASE: release,
    NEXT_PUBLIC_KDM_SENTRY_LOCAL_ENABLED: "1",
  };
  if (typeof runtime.serviceRoleKey === "string" && runtime.serviceRoleKey) {
    childEnv.SUPABASE_SERVICE_ROLE_KEY = runtime.serviceRoleKey;
  } else {
    delete childEnv.SUPABASE_SERVICE_ROLE_KEY;
  }
  delete childEnv.SUPABASE_SECRET_KEY;

  const nextCli = resolve(PROJECT_ROOT, "node_modules/next/dist/bin/next");
  const child = spawnProcess(
    process.execPath,
    [nextCli, "dev", "--hostname", "127.0.0.1", "--port", "3000"],
    {
      cwd: PROJECT_ROOT,
      env: /** @type {NodeJS.ProcessEnv} */ (childEnv),
      stdio: "inherit",
      windowsHide: true,
      shell: false,
    },
  );

  child.on("error", () => {
    console.error("Could not start the local Sentry diagnostics server.");
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = typeof code === "number" ? code : 1;
  });
  return child;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runSentryLocalSmoke();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Local Sentry diagnostics could not start.");
    process.exitCode = 1;
  }
}
