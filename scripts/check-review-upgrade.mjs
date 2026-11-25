// Proves S2-to-S3-02 upgrade preservation and a clean S3-02 install using
// runner-owned local Supabase projects only.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { includeMigration } from "./analysis-upgrade-policy.mjs";
import { redactCliOutput } from "./cli-output-redaction.mjs";
import { includeReviewMigration, reviewMigrationStage } from "./review-upgrade-policy.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceSupabase = join(projectRoot, "supabase");
const supabaseCli = resolve(projectRoot, "node_modules/supabase/dist/supabase.js");
const portOffsets = Array.from({ length: 10 }, (_, index) => index);
const excludedServices = [
  "studio", "edge-runtime", "logflare", "vector", "supavisor",
  "realtime", "analytics", "postgres-meta", "mailpit", "imgproxy",
];
const s3_01MigrationNames = [
  "20261108150000_s3_01_review_enums.sql",
  "20261108150100_s3_01_review_model.sql",
  "20261108150200_s3_01_review_integrity.sql",
  "20261108150300_s3_01_review_security.sql",
  "20261108150400_s3_01_review_audit_outbox.sql",
  "20261108150500_s3_01_approval_contribution_check.sql",
];
const s3_02MigrationNames = [
  "20261114150000_s3_02_review_audit_enum.sql",
  "20261114150100_s3_02_review_model.sql",
  "20261114150200_s3_02_review_coverage_guards.sql",
  "20261114150300_s3_02_review_command_support.sql",
  "20261114150400_s3_02_finding_commands.sql",
  "20261114150500_s3_02_round_commands.sql",
  "20261114150600_s3_02_findings_projection.sql",
];
const workspaceA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const adminA = "10000000-0000-4000-8000-000000000001";
const memberA = "10000000-0000-4000-8000-000000000003";
const fixtureKey = "s3-01-upgrade-preservation";
const fixtureFingerprint = "s3-01-upgrade-preservation";
const notificationId = "91000000-0000-4000-8000-000000000901";
const originalStorageBytes = Buffer.from(
  "S3-02 upgrade original Storage object; immutable verification.\n",
  "utf8",
);

const s2HistoryHashSql = `
with selected_rows(kind, row_id, row_data) as (
  select 'workspaces', w.id::text, to_jsonb(w)
  from public.workspaces w where w.id in ('${workspaceA}'::uuid, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid)
  union all
  select 'profiles', p.id::text, to_jsonb(p)
  from public.profiles p where p.id in (
    '10000000-0000-4000-8000-000000000001'::uuid,
    '10000000-0000-4000-8000-000000000002'::uuid,
    '10000000-0000-4000-8000-000000000003'::uuid,
    '10000000-0000-4000-8000-000000000004'::uuid
  )
  union all
  select 'documents', d.id::text, to_jsonb(d)
  from public.documents d where d.workspace_id in ('${workspaceA}'::uuid, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid)
  union all
  select 'document_versions', v.id::text, to_jsonb(v) - 'workflow_kind'
  from public.document_versions v where v.workspace_id in ('${workspaceA}'::uuid, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid)
  union all
  select 'document_chunks', c.id::text, to_jsonb(c)
  from public.document_chunks c where c.workspace_id in ('${workspaceA}'::uuid, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid)
  union all
  select 'analyses', a.id::text, to_jsonb(a)
  from public.analyses a where a.workspace_id in ('${workspaceA}'::uuid, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid)
  union all
  select 'analysis_documents', d.analysis_id::text || '|' || d.version_id::text || '|' || d.role::text, to_jsonb(d)
  from public.analysis_documents d where d.workspace_id in ('${workspaceA}'::uuid, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid)
  union all
  select 'credit_ledger', l.id::text, to_jsonb(l)
  from public.credit_ledger l where l.workspace_id in ('${workspaceA}'::uuid, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid)
  union all
  select 'findings', f.id::text, to_jsonb(f) - 'review_revision'
  from public.findings f where f.workspace_id in ('${workspaceA}'::uuid, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid)
  union all
  select 'finding_evidence', e.id::text, to_jsonb(e)
  from public.finding_evidence e where e.workspace_id in ('${workspaceA}'::uuid, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid)
  union all
  select 'notification_events', n.id::text, to_jsonb(n) - 'workflow_event_id' - 'workflow_type'
  from public.notification_events n where n.workspace_id in ('${workspaceA}'::uuid, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid)
  union all
  select 'storage_objects', o.name, to_jsonb(o) - 'last_accessed_at'
  from storage.objects o
  where o.bucket_id='documents' and o.name like '${workspaceA}/%'
)
select coalesce(string_agg(kind || '|' || row_id || '|' || md5(row_data::text), E'\\n' order by kind, row_id), '')
from selected_rows;
`;

const s2HistoryCountsSql = `
select
  (select count(*)::text from public.analyses where idempotency_key = '${fixtureKey}') || '|' ||
  (select count(*)::text from public.credit_ledger where analysis_id = (select id from public.analyses where idempotency_key = '${fixtureKey}')) || '|' ||
  (select count(*)::text from public.findings where fingerprint = '${fixtureFingerprint}') || '|' ||
  (select count(*)::text from public.finding_evidence e join public.findings f on f.id = e.finding_id where f.fingerprint = '${fixtureFingerprint}') || '|' ||
  (select count(*)::text from public.notification_events where id = '${notificationId}'::uuid);
`;

