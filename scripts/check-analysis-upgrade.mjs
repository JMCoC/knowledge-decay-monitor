import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { filterFunctionConfigForStage, includeFunction, includeMigration } from "./analysis-upgrade-policy.mjs";
import { redactCliOutput } from "./cli-output-redaction.mjs";

if (process.env.CI !== "true" || process.env.GITHUB_ACTIONS !== "true") {
  console.error("Disposable CI is required.");
  process.exit(1);
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationRoot = "supabase/migrations/";
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
  select 'function-signature', 'bootstrap_workspace',
    pg_get_function_identity_arguments(p.oid) || '|' || pg_get_function_result(p.oid)
  from pg_catalog.pg_proc p
  where p.oid = 'public.bootstrap_workspace(text,text)'::regprocedure
  union all
  select 'function-security', 'bootstrap_workspace',
    p.prosecdef::text || '|' || coalesce(array_to_string(p.proconfig, ','), '')
  from pg_catalog.pg_proc p
  where p.oid = 'public.bootstrap_workspace(text,text)'::regprocedure
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

const s2ReadRpcSecuritySql = `
select
  has_function_privilege('authenticated','public.get_credit_snapshot()','execute')::text || '|' ||
  has_function_privilege('authenticated','public.list_credit_ledger(bigint,integer)','execute')::text || '|' ||
  has_function_privilege('authenticated','private.reserve_analysis_credits(uuid,integer)','execute')::text || '|' ||
  has_function_privilege('authenticated','private.settle_analysis_credits(uuid,integer,public.credit_event_type)','execute')::text || '|' ||
  (to_regprocedure('public.reserve_analysis_credits(uuid,integer)') is null)::text || '|' ||
  (to_regprocedure('public.settle_analysis_credits(uuid,integer,public.credit_event_type)') is null)::text;
`;

const s201HistoryHashSql = `
with selected_rows(kind, row_id, row_data) as (
  -- S2-05 and S2-06 add operational columns to public.analyses.
  -- Exclude post-S2-01 columns so this hash compares only S2-01 history.
  -- Extend this list when a later migration adds another column.
  select 'analyses', a.id::text, to_jsonb(a)
    - 'checkpoint' - 'next_attempt_at'
    - 'estimate_id' - 'command_fingerprint'
    - 'continuation_pending' - 'attempt_started_at'
    - 'attempt_deadline_at' - 'analysis_deadline_at'
  from public.analyses a
  where a.workspace_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid
  union all
  select 'analysis_documents', d.analysis_id::text || '|' || d.version_id::text || '|' || d.role::text, to_jsonb(d)
  from public.analysis_documents d
  where d.workspace_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid
  union all
  select 'credit_ledger', l.id::text, to_jsonb(l)
  from public.credit_ledger l
  where l.workspace_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid
  union all
  select 'findings', f.id::text, to_jsonb(f)
  from public.findings f
  where f.workspace_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid
  union all
  select 'finding_evidence', e.id::text, to_jsonb(e)
  from public.finding_evidence e
  where e.workspace_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid
  union all
  select 'notification_events', n.id::text, to_jsonb(n)
  from public.notification_events n
  where n.workspace_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid
)
select coalesce(string_agg(kind || '|' || row_id || '|' || md5(row_data::text), E'\\n' order by kind, row_id), '')
from selected_rows;
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
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    const captured = [error?.stdout, error?.stderr]
      .filter((part) => typeof part === "string" && part.length > 0)
      .join("\n");
    const detail = redactCliOutput(captured);
    throw new Error(detail ? `${stage} failed.\n${detail}` : `${stage} failed.`);
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

function copyS1Workspace(temporaryRoot, stage) {
  const trackedFiles = runCaptured("git", ["ls-files", "-z", "--", "supabase"], "Supabase source inventory")
    .split("\0")
    .filter(Boolean);
  const supabaseRoot = join(temporaryRoot, "supabase");
  const historicalSeed = resolve(projectRoot, "supabase/fixtures/upgrade/s1-seed.sql");
  readFileSync(historicalSeed, "utf8");
  for (const relativeFile of trackedFiles) {
    if (!relativeFile.startsWith("supabase/")) throw new Error("Unexpected Supabase source path.");
    if (relativeFile.startsWith(migrationRoot) && !includeMigration(relativeFile, stage)) continue;
    if (relativeFile.startsWith("supabase/functions/") && !includeFunction(relativeFile, stage)) continue;
    if (/(^|\/)\.env(?:\.[^/]*)?$/.test(relativeFile) || /(^|\/)\.temp(?:\/|$)/.test(relativeFile)) continue;
    const source = relativeFile === "supabase/seed.sql" && stage !== "s2_02"
      ? historicalSeed
      : resolve(projectRoot, relativeFile);
    const destination = resolve(supabaseRoot, relativeFile.slice("supabase/".length).split("/").join(sep));
    if (!destination.startsWith(`${supabaseRoot}${sep}`)) throw new Error("Unexpected Supabase copy destination.");
    mkdirSync(dirname(destination), { recursive: true });
    if (relativeFile === "supabase/config.toml") {
      const config = readFileSync(source, "utf8");
      writeFileSync(destination, filterFunctionConfigForStage(config, stage), "utf8");
    } else {
      copyFileSync(source, destination);
    }
  }
  if (!trackedFiles.includes("supabase/config.toml") || !trackedFiles.includes("supabase/seed.sql")
      || !trackedFiles.includes("supabase/fixtures/upgrade/s1-seed.sql")) {
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

function assertS201Security(container) {
  const actual = queryDatabase(container, s2SecuritySql, "S2 security check");
  const expected = "6|6|4|false|false|false|true|false|true|true|true|false|false";
  if (actual !== expected) throw new Error("The S2-01 tables, projections, or grants do not match their original boundary.");
}

function assertS2Security(container) {
  const actual = queryDatabase(container, s2SecuritySql, "S2-02 security check");
  const expected = "6|6|4|false|false|false|true|false|true|true|false|false|false";
  if (actual !== expected) throw new Error("The S2 tables, projections, or grants do not match the approved security boundary.");
  const rpcSecurity = queryDatabase(container, s2ReadRpcSecuritySql, "S2-02 credit RPC permission check");
  if (rpcSecurity !== "true|true|false|false|true|true") {
    throw new Error("Credit reads must be the only authenticated credit RPCs.");
  }
}

function seedS201CreditHistory(container) {
  queryDatabase(container, `
    begin;
    set constraints all deferred;
    insert into public.analyses(
      id,workspace_id,initiator_id,status,fixed_cost,reserved_credits,idempotency_key,request_fingerprint,
      retrieval_config,pricing_version,prompt_version,output_schema_version,provider_config,
      attempt_count,operation_id,lease_expires_at,started_at,finished_at,error_code
    ) values (
      '90000000-0000-4000-8000-000000000900',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      '10000000-0000-4000-8000-000000000004',
      'completed',3,3,'upgrade-s2-01-credit-history','upgrade-s2-01-credit-history',
      '{"topK":5}'::jsonb,'upgrade-pricing-v1','upgrade-prompt-v1','upgrade-output-v1',
      '{"primary":{"provider":"synthetic"}}'::jsonb,1,null,null,now(),now(),null
    );
    insert into public.analysis_documents(analysis_id,workspace_id,document_id,version_id,role)
    values (
      '90000000-0000-4000-8000-000000000900',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      '20000000-0000-4000-8000-000000000004',
      '30000000-0000-4000-8000-000000000004',
      'source'
    );
    insert into public.credit_ledger(workspace_id,event_type,amount)
    values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Promotional',50);
    insert into public.credit_ledger(workspace_id,event_type,amount,analysis_id)
    values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Reserved',3,'90000000-0000-4000-8000-000000000900');
    insert into public.credit_ledger(workspace_id,event_type,amount,analysis_id)
    values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Consumed',3,'90000000-0000-4000-8000-000000000900');
    commit;
  `, "S2-01 credit history fixture setup");
  const snapshot = queryDatabase(container, s201HistoryHashSql, "S2-01 history snapshot");
  if (snapshot.split(/\r?\n/).length !== 5) {
    throw new Error("The S2-01 history fixture is incomplete.");
  }
  return snapshot;
}

function assertPromotionBalances(container) {
  const actual = queryDatabase(container, `
    select
      (select b.available::text || '|' || b.reserved::text
        from private.credit_balances('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid) b) || '|' ||
      (select b.available::text || '|' || b.reserved::text
        from private.credit_balances('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid) b) || '|' ||
      (select count(*)::text from public.credit_ledger
        where workspace_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid and event_type='Promotional') || '|' ||
      (select count(*)::text from public.credit_ledger
        where workspace_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid and event_type='Promotional');
  `, "S2-02 promotion balance check");
  if (actual !== "50|0|47|0|1|1") {
    throw new Error("S2-02 did not backfill A while preserving B's credit history.");
  }
}

const repeatPromotionBackfillSql = `
do $credit_workspace_backfill$
declare
  v_workspace_id uuid;
begin
  for v_workspace_id in select w.id from public.workspaces w order by w.id loop
    perform private.grant_promotional_credits(v_workspace_id);
  end loop;
end;
$credit_workspace_backfill$;
`;

function runExpectedPromotionConflict(projectRoot) {
  const result = spawnSync("pnpm", [
    "exec", "supabase", "migration", "up", "--local", "--workdir", projectRoot,
  ], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status === 0) {
    throw new Error("The conflicting promotion migration did not fail as expected.");
  }
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (!/P2002/.test(output)) {
    throw new Error("The conflicting promotion migration failed without the expected P2002 state.");
  }
}

function stopOwnedStack(projectId, temporaryRoot, stage, failures) {
  if (!temporaryRoot) return true;
  try {
    if (ownedContainers(projectId, temporaryRoot).length) {
      runSupabase(["stop", "--no-backup", "--workdir", temporaryRoot], `${stage} stop`);
    }
    if (projectContainers(projectId).length || projectVolumes(projectId).length) {
      throw new Error("The temporary Supabase stack left containers or volumes behind.");
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : `${stage} cleanup failed.`);
    return false;
  }
  try {
    rmSync(temporaryRoot, { recursive: true, force: true });
  } catch {
    failures.push(`${stage} temporary workspace cleanup failed.`);
    return false;
  }
  return true;
}

function runSupabase(args, stage, cwd = projectRoot) {
  runQuiet("pnpm", ["exec", "supabase", ...args], stage, cwd);
}

function main() {
  const projectId = projectIdFromConfig();
  assertNoExistingStack(projectId);
  let s1Root = mkdtempSync(join(tmpdir(), "kdm-s2-02-s1-"));
  let s201Root = mkdtempSync(join(tmpdir(), "kdm-s2-02-s201-"));
  let conflictRoot;
  const failures = [];
  try {
    copyS1Workspace(s1Root, "s1");
    copyS1Workspace(s201Root, "s2_01");

    runSupabase(["start", "--workdir", s1Root], "S1 disposable stack start");
    const container = databaseContainer(projectId, s1Root);
    runSupabase(["db", "reset", "--local", "--workdir", s1Root], "S1 disposable migration and seed reset");

    const baseline = assertS1Baseline(container);
    runSupabase(["migration", "up", "--local", "--workdir", s201Root], "S2-01 migration upgrade");
    assertS1Unchanged(container, baseline);
    assertS201Security(container);

    const s201HistoryBaseline = seedS201CreditHistory(container);
    assertS1Unchanged(container, baseline);

    runSupabase(["migration", "up", "--local", "--workdir", projectRoot], "S2-02 migration upgrade");
    assertS1Unchanged(container, baseline);
    assertS2Security(container);
    assertPromotionBalances(container);
    if (queryDatabase(container, s201HistoryHashSql, "S2-01 history comparison") !== s201HistoryBaseline) {
      throw new Error("The S2-02 migration changed existing S2-01 analysis or credit history.");
    }

    queryDatabase(container, repeatPromotionBackfillSql, "Idempotent promotional backfill replay");
    assertPromotionBalances(container);
    if (queryDatabase(container, s201HistoryHashSql, "S2-01 idempotency comparison") !== s201HistoryBaseline) {
      throw new Error("Replaying the promotion backfill changed existing S2-01 history.");
    }

    runSupabase(["test", "db", "--local", "--workdir", projectRoot], "Database regression tests");
    assertS1Unchanged(container, baseline);
    assertS2Security(container);
    assertPromotionBalances(container);
    if (queryDatabase(container, s201HistoryHashSql, "Post-test S2-01 history comparison") !== s201HistoryBaseline) {
      throw new Error("Database regression tests changed the preserved S2-01 history.");
    }

    if (stopOwnedStack(projectId, s1Root, "S1 through S2-02 stack", failures)) s1Root = null;
    else throw new Error(`Could not confirm stack cleanup; retained workdir: ${s1Root}`);
    if (failures.length) throw new Error(failures.join("\n"));
    rmSync(s201Root, { recursive: true, force: true });
    s201Root = null;

    assertNoExistingStack(projectId);
    conflictRoot = mkdtempSync(join(tmpdir(), "kdm-s2-02-conflict-"));
    copyS1Workspace(conflictRoot, "s1");
    runSupabase(["start", "--workdir", conflictRoot], "Promotional conflict stack start");
    const conflictContainer = databaseContainer(projectId, conflictRoot);
    runSupabase(["db", "reset", "--local", "--workdir", conflictRoot], "Promotional conflict S1 reset");
    const conflictBaseline = assertS1Baseline(conflictContainer);
    copyS1Workspace(conflictRoot, "s2_01");
    runSupabase(["migration", "up", "--local", "--workdir", conflictRoot], "Conflicting S2-01 migration upgrade");
    assertS1Unchanged(conflictContainer, conflictBaseline);
    assertS201Security(conflictContainer);
    queryDatabase(conflictContainer, `
      insert into public.credit_ledger(workspace_id,event_type,amount)
      values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Promotional',49);
    `, "Conflicting historical promotion setup");
    const conflictingRow = queryDatabase(conflictContainer, `
      select id::text || '|' || amount::text || '|' || created_at::text
      from public.credit_ledger
      where workspace_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid and event_type='Promotional';
    `, "Conflicting historical promotion snapshot");

    runExpectedPromotionConflict(projectRoot);
    assertS1Unchanged(conflictContainer, conflictBaseline);
    const conflictState = queryDatabase(conflictContainer, `
      select
        (select count(*)::text from public.credit_ledger
          where workspace_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid and event_type='Promotional') || '|' ||
        (select count(*)::text from public.credit_ledger
          where workspace_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid and event_type='Promotional' and amount=49) || '|' ||
        (select count(*)::text from public.credit_ledger where event_type='Promotional');
    `, "Conflicting historical promotion rollback check");
    if (conflictState !== "0|1|1") {
      throw new Error("A conflicting historical promotion partially backfilled another workspace.");
    }
    if (queryDatabase(conflictContainer, `
      select id::text || '|' || amount::text || '|' || created_at::text
      from public.credit_ledger
      where workspace_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid and event_type='Promotional';
    `, "Conflicting historical promotion preservation check") !== conflictingRow) {
      throw new Error("A conflicting historical promotion was modified by the failed backfill.");
    }
    if (stopOwnedStack(projectId, conflictRoot, "Conflicting S2-01 stack", failures)) conflictRoot = null;
    else throw new Error(`Could not confirm stack cleanup; retained workdir: ${conflictRoot}`);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : "Disposable S1 to S2-02 upgrade failed.");
  } finally {
    if (stopOwnedStack(projectId, conflictRoot, "Conflicting S2-01 stack", failures)) conflictRoot = null;
    if (stopOwnedStack(projectId, s1Root, "S1 through S2-02 stack", failures)) s1Root = null;
    if (s201Root) {
      try {
        rmSync(s201Root, { recursive: true, force: true });
      } catch {
        failures.push("S2-01 temporary workspace cleanup failed.");
      }
    }
  }

  if (failures.length) throw new Error(failures.join("\n"));
  console.log("S1 to S2-01 to S2-02 disposable upgrade passed; S1 and S2-01 history is preserved.");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Disposable S1 to S2 upgrade failed.");
  process.exitCode = 1;
}
