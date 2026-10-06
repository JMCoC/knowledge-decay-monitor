// S1-04 end-to-end acceptance against LOCAL Supabase + Next.js dev + embed Edge.
// Run: node scripts/check-processing-fixtures.mjs
// Requires three terminals: (1) supabase stack, (2) `supabase functions serve
// embed`, (3) `next dev`. Needs INGESTION_INTERNAL_TOKEN in this shell.
// Never prints tokens, keys, document contents, paths, or embeddings —
// version ids are abbreviated to 8 chars in logs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SUPABASE_URL = "http://127.0.0.1:54321";
const APP_URL = "http://127.0.0.1:3000";
const EMBED_URL = `${SUPABASE_URL}/functions/v1/embed`;
const WORKSPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const QA_LEAD_A = "10000000-0000-4000-8000-000000000002";
const short = (id) => String(id).slice(0, 8);

const watchdog = setTimeout(() => {
  console.error("FAIL: exceeded the 5-minute script budget");
  process.exit(1);
}, 5 * 60 * 1000);

function fail(stage, expected, actual) {
  console.error(`FAIL [${stage}]: expected ${expected}, got ${actual}`);
  process.exit(1);
}
const pass = (stage, detail) => console.log(`PASS [${stage}]: ${detail}`);

function localStatus() {
  try {
    return JSON.parse(execFileSync(process.execPath, [
      resolve("node_modules/supabase/dist/supabase.js"), "status", "-o", "json",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } catch {
    fail("env", "local Supabase running", "status unavailable (run: pnpm exec supabase start)");
  }
}

async function rest(path, serviceKey, options = {}) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
    signal: AbortSignal.timeout(30000),
  });
  return response;
}

async function insertRow(serviceKey, table, row, stage) {
  const response = await rest(`/rest/v1/${table}`, serviceKey, {
    method: "POST",
    body: JSON.stringify(row),
  });
  if (response.status !== 201) fail(stage, `201 inserting into ${table}`, `${response.status} ${(await response.text()).slice(0, 120)}`);
}

