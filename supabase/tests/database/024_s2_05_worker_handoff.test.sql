begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
\ir analysis-fixtures.psql
select no_plan();

select has_column('public', 'analyses', 'continuation_pending',
  'Analysis rows distinguish a queued continuation from a retry');
select has_column('public', 'analyses', 'attempt_started_at',
  'Analysis rows persist the start of the current attempt');
select has_column('public', 'analyses', 'attempt_deadline_at',
  'Analysis rows persist the current attempt deadline');
select has_column('public', 'analyses', 'analysis_deadline_at',
  'Analysis rows persist the fixed total deadline');

select has_function('public', 'yield_analysis_batch',
  array['uuid', 'uuid', 'integer', 'jsonb'],
  'The worker can atomically yield a batch with a cursor compare-and-swap');
select has_function('public', 'read_analysis_retrieval_summary',
  array['uuid', 'uuid'],
  'The worker can read an operation-fenced retrieval summary');
select has_function('public', 'read_analysis_pair_batch',
  array['uuid', 'uuid', 'uuid', 'uuid', 'integer'],
  'The worker can read a bounded operation-fenced pair page');
select has_function('public', 'renew_analysis_lease',
  array['uuid', 'uuid', 'integer', 'jsonb'],
  'The worker has a cursor compare-and-swap lease renewal overload');

select is((select data_type from information_schema.columns
  where table_schema = 'public' and table_name = 'analyses' and column_name = 'continuation_pending'),
  'boolean', 'Continuation marker is boolean');
select is((select is_nullable from information_schema.columns
  where table_schema = 'public' and table_name = 'analyses' and column_name = 'continuation_pending'),
  'NO', 'Continuation marker is always present');
select ok(not has_column_privilege('authenticated', 'public.analyses', 'continuation_pending', 'SELECT')
  and not has_column_privilege('authenticated', 'public.analyses', 'attempt_started_at', 'SELECT')
  and not has_column_privilege('authenticated', 'public.analyses', 'attempt_deadline_at', 'SELECT')
  and not has_column_privilege('authenticated', 'public.analyses', 'analysis_deadline_at', 'SELECT'),
  'Technical worker deadlines stay outside the authenticated analysis projection');
select ok(has_column_privilege('service_role', 'public.analyses', 'analysis_deadline_at', 'SELECT'),
  'Service role can inspect the worker deadline');
select ok(not has_function_privilege('authenticated',
    'public.yield_analysis_batch(uuid,uuid,integer,jsonb)', 'EXECUTE')
  and not has_function_privilege('anon',
    'public.read_analysis_retrieval_summary(uuid,uuid)', 'EXECUTE')
  and has_function_privilege('service_role',
    'public.yield_analysis_batch(uuid,uuid,integer,jsonb)', 'EXECUTE')
  and has_function_privilege('service_role',
    'public.read_analysis_pair_batch(uuid,uuid,uuid,uuid,integer)', 'EXECUTE'),
  'Handoff and retrieval readers are service-role-only');
select throws_ok($$select public.yield_analysis_batch(
    '00000000-0000-4000-8000-000000000001'::uuid,
    '00000000-0000-4000-8000-000000000002'::uuid,
    0, '{"totalPairs":10,"findingsCount":0}'::jsonb)$$,
  '22023', null, 'Yield rejects a checkpoint that omits processedPairs');
select throws_ok($$select * from public.renew_analysis_lease(
    '00000000-0000-4000-8000-000000000001'::uuid,
    '00000000-0000-4000-8000-000000000002'::uuid,
    0, '{"totalPairs":10,"findingsCount":0}'::jsonb)$$,
  '22023', null, 'CAS renewal rejects a checkpoint that omits processedPairs');
select throws_ok($$select * from public.read_analysis_pair_batch(
    '00000000-0000-4000-8000-000000000001'::uuid,
    '00000000-0000-4000-8000-000000000002'::uuid,
    null, null, null)$$,
  '22023', null, 'Pair paging rejects a NULL page limit before retrieval');
select throws_ok($$select * from private.analysis_candidate_pair_page(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
    array['30000000-0000-4000-8000-000000000001'::uuid],
    '{}'::uuid[], null, null, null)$$,
  '22023', null, 'The private page helper also rejects NULL instead of returning all pairs');

create temporary table handoff_ops(
  name text primary key,
  operation_id uuid not null,
  attempt_deadline_at timestamptz,
  analysis_deadline_at timestamptz
) on commit drop;

