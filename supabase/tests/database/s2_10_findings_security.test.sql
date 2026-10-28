begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
\ir analysis-fixtures.psql
select plan(8);

insert into pg_temp.analysis_fixture_ids(name, analysis_id) values
  ('completed_a', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001', 'completed', 1)),
  ('processing_a', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001', 'processing', 1)),
  ('completed_b', pg_temp.create_analysis_fixture(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '10000000-0000-4000-8000-000000000004', 'completed', 1));

insert into pg_temp.finding_fixture_ids(name, finding_id, analysis_id) values
  ('completed_a_finding', pg_temp.insert_finding_row(
    pg_temp.analysis_fixture_id('completed_a'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 0.8),
    pg_temp.analysis_fixture_id('completed_a')),
  ('processing_a_finding', pg_temp.insert_finding_row(
    pg_temp.analysis_fixture_id('processing_a'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 0.7),
    pg_temp.analysis_fixture_id('processing_a')),
  ('completed_b_finding', pg_temp.insert_finding_row(
    pg_temp.analysis_fixture_id('completed_b'), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 0.6),
    pg_temp.analysis_fixture_id('completed_b'));

select pg_temp.record_fixture_evidence_and_check(
  'completed_a_evidence', 'completed_a', 'completed_a_finding', 'completed_a', 1, 'Tenant A snapshot');
select pg_temp.record_fixture_evidence_and_check(
  'processing_a_evidence', 'processing_a', 'processing_a_finding', 'processing_a', 1, 'Processing snapshot');
select pg_temp.record_fixture_evidence_and_check(
  'completed_b_evidence', 'completed_b', 'completed_b_finding', 'completed_b', 1, 'Tenant B snapshot');
select pg_temp.force_analysis_checks();
grant select on pg_temp.analysis_fixture_ids to authenticated;

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is((select count(*)::integer from public.analysis_findings), 1,
  'Admin A reads the completed finding in its workspace');
select is((select count(*)::integer from public.analysis_findings
  where workspace_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid), 0,
  'Admin A cannot read findings from Workspace B');
select is((select count(*)::integer from public.analysis_finding_evidence
  where workspace_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid), 0,
  'Admin A cannot read evidence from Workspace B');
select is((select count(*)::integer from public.analysis_findings
  where analysis_id = pg_temp.analysis_fixture_id('processing_a')), 0,
  'Findings from non-completed analyses are not published');
select throws_ok($$select confidence from public.findings limit 1$$,
  '42501', null, 'Authenticated users cannot read internal confidence');

select set_config('request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select is((select count(*)::integer from public.analysis_findings), 0,
  'Member cannot read findings without an S2 assignment flow');
select is((select count(*)::integer from public.analysis_finding_evidence), 0,
  'Member cannot read finding evidence');
reset role;

select is((select count(*)::integer from information_schema.columns
  where table_schema = 'public' and table_name = 'analysis_findings' and column_name = 'confidence'), 0,
  'Public findings projection excludes confidence');

select * from finish();
rollback;
