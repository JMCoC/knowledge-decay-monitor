begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
\ir analysis-fixtures.psql
select no_plan();

create temporary table finding_initial_case (analysis_id uuid) on commit drop;
insert into finding_initial_case
select pg_temp.create_analysis_fixture(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '10000000-0000-4000-8000-000000000001',
  'completed',
  1
);
select pg_temp.force_analysis_checks();

select lives_ok(format(
  'insert into public.findings(workspace_id,analysis_id,type,severity_original,severity_current,confidence,explanation,fingerprint) values (%L::uuid,%L::uuid,''contradiction'',''High'',''High'',0.5,''Initial finding'',''initial-valid'')',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', (select analysis_id from finding_initial_case)
), 'A new finding starts unassigned with matching severities');

select throws_ok(format(
  'insert into public.findings(workspace_id,analysis_id,type,severity_original,severity_current,confidence,explanation,fingerprint) values (%L::uuid,%L::uuid,''contradiction'',''High'',''Medium'',0.5,''Invalid initial severity'',''initial-mismatch'')',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', (select analysis_id from finding_initial_case)
), '23514', null, 'A new finding cannot start with changed severity');

select throws_ok(format(
  'insert into public.findings(workspace_id,analysis_id,type,severity_original,severity_current,confidence,explanation,assignee_id,fingerprint) values (%L::uuid,%L::uuid,''contradiction'',''High'',''High'',0.5,''Invalid initial assignee'',''10000000-0000-4000-8000-000000000001''::uuid,''initial-assigned'')',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', (select analysis_id from finding_initial_case)
), '23514', null, 'A new finding cannot start assigned');

select lives_ok(format(
  'update public.findings set severity_current = ''Medium'', assignee_id = ''10000000-0000-4000-8000-000000000001''::uuid where fingerprint = ''initial-valid'''
), 'The insert guard leaves later review updates available');

select * from finish();
rollback;