async function uploadOriginal(serviceKey, storagePath, bytes, mime, stage) {
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/documents/${storagePath}`, {
    method: "POST",
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": mime },
    body: bytes,
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) fail(stage, "200 uploading original", `${response.status} ${(await response.text()).slice(0, 120)}`);
}

async function readVersion(serviceKey, versionId) {
  const response = await rest(`/rest/v1/document_versions?id=eq.${versionId}&select=processing_status,version_status`, serviceKey);
  if (!response.ok) fail("poll", "200 reading version", String(response.status));
  return (await response.json())[0];
}

async function pollTerminal(serviceKey, versionId, stage, maxSeconds = 60) {
  for (let elapsed = 0; elapsed < maxSeconds; elapsed += 1) {
    const row = await readVersion(serviceKey, versionId);
    if (row?.processing_status === "ready" || row?.processing_status === "processing_failed") return row;
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 1000));
  }
  fail(stage, "terminal processing_status within 60s", "timeout");
}

function assertEmbeddings(vectors, stage) {
  if (vectors.length === 0) fail(stage, "at least one chunk", "0 chunks");
  for (const { embedding } of vectors) {
    const values = String(embedding).slice(1, -1).split(",");
    if (values.length !== 384 || !values.every((v) => Number.isFinite(Number(v)))) {
      fail(stage, "every embedding with 384 finite dims", `${values.length} values`);
    }
  }
}

const MD_BODY = [
  "# Incident Response Overview",
  "",
  "This runbook describes the on-call rotation, escalation policy, and the first",
  "response steps every responder follows when an alert fires outside business hours.",
  "",
  "## Escalation Policy",
  "",
  "Page the primary on-call first. If there is no acknowledgement within fifteen",
  "minutes, escalate to the secondary. Security incidents skip the queue and page",
  "the incident commander directly with severity and impact scope attached.",
  "",
  "## Recovery Drill",
  "",
  "Run the recovery drill every quarter. Rotate drill leads, record findings, and",
  "file follow-up actions before closing the drill report with the QA lead.",
  "",
].join("\n");

async function runStage(serviceKey, token, { label, fileName, mime, bytes, expectReady }) {
  const documentId = randomUUID();
  const versionId = randomUUID();
  const ext = fileName.split(".").pop();
  const storagePath = `${WORKSPACE_A}/${documentId}/${versionId}/original.${ext}`;
  await insertRow(serviceKey, "documents", {
    id: documentId, workspace_id: WORKSPACE_A, name: `S1-04 ${label}`, category: "SOP", owner_id: QA_LEAD_A,
  }, label);
  // A confirmed version must satisfy document_versions_upload_fields_consistent
  // (23514): sha, attempt pointer, and confirmation stamps all present, with
  // no verifying-only lease fields. The attempt row goes first: the FK to
  // document_upload_attempts is checked per REST transaction.
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const attemptId = randomUUID();
  const nowIso = new Date().toISOString();
  await insertRow(serviceKey, "document_upload_attempts", {
    id: attemptId,
    workspace_id: WORKSPACE_A,
    version_id: versionId,
    storage_path: `${WORKSPACE_A}/${documentId}/${versionId}/attempts/${attemptId}/original.${ext}`,
  }, `${label}:attempt`);
  await insertRow(serviceKey, "document_versions", {
    id: versionId, workspace_id: WORKSPACE_A, document_id: documentId, version_number: 1,
    storage_path: storagePath, processing_status: "uploaded", version_status: null,
    upload_state: "confirmed", analysis_status: "pending_reanalysis", size_bytes: bytes.length,
    expected_sha256: sha256, hash_source: "client_declared",
    current_upload_attempt_id: attemptId, reference_set_at: nowIso,
    reference_set_by: QA_LEAD_A, upload_confirmed_at: nowIso,
  }, label);
  await uploadOriginal(serviceKey, storagePath, bytes, mime, label);

  const dispatch = await fetch(`${APP_URL}/api/ingestion/process`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-token": token },
    body: JSON.stringify({ versionId }),
    signal: AbortSignal.timeout(30000),
  });
  if (dispatch.status !== 200) fail(label, "200 dispatching the worker", String(dispatch.status));

  const row = await pollTerminal(serviceKey, versionId, label);
  const chunksResponse = await rest(`/rest/v1/document_chunks?version_id=eq.${versionId}&select=embedding`, serviceKey);
  const chunks = await chunksResponse.json();
  const documentResponse = await rest(`/rest/v1/documents?id=eq.${documentId}&select=active_version_id`, serviceKey);
  const activeVersionId = (await documentResponse.json())[0]?.active_version_id;

  if (expectReady) {
    if (row.processing_status !== "ready") fail(label, "processing_status=ready", row.processing_status);
    if (row.version_status !== "active") fail(label, "version_status=active", String(row.version_status));
    if (activeVersionId !== versionId) fail(label, "documents.active_version_id set", String(activeVersionId));
    assertEmbeddings(chunks, label);
    pass(label, `${short(versionId)} ready+active with ${chunks.length} chunk(s) of 384 dims`);
  } else {
    if (row.processing_status !== "processing_failed") fail(label, "processing_status=processing_failed", row.processing_status);
    if (row.version_status !== null) fail(label, "version_status NULL", String(row.version_status));
    if (activeVersionId !== null) fail(label, "active_version_id NULL", String(activeVersionId));
    if (chunks.length !== 0) fail(label, "0 chunks persisted", `${chunks.length} chunks`);
    pass(label, `${short(versionId)} failed honestly with no chunks and no pointer`);
  }
}

async function run() {
  const internalToken = process.env.INGESTION_INTERNAL_TOKEN;
  if (!internalToken) fail("env", "INGESTION_INTERNAL_TOKEN set", "missing (export it in this shell and in `next dev`)");
  const status = localStatus();
  assert.equal(status.API_URL, SUPABASE_URL, "This script only targets the local stack");
  const serviceKey = status.SERVICE_ROLE_KEY;
  if (!serviceKey) fail("env", "SERVICE_ROLE_KEY from supabase status", "missing");

  try {
    await fetch(APP_URL, { signal: AbortSignal.timeout(5000) });
  } catch {
    fail("env", "Next.js dev on :3000", "unreachable (run: pnpm dev)");
  }

  // Stage 1 — the embed Edge Function answers with real 384-dim vectors.
  const coldStart = Date.now();
  const probe = await fetch(EMBED_URL, {
    method: "POST",
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ inputs: ["hello"] }),
    signal: AbortSignal.timeout(60000),
  });
  const coldMs = Date.now() - coldStart;
  if (probe.status !== 200) fail("embed", "200 from the embed function", `${probe.status} (run: supabase functions serve embed)`);
  const probeBody = await probe.json();
  if (probeBody.dims !== 384 || probeBody.embeddings?.[0]?.length !== 384) {
    fail("embed", "dims 384 with 384-length vectors", `dims=${probeBody.dims}`);
  }
  const warmStart = Date.now();
  const batch = await fetch(EMBED_URL, {
    method: "POST",
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ inputs: Array.from({ length: 8 }, (_, i) => `warmup text ${i}`) }),
    signal: AbortSignal.timeout(60000),
  });
  const warmMs = Date.now() - warmStart;
  if (batch.status !== 200) fail("embed", "200 for a batch of 8", String(batch.status));
  pass("embed", `1 input in ${coldMs}ms, 8 inputs in ${warmMs}ms`);
  if (warmMs > 10000) console.warn("WARN [embed]: batch of 8 slower than 10s (check parallel session.run)");

  const root = "supabase/fixtures/storage/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await runStage(serviceKey, internalToken, {
    label: "md", fileName: "original.md", mime: "text/markdown",
    bytes: Buffer.from(MD_BODY, "utf8"), expectReady: true,
  });
  await runStage(serviceKey, internalToken, {
    label: "empty-pdf", fileName: "original-empty.pdf", mime: "application/pdf",
    bytes: readFileSync(resolve(`${root}/20000000-0000-4000-8000-0000000000e2/30000000-0000-4000-8000-0000000000e2/original-empty.pdf`)),
    expectReady: false,
  });
  await runStage(serviceKey, internalToken, {
    label: "docx", fileName: "original.docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    bytes: readFileSync(resolve(`${root}/20000000-0000-4000-8000-0000000000e1/30000000-0000-4000-8000-0000000000e1/original.docx`)),
    expectReady: true,
  });

  // Stage 5 — legacy rows (upload_state NULL) are never claimed: 204, untouched.
  const legacyDocument = randomUUID();
  const legacyVersion = randomUUID();
  await insertRow(serviceKey, "documents", {
    id: legacyDocument, workspace_id: WORKSPACE_A, name: "S1-04 legacy", category: "SOP", owner_id: QA_LEAD_A,
  }, "legacy");
  await insertRow(serviceKey, "document_versions", {
    id: legacyVersion, workspace_id: WORKSPACE_A, document_id: legacyDocument, version_number: 1,
    storage_path: `${WORKSPACE_A}/${legacyDocument}/${legacyVersion}/original.md`,
    processing_status: "uploaded", version_status: null, upload_state: null,
    analysis_status: "pending_reanalysis", size_bytes: 8,
  }, "legacy");
  const legacyDispatch = await fetch(`${APP_URL}/api/ingestion/process`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-token": internalToken },
    body: JSON.stringify({ versionId: legacyVersion }),
    signal: AbortSignal.timeout(30000),
  });
  if (legacyDispatch.status !== 204) fail("legacy", "204 for a legacy version", String(legacyDispatch.status));
  await new Promise((resolveTimer) => setTimeout(resolveTimer, 5000));
  const legacyRow = await readVersion(serviceKey, legacyVersion);
  if (legacyRow?.processing_status !== "uploaded") fail("legacy", "processing_status still uploaded", legacyRow?.processing_status);
  pass("legacy", `${short(legacyVersion)} untouched after 5s`);

  for (const [label, headers] of [
    ["no-token", { "content-type": "application/json" }],
    ["wrong-token", { "content-type": "application/json", "x-internal-token": "wrong" }],
  ]) {
    const denied = await fetch(`${APP_URL}/api/ingestion/process`, {
      method: "POST", headers, body: JSON.stringify({ versionId: randomUUID() }),
      signal: AbortSignal.timeout(30000),
    });
    if (denied.status !== 401) fail(label, "401", String(denied.status));
    pass(label, "rejected without dispatching");
  }

  clearTimeout(watchdog);
  console.log("PASS: embed sanity, md ready, empty-pdf failed honestly, docx ready, legacy untouched, 401 x2.");
}

run().catch((error) => {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
});
