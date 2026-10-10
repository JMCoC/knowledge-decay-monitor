import { execFileSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database";

const LOCAL_API_URL = "http://127.0.0.1:54321";
const LOCAL_PROJECT_ID = "knowledge-decay-monitor-s1-02";

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

/** Toggles the disposable local upload gate for isolated integration tests. */
export function setLocalUploadMode(mode: "paused" | "active") {
  if (process.env.KDM_LOCAL_SUPABASE_URL !== LOCAL_API_URL) {
    throw new Error("Refusing to change upload mode outside the expected local Supabase project.");
  }
  const sql = "WITH changed AS (UPDATE private.upload_control SET mode = :'mode'::public.upload_control_mode, updated_at = now() WHERE singleton RETURNING singleton) SELECT count(*)::text FROM changed;";
  if (runLocalSql(sql, { mode }) !== "1") {
    throw new Error("Expected exactly one local upload gate to change.");
  }
}

/** Reads the local upload gate so suites can restore the exact starting state. */
export function getLocalUploadMode(): "paused" | "active" {
  if (process.env.KDM_LOCAL_SUPABASE_URL !== LOCAL_API_URL) {
    throw new Error("Refusing to inspect upload mode outside the expected local Supabase project.");
  }
  const mode = runLocalSql("SELECT mode::text FROM private.upload_control WHERE singleton;", {});
  if (mode !== "paused" && mode !== "active") {
    throw new Error("The local upload gate did not return one supported mode.");
  }
  return mode;
}

/** Looks up only an Auth user created by the local UI acceptance tests. */
export function localTestUserIdByEmail(email: string): string | null {
  if (
    process.env.KDM_LOCAL_SUPABASE_URL !== LOCAL_API_URL
    || !/^kdm-[0-9a-f-]{36}@example\.test$/i.test(email)
  ) {
    throw new Error("Refusing to look up an Auth user outside the synthetic local test namespace.");
  }
  const rows = runLocalSql(
    "SELECT id::text FROM auth.users WHERE email = :'email' ORDER BY id LIMIT 2;",
    { email },
  ).split(/\r?\n/).filter(Boolean);
  if (rows.length > 1) throw new Error("The synthetic local Auth email matched multiple users.");
  if (rows.length === 0) return null;
  if (!/^[0-9a-f-]{36}$/i.test(rows[0])) {
    throw new Error("The synthetic local Auth user id was invalid.");
  }
  return rows[0];
}

/** Expires only a synthetic local verification lease to test retry after a lost response. */
export function expireLocalVerificationLease(versionId: string) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (process.env.KDM_LOCAL_SUPABASE_URL !== LOCAL_API_URL || !uuid.test(versionId)) {
    throw new Error("Refusing to change a verification lease outside the local synthetic fixture.");
  }
  const sql = "WITH changed AS (UPDATE public.document_versions SET upload_lease_expires_at = now() - interval '1 second' WHERE id = :'version_id'::uuid AND upload_state = 'verifying' RETURNING id) SELECT count(*)::text FROM changed;";
  if (runLocalSql(sql, { version_id: versionId }) !== "1") {
    throw new Error("Expected exactly one synthetic local verification lease to expire.");
  }
}

/** Expires only a synthetic local recovery lease so maintenance cleanup can retry its retired attempt. */
export function expireLocalRecoveryLease(versionId: string) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (process.env.KDM_LOCAL_SUPABASE_URL !== LOCAL_API_URL || !uuid.test(versionId)) {
    throw new Error("Refusing to change a recovery lease outside the local synthetic fixture.");
  }
  const sql = "WITH changed AS (UPDATE public.document_versions SET upload_lease_expires_at = now() - interval '1 second' WHERE id = :'version_id'::uuid AND upload_state = 'recovering' RETURNING id) SELECT count(*)::text FROM changed;";
  if (runLocalSql(sql, { version_id: versionId }) !== "1") {
    throw new Error("Expected exactly one synthetic local recovery lease to expire.");
  }
}

/** Installs only a synthetic test claim; never usable against a remote project. */
export function seedLocalProcessingClaim(versionId: string,operationId: string,startedAt: string) {
  if(process.env.KDM_LOCAL_SUPABASE_URL!==LOCAL_API_URL || !/^[0-9a-f-]{36}$/i.test(versionId)
    || !/^[0-9a-f-]{36}$/i.test(operationId) || !Number.isFinite(Date.parse(startedAt))) throw new Error("Invalid local claim fixture.");
  const sql=`WITH fixture AS (
    SELECT v.id,v.workspace_id FROM public.document_versions v JOIN public.documents d ON d.id=v.document_id
    WHERE v.id=:'version_id'::uuid AND (d.name LIKE 'Processing-%' OR d.name LIKE 'Retry-%' OR d.name LIKE 'S1-07 Retry %')
  ), changed AS (
    INSERT INTO private.ingestion_jobs(version_id,workspace_id,status,attempt_count,operation_id,started_at,lease_expires_at)
    SELECT id,workspace_id,'running',1,:'operation_id'::uuid,:'started_at'::timestamptz,:'started_at'::timestamptz+interval '180 seconds' FROM fixture
    ON CONFLICT(version_id) DO UPDATE SET status='running',attempt_count=1,operation_id=EXCLUDED.operation_id,started_at=EXCLUDED.started_at,lease_expires_at=EXCLUDED.lease_expires_at RETURNING version_id
  ), projected AS (UPDATE public.document_versions SET processing_status='processing',processing_queued=false,processing_operation_id=:'operation_id'::uuid,
    processing_started_at=:'started_at'::timestamptz,processing_lease_expires_at=:'started_at'::timestamptz+interval '180 seconds'
    WHERE id IN(SELECT version_id FROM changed) RETURNING id) SELECT count(*)::text FROM projected;`;
  if(runLocalSql(sql,{version_id:versionId,operation_id:operationId,started_at:startedAt})!=='1') throw new Error("Synthetic processing claim not found.");
}

