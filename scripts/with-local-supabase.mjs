import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { LOCAL_API_URL, PROJECT_ROOT, readLocalSupabaseRuntime } from "./local-supabase.mjs";

const commands = {
  integration: [resolve(PROJECT_ROOT, "node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.integration.config.ts"],
  e2e: [resolve(PROJECT_ROOT, "node_modules/@playwright/test/cli.js"), "test", "--config", "playwright.config.ts"],
  build: [resolve(PROJECT_ROOT, "node_modules/next/dist/bin/next"), "build"],
};

const selected = process.argv[2];
if (!Object.hasOwn(commands, selected)) {
  console.error("Usage: node scripts/with-local-supabase.mjs <integration|e2e|build>");
  process.exit(2);
}

let runtime;
try {
  runtime = readLocalSupabaseRuntime();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Local Supabase preflight failed.");
  process.exit(1);
}

if (selected !== "build" && (typeof runtime.serviceRoleKey !== "string" || !runtime.serviceRoleKey)) {
  console.error("Local Supabase service role is unavailable for server-side tests.");
  process.exit(1);
}

const [script, ...args] = commands[selected];
const forwardedArgs = process.argv.slice(3);
const childEnv = {
  ...process.env,
  NEXT_PUBLIC_SUPABASE_URL: LOCAL_API_URL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: runtime.publishableKey,
  KDM_LOCAL_SUPABASE_URL: LOCAL_API_URL,
  KDM_MAILPIT_URL: runtime.mailpitUrl,
  SENTRY_DSN: "",
  SENTRY_AUTH_TOKEN: "",
  SENTRY_DISABLE_AUTO_UPLOAD: "true",
  NEXT_PUBLIC_SENTRY_DSN: "",
  NEXT_PUBLIC_KDM_DISABLE_SENTRY: "1",
  KDM_DISABLE_SENTRY: "1",
};
if (selected === "build") {
  delete childEnv.SUPABASE_SERVICE_ROLE_KEY;
} else {
  childEnv.SUPABASE_SERVICE_ROLE_KEY = runtime.serviceRoleKey;
}

const result = spawnSync(process.execPath, [script, ...args, ...forwardedArgs], {
  cwd: PROJECT_ROOT,
  env: childEnv,
  stdio: "inherit",
  windowsHide: true,
});

if (result.error) {
  console.error("Could not start the requested local test command.");
  process.exit(1);
}
process.exit(result.status ?? 1);