const s3DefaultsSql = `
select
  (select column_default = '1' from information_schema.columns where table_schema = 'public' and table_name = 'findings' and column_name = 'review_revision')::text || '|' ||
  (select column_default = '''initial''::text' from information_schema.columns where table_schema = 'public' and table_name = 'document_versions' and column_name = 'workflow_kind')::text || '|' ||
  (select count(*)::text from public.findings where workspace_id = '${workspaceA}'::uuid
    and fingerprint = '${fixtureFingerprint}' and review_revision = 1) || '|' ||
  (select count(*)::text from public.document_versions where workspace_id = '${workspaceA}'::uuid
    and workflow_kind = 'initial') || '|' ||
  (select count(*)::text from public.notification_events where workspace_id = '${workspaceA}'::uuid
    and id = '${notificationId}'::uuid and analysis_id is not null and type is not null
    and workflow_event_id is null and workflow_type is null);
`;

const migrationCountSql = (names) => `
select count(*)::text from supabase_migrations.schema_migrations
where version = any(array[${names.map((name) => `'${name.slice(0, 14)}'`).join(",")}]);
`;

const s3_01MigrationCountSql = migrationCountSql(s3_01MigrationNames);
const s3_02MigrationCountSql = migrationCountSql(s3_02MigrationNames);

const historyFixtureSql = `
\\set QUIET 1
begin;
${readFileSync(join(sourceSupabase, "tests/database/analysis-fixtures.psql"), "utf8")}
do $s3_upgrade_fixture$
declare
  v_analysis_id uuid;
  v_finding_id uuid;
begin
  v_analysis_id := pg_temp.create_analysis_fixture(
    '${workspaceA}'::uuid, '${adminA}'::uuid, 'completed', 1
  );
  update public.analyses
  set idempotency_key = '${fixtureKey}', request_fingerprint = '${fixtureFingerprint}'
  where id = v_analysis_id;

  insert into public.credit_ledger(workspace_id, event_type, amount, analysis_id)
  values ('${workspaceA}'::uuid, 'Reserved', 3, v_analysis_id),
         ('${workspaceA}'::uuid, 'Consumed', 3, v_analysis_id);

  v_finding_id := pg_temp.insert_finding_row(
    v_analysis_id, '${workspaceA}'::uuid, 0.95,
    'Synthetic S3-01 upgrade evidence.', '${fixtureFingerprint}', null
  );
  update public.findings set assignee_id = '${memberA}'::uuid where id = v_finding_id;
  perform pg_temp.insert_evidence_row(
    '${workspaceA}'::uuid, v_analysis_id, v_finding_id,
    (select document_id from pg_temp.analysis_case where analysis_id = v_analysis_id and ordinal = 1),
    (select version_id from pg_temp.analysis_case where analysis_id = v_analysis_id and ordinal = 1),
    (select chunk_id from pg_temp.analysis_case where analysis_id = v_analysis_id and ordinal = 1),
    'Synthetic S3-01 upgrade evidence snapshot.'
  );

  insert into public.notification_events(
    id, workspace_id, analysis_id, type, recipient_id, status,
    attempt_count, next_attempt_at, sent_at, error_code
  ) values (
    '${notificationId}'::uuid, '${workspaceA}'::uuid, v_analysis_id,
    'analysis_completed', '${adminA}'::uuid, 'sent', 1, null, now(), null
  );
end;
$s3_upgrade_fixture$;
set constraints all immediate;
commit;
`;

export function parseReviewUpgradeMode(args, env = process.env) {
  if (args.length !== 1 || !["--disposable-local", "--ci"].includes(args[0])) {
    throw new Error("Use exactly one of --disposable-local or --ci.");
  }
  if (args[0] === "--ci" && (env.CI !== "true" || env.GITHUB_ACTIONS !== "true")) {
    throw new Error("--ci is available only inside GitHub Actions.");
  }
  return args[0];
}

function runCaptured(command, args, stage, cwd = projectRoot, input) {
  try {
    return execFileSync(command, args, {
      cwd,
      input,
      encoding: "utf8",
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    }).trim();
  } catch (error) {
    const captured = [error?.stdout, error?.stderr]
      .filter((part) => typeof part === "string" && part.length > 0)
      .join("\n");
    const detail = redactCliOutput(captured, { maxLines: 80, maxChars: 8000 });
    throw new Error(detail ? `${stage} failed.\n${detail}` : `${stage} failed.`);
  }
}

function runSupabase(args, stage, cwd) {
  return runCaptured(process.execPath, [supabaseCli, ...args], stage, cwd);
}

function reviewStorageRuntime(workdir, expectedApiUrl, originalStoragePath) {
  let status;
  try {
    status = JSON.parse(runSupabase(
      ["status", "-o", "json", "--workdir", workdir],
      "Runner-owned local Storage runtime lookup",
      workdir,
    ));
  } catch {
    throw new Error("Could not read runtime details for the runner-owned Storage project.");
  }
  if (status.API_URL !== expectedApiUrl
      || typeof status.SERVICE_ROLE_KEY !== "string" || !status.SERVICE_ROLE_KEY) {
    throw new Error("Runner-owned local Storage runtime details were incomplete.");
  }
  reviewStorageObjectUrl(status.API_URL, originalStoragePath, "download");
  return { apiUrl: status.API_URL, serviceRoleKey: status.SERVICE_ROLE_KEY };
}