/** Deletes only the workspace/profile generated for a synthetic local Auth user. */
export async function cleanupLocalUser(userId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(userId) || process.env.KDM_LOCAL_SUPABASE_URL !== LOCAL_API_URL) {
    throw new Error("Refusing to clean up outside the synthetic local Auth fixture.");
  }
  const cleanupWorkspaceSql = [
    "WITH candidates AS MATERIALIZED (",
    "SELECT w.id workspace_id FROM public.workspaces w JOIN public.profiles p ON p.workspace_id=w.id",
    "WHERE p.id=:'user_id'::uuid AND p.email LIKE 'kdm-%@example.test'",
    "AND w.name ~ '^kdm-[0-9a-f-]{36}$'),",
    "deleted_documents AS (DELETE FROM public.documents d USING candidates c",
    "WHERE d.workspace_id=c.workspace_id RETURNING d.id),",
    "deleted_workspaces AS (DELETE FROM public.workspaces w USING candidates c,",
    "(SELECT count(*) FROM deleted_documents) cleanup_dependency",
    "WHERE w.id=c.workspace_id RETURNING w.id)",
    "SELECT count(*)::text FROM deleted_workspaces;",
  ].join(" ");
  const deletedWorkspaces = Number(runLocalSql(cleanupWorkspaceSql, { user_id: userId }));
  if (deletedWorkspaces > 1) throw new Error("Synthetic local user matched multiple test workspaces.");

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("Local Auth cleanup requires the local-only service role.");
  const admin = createClient<Database>(LOCAL_API_URL, key, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) throw new Error("Synthetic local Auth user cleanup failed.");
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

export type LocalWorkspaceRole = "Admin" | "QA Lead" | "Member";

export function insertLocalProfile(input: {
  userId: string;
  workspaceId: string;
  role: LocalWorkspaceRole;
  fullName: string;
  email: string;
}) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (
    process.env.KDM_LOCAL_SUPABASE_URL !== LOCAL_API_URL
    || !uuid.test(input.userId)
    || !uuid.test(input.workspaceId)
    || !["Admin", "QA Lead", "Member"].includes(input.role)
    || !/^kdm-[0-9a-f-]{36}@example\.test$/i.test(input.email)
  ) {
    throw new Error("Refusing to create a profile outside the local synthetic fixture.");
  }
  const sql = "INSERT INTO public.profiles (id, workspace_id, role, full_name, email) VALUES (:'user_id'::uuid, :'workspace_id'::uuid, :'role'::public.workspace_role, :'full_name', :'email');";
  runLocalSql(sql, {
    user_id: input.userId,
    workspace_id: input.workspaceId,
    role: input.role,
    full_name: input.fullName,
    email: input.email,
  });
}

export function insertMemberProfile(input: {
  userId: string;
  workspaceId: string;
  fullName: string;
  email: string;
}) {
  insertLocalProfile({ ...input, role: "Member" });
}

/** Inserts a legacy active version and its document pointer in one local-only transaction. */
export function insertLocalActiveVersion(input: {
  workspaceId: string;
  documentId: string;
  versionId: string;
}) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (
    process.env.KDM_LOCAL_SUPABASE_URL !== LOCAL_API_URL
    || !uuid.test(input.workspaceId)
    || !uuid.test(input.documentId)
    || !uuid.test(input.versionId)
  ) {
    throw new Error("Refusing to create a Repository fixture outside the expected local project.");
  }

  const sql = [
    "begin;",
    "insert into public.document_versions (id, workspace_id, document_id, version_number, storage_path, processing_status, version_status)",
    "values (:'version_id'::uuid, :'workspace_id'::uuid, :'document_id'::uuid, 1,",
    " :'workspace_id' || '/' || :'document_id' || '/' || :'version_id' || '/original.md', 'ready', 'active');",
    "update public.documents set active_version_id = :'version_id'::uuid",
    "where id = :'document_id'::uuid and workspace_id = :'workspace_id'::uuid;",
    "commit;",
  ].join(" ");
  runLocalSql(sql, {
    workspace_id: input.workspaceId,
    document_id: input.documentId,
    version_id: input.versionId,
  });

  const verified = runLocalSql(
    "select count(*)::text from public.documents d join public.document_versions v on v.id = d.active_version_id and v.document_id = d.id and v.workspace_id = d.workspace_id where d.id = :'document_id'::uuid and d.workspace_id = :'workspace_id'::uuid and v.id = :'version_id'::uuid and v.version_status = 'active' and v.processing_status = 'ready';",
    {
      workspace_id: input.workspaceId,
      document_id: input.documentId,
      version_id: input.versionId,
    },
  );
  if (verified !== "1") throw new Error("The local Repository active-version fixture was not persisted.");
}

export function expireLocalRecoveryToken(userId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error("Refusing to update a non-test Auth user.");
  const sql = "WITH updated AS (UPDATE auth.users SET recovery_sent_at = now() - interval '31 days' WHERE id = :'user_id'::uuid AND email LIKE 'kdm-%@example.test' RETURNING id) SELECT count(*)::text FROM updated;";
  if (runLocalSql(sql, { user_id: userId }) !== "1") {
    throw new Error("Expected exactly one synthetic local Auth user to expire.");
  }
}