insert into pg_temp.analysis_fixture_ids(name, analysis_id) values
  ('handoff_batches', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001', 'queued', 1));
insert into pg_temp.handoff_ops(name, operation_id)
  select 'handoff_batches', c.operation_id
  from public.claim_analysis(pg_temp.analysis_fixture_id('handoff_batches')) c;
update pg_temp.handoff_ops set attempt_deadline_at = a.attempt_deadline_at,
  analysis_deadline_at = a.analysis_deadline_at
  from public.analyses a where handoff_ops.name = 'handoff_batches'
    and a.id = pg_temp.analysis_fixture_id('handoff_batches');
select is((select attempt_count from public.analyses where id = pg_temp.analysis_fixture_id('handoff_batches')),
  1, 'The first claim starts attempt 1');
select ok((select attempt_deadline_at > attempt_started_at
    and attempt_deadline_at <= attempt_started_at + interval '30 minutes'
    and analysis_deadline_at between attempt_started_at + interval '89 minutes'
      and attempt_started_at + interval '91 minutes'
    and lease_expires_at <= attempt_deadline_at
    and lease_expires_at <= analysis_deadline_at
    from public.analyses where id = pg_temp.analysis_fixture_id('handoff_batches')),
  'A claim fixes attempt and total deadlines and caps its lease');

select is(public.yield_analysis_batch(
    pg_temp.analysis_fixture_id('handoff_batches'),
    (select operation_id from pg_temp.handoff_ops where name = 'handoff_batches'),
    0,
    '{"processedPairs":10,"totalPairs":40,"findingsCount":0,"lastPairFingerprint":"pair-10","startedAt":"2026-10-17T00:00:00Z"}'::jsonb),
  true, 'The first successful 10-pair batch yields');
select ok((select status = 'queued' and continuation_pending
    and operation_id is null and lease_expires_at is null and next_attempt_at is null
    and attempt_count = 1
    from public.analyses where id = pg_temp.analysis_fixture_id('handoff_batches')),
  'Yield queues a continuation without releasing its active slot or spending an attempt');
select is((select id from public.claim_analysis(pg_temp.analysis_fixture_id('handoff_batches'))),
  pg_temp.analysis_fixture_id('handoff_batches'), 'The continuation can be claimed');
select ok((select attempt_count = 1 and not continuation_pending
    and operation_id is distinct from (select operation_id from pg_temp.handoff_ops where name = 'handoff_batches')
    and attempt_deadline_at = (select attempt_deadline_at from pg_temp.handoff_ops where name = 'handoff_batches')
    and analysis_deadline_at = (select analysis_deadline_at from pg_temp.handoff_ops where name = 'handoff_batches')
    from public.analyses where id = pg_temp.analysis_fixture_id('handoff_batches')),
  'A continuation claim rotates operation but preserves attempt count and both deadlines');
update pg_temp.handoff_ops set operation_id = a.operation_id
  from public.analyses a where handoff_ops.name = 'handoff_batches'
    and a.id = pg_temp.analysis_fixture_id('handoff_batches');

select is(public.yield_analysis_batch(
    pg_temp.analysis_fixture_id('handoff_batches'),
    (select operation_id from pg_temp.handoff_ops where name = 'handoff_batches'),
    10,
    '{"processedPairs":20,"totalPairs":40,"findingsCount":0,"lastPairFingerprint":"pair-20","startedAt":"2026-10-17T00:00:00Z"}'::jsonb),
  true, 'The second successful 10-pair batch yields');
select is((select id from public.claim_analysis(pg_temp.analysis_fixture_id('handoff_batches'))),
  pg_temp.analysis_fixture_id('handoff_batches'), 'The second continuation is claimed');
update pg_temp.handoff_ops set operation_id = a.operation_id
  from public.analyses a where handoff_ops.name = 'handoff_batches'
    and a.id = pg_temp.analysis_fixture_id('handoff_batches');
select is(public.yield_analysis_batch(
    pg_temp.analysis_fixture_id('handoff_batches'),
    (select operation_id from pg_temp.handoff_ops where name = 'handoff_batches'),
    20,
    '{"processedPairs":30,"totalPairs":40,"findingsCount":0,"lastPairFingerprint":"pair-30","startedAt":"2026-10-17T00:00:00Z"}'::jsonb),
  true, 'The third successful 10-pair batch yields');
select is((select id from public.claim_analysis(pg_temp.analysis_fixture_id('handoff_batches'))),
  pg_temp.analysis_fixture_id('handoff_batches'), 'The third continuation is claimed');
update pg_temp.handoff_ops set operation_id = a.operation_id
  from public.analyses a where handoff_ops.name = 'handoff_batches'
    and a.id = pg_temp.analysis_fixture_id('handoff_batches');
select is(public.yield_analysis_batch(
    pg_temp.analysis_fixture_id('handoff_batches'),
    (select operation_id from pg_temp.handoff_ops where name = 'handoff_batches'),
    30,
    '{"processedPairs":40,"totalPairs":40,"findingsCount":0,"lastPairFingerprint":"pair-40","startedAt":"2026-10-17T00:00:00Z"}'::jsonb),
  true, 'The fourth successful 10-pair batch yields');
select is((select attempt_count from public.analyses where id = pg_temp.analysis_fixture_id('handoff_batches')),
  1, 'Forty simulated pairs still consume only attempt 1');
select is((select id from public.claim_analysis(pg_temp.analysis_fixture_id('handoff_batches'))),
  pg_temp.analysis_fixture_id('handoff_batches'), 'The fourth continuation is claimable');
update pg_temp.handoff_ops set operation_id = a.operation_id
  from public.analyses a where handoff_ops.name = 'handoff_batches'
    and a.id = pg_temp.analysis_fixture_id('handoff_batches');

select throws_ok(format(
    'select * from public.renew_analysis_lease(%L::uuid,%L::uuid,40,%L::jsonb)',
    pg_temp.analysis_fixture_id('handoff_batches'),
    (select operation_id from pg_temp.handoff_ops where name = 'handoff_batches'),
    '{"processedPairs":30,"totalPairs":40,"findingsCount":0}'),
  '22023', null, 'CAS heartbeat rejects a backwards cursor');
select lives_ok(format(
    'select * from public.renew_analysis_lease(%L::uuid,%L::uuid,40,%L::jsonb)',
    pg_temp.analysis_fixture_id('handoff_batches'),
    (select operation_id from pg_temp.handoff_ops where name = 'handoff_batches'),
    '{"processedPairs":40,"totalPairs":40,"findingsCount":0,"lastPairFingerprint":"pair-40","startedAt":"2026-10-17T00:00:00Z"}'),
  'CAS heartbeat accepts the current cursor');
select ok((select public.yield_analysis_batch(
    pg_temp.analysis_fixture_id('handoff_batches'),
    (select operation_id from pg_temp.handoff_ops where name = 'handoff_batches'),
    30,
    '{"processedPairs":40,"totalPairs":40,"findingsCount":0,"lastPairFingerprint":"pair-40","startedAt":"2026-10-17T00:00:00Z"}'::jsonb) = false),
  'A handoff rejects a cursor that is not the current checkpoint');
select ok((select attempt_deadline_at = (select attempt_deadline_at from pg_temp.handoff_ops where name = 'handoff_batches')
    and analysis_deadline_at = (select analysis_deadline_at from pg_temp.handoff_ops where name = 'handoff_batches')
    from public.analyses where id = pg_temp.analysis_fixture_id('handoff_batches')),
  'Heartbeat and handoff never move either deadline');
delete from public.analysis_documents where analysis_id = pg_temp.analysis_fixture_id('handoff_batches');
delete from public.analyses where id = pg_temp.analysis_fixture_id('handoff_batches');

insert into pg_temp.analysis_fixture_ids(name, analysis_id) values
  ('handoff_crash', pg_temp.create_analysis_fixture(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '10000000-0000-4000-8000-000000000004', 'queued', 1));
insert into pg_temp.handoff_ops(name, operation_id)
  select 'handoff_crash', c.operation_id
  from public.claim_analysis(pg_temp.analysis_fixture_id('handoff_crash')) c;
update pg_temp.handoff_ops set attempt_deadline_at = a.attempt_deadline_at,
  analysis_deadline_at = a.analysis_deadline_at
  from public.analyses a where handoff_ops.name = 'handoff_crash'
    and a.id = pg_temp.analysis_fixture_id('handoff_crash');
update public.analyses set lease_expires_at = clock_timestamp() - interval '1 second'
  where id = pg_temp.analysis_fixture_id('handoff_crash');
select is((select attempt_count from public.claim_analysis(pg_temp.analysis_fixture_id('handoff_crash'))),
  2, 'A crashed processing lease starts a new attempt');
select ok((select operation_id is distinct from (select operation_id from pg_temp.handoff_ops where name = 'handoff_crash')
    and analysis_deadline_at = (select analysis_deadline_at from pg_temp.handoff_ops where name = 'handoff_crash')
    and attempt_started_at > (select created_at from public.analyses where id = pg_temp.analysis_fixture_id('handoff_crash'))
    from public.analyses where id = pg_temp.analysis_fixture_id('handoff_crash')),
  'Crash recovery rotates the operation and attempt deadline under the original total deadline');
delete from public.analysis_documents where analysis_id = pg_temp.analysis_fixture_id('handoff_crash');
delete from public.analyses where id = pg_temp.analysis_fixture_id('handoff_crash');

insert into pg_temp.analysis_fixture_ids(name, analysis_id) values
  ('handoff_expired', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001', 'queued', 1));
insert into pg_temp.handoff_ops(name, operation_id)
  select 'handoff_expired', c.operation_id
  from public.claim_analysis(pg_temp.analysis_fixture_id('handoff_expired')) c;
insert into public.credit_ledger(workspace_id, event_type, amount, analysis_id)
select workspace_id, 'Reserved', 3, id
from public.analyses where id = pg_temp.analysis_fixture_id('handoff_expired');
update pg_temp.handoff_ops set attempt_deadline_at = a.attempt_deadline_at,
  analysis_deadline_at = a.analysis_deadline_at
  from public.analyses a where handoff_ops.name = 'handoff_expired'
    and a.id = pg_temp.analysis_fixture_id('handoff_expired');
select is(public.yield_analysis_batch(
    pg_temp.analysis_fixture_id('handoff_expired'),
    (select operation_id from pg_temp.handoff_ops where name = 'handoff_expired'),
    0,
    '{"processedPairs":1,"totalPairs":10,"findingsCount":0,"lastPairFingerprint":"pair-1","startedAt":"2026-10-17T00:00:00Z"}'::jsonb),
  true, 'An in-budget continuation can be queued before expiry');
update public.analyses set attempt_deadline_at = clock_timestamp() - interval '1 second'
  where id = pg_temp.analysis_fixture_id('handoff_expired');
select is((select count(*)::integer from public.claim_analysis(pg_temp.analysis_fixture_id('handoff_expired'))),
  0, 'An expired continuation is not claimed as a new retry');
select is((select status::text || '|' || error_code::text || '|' || attempt_count::text
  from public.analyses where id = pg_temp.analysis_fixture_id('handoff_expired')),
  'failed|TIMEOUT|1', 'An expired continuation becomes terminal without consuming another attempt');
select is((select count(*)::integer from public.credit_ledger
  where analysis_id = pg_temp.analysis_fixture_id('handoff_expired')), 2,
  'An expired continuation keeps the reservation and adds a release');
select is((select count(*)::integer from public.credit_ledger
  where analysis_id = pg_temp.analysis_fixture_id('handoff_expired') and event_type = 'Released'), 1,
  'An expired continuation releases the reservation exactly once');
select is((select count(*)::integer from public.notification_events
  where analysis_id = pg_temp.analysis_fixture_id('handoff_expired')
    and type = 'analysis_failed'), 1,
  'An expired continuation emits one failure event');
delete from public.notification_events
  where analysis_id = pg_temp.analysis_fixture_id('handoff_expired');
delete from public.credit_ledger
  where analysis_id = pg_temp.analysis_fixture_id('handoff_expired');
delete from public.analysis_documents where analysis_id = pg_temp.analysis_fixture_id('handoff_expired');
delete from public.analyses where id = pg_temp.analysis_fixture_id('handoff_expired');

insert into pg_temp.analysis_fixture_ids(name, analysis_id) values
  ('handoff_failure', pg_temp.create_analysis_fixture(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '10000000-0000-4000-8000-000000000004', 'queued', 1));
insert into pg_temp.handoff_ops(name, operation_id)
  select 'handoff_failure', c.operation_id
  from public.claim_analysis(pg_temp.analysis_fixture_id('handoff_failure')) c;
update pg_temp.handoff_ops set attempt_deadline_at = a.attempt_deadline_at,
  analysis_deadline_at = a.analysis_deadline_at
  from public.analyses a where handoff_ops.name = 'handoff_failure'
    and a.id = pg_temp.analysis_fixture_id('handoff_failure');
update public.analyses set continuation_pending = true
  where id = pg_temp.analysis_fixture_id('handoff_failure');
select is((select public.fail_analysis(
    pg_temp.analysis_fixture_id('handoff_failure'),
    (select operation_id from pg_temp.handoff_ops where name = 'handoff_failure'),
    true, 'PROVIDER_UNAVAILABLE'::public.analysis_failure_code)),
  'queued', 'A recoverable provider error enters the retry backoff');
select ok((select not continuation_pending and attempt_count = 1
    and checkpoint is null and operation_id is null and lease_expires_at is null
    from public.analyses where id = pg_temp.analysis_fixture_id('handoff_failure')),
  'A recoverable error clears continuation and keeps the attempt budget available');
update public.analyses set next_attempt_at = clock_timestamp() - interval '1 second'
  where id = pg_temp.analysis_fixture_id('handoff_failure');
select is((select attempt_count from public.claim_analysis(pg_temp.analysis_fixture_id('handoff_failure'))),
  2, 'A retry after backoff starts attempt 2');
select ok((select analysis_deadline_at = (select analysis_deadline_at from pg_temp.handoff_ops where name = 'handoff_failure')
    and attempt_deadline_at > (select attempt_deadline_at from pg_temp.handoff_ops where name = 'handoff_failure')
    from public.analyses where id = pg_temp.analysis_fixture_id('handoff_failure')),
  'A retry gets a fresh attempt deadline without extending the total deadline');

select * from finish();
rollback;