async function requestReviewStorageObject(runtime, originalStoragePath, method, stage) {
  const upload = method === "POST";
  let response;
  try {
    response = await fetch(reviewStorageObjectUrl(
      runtime.apiUrl,
      originalStoragePath,
      upload ? "upload" : "download",
    ), {
      method,
      headers: {
        apikey: runtime.serviceRoleKey,
        authorization: `Bearer ${runtime.serviceRoleKey}`,
        ...(upload ? { "content-type": "text/markdown" } : {}),
      },
      ...(upload ? { body: originalStorageBytes } : {}),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error(`${stage} could not reach runner-owned local Storage.`);
  }
  if (!response.ok) throw new Error(`${stage} returned HTTP ${response.status} from local Storage.`);
  if (!upload) {
    let actualBytes;
    try {
      actualBytes = Buffer.from(await response.arrayBuffer());
    } catch {
      throw new Error(`${stage} could not read original bytes from local Storage.`);
    }
    if (!actualBytes.equals(originalStorageBytes)) {
      throw new Error(`${stage} changed the original Storage bytes.`);
    }
  }
}

function dockerList(args, stage) {
  return runCaptured("docker", args, stage)
    .split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function projectContainers(projectId) {
  return dockerList(["ps", "-a", "--filter", `name=${projectId}`, "--format", "{{.Names}}"], "Docker container inventory")
    .filter((name) => name.endsWith(`_${projectId}`));
}

function projectVolumes(projectId) {
  return dockerList(["volume", "ls", "--filter", `name=${projectId}`, "--format", "{{.Name}}"], "Docker volume inventory")
    .filter((name) => name.endsWith(`_${projectId}`) || name === projectId);
}

export function reviewProjectResourcesOwned(containers, owned) {
  if (!Array.isArray(containers) || !Array.isArray(owned) || containers.length !== owned.length) return false;
  const ownedNames = new Set(owned);
  return ownedNames.size === owned.length && containers.every((name) => ownedNames.has(name));
}

export function isReviewUpgradeTemporaryRoot(candidate, tempRoot, prefix) {
  const normalizedCandidate = resolve(candidate);
  const normalizedTempRoot = resolve(tempRoot);
  const relativeRoot = relative(normalizedTempRoot, normalizedCandidate);
  return Boolean(relativeRoot)
    && relativeRoot !== ".."
    && !relativeRoot.startsWith(`..${sep}`)
    && !relativeRoot.includes(sep)
    && relativeRoot.startsWith(prefix);
}

function assertNoStack(projectId) {
  if (projectContainers(projectId).length || projectVolumes(projectId).length) {
    throw new Error("Refusing to reuse an existing disposable review-upgrade project.");
  }
}

function ownedContainers(projectId, ownerRoot) {
  const normalizedRoot = resolve(ownerRoot);
  return projectContainers(projectId).filter((name) => {
    let labels;
    try {
      labels = JSON.parse(runCaptured("docker", ["inspect", "--format", "{{json .Config.Labels}}", name], "Docker ownership check"));
    } catch {
      return false;
    }
    return labels?.["com.supabase.cli.project"] === projectId
      && typeof labels?.["com.supabase.cli.workdir"] === "string"
      && resolve(labels["com.supabase.cli.workdir"]) === normalizedRoot;
  });
}

function availablePort(port) {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.once("error", () => resolvePort(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolvePort(true)));
  });
}

async function choosePortBase() {
  const first = 56000 + Math.floor(Math.random() * 3000);
  for (let offset = 0; offset < 200; offset += 1) {
    const base = first + offset * 10;
    if (base + 9 > 65535) break;
    let available = true;
    for (const portOffset of portOffsets) {
      if (!(await availablePort(base + portOffset))) {
        available = false;
        break;
      }
    }
    if (available) return base;
  }
  throw new Error("Could not find an unused loopback port range for the review-upgrade project.");
}

async function assertPortRangeAvailable(portBase) {
  for (const offset of portOffsets) {
    if (!(await availablePort(portBase + offset))) {
      throw new Error("A disposable review-upgrade port became occupied before startup.");
    }
  }
}

function copySupabaseTree(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if ([".temp", ".branches"].includes(entry.name) || /^\.env(?:\.|$)/i.test(entry.name)) continue;
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    const entryInfo = lstatSync(sourcePath);
    if (entryInfo.isSymbolicLink()) throw new Error("Supabase fixture copy encountered a symbolic link.");
    if (entryInfo.isDirectory()) copySupabaseTree(sourcePath, destinationPath);
    else if (entryInfo.isFile()) copyFileSync(sourcePath, destinationPath);
  }
}

function migrationInventory() {
  const migrationRoot = join(sourceSupabase, "migrations");
  const entries = readdirSync(migrationRoot, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-z0-9_]+\.sql$/.test(entry.name)) {
      throw new Error("The migration directory contains an unexpected entry.");
    }
    const relativePath = `supabase/migrations/${entry.name}`;
    const stage = reviewMigrationStage(relativePath);
    files.push({ name: entry.name, relativePath, stage });
  }
  const s3_01Names = files.filter((file) => file.stage === "s3_01").map((file) => file.name).sort();
  if (JSON.stringify(s3_01Names) !== JSON.stringify([...s3_01MigrationNames].sort())) {
    throw new Error("The filesystem S3-01 migration inventory differs from its reviewed allowlist.");
  }
  const s3_02Names = files.filter((file) => file.stage === "s3_02").map((file) => file.name).sort();
  if (JSON.stringify(s3_02Names) !== JSON.stringify([...s3_02MigrationNames].sort())) {
    throw new Error("The filesystem S3-02 migration inventory differs from its reviewed allowlist.");
  }
  return files;
}

function includeAtStage(file, stage) {
  if (!includeReviewMigration(file.relativePath, stage)) return false;
  return stage === "s2"
    ? includeMigration(file.relativePath, "s2_11")
    : includeMigration(file.relativePath, stage);
}

