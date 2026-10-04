import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROJECT_ROOT, LOCAL_API_URL, readLocalSupabaseRuntime } from "./local-supabase.mjs";

const BUCKET = "documents";
const PAGE_SIZE = 100;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CANONICAL_PATH = new RegExp(`^(${UUID})/(${UUID})/(${UUID})/original\\.(pdf|docx|md)$`, "i");
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

export function parseMaintenanceArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!["--target", "--mode", "--project-ref"].includes(flag) || values.has(flag)) {
      throw new Error("Invalid maintenance arguments.");
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error("A maintenance argument is missing its value.");
    values.set(flag, value);
    index += 1;
  }

  const target = values.get("--target");
  const mode = values.get("--mode");
  const projectRef = values.get("--project-ref");
  if (!["local", "linked"].includes(target) || !["inspect", "apply"].includes(mode)) {
    throw new Error("Explicit target and mode are required.");
  }
  if (target === "linked" && (!projectRef || !/^[a-z0-9]{20}$/.test(projectRef))) {
    throw new Error("Linked target requires an explicit project reference.");
  }
  if (target === "local" && projectRef) throw new Error("Project reference is valid only for a linked target.");
  return { target, mode, projectRef };
}

export function resolveMaintenanceRuntime(options, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  if (options.target === "local") {
    const runtime = (dependencies.readLocalRuntime ?? readLocalSupabaseRuntime)();
    if (runtime.apiUrl !== LOCAL_API_URL || !runtime.serviceRoleKey) {
      throw new Error("Local Supabase target is not available.");
    }
    return { url: runtime.apiUrl, serviceRoleKey: runtime.serviceRoleKey };
  }

  let linkedProjectRef;
  try {
    linkedProjectRef = (dependencies.readLinkedProjectRef ?? (() =>
      readFileSync(resolve(PROJECT_ROOT, "supabase/.temp/project-ref"), "utf8")))().trim();
  } catch {
    throw new Error("The Supabase CLI has no linked project reference.");
  }
  if (linkedProjectRef !== options.projectRef) throw new Error("Linked project reference does not match.");

  const urlText = env.KDM_LINKED_SUPABASE_URL;
  const serviceRoleKey = env.KDM_LINKED_SUPABASE_SERVICE_ROLE_KEY;
  if (!urlText || !serviceRoleKey) throw new Error("Linked Supabase credentials are unavailable.");
  let url;
  try {
    url = new URL(urlText);
  } catch {
    throw new Error("Linked Supabase URL is invalid.");
  }
  if (
    url.protocol !== "https:"
    || url.hostname !== `${options.projectRef}.supabase.co`
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) throw new Error("Linked Supabase destination does not match the declared project.");
  return { url: urlText, serviceRoleKey };
}

