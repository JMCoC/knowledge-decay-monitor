begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
\ir review-fixtures.psql
select no_plan();
select pg_temp.create_review_fixture_case();
select pg_temp.create_review_fixture_case();

create temporary table findings_projection_context (
  case_name text primary key,
  workspace_id uuid not null,
  admin_id uuid not null,
  member_a_id uuid not null,
  member_b_id uuid not null,
  analysis_id uuid not null,
  finding_a_id uuid not null,
  finding_b_id uuid not null,
  finding_c_id uuid not null
) on commit drop;
insert into pg_temp.findings_projection_context
select case when row_number() over (order by f.workspace_id) = 1 then 'a' else 'b' end,
  f.workspace_id, f.admin_id, f.member_a_id, f.member_b_id, f.analysis_id,
  f.finding_a_id, f.finding_b_id, f.finding_c_id
from pg_temp.review_fixture_case f;

select has_column('public', 'analysis_findings', 'review_revision',
  'Analysis findings project the persisted review revision');
select has_column('public', 'analysis_findings', 'assignee_id',
  'Analysis findings project the persisted assignee ID');
select has_column('public', 'analysis_findings', 'assignee_full_name',
  'Analysis findings project a safe assignee display name');
select ok(not has_table_privilege('authenticated', 'public.profiles', 'SELECT'),
  'Authenticated users do not receive table-wide Profile reads');
select ok(has_column_privilege('authenticated', 'public.profiles', 'id', 'SELECT')
    and has_column_privilege('authenticated', 'public.profiles', 'workspace_id', 'SELECT')
    and has_column_privilege('authenticated', 'public.profiles', 'role', 'SELECT')
    and has_column_privilege('authenticated', 'public.profiles', 'full_name', 'SELECT'),
  'Authenticated projections keep only the Profile columns they require');
select ok(not has_column_privilege('authenticated', 'public.profiles', 'email', 'SELECT'),
  'Profile email remains unavailable to authenticated callers');

select is((
  select f.assignee_id from public.analysis_findings f
  where f.id = (select finding_a_id from pg_temp.findings_projection_context where case_name = 'a')
), (select member_a_id from pg_temp.findings_projection_context where case_name = 'a'),
  'Assigned finding exposes its persisted same-workspace Member ID');
select is((
  select f.assignee_full_name from public.analysis_findings f
  where f.id = (select finding_a_id from pg_temp.findings_projection_context where case_name = 'a')
), 'Synthetic review member A', 'Assigned finding exposes only its Member display name');
select is((
  select f.review_revision from public.analysis_findings f
  where f.id = (select finding_a_id from pg_temp.findings_projection_context where case_name = 'a')
), 2::bigint, 'Finding projection carries the persisted review revision');

select ok(pg_get_viewdef('public.analysis_findings'::regclass) ~* 'assignee\.workspace_id = f\.workspace_id',
  'The assignee Profile join is explicitly scoped to the finding tenant');
select ok((
  select a.workspace_id <> b.workspace_id
  from pg_temp.findings_projection_context a
  cross join pg_temp.findings_projection_context b
  where a.case_name = 'a' and b.case_name = 'b'
), 'Projection fixtures use distinct tenants for cross-workspace checks');
select throws_ok(format(
  'update public.findings set assignee_id = %L where id = %L',
  (select member_a_id from pg_temp.findings_projection_context where case_name = 'b'),
  (select finding_a_id from pg_temp.findings_projection_context where case_name = 'a')),
  '23503', null, 'A finding cannot be assigned to a Profile from another workspace');

select is((
  select count(*)::integer from public.analysis_findings f
  where f.workspace_id = (select workspace_id from pg_temp.findings_projection_context where case_name = 'a')
    and f.analysis_id = (select analysis_id from pg_temp.findings_projection_context where case_name = 'a')
), 3, 'The all-findings projection retains the complete result total');
update public.findings f set assignee_id = null
where f.id = (select finding_c_id from pg_temp.findings_projection_context where case_name = 'a');
select is((
  select count(*)::integer from public.analysis_findings f
  where f.workspace_id = (select workspace_id from pg_temp.findings_projection_context where case_name = 'a')
    and f.analysis_id = (select analysis_id from pg_temp.findings_projection_context where case_name = 'a')
    and f.assignee_id is null
), 1, 'The unassigned projection filters by assignee ID and preserves its total');
select is((
  select count(*)::integer from (
    select f.id from public.analysis_findings f
    where f.workspace_id = (select workspace_id from pg_temp.findings_projection_context where case_name = 'a')
      and f.analysis_id = (select analysis_id from pg_temp.findings_projection_context where case_name = 'a')
      and f.assignee_id is null
    order by f.severity_current, f.created_at desc, f.id desc
    limit 1 offset 0
  ) page
), 1, 'Pagination still returns the sole unassigned row');

select is(public.review_assign_finding(
  (select admin_id from pg_temp.findings_projection_context where case_name = 'a'),
  (select finding_a_id from pg_temp.findings_projection_context where case_name = 'a'),
  (select review_revision from public.findings
    where id = (select finding_a_id from pg_temp.findings_projection_context where case_name = 'a')),
  (select member_b_id from pg_temp.findings_projection_context where case_name = 'a'),
  'findings-projection-reassignment'
)->'assignee'->>'id',
  (select member_b_id::text from pg_temp.findings_projection_context where case_name = 'a'),
  'The supported assignment command reassigns the finding');
select is((
  select f.assignee_full_name from public.analysis_findings f
  where f.workspace_id = (select workspace_id from pg_temp.findings_projection_context where case_name = 'a')
    and f.analysis_id = (select analysis_id from pg_temp.findings_projection_context where case_name = 'a')
    and f.assignee_id = (select member_b_id from pg_temp.findings_projection_context where case_name = 'a')
  order by f.id limit 1
), 'Synthetic review member B', 'The list projection reflects the persisted reassignment');
select is((
  select f.assignee_id from public.analysis_findings f
  where f.id = (select finding_a_id from pg_temp.findings_projection_context where case_name = 'a')
), (select member_b_id from pg_temp.findings_projection_context where case_name = 'a'),
  'The detail projection reflects the same persisted reassignment');
select is((
  select f.assignee_full_name from public.analysis_findings f
  where f.id = (select finding_a_id from pg_temp.findings_projection_context where case_name = 'a')
), 'Synthetic review member B', 'The detail projection returns the current Member name');

grant select on pg_temp.findings_projection_context to authenticated;
set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', (select member_b_id::text from pg_temp.findings_projection_context where case_name = 'a'),
  'role', 'authenticated',
  'app_metadata', jsonb_build_object('role', 'Admin', 'workspace_id',
    (select workspace_id::text from pg_temp.findings_projection_context where case_name = 'b'))
)::text, true);
select is((
  select count(*)::integer from public.findings f
  where f.id in (
    select finding_a_id from pg_temp.findings_projection_context where case_name = 'a'
    union all select finding_b_id from pg_temp.findings_projection_context where case_name = 'a'
  )
), 2, 'Member review capability still exposes only its assigned findings at the base table');
select is((select count(*)::integer from public.analysis_findings), 0,
  'Member cannot browse the analysis-history projection through its own review capability');
reset role;

select * from finish();
rollback;