export function includeReviewDatabaseTestFile(fileName, stage) {
  if (stage !== "s2" && stage !== "s3_01" && stage !== "s3_02") {
    throw new Error("Unknown review database test stage.");
  }
  if (typeof fileName !== "string" || !/^[a-z0-9_.-]+\.test\.sql$/i.test(fileName)) return false;
  if (fileName.startsWith("s3_02_") && stage !== "s3_02") return false;
  if (fileName.startsWith("s3_05_")) return false;
  if (fileName.startsWith("s3_01_") && stage === "s2") return false;
  return true;
}

export function reviewStorageObjectUrl(apiUrl, storagePath, operation) {
  let parsedApiUrl;
  try {
    parsedApiUrl = new URL(apiUrl);
  } catch {
    throw new Error("Review upgrade Storage verification requires a local API URL.");
  }
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
  if (parsedApiUrl.protocol !== "http:"
      || parsedApiUrl.hostname !== "127.0.0.1"
      || !/^\d{4,5}$/.test(parsedApiUrl.port)
      || parsedApiUrl.pathname !== "/"
      || parsedApiUrl.search !== ""
      || parsedApiUrl.hash !== ""
      || parsedApiUrl.username !== ""
      || parsedApiUrl.password !== ""
      || typeof storagePath !== "string"
      || !new RegExp(`^${uuid}/${uuid}/${uuid}/original\\.md$`, "i").test(storagePath)
      || (operation !== "upload" && operation !== "download")) {
    throw new Error("Review upgrade Storage verification requires a canonical original in the runner-owned local project.");
  }
  const authenticatedPath = operation === "download" ? "authenticated/" : "";
  const encodedPath = storagePath.split("/").map(encodeURIComponent).join("/");
  return `${parsedApiUrl.origin}/storage/v1/object/${authenticatedPath}documents/${encodedPath}`;
}

function filterDatabaseTestFiles(workdir, stage) {
  const testRoot = join(workdir, "supabase", "tests", "database");
  for (const entry of readdirSync(testRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".test.sql")) continue;
    if (!includeReviewDatabaseTestFile(entry.name, stage)) {
      rmSync(join(testRoot, entry.name), { force: true });
    }
  }
}

function renderTemporaryConfig(sourcePath, destinationPath, projectId, portBase) {
  let config = readFileSync(sourcePath, "utf8");
  const idLine = /^[ \t]*project_id[ \t]*=[ \t]*"[^"]+"[ \t]*\r?$/m;
  if (!idLine.test(config)) throw new Error("Supabase config has no project ID to replace.");
  config = config.replace(idLine, `project_id = "${projectId}"`);
  config = config.replace(/^([ \t]*)(port|shadow_port)[ \t]*=[ \t]*(\d+)[ \t]*\r?$/gm, (line, indent, field, rawPort) => {
    const configuredPort = Number(rawPort);
    if (configuredPort < 54320 || configuredPort > 54329) return line;
    return `${indent}${field} = ${portBase + configuredPort - 54320}`;
  });
  const renderedLines = [];
  let inFunctionSection = false;
  for (const line of config.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      inFunctionSection = /^\s*\[functions\.[^\]]+\]\s*$/.test(line);
      renderedLines.push(line);
      if (inFunctionSection) renderedLines.push("enabled = false");
      continue;
    }
    if (inFunctionSection && /^\s*enabled\s*=/.test(line)) continue;
    renderedLines.push(line);
  }
  mkdirSync(dirname(destinationPath), { recursive: true });
  writeFileSync(destinationPath, renderedLines.join("\n"), "utf8");
}

function prepareWorkspace(workdir, projectId, portBase, stage, migrations) {
  mkdirSync(workdir, { recursive: true });
  const destinationSupabase = join(workdir, "supabase");
  copySupabaseTree(sourceSupabase, destinationSupabase);
  renderTemporaryConfig(join(sourceSupabase, "config.toml"), join(destinationSupabase, "config.toml"), projectId, portBase);
  for (const migration of migrations) {
    if (includeAtStage(migration, stage)) continue;
    const destination = resolve(destinationSupabase, "migrations", migration.name);
    if (!destination.startsWith(`${resolve(destinationSupabase)}${sep}`)) {
      throw new Error("Unexpected temporary migration destination.");
    }
    rmSync(destination, { force: true });
  }
  filterDatabaseTestFiles(workdir, stage);
}

function assertOwnedDatabase(projectId, ownerRoot) {
  const expected = `supabase_db_${projectId}`;
  if (!ownedContainers(projectId, ownerRoot).includes(expected)) {
    throw new Error("The disposable review-upgrade database is not owned by this runner.");
  }
  const running = runCaptured("docker", ["inspect", "--format", "{{.State.Running}}", expected], "Database health check");
  if (running !== "true") throw new Error("The disposable review-upgrade database is not running.");
  return expected;
}

function queryDatabase(container, sql, stage) {
  return runCaptured("docker", [
    "exec", "-i", container, "psql", "-XAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres",
  ], stage, projectRoot, sql);
}

function expandDatabaseFixture(fileName, visited = new Set()) {
  if (typeof fileName !== "string" || !/^[a-z0-9_.-]+\.psql$/i.test(fileName) || visited.has(fileName)) {
    throw new Error("The S3-02 upgrade fixture include is invalid or repeated.");
  }
  const fixtureRoot = resolve(sourceSupabase, "tests", "database");
  const fixturePath = resolve(fixtureRoot, fileName);
  if (!fixturePath.startsWith(`${fixtureRoot}${sep}`)) {
    throw new Error("The S3-02 upgrade fixture include is outside the database test directory.");
  }
  visited.add(fileName);
  const source = readFileSync(fixturePath, "utf8");
  return source.replace(/^\\ir ([a-z0-9_.-]+\.psql)\r?$/gim, (_match, includeName) =>
    expandDatabaseFixture(includeName, visited));
}

