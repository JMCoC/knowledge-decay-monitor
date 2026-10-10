import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.CI !== "true" || process.env.GITHUB_ACTIONS !== "true") {
  console.error("Disposable CI is required.");
  process.exit(1);
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationRoot = "supabase/migrations/";
const excludedS2Migrations = new Set([
  `${migrationRoot}20261010192119_s2_01_analysis_tables.sql`,
  `${migrationRoot}20261010193514_s2_01_analysis_integrity.sql`,
  `${migrationRoot}20261010194238_s2_01_analysis_security.sql`,
  `${migrationRoot}20261010195500_s2_01_finding_initial_state.sql`,
]);
const seededS2TableList = "'analyses','analysis_documents','credit_ledger','findings','finding_evidence','notification_events'";
const seededS2ViewList = "'analysis_runs','analysis_scope','analysis_findings','analysis_finding_evidence'";

const s1RowsHashSql = `
with selected_rows(kind, row_id, row_data) as (
  select 'workspaces', w.id::text, to_jsonb(w)
  from public.workspaces w
  where w.id in (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid
  )
  union all
  select 'profiles', p.id::text, to_jsonb(p)
  from public.profiles p
  where p.id in (
    '10000000-0000-4000-8000-000000000001'::uuid,
    '10000000-0000-4000-8000-000000000002'::uuid,
    '10000000-0000-4000-8000-000000000003'::uuid,
    '10000000-0000-4000-8000-000000000004'::uuid
  )
  union all
  select 'documents', d.id::text, to_jsonb(d)
  from public.documents d
  where d.id in (
    '20000000-0000-4000-8000-000000000001'::uuid,
    '20000000-0000-4000-8000-000000000002'::uuid,
    '20000000-0000-4000-8000-000000000003'::uuid,
    '20000000-0000-4000-8000-000000000004'::uuid
  )
  union all
  select 'document_versions', v.id::text, to_jsonb(v)
  from public.document_versions v
  where v.id in (
    '30000000-0000-4000-8000-000000000001'::uuid,
    '30000000-0000-4000-8000-000000000002'::uuid,
    '30000000-0000-4000-8000-000000000003'::uuid,
    '30000000-0000-4000-8000-000000000004'::uuid
  )
  union all
  select 'document_chunks', c.id::text, to_jsonb(c)
  from public.document_chunks c
  where c.id in (
    '40000000-0000-4000-8000-000000000001'::uuid,
    '40000000-0000-4000-8000-000000000002'::uuid,
    '40000000-0000-4000-8000-000000000003'::uuid
  )
)
select coalesce(string_agg(kind || '|' || row_id || '|' || md5(row_data::text), E'\\n' order by kind, row_id), '')
from selected_rows;
`;

const s1SecurityHashSql = `
with facts(kind, identity, detail) as (
  select 'table-grant', table_name || '|' || grantee || '|' || privilege_type,
    grantor || '|' || is_grantable
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name = any(array['profiles','documents','document_versions','document_chunks'])
  union all
  select 'column-grant', table_name || '|' || column_name || '|' || grantee || '|' || privilege_type,
    grantor || '|' || is_grantable
  from information_schema.column_privileges
  where table_schema = 'public'
    and table_name = any(array['profiles','documents','document_versions','document_chunks'])
  union all
  select 'policy', schemaname || '.' || tablename || '|' || policyname,
    cmd || '|' || array_to_string(roles, ',') || '|' || coalesce(qual, '') || '|' || coalesce(with_check, '')
  from pg_catalog.pg_policies
  where (schemaname = 'public' and tablename = any(array['profiles','documents','document_versions','document_chunks']))
     or (schemaname = 'storage' and tablename = 'objects')
  union all
  select 'bucket', id, public::text || '|' || coalesce(file_size_limit::text, '') || '|' || coalesce(array_to_string(allowed_mime_types, ','), '')
  from storage.buckets
  where id = 'documents'
  union all
  select 'function', 'bootstrap_workspace', md5(pg_get_functiondef('public.bootstrap_workspace(text,text)'::regprocedure))
  union all
  select 'function-grant', role_name, has_function_privilege(role_name, 'public.bootstrap_workspace(text,text)', 'execute')::text
  from unnest(array['anon','authenticated','service_role']) role_name
  union all
  select 'table-privilege', role_name || '|documents|select', has_table_privilege(role_name, 'public.documents', 'select')::text
  from unnest(array['anon','authenticated','service_role']) role_name
)
select md5(coalesce(string_agg(kind || '|' || identity || '|' || detail, E'\\n' order by kind, identity, detail), ''))
from facts;
`;

const s1ShapeSql = `
select
  (select count(*) from public.workspaces where id in ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid)) || '|' ||
  (select count(*) from public.profiles where id in ('10000000-0000-4000-8000-000000000001'::uuid,'10000000-0000-4000-8000-000000000002'::uuid,'10000000-0000-4000-8000-000000000003'::uuid,'10000000-0000-4000-8000-000000000004'::uuid)) || '|' ||
  (select count(*) from public.documents where id::text like '20000000-0000-4000-8000-%') || '|' ||
  (select count(*) from public.document_versions where id::text like '30000000-0000-4000-8000-%') || '|' ||
  (select count(*) from public.document_chunks where id::text like '40000000-0000-4000-8000-%') || '|' ||
  (select count(*) from pg_catalog.pg_class where relnamespace = 'public'::regnamespace and relname = any(array['profiles','documents','document_versions','document_chunks']) and relrowsecurity);
`;

const s2SecuritySql = `
select
  (select count(*) from pg_catalog.pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relname = any(array[${seededS2TableList}])) || '|' ||
  (select count(*) from pg_catalog.pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relrowsecurity and relname = any(array[${seededS2TableList}])) || '|' ||
  (select count(*) from pg_catalog.pg_class where relnamespace = 'public'::regnamespace and relkind = 'v' and reloptions @> array['security_invoker=true'] and relname = any(array[${seededS2ViewList}])) || '|' ||
  (select public::text from storage.buckets where id = 'documents') || '|' ||
  has_table_privilege('authenticated','public.notification_events','select')::text || '|' ||
  has_table_privilege('authenticated','public.credit_ledger','select')::text || '|' ||
  has_column_privilege('authenticated','public.credit_ledger','event_type','select')::text || '|' ||
  has_column_privilege('authenticated','public.analyses','error_code','select')::text || '|' ||
  has_table_privilege('authenticated','public.analysis_runs','select')::text || '|' ||
  has_table_privilege('service_role','public.credit_ledger','select')::text || '|' ||
  has_table_privilege('service_role','public.credit_ledger','insert')::text || '|' ||
  has_table_privilege('service_role','public.credit_ledger','update')::text || '|' ||
  has_table_privilege('service_role','public.credit_ledger','delete')::text;
`;

function runCaptured(command, args, stage, cwd = projectRoot) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }).trim();
  } catch {
    throw new Error(`${stage} failed.`);
  }
}

