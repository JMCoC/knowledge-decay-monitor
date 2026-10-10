begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
\ir analysis-fixtures.psql
select no_plan();

select has_table('public', 'analyses', 'Analysis table exists');
select has_table('public', 'analysis_documents', 'Analysis scope table exists');
select has_table('public', 'credit_ledger', 'Credit ledger table exists');
select has_table('public', 'findings', 'Findings table exists');
select has_table('public', 'finding_evidence', 'Evidence table exists');
select has_table('public', 'notification_events', 'Notification event table exists');
select is((
  select count(*)::integer from pg_class
  where relnamespace = 'public'::regnamespace
    and relname in ('analyses', 'analysis_documents', 'credit_ledger', 'findings', 'finding_evidence', 'notification_events')
    and relrowsecurity
), 6, 'All six tables enforce RLS');

select is((
  select count(*)::integer from pg_type t join pg_namespace n on n.oid = t.typnamespace
  where n.nspname = 'public' and t.typname in (
    'analysis_job_status', 'analysis_scope_role', 'finding_type', 'finding_severity',
    'finding_status', 'credit_event_type', 'notification_type', 'notification_status',
    'analysis_failure_code'
  ) and t.typtype = 'e'
), 9, 'S2 analysis enums exist');
select is((
  select array_agg(e.enumlabel::text order by e.enumsortorder) from pg_enum e
  where e.enumtypid = 'public.analysis_job_status'::regtype
), ARRAY['queued', 'processing', 'completed', 'failed']::text[], 'Analysis status values are stable');
select is((
  select array_agg(e.enumlabel::text order by e.enumsortorder) from pg_enum e
  where e.enumtypid = 'public.analysis_scope_role'::regtype
), ARRAY['source', 'comparison']::text[], 'Scope role values are stable');
select is((
  select array_agg(e.enumlabel::text order by e.enumsortorder) from pg_enum e
  where e.enumtypid = 'public.finding_type'::regtype
), ARRAY['contradiction', 'obsolescence']::text[], 'Finding type values are stable');
select is((
  select array_agg(e.enumlabel::text order by e.enumsortorder) from pg_enum e
  where e.enumtypid = 'public.finding_severity'::regtype
), ARRAY['High', 'Medium', 'Low']::text[], 'Finding severity values are stable');
select is((
  select array_agg(e.enumlabel::text order by e.enumsortorder) from pg_enum e
  where e.enumtypid = 'public.finding_status'::regtype
), ARRAY['pending_review']::text[], 'S2 finding status stays pending review');

select has_column('public', 'analyses', 'workspace_id', 'Analysis carries its tenant');
select has_column('public', 'analyses', 'reserved_credits', 'Analysis keeps historical reserved amount');
select has_column('public', 'analyses', 'request_fingerprint', 'Analysis stores request fingerprint');
select has_column('public', 'analysis_documents', 'role', 'Scope records source/comparison role');
select has_column('public', 'findings', 'confidence', 'Internal confidence is persisted');
select has_column('public', 'finding_evidence', 'snapshot', 'Evidence keeps an immutable text snapshot');
select has_column('public', 'notification_events', 'recipient_id', 'Notification recipient is persisted');
select ok(exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'analyses_one_active'),
  'Only one queued or processing analysis is indexed per workspace');