function seedReviewUpgradeHistory(container) {
  const output = queryDatabase(
    container,
    expandDatabaseFixture("s3_02_review_upgrade_fixture.psql"),
    "S3-01 review-state preservation fixture",
  );
  const values = output.trim().split("|");
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (values.length !== 15 || values.some((value) => !uuidPattern.test(value))) {
    throw new Error("The S3-01 review-state fixture returned an invalid synthetic identifier set.");
  }
  return {
    workspaceId: values[0],
    adminId: values[1],
    memberAId: values[2],
    memberBId: values[3],
    draftRoundId: values[4],
    draftFindingId: values[5],
    collectingRoundId: values[6],
    groupedSubmissionId: values[7],
    processingRoundId: values[8],
    processingCandidateId: values[9],
    pendingRoundId: values[10],
    pendingCandidateId: values[11],
    pendingFindingId: values[12],
    rejectedCandidateId: values[13],
    approvedCandidateId: values[14],
  };
}

function reviewPreservationHashSql(workspaceId) {
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidPattern.test(workspaceId)) throw new Error("The review upgrade workspace marker is invalid.");
  const workspace = `'${workspaceId}'::uuid`;
  return `
with selected_rows(kind, row_id, row_data) as (
  select 'documents', d.id::text, to_jsonb(d) from public.documents d where d.workspace_id=${workspace}
  union all
  select 'document_versions', v.id::text, to_jsonb(v) from public.document_versions v where v.workspace_id=${workspace}
  union all
  select 'rounds', r.id::text, to_jsonb(r) - 'coverage_revision'
    from public.correction_rounds r where r.workspace_id=${workspace}
  union all
  select 'round_items', i.id::text, to_jsonb(i) - 'coverage_revision' - 'opened_assignee_id'
    from public.correction_round_items i where i.workspace_id=${workspace}
  union all
  select 'submissions', s.id::text, to_jsonb(s) from public.correction_submissions s where s.workspace_id=${workspace}
  union all
  select 'submission_items', si.submission_id::text || '|' || si.round_item_id::text, to_jsonb(si)
    from public.correction_submission_items si where si.workspace_id=${workspace}
  union all
  select 'audit_events', a.id::text, to_jsonb(a)
    from public.audit_events a where a.workspace_id=${workspace}
  union all
  select 'review_commands', c.actor_id::text || '|' || c.operation || '|' || c.idempotency_key, to_jsonb(c)
    from private.review_commands c where c.workspace_id=${workspace}
  union all
  select 'workflow_notifications', n.id::text, to_jsonb(n)
    from public.notification_events n where n.workspace_id=${workspace}
  union all
  select 'candidates', c.id::text, to_jsonb(c) - 'coverage_revision'
    from public.correction_candidates c where c.workspace_id=${workspace}
  union all
  select 'candidate_items', ci.candidate_id::text || '|' || ci.round_item_id::text, to_jsonb(ci)
    from public.correction_candidate_items ci where ci.workspace_id=${workspace}
  union all
  select 'candidate_decisions', d.id::text, to_jsonb(d)
    from public.correction_candidate_decisions d where d.workspace_id=${workspace}
  union all
  select 'approval_contributions', c.approval_id::text || '|' || c.contributor_id::text, to_jsonb(c)
    from public.correction_approval_contributions c where c.workspace_id=${workspace}
  union all
  select 'returns', r.id::text, to_jsonb(r) from public.correction_returns r where r.workspace_id=${workspace}
  union all
  select 'return_items', i.return_id::text || '|' || i.round_item_id::text, to_jsonb(i)
    from public.correction_return_items i where i.workspace_id=${workspace}
  union all
  select 'credit_ledger', l.id::text, to_jsonb(l) from public.credit_ledger l where l.workspace_id=${workspace}
  union all
  select 'ingestion_jobs', j.version_id::text, to_jsonb(j) from private.ingestion_jobs j where j.workspace_id=${workspace}
)
select coalesce(string_agg(kind || '|' || row_id || '|' || md5(row_data::text), E'\\n' order by kind, row_id), '')
from selected_rows;
`;
}

function seedUpgradeHistory(container) {
  queryDatabase(container, historyFixtureSql, "S2 preservation fixture setup");
  const counts = queryDatabase(container, s2HistoryCountsSql, "S2 preservation fixture inventory");
  if (counts !== "1|2|1|1|1") throw new Error("The synthetic S2 history fixture is incomplete.");
  const originalStoragePath = queryDatabase(container, `
select v.storage_path
from public.analyses a
join public.analysis_documents d on d.analysis_id=a.id and d.workspace_id=a.workspace_id
join public.document_versions v on v.id=d.version_id and v.workspace_id=d.workspace_id
where a.idempotency_key='${fixtureKey}' and d.role='source'
order by d.document_id
limit 1;
`, "S2 original Storage path fixture lookup");
  reviewStorageObjectUrl("http://127.0.0.1:54321", originalStoragePath, "upload");
  return originalStoragePath;
}

function assertHistoryUnchanged(container, baseline, stage) {
  const current = queryDatabase(container, s2HistoryHashSql, `${stage} history comparison`);
  if (current !== baseline) throw new Error(`${stage} changed original S2 row values.`);
}

function assertS3Defaults(container) {
  const actual = queryDatabase(container, s3DefaultsSql, "S3 default and retained notification check");
  if (actual !== "true|true|1|4|1") {
    throw new Error(`S3 defaults or existing S2 notification references do not match the expected shape (${actual}).`);
  }
}