function runQuiet(command, args, stage, cwd = projectRoot) {
  try {
    execFileSync(command, args, {
      cwd,
      stdio: "ignore",
      windowsHide: true,
    });
  } catch {
    throw new Error(`${stage} failed.`);
  }
}

function projectIdFromConfig() {
  const config = readFileSync(join(projectRoot, "supabase", "config.toml"), "utf8");
  const projectId = config.match(/^\s*project_id\s*=\s*"([^"]+)"\s*$/m)?.[1];
  if (!projectId || !/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(projectId)) {
    throw new Error("The Supabase project ID is invalid.");
  }
  return projectId;
}

function projectContainers(projectId) {
  const names = runCaptured("docker", [
    "ps", "-a", "--filter", `name=${projectId}`, "--format", "{{.Names}}",
  ], "Docker container inventory");
  return names.split(/\r?\n/).map((name) => name.trim())
    .filter((name) => name.endsWith(`_${projectId}`));
}

function projectVolumes(projectId) {
  const names = runCaptured("docker", [
    "volume", "ls", "--filter", `name=${projectId}`, "--format", "{{.Name}}",
  ], "Docker volume inventory");
  return names.split(/\r?\n/).map((name) => name.trim())
    .filter((name) => name.endsWith(`_${projectId}`) || name === projectId);
}

function assertNoExistingStack(projectId) {
  if (projectContainers(projectId).length || projectVolumes(projectId).length) {
    throw new Error("Refusing to reuse an existing local stack.");
  }
}

function ownedContainers(projectId, temporaryRoot) {
  const normalizedRoot = resolve(temporaryRoot);
  return projectContainers(projectId).filter((name) => {
    const labelsText = runCaptured("docker", [
      "inspect", "--format", "{{json .Config.Labels}}", name,
    ], "Docker stack ownership check");
    let labels;
    try {
      labels = JSON.parse(labelsText);
    } catch {
      return false;
    }
    return labels?.["com.supabase.cli.project"] === projectId
      && typeof labels?.["com.supabase.cli.workdir"] === "string"
      && resolve(labels["com.supabase.cli.workdir"]) === normalizedRoot;
  });
}

