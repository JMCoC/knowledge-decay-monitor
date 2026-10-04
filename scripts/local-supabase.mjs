import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
export const LOCAL_API_URL = "http://127.0.0.1:54321";
export const LOCAL_APP_ORIGIN = "http://127.0.0.1:3000";
export const LOCAL_MAILPIT_URL = "http://127.0.0.1:54324";

function isLoopback(url) {
  return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname);
}

export function readLocalSupabaseRuntime() {
  if (!existsSync(resolve(PROJECT_ROOT, "supabase/config.toml"))) {
    throw new Error("Run this command from the Knowledge Decay Monitor project.");
  }

  let status;
  try {
    const output = execFileSync(
      process.execPath,
      [resolve(PROJECT_ROOT, "node_modules/supabase/dist/supabase.js"), "status", "-o", "json"],
      { cwd: PROJECT_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    status = JSON.parse(output);
  } catch {
    throw new Error("Local Supabase is unavailable. Start the project stack first.");
  }

  const publishableKey = status.PUBLISHABLE_KEY ?? status.ANON_KEY;
  const serviceRoleKey = status.SERVICE_ROLE_KEY;
  const mailpitUrl = status.MAILPIT_URL ?? status.INBUCKET_URL;
  let parsedMailpitUrl;
  try {
    parsedMailpitUrl = new URL(mailpitUrl);
  } catch {
    throw new Error("Local Mailpit status is unavailable.");
  }

  if (status.API_URL !== LOCAL_API_URL) {
    throw new Error("Refusing to run Auth tests: Supabase API is not the expected local URL.");
  }
  if (!isLoopback(parsedMailpitUrl) || parsedMailpitUrl.port !== "54324") {
    throw new Error("Refusing to use a non-local Mailpit endpoint.");
  }
  if (typeof publishableKey !== "string" || !publishableKey) {
    throw new Error("Local Supabase publishable key is unavailable.");
  }

  return {
    apiUrl: LOCAL_API_URL,
    publishableKey,
    serviceRoleKey,
    mailpitUrl: LOCAL_MAILPIT_URL,
  };
}

export function runLocalSupabaseLifecycle(command) {
  if (command !== "start" && command !== "stop") {
    throw new Error("Only the current local Supabase start/stop commands are permitted.");
  }
  try {
    execFileSync(
      process.execPath,
      [resolve(PROJECT_ROOT, "node_modules/supabase/dist/supabase.js"), command],
      { cwd: PROJECT_ROOT, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
  } catch {
    throw new Error(`Supabase local ${command} failed. CLI output was suppressed to protect keys.`);
  }
}