function assertS3MigrationCounts(container, s3_01Expected, s3_02Expected, stage) {
  const s3_01Actual = queryDatabase(container, s3_01MigrationCountSql, `${stage} S3-01 migration history check`);
  const s3_02Actual = queryDatabase(container, s3_02MigrationCountSql, `${stage} S3-02 migration history check`);
  if (s3_01Actual !== String(s3_01Expected) || s3_02Actual !== String(s3_02Expected)) {
    throw new Error(`${stage} migration history does not match its exact S3-01/S3-02 allowlists.`);
  }
}

function assertReviewCoverageBackfill(container, fixture) {
  const workspace = `'${fixture.workspaceId}'::uuid`;
  const sql = `
select
  (not exists (select 1 from public.correction_rounds r
    where r.workspace_id=${workspace} and r.coverage_revision <> r.revision))::text || '|' ||
  (not exists (select 1 from public.correction_round_items i
    join public.correction_rounds r on r.id=i.round_id and r.workspace_id=i.workspace_id
    where i.workspace_id=${workspace} and (i.coverage_revision <> i.revision
      or (r.opened_at is null and i.opened_assignee_id is not null)
      or (r.opened_at is not null and i.opened_assignee_id is distinct from i.initial_assignee_id))))::text || '|' ||
  (not exists (select 1 from public.correction_candidates c
    join public.correction_rounds r on r.id=c.round_id and r.workspace_id=c.workspace_id
    where c.workspace_id=${workspace} and c.id=r.active_candidate_id
      and c.status in ('selected','processing','failed','pending_approval','approved')
      and c.coverage_revision <> r.coverage_revision))::text || '|' ||
  exists (select 1 from public.correction_rounds r
    where r.id='${fixture.draftRoundId}'::uuid and r.status='draft' and r.opened_at is null)::text || '|' ||
  exists (select 1 from public.correction_submissions s
    join public.correction_submission_items si on si.submission_id=s.id
    where s.id='${fixture.groupedSubmissionId}'::uuid and s.state='confirmed'
    group by s.id having count(*) > 1)::text || '|' ||
  exists (select 1 from public.correction_rounds r join public.correction_candidates c
    on c.id=r.active_candidate_id and c.round_id=r.id
    where r.id='${fixture.processingRoundId}'::uuid and r.status='candidate_processing' and c.status='processing')::text || '|' ||
  exists (select 1 from public.correction_rounds r join public.correction_candidates c
    on c.id=r.active_candidate_id and c.round_id=r.id
    where r.id='${fixture.pendingRoundId}'::uuid and r.status='pending_approval' and c.status='pending_approval')::text || '|' ||
  exists (select 1 from public.correction_candidates c
    where c.id='${fixture.rejectedCandidateId}'::uuid and c.status='rejected')::text || '|' ||
  exists (select 1 from public.correction_candidates c
    where c.id='${fixture.approvedCandidateId}'::uuid and c.status='approved')::text;
`;
  const actual = queryDatabase(container, sql, "S3-02 coverage and opening-assignee backfill check");
  if (actual !== "true|true|true|true|true|true|true|true|true") {
    throw new Error(`S3-02 backfill did not preserve valid S3-01 review history (${actual}).`);
  }
}

function assertReviewConstraintsImmediate(container, stage) {
  queryDatabase(container, "begin;\nset constraints all immediate;\ncommit;", stage);
}

function capturePendingReassignmentBaseline(container, fixture) {
  const sql = `
select f.review_revision::text || '|' || i.revision::text || '|' || i.coverage_revision::text || '|' ||
  i.current_submission_id::text || '|' || r.revision::text || '|' || r.coverage_revision::text || '|' ||
  c.revision::text || '|' || c.coverage_revision::text || '|' || c.version_id::text || '|' ||
  ci.item_revision::text || '|' || s.submitter_id::text || '|' || s.state::text
from public.findings f
join public.correction_round_items i on i.finding_id=f.id and i.workspace_id=f.workspace_id
join public.correction_rounds r on r.id=i.round_id and r.workspace_id=i.workspace_id
join public.correction_candidates c on c.id=r.active_candidate_id and c.round_id=r.id
join public.correction_candidate_items ci on ci.candidate_id=c.id and ci.round_item_id=i.id
join public.correction_submissions s on s.id=ci.submission_id and s.workspace_id=ci.workspace_id
where f.id='${fixture.pendingFindingId}'::uuid and r.id='${fixture.pendingRoundId}'::uuid
  and c.id='${fixture.pendingCandidateId}'::uuid;
`;
  const values = queryDatabase(container, sql, "S3-02 pending-candidate reassignment baseline").split("|");
  if (values.length !== 12 || values.some((value, index) => index !== 11 && index !== 3 && index !== 8 && index !== 10 && !/^\d+$/.test(value))
    || !/^[0-9a-f-]{36}$/i.test(values[3]) || !/^[0-9a-f-]{36}$/i.test(values[8])
    || !/^[0-9a-f-]{36}$/i.test(values[10]) || values[11] !== "confirmed") {
    throw new Error("The S3-02 pending-candidate preservation marker was invalid.");
  }
  return values;
}

function reassignPendingCandidateFinding(container, fixture) {
  const sql = `
select public.review_assign_finding(
  '${fixture.adminId}'::uuid,
  '${fixture.pendingFindingId}'::uuid,
  (select review_revision from public.findings where id='${fixture.pendingFindingId}'::uuid),
  '${fixture.memberBId}'::uuid,
  's3-02-upgrade-first-reassignment'
) is not null;
`;
  const actual = queryDatabase(container, sql, "First S3-02 product reassignment");
  if (actual !== "t") throw new Error("The first S3-02 reassignment did not return its product snapshot.");
}