function copyS1Workspace(temporaryRoot) {
  const trackedFiles = runCaptured("git", ["ls-files", "-z", "--", "supabase"], "Supabase source inventory")
    .split("\0")
    .filter(Boolean);
  const supabaseRoot = join(temporaryRoot, "supabase");
  for (const relativeFile of trackedFiles) {
    if (!relativeFile.startsWith("supabase/")) throw new Error("Unexpected Supabase source path.");
    if (excludedS2Migrations.has(relativeFile)) continue;
    if (/(^|\/)\.env(?:\.[^/]*)?$/.test(relativeFile) || /(^|\/)\.temp(?:\/|$)/.test(relativeFile)) continue;
    const source = resolve(projectRoot, relativeFile);
    const destination = resolve(supabaseRoot, relativeFile.slice("supabase/".length).split("/").join(sep));
    if (!destination.startsWith(`${supabaseRoot}${sep}`)) throw new Error("Unexpected Supabase copy destination.");
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
  if (!trackedFiles.includes("supabase/config.toml") || !trackedFiles.includes("supabase/seed.sql")) {
    throw new Error("The tracked S1 Supabase project files are incomplete.");
  }
}

function databaseContainer(projectId, temporaryRoot) {
  const expected = `supabase_db_${projectId}`;
  if (!ownedContainers(projectId, temporaryRoot).includes(expected)) {
    throw new Error("The temporary Supabase database is not owned by this run.");
  }
  const running = runCaptured("docker", [
    "inspect", "--format", "{{.State.Running}}", expected,
  ], "Temporary database health check");
  if (running !== "true") throw new Error("The temporary Supabase database is not running.");
  return expected;
}

function queryDatabase(container, sql, stage) {
  return runCaptured("docker", [
    "exec", container, "psql", "-XAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres", "-c", sql,
  ], stage);
}

function assertS1Baseline(container) {
  const shape = queryDatabase(container, s1ShapeSql, "S1 fixture inventory");
  if (shape !== "2|4|4|4|3|4") throw new Error("The S1 fixture inventory is incomplete.");
  const bucketPublic = queryDatabase(container,
    "select public::text from storage.buckets where id = 'documents';", "S1 storage policy check");
  if (bucketPublic !== "false") throw new Error("The S1 documents bucket is not private.");
  const s2Objects = queryDatabase(container,
    `select count(*)::text from pg_catalog.pg_class where relnamespace = 'public'::regnamespace and relkind in ('r','v') and relname = any(array[${seededS2TableList},${seededS2ViewList}]);`,
    "S2 baseline object check");
  if (s2Objects !== "0") throw new Error("S2 tables or projections were present before the upgrade.");
  const rowSnapshot = queryDatabase(container, s1RowsHashSql, "S1 row snapshot");
  if (rowSnapshot.split(/\r?\n/).length !== 17) throw new Error("The S1 snapshot does not contain all seeded rows.");
  return {
    rowSnapshot,
    securitySnapshot: queryDatabase(container, s1SecurityHashSql, "S1 permission snapshot"),
  };
}

function assertS1Unchanged(container, baseline) {
  const rowSnapshot = queryDatabase(container, s1RowsHashSql, "S1 row comparison");
  const securitySnapshot = queryDatabase(container, s1SecurityHashSql, "S1 permission comparison");
  if (rowSnapshot !== baseline.rowSnapshot) throw new Error("The S2 upgrade changed seeded S1 rows.");
  if (securitySnapshot !== baseline.securitySnapshot) throw new Error("The S2 upgrade changed S1 permissions or policies.");
}

function assertS2Security(container) {
  const actual = queryDatabase(container, s2SecuritySql, "S2 security check");
  const expected = "6|6|4|false|false|false|true|false|true|true|true|false|false";
  if (actual !== expected) throw new Error("The S2 tables, projections, or grants do not match the approved security boundary.");
}

function runSupabase(args, stage, cwd = projectRoot) {
  runQuiet("pnpm", ["exec", "supabase", ...args], stage, cwd);
}

function main() {
  const projectId = projectIdFromConfig();
  assertNoExistingStack(projectId);

  const temporaryRoot = mkdtempSync(join(tmpdir(), "kdm-s2-01-upgrade-"));
  copyS1Workspace(temporaryRoot);

  let startAttempted = false;
  const failures = [];
  try {
    startAttempted = true;
    runSupabase(["start", "--workdir", temporaryRoot], "S1 disposable stack start");
    const container = databaseContainer(projectId, temporaryRoot);
    runSupabase(["db", "reset", "--local", "--workdir", temporaryRoot], "S1 disposable migration and seed reset");

    const baseline = assertS1Baseline(container);
    runSupabase(["migration", "up", "--local", "--workdir", projectRoot], "S2 migration upgrade");
    assertS1Unchanged(container, baseline);
    assertS2Security(container);

    runSupabase(["test", "db", "--local", "--workdir", projectRoot], "Database regression tests");
    assertS1Unchanged(container, baseline);
    assertS2Security(container);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : "Disposable S1 to S2 upgrade failed.");
  } finally {
    if (startAttempted) {
      try {
        if (ownedContainers(projectId, temporaryRoot).length) {
          runSupabase(["stop", "--no-backup", "--workdir", temporaryRoot], "Temporary Supabase stop");
          if (projectContainers(projectId).length || projectVolumes(projectId).length) {
            throw new Error("The temporary Supabase stack left containers or volumes behind.");
          }
        }
      } catch (error) {
        failures.push(error instanceof Error ? error.message : "Temporary Supabase cleanup failed.");
      }
    }
  }

  if (failures.length) throw new Error(failures.join("\n"));
  console.log("S1 to S2 disposable upgrade passed; S1 fixture rows and permissions are unchanged.");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Disposable S1 to S2 upgrade failed.");
  process.exitCode = 1;
}
