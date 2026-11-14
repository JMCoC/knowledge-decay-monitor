// Proves S2-to-S3-01 upgrade preservation and a clean S3-01 install using
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
const s3MigrationNames = [
  "20261108150000_s3_01_review_enums.sql",
  "20261108150100_s3_01_review_model.sql",
  "20261108150200_s3_01_review_integrity.sql",
  "20261108150300_s3_01_review_security.sql",
  "20261108150400_s3_01_review_audit_outbox.sql",
  "20261108150500_s3_01_approval_contribution_check.sql",
];
const workspaceA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const adminA = "10000000-0000-4000-8000-000000000001";
const memberA = "10000000-0000-4000-8000-000000000003";
const fixtureKey = "s3-01-upgrade-preservation";
const fixtureFingerprint = "s3-01-upgrade-preservation";
const notificationId = "91000000-0000-4000-8000-000000000901";

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
  (select count(*)::text from public.findings where review_revision = 1) || '|' ||
  (select count(*)::text from public.document_versions where workflow_kind = 'initial') || '|' ||
  (select count(*)::text from public.notification_events where analysis_id is not null and type is not null and workflow_event_id is null and workflow_type is null);
`;

const s3MigrationCountSql = `
select count(*)::text from supabase_migrations.schema_migrations
where version = any(array[${s3MigrationNames.map((name) => `'${name.slice(0, 14)}'`).join(",")}]);
`;

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
    const detail = redactCliOutput(captured);
    throw new Error(detail ? `${stage} failed.\n${detail}` : `${stage} failed.`);
  }
}

function runSupabase(args, stage, cwd) {
  return runCaptured(process.execPath, [supabaseCli, ...args], stage, cwd);
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
  const s3Names = files.filter((file) => file.stage === "s3_01").map((file) => file.name).sort();
  if (JSON.stringify(s3Names) !== JSON.stringify([...s3MigrationNames].sort())) {
    throw new Error("The filesystem S3-01 migration inventory differs from its reviewed allowlist.");
  }
  return files;
}

function includeAtStage(file, stage) {
  if (!includeReviewMigration(file.relativePath, stage)) return false;
  return stage === "s2"
    ? includeMigration(file.relativePath, "s2_11")
    : includeMigration(file.relativePath, "s3_01");
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

function seedUpgradeHistory(container) {
  queryDatabase(container, historyFixtureSql, "S2 preservation fixture setup");
  const counts = queryDatabase(container, s2HistoryCountsSql, "S2 preservation fixture inventory");
  if (counts !== "1|2|1|1|1") throw new Error("The synthetic S2 history fixture is incomplete.");
  return queryDatabase(container, s2HistoryHashSql, "S2 original-column baseline");
}

function assertHistoryUnchanged(container, baseline, stage) {
  const current = queryDatabase(container, s2HistoryHashSql, `${stage} history comparison`);
  if (current !== baseline) throw new Error(`${stage} changed original S2 row values.`);
}

function assertS3Defaults(container) {
  const actual = queryDatabase(container, s3DefaultsSql, "S3 default and retained notification check");
  if (actual !== "true|true|1|5|1") {
    throw new Error("S3 defaults or existing S2 notification references do not match the expected shape.");
  }
}

function assertS3MigrationCount(container) {
  const actual = queryDatabase(container, s3MigrationCountSql, "S3 migration history check");
  if (actual !== String(s3MigrationNames.length)) {
    throw new Error("The disposable project did not apply the complete S3-01 migration allowlist.");
  }
}

function cleanupOwnedProject(projectId, ownerRoot, temporaryRoot, failures, stage) {
  const normalizedRoot = resolve(temporaryRoot);
  if (!isReviewUpgradeTemporaryRoot(normalizedRoot, tmpdir(), `kdm-s3-01-${stage}-`)) {
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
  const temporaryRoot = mkdtempSync(join(tmpdir(), "kdm-s3-01-upgrade-"));
  const projectId = `kdm-s3-01-upgrade-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const portBase = await choosePortBase();
  const s2Root = join(temporaryRoot, "s2");
  const s3Root = join(temporaryRoot, "s3");
  let started = false;
  try {
    assertNoStack(projectId);
    prepareWorkspace(s2Root, projectId, portBase, "s2", migrations);
    prepareWorkspace(s3Root, projectId, portBase, "s3_01", migrations);
    assertNoStack(projectId);
    await assertPortRangeAvailable(portBase);
    runSupabase(["start", "--exclude", excludedServices.join(","), "--workdir", s2Root], "S2 baseline stack start", s2Root);
    started = true;
    const database = assertOwnedDatabase(projectId, s2Root);
    runSupabase(["db", "reset", "--local", "--workdir", s2Root], "S2 baseline migration and seed reset", s2Root);
    const historyBaseline = seedUpgradeHistory(database);
    runSupabase(["migration", "up", "--local", "--workdir", s3Root], "S3-01 upgrade", s3Root);
    assertHistoryUnchanged(database, historyBaseline, "S3-01 upgrade");
    assertS3Defaults(database);
    assertS3MigrationCount(database);
    runSupabase(["migration", "up", "--local", "--workdir", s3Root], "S3-01 idempotent reapply", s3Root);
    assertHistoryUnchanged(database, historyBaseline, "S3-01 idempotent reapply");
    assertS3Defaults(database);
    assertS3MigrationCount(database);
  } finally {
    if (!cleanupOwnedProject(projectId, s2Root, temporaryRoot, failures, "upgrade")) {
      if (!started) failures.push("The S2-to-S3-01 temporary project was not started.");
    }
  }
}

async function runFreshScenario(migrations, failures) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "kdm-s3-01-fresh-"));
  const projectId = `kdm-s3-01-fresh-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const portBase = await choosePortBase();
  const freshRoot = join(temporaryRoot, "project");
  let started = false;
  try {
    assertNoStack(projectId);
    prepareWorkspace(freshRoot, projectId, portBase, "s3_01", migrations);
    assertNoStack(projectId);
    await assertPortRangeAvailable(portBase);
    runSupabase(["start", "--exclude", excludedServices.join(","), "--workdir", freshRoot], "Fresh S3-01 stack start", freshRoot);
    started = true;
    const database = assertOwnedDatabase(projectId, freshRoot);
    runSupabase(["db", "reset", "--local", "--workdir", freshRoot], "Fresh S3-01 migration and seed reset", freshRoot);
    assertS3MigrationCount(database);
    runSupabase(["test", "db", "--local", "--workdir", freshRoot], "Fresh S3-01 pgTAP suite", freshRoot);
    assertS3MigrationCount(database);
  } finally {
    if (!cleanupOwnedProject(projectId, freshRoot, temporaryRoot, failures, "fresh")) {
      if (!started) failures.push("The fresh S3-01 temporary project was not started.");
    }
  }
}

async function main(args) {
  parseReviewUpgradeMode(args);
  const migrations = migrationInventory();
  const failures = [];
  console.log("Starting isolated S2-to-S3-01 upgrade and clean-install verification.");
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
  console.log("PASS: S2-to-S3-01 upgrade preserved original data; clean install and S3-01 pgTAP passed.");
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