function assertPendingReassignmentPreservedCoverage(container, fixture, baseline) {
  const sql = `
select (
  f.assignee_id='${fixture.memberBId}'::uuid and f.review_revision=${Number(baseline[0]) + 1}
  and i.assignee_id='${fixture.memberBId}'::uuid and i.revision=${Number(baseline[1]) + 1}
  and i.coverage_revision=${baseline[2]}::bigint and i.current_submission_id='${baseline[3]}'::uuid
  and i.opened_assignee_id=i.initial_assignee_id
  and r.revision=${Number(baseline[4]) + 1} and r.coverage_revision=${baseline[5]}::bigint
  and r.status='pending_approval' and r.active_candidate_id='${fixture.pendingCandidateId}'::uuid
  and c.status='pending_approval' and c.revision=${baseline[6]}::bigint
  and c.coverage_revision=${baseline[7]}::bigint and c.version_id='${baseline[8]}'::uuid
  and c.selected_by='${fixture.adminId}'::uuid
  and ci.item_revision=${baseline[9]}::bigint and ci.item_revision=i.coverage_revision
  and s.submitter_id='${baseline[10]}'::uuid and s.state='confirmed'
  and (select count(*) from public.correction_candidate_items x where x.candidate_id=c.id)
      = (select count(*) from public.correction_round_items x where x.round_id=r.id)
)::text
from public.findings f
join public.correction_round_items i on i.finding_id=f.id and i.workspace_id=f.workspace_id
join public.correction_rounds r on r.id=i.round_id and r.workspace_id=i.workspace_id
join public.correction_candidates c on c.id=r.active_candidate_id and c.round_id=r.id
join public.correction_candidate_items ci on ci.candidate_id=c.id and ci.round_item_id=i.id
join public.correction_submissions s on s.id=ci.submission_id and s.workspace_id=ci.workspace_id
where f.id='${fixture.pendingFindingId}'::uuid and r.id='${fixture.pendingRoundId}'::uuid
  and c.id='${fixture.pendingCandidateId}'::uuid;
`;
  const actual = queryDatabase(container, sql, "S3-02 reassignment coverage-fence check");
  if (actual !== "true") throw new Error("Reassignment changed confirmed coverage or invalidated its active candidate.");
}

function cleanupOwnedProject(projectId, ownerRoot, temporaryRoot, failures, stage) {
  const normalizedRoot = resolve(temporaryRoot);
  if (!isReviewUpgradeTemporaryRoot(normalizedRoot, tmpdir(), `kdm-s3-review-${stage}-`)) {
    failures.push("Refusing to remove a temporary path outside this runner's workspace.");
    return false;
  }
  let resourcesRemoved = false;
  try {
    const containers = projectContainers(projectId);
    if (containers.length) {
      const owned = ownedContainers(projectId, ownerRoot);
      if (!reviewProjectResourcesOwned(containers, owned)) {
        throw new Error("A project container is not owned by this run.");
      }
      runSupabase(["stop", "--no-backup", "--workdir", ownerRoot], `${stage} stack stop`, ownerRoot);
    }
    if (projectContainers(projectId).length || projectVolumes(projectId).length) {
      throw new Error("The disposable project left containers or volumes behind.");
    }
    resourcesRemoved = true;
  } catch (error) {
    failures.push(error instanceof Error ? error.message : `${stage} cleanup failed.`);
  }

  if (!resourcesRemoved) {
    failures.push(`${stage} temporary workspace retained for safe inspection: ${normalizedRoot}`);
    return false;
  }
  try {
    rmSync(normalizedRoot, { recursive: true, force: true });
    return true;
  } catch {
    failures.push(`${stage} temporary workspace cleanup failed: ${normalizedRoot}`);
    return false;
  }
}