export function createMaintenanceClient(runtime) {
  return createClient(runtime.url, runtime.serviceRoleKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
}

function isRegisteredAttemptPath(row) {
  if (!row || typeof row.storage_path !== "string") return false;
  const match = new RegExp(`^(${UUID})/(${UUID})/(${UUID})/attempts/(${UUID})/original\\.(pdf|docx|md)$`, "i")
    .exec(row.storage_path);
  return Boolean(
    match
    && match[1]?.toLowerCase() === row.workspace_id?.toLowerCase()
    && match[3]?.toLowerCase() === row.version_id?.toLowerCase()
    && match[4]?.toLowerCase() === row.id?.toLowerCase()
  );
}

function storageReadUrl(baseUrl, path) {
  const url = new URL(baseUrl);
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  url.pathname = `/storage/v1/object/authenticated/${BUCKET}/${encoded}`;
  return url;
}

async function objectIsAbsent(runtime, path) {
  let response;
  try {
    response = await fetch(storageReadUrl(runtime.url, path), {
      method: "GET",
      headers: { apikey: runtime.serviceRoleKey, authorization: `Bearer ${runtime.serviceRoleKey}` },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("Storage absence could not be confirmed.");
  }
  if (response.status === 404) return true;
  if (response.status === 400) {
    let payload;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (payload && typeof payload === "object" && payload.code === "NoSuchKey") return true;
  }
  if (response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return false;
  }
  await response.body?.cancel().catch(() => undefined);
  throw new Error("Storage absence could not be confirmed.");
}

function isNoSuchKey(payload) {
  return Boolean(payload && typeof payload === "object" && payload.code === "NoSuchKey");
}

/** Inspects one canonical legacy object without persisting bytes or returning its digest in CLI output. */
export async function inspectLegacyOriginal(runtime, path, expectedSizeBytes) {
  const match = CANONICAL_PATH.exec(path);
  if (!match || !/^[0-9a-f-]{36}$/i.test(match[1] ?? "") || !/^[0-9a-f-]{36}$/i.test(match[3] ?? "")) {
    throw new Error("Legacy path is not a registered canonical object.");
  }

  let response;
  try {
    response = await fetch(storageReadUrl(runtime.url, path), {
      method: "GET",
      headers: { apikey: runtime.serviceRoleKey, authorization: `Bearer ${runtime.serviceRoleKey}` },
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new Error("Storage inspection failed.");
  }
  if (response.status === 404) return { observation: "missing" };
  if (response.status === 400) {
    let payload;
    try { payload = await response.json(); } catch { payload = null; }
    if (isNoSuchKey(payload)) return { observation: "missing" };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Storage inspection failed.");
  }

  const reader = response.body?.getReader();
  if (!reader) return { observation: "invalid" };
  const chunks = [];
  let totalBytes = 0;
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { completed = true; break; }
      if (totalBytes + value.byteLength > MAX_FILE_SIZE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { observation: "invalid" };
      }
      totalBytes += value.byteLength;
      chunks.push(Buffer.from(value));
    }
  } catch {
    throw new Error("Storage inspection failed.");
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  if (totalBytes < 1 || (expectedSizeBytes !== null && expectedSizeBytes !== undefined && totalBytes !== expectedSizeBytes)) {
    return { observation: "invalid" };
  }
  const bytes = Buffer.concat(chunks, totalBytes);
  const extension = match[4]?.toLowerCase();
  const signatureValid = extension === "md"
    || (extension === "pdf" && bytes.subarray(0, 5).toString("ascii") === "%PDF-")
    || (extension === "docx" && bytes.length >= 4 && bytes[0] === 0x50
      && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04);
  if (!signatureValid) return { observation: "invalid" };
  return {
    observation: "valid",
    observedSizeBytes: totalBytes,
    observedSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function runLegacyReconciliation(client, runtime, mode, actorUserId, inspect = inspectLegacyOriginal) {
  if (!/^[0-9a-f-]{36}$/i.test(actorUserId)) throw new Error("An explicit operator identity is required.");
  const { data: actor, error: actorError } = await client.from("profiles")
    .select("workspace_id,role").eq("id", actorUserId).maybeSingle();
  if (actorError || !actor || !["Admin", "QA Lead"].includes(actor.role)) {
    throw new Error("The selected operator has no document-management capability.");
  }

  const counts = { scanned: 0, confirmed: 0, missing: 0, invalid: 0, failed: 0, skipped: 0 };
  let cursor;
  while (true) {
    let request = client.from("document_versions")
      .select("id,workspace_id,document_id,storage_path,size_bytes")
      .eq("workspace_id", actor.workspace_id)
      .is("upload_state", null)
      .order("id", { ascending: true })
      .limit(PAGE_SIZE);
    if (cursor) request = request.gt("id", cursor);
    const { data: rows, error } = await request;
    if (error) throw new Error("Could not inspect legacy uploads.");
    if (!rows?.length) break;
    cursor = rows.at(-1)?.id;

    for (const row of rows) {
      counts.scanned += 1;
      const pathMatch = typeof row.storage_path === "string" ? CANONICAL_PATH.exec(row.storage_path) : null;
      if (!pathMatch || pathMatch[1]?.toLowerCase() !== row.workspace_id.toLowerCase()
        || pathMatch[2]?.toLowerCase() !== row.document_id.toLowerCase()
        || pathMatch[3]?.toLowerCase() !== row.id.toLowerCase()) {
        counts.failed += 1;
        continue;
      }

      let observed;
      try {
        observed = await inspect(runtime, row.storage_path, row.size_bytes);
      } catch {
        counts.failed += 1;
        continue;
      }
      if (mode === "inspect") {
        if (observed.observation === "valid") counts.confirmed += 1;
        else if (observed.observation === "missing") counts.missing += 1;
        else counts.invalid += 1;
        continue;
      }

      const { data: current, error: currentError } = await client.from("document_versions")
        .select("id").eq("id", row.id).eq("workspace_id", actor.workspace_id)
        .is("upload_state", null).maybeSingle();
      if (currentError) { counts.failed += 1; continue; }
      if (!current) { counts.skipped += 1; continue; }
      const { data: result, error: rpcError } = await client.rpc("reconcile_legacy_upload", {
        p_user_id: actorUserId,
        p_version_id: row.id,
        p_observation: observed.observation,
        p_observed_size_bytes: observed.observedSizeBytes ?? null,
        p_observed_sha256: observed.observedSha256 ?? null,
      });
      if (rpcError || !Array.isArray(result) || result.length !== 1) {
        counts.failed += 1;
        continue;
      }
      const outcome = result[0]?.outcome;
      if (outcome === "confirmed") counts.confirmed += 1;
      else if (outcome === "missing_unprocessed" || outcome === "missing_processed") counts.missing += 1;
      else if (outcome === "invalid_unprocessed" || outcome === "invalid_processed") counts.invalid += 1;
      else counts.failed += 1;
    }
    if (rows.length < PAGE_SIZE) break;
  }
  return counts;
}

async function removeAndConfirm(client, runtime, path) {
  try {
    await client.storage.from(BUCKET).remove([path]);
  } catch {
    // A follow-up 404 is still authoritative if the delete response was lost.
  }
  return objectIsAbsent(runtime, path);
}

export async function runAttemptCleanup(client, runtime, mode) {
  const counts = { retired: 0, pending: 0, absent: 0, failed: 0, processed: 0 };
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await client.from("document_upload_attempts")
      .select("id,workspace_id,version_id,storage_path,retired_at,cleanup_status")
      .not("retired_at", "is", null)
      .order("created_at", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error("Could not inspect retired upload attempts.");
    const rows = data ?? [];
    counts.retired += rows.length;
    for (const row of rows) {
      if (mode !== "apply") {
        if (row.cleanup_status === "pending") counts.pending += 1;
        if (row.cleanup_status === "absent") counts.absent += 1;
        if (row.cleanup_status === "failed") counts.failed += 1;
        continue;
      }
      if (!isRegisteredAttemptPath(row)) {
        counts.failed += 1;
        continue;
      }

      const { data: current, error: rereadError } = await client.from("document_upload_attempts")
        .select("id,workspace_id,version_id,storage_path,retired_at")
        .eq("id", row.id)
        .eq("workspace_id", row.workspace_id)
        .eq("version_id", row.version_id)
        .not("retired_at", "is", null)
        .maybeSingle();
      if (rereadError || !current || !isRegisteredAttemptPath(current)) {
        counts.failed += 1;
        continue;
      }

      let absent = false;
      try {
        absent = await removeAndConfirm(client, runtime, current.storage_path);
      } catch {
        absent = false;
      }
      const { data: marked, error: markError } = await client.rpc("mark_upload_attempt_cleanup", {
        p_version_id: current.version_id,
        p_attempt_id: current.id,
        p_object_absent: absent,
      });
      if (markError || marked !== true) {
        counts.failed += 1;
        continue;
      }
      counts.processed += 1;
      if (absent) counts.absent += 1;
      else counts.failed += 1;
    }
    if (rows.length < PAGE_SIZE) break;
  }
  return counts;
}
