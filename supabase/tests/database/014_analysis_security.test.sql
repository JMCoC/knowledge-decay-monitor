begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
\ir analysis-fixtures.psql
select no_plan();

select ok(has_column_privilege('authenticated', 'public.analyses', 'status', 'SELECT'),
  'Authenticated roles can read public analysis status');
select ok(not has_column_privilege('authenticated', 'public.analyses', 'lease_expires_at', 'SELECT'),
  'Analysis lease stays internal');
select ok(not has_column_privilege('authenticated', 'public.analyses', 'error_code', 'SELECT'),
  'Technical failure taxonomy stays internal');
select ok(not has_column_privilege('authenticated', 'public.findings', 'confidence', 'SELECT'),
  'Finding confidence stays internal');
select ok(not has_table_privilege('authenticated', 'public.notification_events', 'SELECT'),
  'Notification outbox is internal');
select ok(not has_table_privilege('service_role', 'public.credit_ledger', 'UPDATE'),
  'Server application role cannot update the credit ledger');
select ok(not has_table_privilege('service_role', 'public.credit_ledger', 'DELETE'),
  'Server application role cannot delete the credit ledger');
select ok(not has_table_privilege('service_role', 'public.credit_ledger', 'TRUNCATE'),
  'Server application role cannot truncate the credit ledger');
select is((
  select count(*)::integer from pg_class
  where relnamespace = 'public'::regnamespace and relkind = 'v'
    and relname in ('analysis_runs', 'analysis_scope', 'analysis_findings', 'analysis_finding_evidence')
), 4, 'Four analysis projections exist');
select ok((
  select bool_and(reloptions @> array['security_invoker=true']) from pg_class
  where relnamespace = 'public'::regnamespace and relname in (
    'analysis_runs', 'analysis_scope', 'analysis_findings', 'analysis_finding_evidence'
  ) and relkind = 'v'
), 'Every analysis projection preserves caller privileges and RLS');
select is((
  select count(*)::integer from information_schema.columns
  where table_schema = 'public'
    and table_name in ('analysis_runs', 'analysis_scope', 'analysis_findings', 'analysis_finding_evidence')
    and column_name in (
      'confidence', 'assignee_id', 'lease_expires_at', 'operation_id', 'idempotency_key',
      'request_fingerprint', 'retrieval_config', 'provider_config', 'attempt_count', 'error_code'
    )
), 0, 'Read projections exclude internal analysis and provider data');
select ok(not exists (
  select 1 from pg_class where oid = to_regclass('public.analysis_runs')
    and has_table_privilege('anon', oid, 'SELECT')
), 'Anonymous callers cannot read analysis projections');