async function runUpgradeScenario(migrations, failures) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "kdm-s3-review-upgrade-"));
  const projectId = `kdm-s3-review-upgrade-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const portBase = await choosePortBase();
  const s2Root = join(temporaryRoot, "s2");
  const s3_01Root = join(temporaryRoot, "s3_01");
  const s3_02Root = join(temporaryRoot, "s3_02");
  let started = false;
  try {
    assertNoStack(projectId);
    prepareWorkspace(s2Root, projectId, portBase, "s2", migrations);
    prepareWorkspace(s3_01Root, projectId, portBase, "s3_01", migrations);
    prepareWorkspace(s3_02Root, projectId, portBase, "s3_02", migrations);
    assertNoStack(projectId);
    await assertPortRangeAvailable(portBase);
    runSupabase(["start", "--debug", "--exclude", excludedServices.join(","), "--workdir", s2Root], "S2 baseline stack start", s2Root);
    started = true;
    const database = assertOwnedDatabase(projectId, s2Root);
    runSupabase(["db", "reset", "--local", "--workdir", s2Root], "S2 baseline migration and seed reset", s2Root);
    const originalStoragePath = seedUpgradeHistory(database);
    const storageRuntime = reviewStorageRuntime(
      s2Root,
      `http://127.0.0.1:${portBase + 1}`,
      originalStoragePath,
    );
    await requestReviewStorageObject(storageRuntime, originalStoragePath, "POST", "S2 original upload");
    await requestReviewStorageObject(storageRuntime, originalStoragePath, "GET", "S2 original byte check");
    const historyBaseline = queryDatabase(database, s2HistoryHashSql, "S2 original-column baseline");
    assertS3MigrationCounts(database, 0, 0, "S2 baseline");

    runSupabase(["migration", "up", "--local", "--workdir", s3_01Root], "S3-01 upgrade", s3_01Root);
    await requestReviewStorageObject(storageRuntime, originalStoragePath, "GET", "S3-01 original byte check");
    assertHistoryUnchanged(database, historyBaseline, "S3-01 upgrade");
    assertS3Defaults(database);
    assertS3MigrationCounts(database, 6, 0, "S3-01 upgrade");
    runSupabase(["migration", "up", "--local", "--workdir", s3_01Root], "S3-01 idempotent reapply", s3_01Root);
    await requestReviewStorageObject(storageRuntime, originalStoragePath, "GET", "S3-01 reapply original byte check");
    assertHistoryUnchanged(database, historyBaseline, "S3-01 idempotent reapply");
    assertS3Defaults(database);
    assertS3MigrationCounts(database, 6, 0, "S3-01 idempotent reapply");

    const reviewFixture = seedReviewUpgradeHistory(database);
    const reviewBaseline = queryDatabase(
      database,
      reviewPreservationHashSql(reviewFixture.workspaceId),
      "S3-01 review-state baseline",
    );
    runSupabase(["migration", "up", "--local", "--workdir", s3_02Root], "S3-02 upgrade", s3_02Root);
    await requestReviewStorageObject(storageRuntime, originalStoragePath, "GET", "S3-02 original byte check");
    assertHistoryUnchanged(database, historyBaseline, "S3-02 upgrade");
    assertS3Defaults(database);
    assertS3MigrationCounts(database, 6, 7, "S3-02 upgrade");
    assertReviewCoverageBackfill(database, reviewFixture);
    assertReviewConstraintsImmediate(database, "S3-02 deferred constraint validation");
    const preservedReviewState = queryDatabase(
      database,
      reviewPreservationHashSql(reviewFixture.workspaceId),
      "S3-02 legacy review-state comparison",
    );
    if (preservedReviewState !== reviewBaseline) {
      throw new Error("S3-02 changed S3-01 review rows beyond the documented coverage backfill.");
    }

    const reassignmentBaseline = capturePendingReassignmentBaseline(database, reviewFixture);
    reassignPendingCandidateFinding(database, reviewFixture);
    assertPendingReassignmentPreservedCoverage(database, reviewFixture, reassignmentBaseline);
    const reassignedHistoryBaseline = queryDatabase(database, s2HistoryHashSql, "Post-reassignment S2 history baseline");
    const reassignedReviewBaseline = queryDatabase(
      database,
      reviewPreservationHashSql(reviewFixture.workspaceId),
      "Post-reassignment review-state baseline",
    );

    runSupabase(["migration", "up", "--local", "--workdir", s3_02Root], "S3-02 idempotent reapply", s3_02Root);
    await requestReviewStorageObject(storageRuntime, originalStoragePath, "GET", "S3-02 reapply original byte check");
    assertHistoryUnchanged(database, reassignedHistoryBaseline, "S3-02 idempotent reapply");
    assertS3Defaults(database);
    assertS3MigrationCounts(database, 6, 7, "S3-02 idempotent reapply");
    assertReviewConstraintsImmediate(database, "S3-02 idempotent deferred constraint validation");
    assertPendingReassignmentPreservedCoverage(database, reviewFixture, reassignmentBaseline);
    const reassignedReviewState = queryDatabase(
      database,
      reviewPreservationHashSql(reviewFixture.workspaceId),
      "S3-02 idempotent review-state comparison",
    );
    if (reassignedReviewState !== reassignedReviewBaseline) {
      throw new Error("S3-02 idempotent reapply changed review state.");
    }
  } finally {
    if (!cleanupOwnedProject(projectId, s2Root, temporaryRoot, failures, "upgrade")) {
      if (!started) failures.push("The S2-to-S3-02 temporary project was not started.");
    }
  }
}

async function runFreshScenario(migrations, failures) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "kdm-s3-review-fresh-"));
  const projectId = `kdm-s3-review-fresh-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const portBase = await choosePortBase();
  const freshRoot = join(temporaryRoot, "project");
  let started = false;
  try {
    assertNoStack(projectId);
    prepareWorkspace(freshRoot, projectId, portBase, "s3_02", migrations);
    assertNoStack(projectId);
    await assertPortRangeAvailable(portBase);
    runSupabase(["start", "--debug", "--exclude", excludedServices.join(","), "--workdir", freshRoot], "Fresh S3-02 stack start", freshRoot);
    started = true;
    const database = assertOwnedDatabase(projectId, freshRoot);
    runSupabase(["db", "reset", "--local", "--workdir", freshRoot], "Fresh S3-02 migration and seed reset", freshRoot);
    assertS3MigrationCounts(database, 6, 7, "Fresh S3-02 install");
    runSupabase(["test", "db", "--local", "--workdir", freshRoot], "Fresh S3-02 pgTAP suite", freshRoot);
    assertS3MigrationCounts(database, 6, 7, "Fresh S3-02 pgTAP suite");
  } finally {
    if (!cleanupOwnedProject(projectId, freshRoot, temporaryRoot, failures, "fresh")) {
      if (!started) failures.push("The fresh S3-02 temporary project was not started.");
    }
  }
}

async function main(args) {
  parseReviewUpgradeMode(args);
  const migrations = migrationInventory();
  const failures = [];
  console.log("Starting isolated S2-to-S3-02 upgrade and clean-install verification.");
  try {
    await runUpgradeScenario(migrations, failures);
    if (!failures.length) await runFreshScenario(migrations, failures);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : "Review upgrade verification failed.");
  }
  if (failures.length) {
    for (const failure of failures) console.error(failure);
    return 1;
  }
  console.log("PASS: S2-to-S3-02 upgrade preserved original Storage bytes and S3-01 review data; first reassignment retained coverage; clean S3-02 install and pgTAP passed.");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : "Review upgrade verification failed.");
    process.exitCode = 1;
  });
}
