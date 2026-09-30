import { execFileSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database";

const LOCAL_API_URL = "http://127.0.0.1:54321";
const LOCAL_PROJECT_ID = "knowledge-decay-monitor";

function localClient() {
  const url = process.env.KDM_LOCAL_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (url !== LOCAL_API_URL || !key) {
    throw new Error("Local Supabase test environment is missing or has the wrong API URL.");
  }
  return createClient<Database>(url, key, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}

function localJwtSecret() {
  let status: { API_URL?: string; JWT_SECRET?: string };
  try {
    const output = execFileSync(
      process.execPath,
      [resolve(process.cwd(), "node_modules/supabase/dist/supabase.js"), "status", "-o", "json"],
      { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    status = JSON.parse(output) as { API_URL?: string; JWT_SECRET?: string };
  } catch {
    throw new Error("Could not read the local-only JWT signing fixture.");
  }
  if (status.API_URL !== LOCAL_API_URL || !status.JWT_SECRET) {
    throw new Error("Refusing to sign a test token without the expected local Auth configuration.");
  }
  return status.JWT_SECRET;
}

export function expiredSignedAccessToken(accessToken: string) {
  const [, encodedPayload, signature] = accessToken.split(".");
  if (!encodedPayload || !signature) throw new Error("The local Auth session did not contain a JWT.");
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("The local Auth session JWT could not be decoded.");
  }
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const expiredPayload = Buffer.from(
    JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) - 60 }),
  ).toString("base64url");
  const unsigned = `${header}.${expiredPayload}`;
  const expiredSignature = createHmac("sha256", localJwtSecret()).update(unsigned).digest("base64url");
  return `${unsigned}.${expiredSignature}`;
}

export async function assertLocalSupabaseReady() {
  const url = process.env.KDM_LOCAL_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (url !== LOCAL_API_URL || !key) {
    throw new Error("Local Supabase test environment is missing or has the wrong API URL.");
  }
  let response: Response;
  try {
    response = await fetch(`${LOCAL_API_URL}/auth/v1/settings`, {
      headers: { apikey: key },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new Error("Local Supabase Auth did not respond at the expected loopback URL.");
  }
  if (!response.ok) throw new Error("Local Supabase Auth readiness check failed.");
}

export async function newLocalUser(): Promise<{
  client: ReturnType<typeof localClient>;
  userId: string;
  email: string;
  password: string;
}> {
  const client = localClient();
  const suffix = randomUUID();
  const email = `kdm-${suffix}@example.test`;
  const password = `Kdm-${randomUUID()}`;
  const { data, error } = await client.auth.signUp({ email, password });
  if (error || !data.user || !data.session) {
    const safeCodes = new Set([
      "email_not_confirmed",
      "email_rate_limit_exceeded",
      "invalid_credentials",
      "over_email_send_rate_limit",
      "over_request_rate_limit",
      "signup_disabled",
      "user_already_exists",
      "user_banned",
      "validation_failed",
    ]);
    const rawCode = error?.code;
    const code = typeof rawCode === "string" && safeCodes.has(rawCode) ? rawCode : error ? "other" : "none";
    const status = typeof error?.status === "number" ? error.status : "none";
    throw new Error(
      `Local Auth signup returned no session (status=${status}, code=${code}, user=${Boolean(data.user)}, session=${Boolean(data.session)}).`,
    );
  }
  return { client, userId: data.user.id, email, password };
}

function localDatabaseContainer() {
  let names: string;
  try {
    names = execFileSync(
      "docker",
      ["ps", "--filter", `name=supabase_db_${LOCAL_PROJECT_ID}`, "--format", "{{.Names}}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    ).trim();
  } catch {
    throw new Error("The local Supabase database container is unavailable.");
  }
  const matches = names.split(/\r?\n/).filter((name) => name === `supabase_db_${LOCAL_PROJECT_ID}`);
  if (matches.length !== 1) throw new Error("Expected exactly one local project database container.");
  return matches[0];
}

function runLocalSql(sql: string, variables: Record<string, string>) {
  const args = ["exec", "-i", localDatabaseContainer(), "psql", "-XAt", "-F", "|", "-U", "postgres", "-d", "postgres"];
  for (const [name, value] of Object.entries(variables)) args.push("-v", `${name}=${value}`);
  try {
    return execFileSync("docker", args, {
      input: sql,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }).trim();
  } catch {
    throw new Error("Local database observation failed; SQL output was suppressed.");
  }
}

export function bootstrapCounts(workspaceName: string) {
  if (!/^kdm-[a-z0-9-]+$/.test(workspaceName)) {
    throw new Error("Refusing to query outside the generated local test marker.");
  }
  const sql = [
    "SELECT",
    "(SELECT count(*) FROM public.workspaces w WHERE w.name = :'marker')::text || '|' ||",
    "(SELECT count(*) FROM public.profiles p JOIN public.workspaces w ON w.id = p.workspace_id WHERE w.name = :'marker')::text || '|' ||",
    "(SELECT count(*) FROM public.profiles p JOIN public.workspaces w ON w.id = p.workspace_id WHERE w.name = :'marker' AND p.role = 'Admin')::text;",
  ].join(" ");
  const [workspaceCount, profileCount, adminCount] = runLocalSql(sql, { marker: workspaceName })
    .split("|")
    .map(Number);
  return { workspaceCount, profileCount, adminCount };
}

export async function ownWorkspaceId(client: ReturnType<typeof localClient>, userId: string) {
  const { data, error } = await client
    .from("profiles")
    .select("workspace_id")
    .eq("id", userId)
    .maybeSingle();
  if (error || !data) throw new Error("The authenticated local user has no visible Profile.");
  return data.workspace_id;
}

export function insertMemberProfile(input: {
  userId: string;
  workspaceId: string;
  fullName: string;
  email: string;
}) {
  const sql = "INSERT INTO public.profiles (id, workspace_id, role, full_name, email) VALUES (:'user_id'::uuid, :'workspace_id'::uuid, 'Member', :'full_name', :'email');";
  runLocalSql(sql, {
    user_id: input.userId,
    workspace_id: input.workspaceId,
    full_name: input.fullName,
    email: input.email,
  });
}

export function expireLocalRecoveryToken(userId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error("Refusing to update a non-test Auth user.");
  const sql = "WITH updated AS (UPDATE auth.users SET recovery_sent_at = now() - interval '31 days' WHERE id = :'user_id'::uuid AND email LIKE 'kdm-%@example.test' RETURNING id) SELECT count(*)::text FROM updated;";
  if (runLocalSql(sql, { user_id: userId }) !== "1") {
    throw new Error("Expected exactly one synthetic local Auth user to expire.");
  }
}