insert into pg_temp.analysis_fixture_ids(name, analysis_id) values
  ('completed_a', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001', 'completed', 1)),
  ('processing_a', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001', 'processing', 1)),
  ('failed_a', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001', 'failed', 1)),
  ('completed_b', pg_temp.create_analysis_fixture(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '10000000-0000-4000-8000-000000000004', 'completed', 1));

update public.documents d set owner_id = '10000000-0000-4000-8000-000000000003'
from pg_temp.analysis_case c
where c.analysis_id = pg_temp.analysis_fixture_id('completed_a')
  and c.ordinal = 1 and d.id = c.document_id;

insert into pg_temp.finding_fixture_ids(name, finding_id, analysis_id) values
  ('completed_a_finding', pg_temp.insert_finding_row(
    pg_temp.analysis_fixture_id('completed_a'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 0.1),
    pg_temp.analysis_fixture_id('completed_a')),
  ('processing_a_finding', pg_temp.insert_finding_row(
    pg_temp.analysis_fixture_id('processing_a'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 0.5),
    pg_temp.analysis_fixture_id('processing_a')),
  ('failed_a_finding', pg_temp.insert_finding_row(
    pg_temp.analysis_fixture_id('failed_a'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 0.5),
    pg_temp.analysis_fixture_id('failed_a')),
  ('completed_b_finding', pg_temp.insert_finding_row(
    pg_temp.analysis_fixture_id('completed_b'), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 0.5),
    pg_temp.analysis_fixture_id('completed_b'));

select pg_temp.record_fixture_evidence_and_check(
  'completed_a_evidence', 'completed_a', 'completed_a_finding', 'completed_a', 1, 'Public snapshot');
select pg_temp.record_fixture_evidence_and_check(
  'processing_a_evidence', 'processing_a', 'processing_a_finding', 'processing_a', 1, 'Provisional snapshot');
select pg_temp.record_fixture_evidence_and_check(
  'failed_a_evidence', 'failed_a', 'failed_a_finding', 'failed_a', 1, 'Failed snapshot');
select pg_temp.record_fixture_evidence_and_check(
  'completed_b_evidence', 'completed_b', 'completed_b_finding', 'completed_b', 1, 'Tenant B snapshot');

insert into public.credit_ledger(workspace_id, event_type, amount)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Promotional', 50),
       ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Promotional', 50);
insert into public.credit_ledger(workspace_id, event_type, amount, analysis_id)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Reserved', 3,
          pg_temp.analysis_fixture_id('completed_a'));
insert into public.notification_events(workspace_id, analysis_id, type, recipient_id)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.analysis_fixture_id('completed_a'),
          'analysis_completed', '10000000-0000-4000-8000-000000000001'),
       ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', pg_temp.analysis_fixture_id('completed_b'),
          'analysis_completed', '10000000-0000-4000-8000-000000000004');
select pg_temp.force_analysis_checks();

select lives_ok($$select pg_temp.expect_text(
  'select public_error_code from public.analysis_runs where status = ''failed''', 'ANALYSIS_FAILED')$$,
  'Failed runs expose a controlled public code instead of the technical taxonomy');

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok(format('select pg_temp.expect_count(%L, 3)',
  'select count(*)::integer from public.analyses'), 'Admin A sees all analysis states in Workspace A');
select lives_ok(format('select pg_temp.expect_count(%L, 3)',
  'select count(*)::integer from public.analysis_runs'), 'Admin A reads its run projection');
select lives_ok(format('select pg_temp.expect_count(%L, 3)',
  'select count(*)::integer from public.analysis_scope'), 'Admin A reads exact document scope');
select lives_ok(format('select pg_temp.expect_count(%L, 1)',
  'select count(*)::integer from public.findings'), 'Admin A sees findings only after completion');
select lives_ok(format('select pg_temp.expect_count(%L, 1)',
  'select count(*)::integer from public.finding_evidence'), 'Admin A sees evidence only after completion');
select lives_ok(format('select pg_temp.expect_count(%L, 1)',
  'select count(*)::integer from public.analysis_findings'), 'Findings view publishes only completed analyses');
select lives_ok(format('select pg_temp.expect_count(%L, 1)',
  'select count(*)::integer from public.analysis_finding_evidence'), 'Evidence view publishes only completed analyses');
select lives_ok(format('select pg_temp.expect_count(%L, 2)',
  'select count(*)::integer from public.credit_ledger'), 'Admin A reads detailed ledger rows for its workspace');
select lives_ok(format('select pg_temp.expect_count(%L, 0)',
  'select count(*)::integer from public.analyses where workspace_id = ''bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb''::uuid'),
  'Admin A cannot read a known Workspace B analysis');
select lives_ok(format('select pg_temp.expect_count(%L, 0)',
  'select count(*)::integer from public.analysis_runs where workspace_id = ''bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb''::uuid'),
  'Admin A cannot read a known Workspace B projection');
select throws_ok($$select * from public.analyses$$,
  '42501', null, 'Wildcard access to analyses is denied by column privileges');
select throws_ok($$select lease_expires_at from public.analyses$$,
  '42501', null, 'Explicit lease reads are denied');
select throws_ok($$select error_code from public.analyses$$,
  '42501', null, 'Explicit technical error taxonomy reads are denied');
select throws_ok($$select * from public.findings$$,
  '42501', null, 'Wildcard access to findings is denied by column privileges');
select throws_ok($$select confidence from public.findings$$,
  '42501', null, 'Explicit confidence reads are denied');
select lives_ok($$select * from public.analysis_runs limit 0$$,
  'Wildcard access to a curated run projection works');
select lives_ok($$select * from public.analysis_scope limit 0$$,
  'Wildcard access to a curated scope projection works');
select lives_ok($$select * from public.analysis_findings limit 0$$,
  'Wildcard access to a curated findings projection works');
select lives_ok($$select * from public.analysis_finding_evidence limit 0$$,
  'Wildcard access to a curated evidence projection works');
select throws_ok($$select * from public.notification_events$$,
  '42501', null, 'Authenticated callers cannot query notification events');
select throws_ok($$insert into public.analysis_documents(analysis_id,workspace_id,document_id,version_id,role)
  values (gen_random_uuid(), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','source')$$,
  '42501', null, 'Authenticated callers cannot insert analysis scope');
select throws_ok($$update public.analyses set status = 'failed'$$,
  '42501', null, 'Authenticated callers cannot update analysis state');
select throws_ok($$delete from public.analyses$$,
  '42501', null, 'Authenticated callers cannot delete analysis history');
select throws_ok($$update public.profiles set role = 'Admin'$$,
  '42501', null, 'Authenticated callers cannot change persisted workspace roles');

select set_config('request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select lives_ok(format('select pg_temp.expect_count(%L, 3)',
  'select count(*)::integer from public.analysis_runs'), 'QA A has the same read scope as Admin A');
reset role;
update public.profiles set role = 'Member'
where id = '10000000-0000-4000-8000-000000000002';
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select lives_ok(format('select pg_temp.expect_count(%L, 0)',
  'select count(*)::integer from public.analysis_runs'),
  'A QA session loses access immediately after Profile is changed to Member');
reset role;
update public.profiles set role = 'QA Lead'
where id = '10000000-0000-4000-8000-000000000002';

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000003","role":"authenticated","app_metadata":{"role":"Admin","workspace_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}}', true);
select lives_ok(format('select pg_temp.expect_count(%L, 0)',
  'select count(*)::integer from public.analyses'),
  'Member ownership and forged role/tenant metadata do not grant access');
select lives_ok(format('select pg_temp.expect_count(%L, 0)',
  'select count(*)::integer from public.credit_ledger'), 'Member cannot read detailed ledger rows');
select lives_ok(format('select pg_temp.expect_count(%L, 0)',
  'select count(*)::integer from public.findings'), 'Member cannot read findings even when Owner');
select lives_ok(format('select pg_temp.expect_count(%L, 0)',
  'select count(*)::integer from public.finding_evidence'), 'Member cannot read evidence even when Owner');
select lives_ok(format('select pg_temp.expect_count(%L, 0)',
  'select count(*)::integer from public.analysis_runs'), 'Member cannot read the analysis projection');
reset role;

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
select lives_ok(format('select pg_temp.expect_count(%L, 1)',
  'select count(*)::integer from public.analysis_runs'), 'Admin B sees only its own workspace');
select lives_ok(format('select pg_temp.expect_count(%L, 1)',
  'select count(*)::integer from public.analysis_findings'), 'Admin B sees its completed finding');
select lives_ok(format('select pg_temp.expect_count(%L, 1)',
  'select count(*)::integer from public.analysis_finding_evidence'), 'Admin B sees its completed evidence');
select lives_ok(format('select pg_temp.expect_count(%L, 1)',
  'select count(*)::integer from public.credit_ledger'), 'Admin B sees only its ledger rows');
reset role;

set local role anon;
select throws_ok($$select * from public.analysis_runs$$,
  '42501', null, 'Anonymous callers cannot read analysis projections');
select throws_ok($$select status from public.analyses$$,
  '42501', null, 'Anonymous callers cannot read analysis tables');
reset role;

grant select on pg_temp.analysis_fixture_ids to service_role;
set local role service_role;
select lives_ok(format('select pg_temp.expect_count(%L, 3)',
  'select count(*)::integer from public.credit_ledger'), 'Server role can read ledger rows');
select lives_ok(format(
  'insert into public.credit_ledger(workspace_id,event_type,amount,analysis_id) values (%L::uuid,''Released'',3,%L::uuid)',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.analysis_fixture_id('completed_a')),
  'Server role can append a ledger movement');
select throws_ok($$update public.credit_ledger set amount = amount + 1$$,
  '42501', null, 'Server role cannot update an existing ledger movement');
select throws_ok($$delete from public.credit_ledger$$,
  '42501', null, 'Server role cannot delete ledger history');
select throws_ok($$truncate public.credit_ledger$$,
  '42501', null, 'Server role cannot truncate ledger history');
select lives_ok($$insert into public.analyses(
  id,workspace_id,initiator_id,status,fixed_cost,reserved_credits,idempotency_key,request_fingerprint,
  retrieval_config,pricing_version,prompt_version,output_schema_version,provider_config
) values (
  '90000000-0000-4000-8000-000000000901','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '10000000-0000-4000-8000-000000000001','completed',3,3,'service-analysis-key','service-analysis-fingerprint',
  '{"topK":5}'::jsonb,'pricing-v1','prompt-v1','schema-v1','{"primary":{"provider":"synthetic"}}'::jsonb
)$$, 'Server role can create a run through direct internal SQL');
select lives_ok($$insert into public.analysis_documents(analysis_id,workspace_id,document_id,version_id,role)
  values ('90000000-0000-4000-8000-000000000901','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','source')$$,
  'Server role can persist a valid source association');
select throws_ok($$insert into public.analysis_documents(analysis_id,workspace_id,document_id,version_id,role)
  values ('90000000-0000-4000-8000-000000000901','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '20000000-0000-4000-8000-000000000004','30000000-0000-4000-8000-000000000004','comparison')$$,
  '23503', null, 'Server role cannot bypass composite tenant foreign keys');
reset role;
select pg_temp.force_analysis_checks();

select * from finish();
rollback;
