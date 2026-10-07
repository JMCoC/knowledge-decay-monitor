import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { LOCAL_API_URL, PROJECT_ROOT, readLocalSupabaseRuntime } from "./local-supabase.mjs";

const commands = {
  integration: [resolve(PROJECT_ROOT, "node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.integration.config.ts"],
  e2e: [resolve(PROJECT_ROOT, "node_modules/@playwright/test/cli.js"), "test", "--config", "playwright.config.ts"],
  build: [resolve(PROJECT_ROOT, "node_modules/next/dist/bin/next"), "build"],
};

/**
 * @param {object} options
 * @param {string} [options.selected]
 * @param {string[]} [options.forwardedArgs]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {typeof readLocalSupabaseRuntime} [options.runtimeReader]
 * @param {typeof spawnSync} [options.spawnCommand]
 * @param {(message: string) => void} [options.logError]
 */
export function runWithLocalSupabase({
  selected = process.argv[2],
  forwardedArgs = process.argv.slice(3),
  env = process.env,
  runtimeReader = readLocalSupabaseRuntime,
  spawnCommand = spawnSync,
  logError = console.error,
} = {}) {
  if (!Object.hasOwn(commands, selected)) {
    logError("Usage: node scripts/with-local-supabase.mjs <integration|e2e|build>");
    return 2;
  }

  let runtime;
  try {
    runtime = runtimeReader();
  } catch (error) {
    logError(error instanceof Error ? error.message : "Local Supabase preflight failed.");
    return 1;
  }

  if (selected !== "build" && (typeof runtime.serviceRoleKey !== "string" || !runtime.serviceRoleKey)) {
    logError("Local Supabase service role is unavailable for server-side tests.");
    return 1;
  }

  const [script, ...args] = commands[selected];
  const childEnv = {
    ...env,
    NEXT_PUBLIC_SUPABASE_URL: LOCAL_API_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: runtime.publishableKey,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
    KDM_LOCAL_SUPABASE_URL: LOCAL_API_URL,
    KDM_MAILPIT_URL: runtime.mailpitUrl,
    SUPABASE_URL: "",
    SUPABASE_PUBLISHABLE_KEY: "",
    SUPABASE_ANON_KEY: "",
    SENTRY_DSN: "",
    SENTRY_AUTH_TOKEN: "",
    SENTRY_DISABLE_AUTO_UPLOAD: "true",
    NEXT_PUBLIC_SENTRY_DSN: "",
    NEXT_PUBLIC_KDM_DISABLE_SENTRY: "1",
    KDM_DISABLE_SENTRY: "1",
    NEXT_PUBLIC_KDM_SENTRY_LOCAL_ENABLED: "0",
    KDM_SENTRY_DIAGNOSTICS_ENABLED: "0",
    KDM_SENTRY_DIAGNOSTICS_OPERATOR_IDS: "",
    KDM_SENTRY_DIAGNOSTICS_EXPIRES_AT: "",
  };
  if (selected === "e2e") {
    // The test web server uses the same one-run local token for internal ingestion dispatch.
    childEnv.INGESTION_INTERNAL_TOKEN = randomBytes(32).toString("hex");
  }
  delete childEnv.SUPABASE_SECRET_KEY;
  if (selected === "build") {
    delete childEnv.SUPABASE_SERVICE_ROLE_KEY;
  } else {
    childEnv.SUPABASE_SERVICE_ROLE_KEY = runtime.serviceRoleKey;
  }

  const result = spawnCommand(process.execPath, [script, ...args, ...forwardedArgs], {
    cwd: PROJECT_ROOT,
    env: /** @type {NodeJS.ProcessEnv} */ (childEnv),
    stdio: "inherit",
    windowsHide: true,
  });

  if (result.error) {
    logError("Could not start the requested local test command.");
    return 1;
  }
  return result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runWithLocalSupabase();
}