insert into pg_temp.analysis_fixture_ids(name, analysis_id) values
  ('analysis_a', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001', 'completed', 1)),
  ('analysis_a_two', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001', 'completed', 2)),
  ('analysis_b', pg_temp.create_analysis_fixture(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '10000000-0000-4000-8000-000000000004', 'completed', 1)),
  ('queued_a', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001', 'queued', 1)),
  ('queued_b', pg_temp.create_analysis_fixture(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '10000000-0000-4000-8000-000000000004', 'queued', 1));

select is((select fixed_cost from public.analyses where id = pg_temp.analysis_fixture_id('analysis_a')), 3,
  'A synthetic analysis stores a fixed positive cost');
select is((select reserved_credits from public.analyses where id = pg_temp.analysis_fixture_id('analysis_a')), 3,
  'Reserved amount records the original fixed cost');
select is((select count(*)::integer from public.analysis_documents
  where analysis_id = pg_temp.analysis_fixture_id('analysis_a') and role = 'source'), 1,
  'The local fixture records one source version');

select throws_ok(format(
  'select pg_temp.insert_analysis_row(%L::uuid, %L::uuid, ''completed'', 0, 0)',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001'),
  '23514', null, 'Zero fixed cost is rejected');
select throws_ok(format(
  'select pg_temp.insert_analysis_row(%L::uuid, %L::uuid, ''completed'', 3, 2)',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001'),
  '23514', null, 'Reserved credits must equal fixed cost');
select throws_ok(format(
  'select pg_temp.insert_analysis_row(%L::uuid, %L::uuid, ''completed'', 3, 3, '''', ''fp'')',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001'),
  '23514', null, 'Idempotency key cannot be blank');
select throws_ok(format(
  'select pg_temp.insert_analysis_row(%L::uuid, %L::uuid, ''completed'', 3, 3, ''key'', '''')',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001'),
  '23514', null, 'Request fingerprint cannot be blank');
select throws_ok(format(
  'select pg_temp.insert_analysis_row(%L::uuid, %L::uuid, ''completed'', 3, 3, ''key'', ''fp'', 4)',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001'),
  '23514', null, 'Attempt count is capped at three');
select throws_ok(format(
  'select pg_temp.insert_analysis_row(%L::uuid, %L::uuid, ''completed'', 3, 3, ''key'', ''fp'', 0, null, ''[]''::jsonb)',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001'),
  '23514', null, 'Retrieval configuration must be a JSON object');
select throws_ok(format(
  'select pg_temp.insert_analysis_row(%L::uuid, %L::uuid, ''completed'', 3, 3, ''key'', ''fp'', 0, null, ''{}''::jsonb, '''')',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001'),
  '23514', null, 'Pricing version cannot be blank');
select throws_ok($$select pg_temp.insert_analysis_row(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001',
  'completed', 3, 3, 'key', 'fp', 0, null, '{}'::jsonb, 'pricing-v1', '', 'schema-v1')$$,
  '23514', null, 'Prompt version cannot be blank');
select throws_ok($$select pg_temp.insert_analysis_row(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001',
  'completed', 3, 3, 'key', 'fp', 0, null, '{}'::jsonb, 'pricing-v1', 'prompt-v1', '')$$,
  '23514', null, 'Output schema version cannot be blank');
select throws_ok($$select 'unknown'::public.analysis_job_status$$,
  '22P02', null, 'Unknown analysis states cannot be stored');
select throws_ok(format(
  'select pg_temp.insert_analysis_row(%L::uuid, %L::uuid)',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc', '10000000-0000-4000-8000-000000000001'),
  '23503', null, 'Analysis cannot reference an unknown workspace');
select throws_ok(format(
  'select pg_temp.insert_analysis_row(%L::uuid, %L::uuid)',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000004'),
  '23503', null, 'Initiator must belong to the analysis workspace');
select throws_ok(format(
  'select pg_temp.insert_analysis_row(%L::uuid, %L::uuid, ''completed'', 3, 3, null, null, 0, %L::uuid)',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001',
  pg_temp.analysis_fixture_id('analysis_b')),
  '23503', null, 'Manual retry reference must stay in the same workspace');
select throws_ok(format(
  'select pg_temp.insert_analysis_row(%L::uuid, %L::uuid, ''completed'', 3, 3, %L)',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001',
  (select idempotency_key from public.analyses where id = pg_temp.analysis_fixture_id('analysis_a'))),
  '23505', null, 'Idempotency key is unique per workspace and initiator');
select throws_ok(format(
  'select pg_temp.insert_analysis_row(%L::uuid, %L::uuid, ''queued'')',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001'),
  '23505', null, 'A workspace cannot have a second active analysis');
select lives_ok(format(
  'select pg_temp.insert_analysis_row(%L::uuid, %L::uuid, ''completed'')',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001'),
  'A completed analysis does not occupy the active slot');

select lives_ok(format(
  'insert into public.analysis_documents(analysis_id, workspace_id, document_id, version_id, role) '
  || 'select %L::uuid, workspace_id, document_id, version_id, ''comparison'' '
  || 'from pg_temp.analysis_case where analysis_id = %L::uuid and ordinal = 1',
  pg_temp.analysis_fixture_id('analysis_a'), pg_temp.analysis_fixture_id('analysis_a')),
  'A version may be both a source and a comparison');
select throws_ok(format(
  'insert into public.analysis_documents(analysis_id, workspace_id, document_id, version_id, role) '
  || 'select %L::uuid, workspace_id, document_id, version_id, ''source'' '
  || 'from pg_temp.analysis_case where analysis_id = %L::uuid and ordinal = 1',
  pg_temp.analysis_fixture_id('analysis_a'), pg_temp.analysis_fixture_id('analysis_a')),
  '23505', null, 'A version cannot repeat within the same scope role');
select throws_ok(format(
  'insert into public.analysis_documents(analysis_id, workspace_id, document_id, version_id, role) '
  || 'select %L::uuid, %L::uuid, document_id, version_id, ''comparison'' '
  || 'from pg_temp.analysis_case where analysis_id = %L::uuid and ordinal = 1',
  pg_temp.analysis_fixture_id('analysis_a_two'), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  pg_temp.analysis_fixture_id('analysis_a_two')),
  '23503', null, 'Scope analysis and workspace must match');
select throws_ok(format(
  'insert into public.analysis_documents(analysis_id, workspace_id, document_id, version_id, role) '
  || 'select %L::uuid, %L::uuid, document_id, version_id, ''source'' '
  || 'from pg_temp.analysis_case where analysis_id = %L::uuid and ordinal = 1',
  pg_temp.analysis_fixture_id('analysis_a'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  pg_temp.analysis_fixture_id('analysis_b')),
  '23503', null, 'Scope document and version must belong to the same tenant');

select lives_ok($$insert into public.credit_ledger(workspace_id, event_type, amount)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Promotional', 50)$$,
  'One synthetic promotional grant can be recorded');
select throws_ok($$insert into public.credit_ledger(workspace_id, event_type, amount)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Promotional', 50)$$,
  '23505', null, 'A workspace cannot receive duplicate promotional grants');
select throws_ok(format(
  'insert into public.credit_ledger(workspace_id, event_type, amount, analysis_id) values (%L::uuid, ''Promotional'', 50, %L::uuid)',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.analysis_fixture_id('analysis_a')),
  '23514', null, 'Promotional events do not reference analyses');
select throws_ok($$insert into public.credit_ledger(workspace_id, event_type, amount)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Reserved', 3)$$,
  '23514', null, 'Analysis credit events require an analysis reference');
select throws_ok($$insert into public.credit_ledger(workspace_id, event_type, amount)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Promotional', 0)$$,
  '23514', null, 'Credit movement amount must be positive');
select lives_ok(format(
  'insert into public.credit_ledger(workspace_id, event_type, amount, analysis_id) values (%L::uuid, ''Reserved'', 3, %L::uuid)',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.analysis_fixture_id('analysis_a')),
  'Analysis can have one reservation movement');
select throws_ok(format(
  'insert into public.credit_ledger(workspace_id, event_type, amount, analysis_id) values (%L::uuid, ''Reserved'', 3, %L::uuid)',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.analysis_fixture_id('analysis_a')),
  '23505', null, 'Reservation movement is unique per analysis');
select lives_ok(format(
  'insert into public.credit_ledger(workspace_id, event_type, amount, analysis_id) values (%L::uuid, ''Consumed'', 3, %L::uuid)',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.analysis_fixture_id('analysis_a')),
  'Analysis can have a terminal consumption movement');
select throws_ok(format(
  'insert into public.credit_ledger(workspace_id, event_type, amount, analysis_id) values (%L::uuid, ''Released'', 3, %L::uuid)',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.analysis_fixture_id('analysis_a')),
  '23505', null, 'An analysis can have only one terminal settlement');
select throws_ok(format(
  'insert into public.credit_ledger(workspace_id, event_type, amount, analysis_id) values (%L::uuid, ''Reserved'', 3, %L::uuid)',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', pg_temp.analysis_fixture_id('analysis_a_two')),
  '23503', null, 'Ledger analysis reference cannot cross tenants');

select lives_ok(format(
  'insert into pg_temp.finding_fixture_ids(name, finding_id, analysis_id) '
  || 'select ''finding_a'', pg_temp.insert_finding_row(%L::uuid, %L::uuid, 0.1, ''Synthetic explanation'', ''shared-fingerprint''), %L::uuid',
  pg_temp.analysis_fixture_id('analysis_a'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  pg_temp.analysis_fixture_id('analysis_a')),
  'Low-confidence finding is valid and retained for review');
select lives_ok(format(
  'insert into pg_temp.finding_fixture_ids(name, finding_id, analysis_id) '
  || 'select ''finding_a_two'', pg_temp.insert_finding_row(%L::uuid, %L::uuid, 0.5, ''Synthetic explanation'', ''shared-fingerprint''), %L::uuid',
  pg_temp.analysis_fixture_id('analysis_a_two'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  pg_temp.analysis_fixture_id('analysis_a_two')),
  'Fingerprint may repeat in another analysis');
select lives_ok(format(
  'insert into pg_temp.finding_fixture_ids(name, finding_id, analysis_id) '
  || 'select ''finding_b'', pg_temp.insert_finding_row(%L::uuid, %L::uuid, 0.5, ''Synthetic explanation'', ''shared-fingerprint''), %L::uuid',
  pg_temp.analysis_fixture_id('analysis_b'), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  pg_temp.analysis_fixture_id('analysis_b')),
  'Tenant B can reuse a finding fingerprint');
select lives_ok(format('select pg_temp.insert_finding_row(%L::uuid, %L::uuid, 0.0)',
  pg_temp.analysis_fixture_id('analysis_a'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  'Confidence zero is valid');
select lives_ok(format('select pg_temp.insert_finding_row(%L::uuid, %L::uuid, 1.0)',
  pg_temp.analysis_fixture_id('analysis_a'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  'Confidence one is valid');
select throws_ok(format('select pg_temp.insert_finding_row(%L::uuid, %L::uuid, -0.1)',
  pg_temp.analysis_fixture_id('analysis_a'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  '23514', null, 'Negative confidence is rejected');
select throws_ok(format('select pg_temp.insert_finding_row(%L::uuid, %L::uuid, 1.1)',
  pg_temp.analysis_fixture_id('analysis_a'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  '23514', null, 'Confidence above one is rejected');
select throws_ok(format('select pg_temp.insert_finding_row(%L::uuid, %L::uuid, ''NaN''::double precision)',
  pg_temp.analysis_fixture_id('analysis_a'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  '23514', null, 'NaN confidence is rejected');
select throws_ok(format('select pg_temp.insert_finding_row(%L::uuid, %L::uuid, ''Infinity''::double precision)',
  pg_temp.analysis_fixture_id('analysis_a'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  '23514', null, 'Infinite confidence is rejected');
select throws_ok(format('select pg_temp.insert_finding_row(%L::uuid, %L::uuid, 0.5, '''')',
  pg_temp.analysis_fixture_id('analysis_a'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  '23514', null, 'Finding explanation cannot be blank');
select throws_ok(format('select pg_temp.insert_finding_row(%L::uuid, %L::uuid, 0.5, ''Explanation'', '''')',
  pg_temp.analysis_fixture_id('analysis_a'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  '23514', null, 'Finding fingerprint cannot be blank');
select throws_ok(format('select pg_temp.insert_finding_row(%L::uuid, %L::uuid, 0.5, ''Explanation'', ''shared-fingerprint'')',
  pg_temp.analysis_fixture_id('analysis_a'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  '23505', null, 'Finding fingerprint is unique within one analysis');
select throws_ok(format(
  'update public.findings set assignee_id = %L::uuid where id = %L::uuid',
  '10000000-0000-4000-8000-000000000004',
  (select finding_id from pg_temp.finding_fixture_ids where name = 'finding_a')),
  '23503', null, 'Finding assignee must belong to the analysis workspace');
select throws_ok(format('select pg_temp.insert_finding_row(%L::uuid, %L::uuid, 0.5)',
  pg_temp.analysis_fixture_id('analysis_a'), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  '23503', null, 'Finding analysis and workspace must match');
select is((select status::text from public.findings where id =
  (select finding_id from pg_temp.finding_fixture_ids where name = 'finding_a')),
  'pending_review', 'Findings start in pending review');

select lives_ok($$select pg_temp.insert_fixture_evidence(
  'analysis_a', 'finding_a', 'analysis_a', 1, 'Synthetic evidence snapshot')$$,
  'Evidence points to a version in its analysis scope');
select lives_ok($$select pg_temp.insert_fixture_evidence(
  'analysis_a', 'finding_a', 'analysis_a', 1, repeat('😀', 2000))$$,
  'A 2000-character supplementary Unicode snapshot is accepted');
select throws_ok($$select pg_temp.insert_fixture_evidence(
  'analysis_a', 'finding_a', 'analysis_a', 1, repeat('😀', 2001))$$,
  '23514', null, 'A 2001-character supplementary Unicode snapshot is rejected');
select throws_ok($$select pg_temp.insert_fixture_evidence(
  'analysis_a', 'finding_a', 'analysis_a', 1, '')$$,
  '23514', null, 'Empty evidence snapshot is rejected');
select throws_ok($$select pg_temp.insert_fixture_evidence(
  'analysis_a', 'finding_a', 'analysis_a', 1, '   ')$$,
  '23514', null, 'Whitespace-only evidence snapshot is rejected');
select throws_ok($$select pg_temp.insert_fixture_evidence(
  'analysis_a', 'finding_a', 'analysis_a', 1, 'snapshot', 0)$$,
  '23514', null, 'Evidence page number must be positive');
select throws_ok($$select pg_temp.insert_fixture_evidence(
  'analysis_a_two', 'finding_a_two', 'analysis_a_two', 1, 'snapshot', null, 2)$$,
  '23503', null, 'Evidence chunk must belong to the referenced version');
select throws_ok($$select pg_temp.insert_fixture_evidence(
  'analysis_a', 'finding_a', 'analysis_b', 1, 'snapshot')$$,
  '23503', null, 'Evidence cannot reference another workspace');

select lives_ok(format(
  'insert into public.notification_events(workspace_id, analysis_id, type, recipient_id) values (%L::uuid, %L::uuid, ''analysis_completed'', %L::uuid)',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.analysis_fixture_id('analysis_a'),
  '10000000-0000-4000-8000-000000000001'),
  'A terminal notification event records its tenant recipient');
select throws_ok(format(
  'insert into public.notification_events(workspace_id, analysis_id, type, recipient_id) values (%L::uuid, %L::uuid, ''analysis_completed'', %L::uuid)',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.analysis_fixture_id('analysis_a'),
  '10000000-0000-4000-8000-000000000001'),
  '23505', null, 'Notification event is unique by analysis, type, and recipient');
select throws_ok(format(
  'insert into public.notification_events(workspace_id, analysis_id, type, recipient_id) values (%L::uuid, %L::uuid, ''analysis_failed'', %L::uuid)',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.analysis_fixture_id('analysis_a'),
  '10000000-0000-4000-8000-000000000004'),
  '23503', null, 'Notification recipient must belong to the analysis workspace');
select throws_ok(format(
  'insert into public.notification_events(workspace_id, analysis_id, type, recipient_id, error_code) values (%L::uuid, %L::uuid, ''analysis_failed'', %L::uuid, ''provider-secret'')',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.analysis_fixture_id('analysis_a'),
  '10000000-0000-4000-8000-000000000001'),
  '23514', null, 'Notification errors use a controlled code');
select throws_ok(format(
  'insert into public.notification_events(workspace_id, analysis_id, type, recipient_id, attempt_count) values (%L::uuid, %L::uuid, ''analysis_failed'', %L::uuid, 4)',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.analysis_fixture_id('analysis_a'),
  '10000000-0000-4000-8000-000000000001'),
  '23514', null, 'Notification retry attempts are bounded');

select * from finish();
rollback;
