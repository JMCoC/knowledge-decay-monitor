begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
\ir analysis-fixtures.psql
select no_plan();

-- (a) Worker columns exist and are nullable.
select has_column('public', 'analyses', 'checkpoint', 'Worker checkpoint column exists');
select has_column('public', 'analyses', 'next_attempt_at', 'Worker backoff column exists');
select is((select data_type from information_schema.columns
  where table_schema = 'public' and table_name = 'analyses' and column_name = 'checkpoint'),
  'jsonb', 'checkpoint stores a JSON cursor');
select is((select data_type from information_schema.columns
  where table_schema = 'public' and table_name = 'analyses' and column_name = 'next_attempt_at'),
  'timestamp with time zone', 'next_attempt_at stores a backoff timestamp');
select is((select is_nullable from information_schema.columns
  where table_schema = 'public' and table_name = 'analyses' and column_name = 'checkpoint'),
  'YES', 'checkpoint is nullable');
select is((select is_nullable from information_schema.columns
  where table_schema = 'public' and table_name = 'analyses' and column_name = 'next_attempt_at'),
  'YES', 'next_attempt_at is nullable');

-- (b) New columns stay outside the authenticated projection; service_role sees them.
select ok(not has_column_privilege('authenticated', 'public.analyses', 'checkpoint', 'SELECT'),
  'Browser cannot read checkpoint');
select ok(not has_column_privilege('authenticated', 'public.analyses', 'next_attempt_at', 'SELECT'),
  'Browser cannot read next_attempt_at');
select ok(has_column_privilege('service_role', 'public.analyses', 'checkpoint', 'SELECT'),
  'Service role reads checkpoint');
select ok(has_column_privilege('service_role', 'public.analyses', 'next_attempt_at', 'SELECT'),
  'Service role reads next_attempt_at');

-- (i) Claim entrypoint privileges.
select has_function('public', 'claim_analysis', array['uuid'], 'claim_analysis entrypoint exists');
select ok(not has_function_privilege('authenticated', 'public.claim_analysis(uuid)', 'EXECUTE'),
  'Browser cannot claim analysis jobs');
select ok(not has_function_privilege('anon', 'public.claim_analysis(uuid)', 'EXECUTE'),
  'Anonymous cannot claim analysis jobs');
select ok(has_function_privilege('service_role', 'public.claim_analysis(uuid)', 'EXECUTE'),
  'Service role can claim analysis jobs');

-- (j) Task 0 Option A grant: the worker runs retrieval as service_role.
select ok(has_function_privilege('service_role',
  'public.retrieve_candidate_pairs(uuid,uuid[],uuid[],integer,double precision)', 'EXECUTE'),
  'Service role can run retrieval for the worker');

-- NOTE: privileged calls below run as the default test-runner role (011
-- pattern: set local role is only needed for negative-path throws_ok).
-- (c) Review Focus #1: a fresh queued job with NULL next_attempt_at is claimed.
insert into pg_temp.analysis_fixture_ids(name, analysis_id) values
  ('claim_fresh', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001', 'queued', 1));
select is((select count(*)::integer from public.claim_analysis(null)), 1,
  'A fresh queued job with NULL next_attempt_at is claimed');
select is((select status::text from public.analyses
  where id = pg_temp.analysis_fixture_id('claim_fresh')), 'processing',
  'A claimed job moves to processing');
select is((select attempt_count from public.analyses
  where id = pg_temp.analysis_fixture_id('claim_fresh')), 1,
  'The first claim starts attempt 1');
select ok((select operation_id is not null from public.analyses
  where id = pg_temp.analysis_fixture_id('claim_fresh')),
  'A claim mints a fencing operation_id');
select ok((select lease_expires_at is not null from public.analyses
  where id = pg_temp.analysis_fixture_id('claim_fresh')),
  'A claim sets a lease');
select ok((select next_attempt_at is null from public.analyses
  where id = pg_temp.analysis_fixture_id('claim_fresh')),
  'A claim clears next_attempt_at');
delete from public.analysis_documents
  where analysis_id = pg_temp.analysis_fixture_id('claim_fresh');
delete from public.analyses where id = pg_temp.analysis_fixture_id('claim_fresh');

-- (d) FIFO sweep across workspaces.
insert into pg_temp.analysis_fixture_ids(name, analysis_id) values
  ('fifo_old', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001', 'queued', 1)),
  ('fifo_new', pg_temp.create_analysis_fixture(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '10000000-0000-4000-8000-000000000004', 'queued', 1));
update public.analyses set created_at = now() - interval '1 hour'
  where id = pg_temp.analysis_fixture_id('fifo_old');
update public.analyses set created_at = now()
  where id = pg_temp.analysis_fixture_id('fifo_new');
select is((select id from public.claim_analysis(null)),
  pg_temp.analysis_fixture_id('fifo_old'),
  'The FIFO sweep returns the oldest queued job first');
delete from public.analysis_documents
  where analysis_id in (
    pg_temp.analysis_fixture_id('fifo_old'), pg_temp.analysis_fixture_id('fifo_new'));
delete from public.analyses
  where id in (
    pg_temp.analysis_fixture_id('fifo_old'), pg_temp.analysis_fixture_id('fifo_new'));

-- (e) Review Focus #2: an expired third attempt is never reclaimed.
insert into pg_temp.analysis_fixture_ids(name, analysis_id) values
  ('claim_terminal', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001', 'processing', 1));
update public.analyses
  set lease_expires_at = now() - interval '1 minute', attempt_count = 3
  where id = pg_temp.analysis_fixture_id('claim_terminal');
select is((select count(*)::integer from public.claim_analysis(null)), 0,
  'An expired third attempt is never reclaimed');
select is((select status::text from public.analyses
  where id = pg_temp.analysis_fixture_id('claim_terminal')), 'failed',
  'An expired third attempt is marked failed');
select is((select error_code::text from public.analyses
  where id = pg_temp.analysis_fixture_id('claim_terminal')), 'ATTEMPTS_EXHAUSTED',
  'Terminal marking uses ATTEMPTS_EXHAUSTED');
select ok((select finished_at is not null from public.analyses
  where id = pg_temp.analysis_fixture_id('claim_terminal')),
  'Terminal marking stamps finished_at');
select is((select count(*)::integer from public.credit_ledger
  where analysis_id = pg_temp.analysis_fixture_id('claim_terminal')), 0,
  'Terminal marking releases no credits (TODO S2-08)');
delete from public.analysis_documents
  where analysis_id = pg_temp.analysis_fixture_id('claim_terminal');
delete from public.analyses where id = pg_temp.analysis_fixture_id('claim_terminal');

-- (f) Directed claim returns the requested job.
insert into pg_temp.analysis_fixture_ids(name, analysis_id) values
  ('claim_directed', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001', 'queued', 1));
select is((select id from public.claim_analysis(pg_temp.analysis_fixture_id('claim_directed'))),
  pg_temp.analysis_fixture_id('claim_directed'),
  'A directed claim returns the requested job');
delete from public.analysis_documents
  where analysis_id = pg_temp.analysis_fixture_id('claim_directed');
delete from public.analyses where id = pg_temp.analysis_fixture_id('claim_directed');

-- (g) Ineligible directed ids fall back to an empty sweep.
insert into pg_temp.analysis_fixture_ids(name, analysis_id) values
  ('claim_done', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001', 'completed', 1));
select is((select count(*)::integer
  from public.claim_analysis(pg_temp.analysis_fixture_id('claim_done'))), 0,
  'A terminal id falls back to an empty sweep');
insert into pg_temp.analysis_fixture_ids(name, analysis_id) values
  ('claim_waiting', pg_temp.create_analysis_fixture(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '10000000-0000-4000-8000-000000000004', 'queued', 1));
update public.analyses set next_attempt_at = now() + interval '1 hour'
  where id = pg_temp.analysis_fixture_id('claim_waiting');
select is((select count(*)::integer
  from public.claim_analysis(pg_temp.analysis_fixture_id('claim_waiting'))), 0,
  'A job inside backoff is skipped by directed claim and sweep');
delete from public.analysis_documents
  where analysis_id in (
    pg_temp.analysis_fixture_id('claim_done'), pg_temp.analysis_fixture_id('claim_waiting'));
delete from public.analyses
  where id in (
    pg_temp.analysis_fixture_id('claim_done'), pg_temp.analysis_fixture_id('claim_waiting'));

-- Task 2: renew/complete/fail. Operation ids of live fixtures are pinned
-- in a temp table so fencing tests can replay the exact fencing token.
create temporary table worker_ops(
  analysis_name text primary key,
  operation_id uuid
) on commit drop;

-- (k) Valid renew extends the lease and persists the checkpoint.
insert into pg_temp.analysis_fixture_ids(name, analysis_id) values
  ('renew_ok', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001', 'processing', 1));
insert into pg_temp.worker_ops(analysis_name, operation_id)
  select 'renew_ok', operation_id from public.analyses
  where id = pg_temp.analysis_fixture_id('renew_ok');
select ok((select lease_expires_at is not null from public.renew_analysis_lease(
    pg_temp.analysis_fixture_id('renew_ok'),
    (select operation_id from pg_temp.worker_ops where analysis_name = 'renew_ok'),
    '{"processedPairs":1,"totalPairs":10,"findingsCount":0,"lastPairFingerprint":null,"startedAt":"2026-10-15T00:00:00.000Z"}'::jsonb)),
  'A valid renew returns a fresh lease');
select is((select checkpoint->>'processedPairs' from public.analyses
  where id = pg_temp.analysis_fixture_id('renew_ok')), '1',
  'A renew persists the checkpoint cursor');
select ok((select lease_expires_at > clock_timestamp() + interval '100 seconds'
  from public.analyses where id = pg_temp.analysis_fixture_id('renew_ok')),
  'A renew extends the lease toward 180 seconds');

-- (l) Renew rejects a foreign operation_id.
select throws_ok(format('select public.renew_analysis_lease(%L::uuid, %L::uuid, %L::jsonb)',
    pg_temp.analysis_fixture_id('renew_ok'),
    '00000000-0000-0000-0000-000000000000',
    '{"processedPairs":1}'),
  '22023', null, 'A renew with a foreign operation_id is fenced');

-- (m) Renew rejects an expired lease.
update public.analyses set lease_expires_at = clock_timestamp() - interval '1 minute'
  where id = pg_temp.analysis_fixture_id('renew_ok');
select throws_ok(format('select public.renew_analysis_lease(%L::uuid, %L::uuid, %L::jsonb)',
    pg_temp.analysis_fixture_id('renew_ok'),
    (select operation_id from pg_temp.worker_ops where analysis_name = 'renew_ok'),
    '{"processedPairs":2}'),
  '22023', null, 'A renew with an expired lease is fenced');

-- (n) Renew rejects a non-object checkpoint.
update public.analyses
  set lease_expires_at = clock_timestamp() + interval '1 minute', started_at = clock_timestamp()
  where id = pg_temp.analysis_fixture_id('renew_ok');
select throws_ok(format('select public.renew_analysis_lease(%L::uuid, %L::uuid, %L::jsonb)',
    pg_temp.analysis_fixture_id('renew_ok'),
    (select operation_id from pg_temp.worker_ops where analysis_name = 'renew_ok'),
    '[]'),
  '22023', null, 'A renew with a non-object checkpoint is rejected');

-- (o) Renew rejects an attempt older than 30 minutes.
update public.analyses
  set lease_expires_at = clock_timestamp() + interval '1 minute',
      started_at = clock_timestamp() - interval '31 minutes'
  where id = pg_temp.analysis_fixture_id('renew_ok');
select throws_ok(format('select public.renew_analysis_lease(%L::uuid, %L::uuid, %L::jsonb)',
    pg_temp.analysis_fixture_id('renew_ok'),
    (select operation_id from pg_temp.worker_ops where analysis_name = 'renew_ok'),
    '{"processedPairs":3}'),
  '22023', null, 'A renew past started_at plus 30 minutes is fenced');
delete from public.analysis_documents
  where analysis_id = pg_temp.analysis_fixture_id('renew_ok');
delete from public.analyses where id = pg_temp.analysis_fixture_id('renew_ok');

-- (p) Valid complete marks the job completed.
insert into pg_temp.analysis_fixture_ids(name, analysis_id) values
  ('complete_ok', pg_temp.create_analysis_fixture(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '10000000-0000-4000-8000-000000000004', 'processing', 1));
insert into pg_temp.worker_ops(analysis_name, operation_id)
  select 'complete_ok', operation_id from public.analyses
  where id = pg_temp.analysis_fixture_id('complete_ok');
select lives_ok(format('select public.complete_analysis(%L::uuid, %L::uuid)',
    pg_temp.analysis_fixture_id('complete_ok'),
    (select operation_id from pg_temp.worker_ops where analysis_name = 'complete_ok')),
  'A valid complete marks the job completed');
select is((select status::text from public.analyses
  where id = pg_temp.analysis_fixture_id('complete_ok')), 'completed',
  'A completed job stays completed');
select ok((select finished_at is not null from public.analyses
  where id = pg_temp.analysis_fixture_id('complete_ok')),
  'A complete stamps finished_at');

-- (q) Repeating the same complete is a no-op.
select lives_ok(format('select public.complete_analysis(%L::uuid, %L::uuid)',
    pg_temp.analysis_fixture_id('complete_ok'),
    (select operation_id from pg_temp.worker_ops where analysis_name = 'complete_ok')),
  'Repeating a complete is an idempotent no-op');

-- (r) Complete with a foreign operation_id raises.
select throws_ok(format('select public.complete_analysis(%L::uuid, %L::uuid)',
    pg_temp.analysis_fixture_id('complete_ok'),
    '00000000-0000-0000-0000-000000000000'),
  '22023', null, 'A complete with a foreign operation_id is fenced');
delete from public.analysis_documents
  where analysis_id = pg_temp.analysis_fixture_id('complete_ok');
delete from public.analyses where id = pg_temp.analysis_fixture_id('complete_ok');

-- (s) Review Focus #3: retryable failure at attempt 1 requeues without incrementing.
insert into pg_temp.analysis_fixture_ids(name, analysis_id) values
  ('fail_r1', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001', 'processing', 1));
insert into pg_temp.worker_ops(analysis_name, operation_id)
  select 'fail_r1', operation_id from public.analyses
  where id = pg_temp.analysis_fixture_id('fail_r1');
select is((select public.fail_analysis(
    pg_temp.analysis_fixture_id('fail_r1'),
    (select operation_id from pg_temp.worker_ops where analysis_name = 'fail_r1'),
    true, 'PROVIDER_UNAVAILABLE'::public.analysis_failure_code)), 'queued',
  'A retryable failure at attempt 1 requeues the job');
select is((select attempt_count from public.analyses
  where id = pg_temp.analysis_fixture_id('fail_r1')), 1,
  'fail_analysis does not increment attempt_count');
select is((select status::text from public.analyses
  where id = pg_temp.analysis_fixture_id('fail_r1')), 'queued',
  'A requeued job waits for its backoff');
select ok((select next_attempt_at between clock_timestamp() + interval '25 seconds'
    and clock_timestamp() + interval '35 seconds' from public.analyses
  where id = pg_temp.analysis_fixture_id('fail_r1')),
  'Backoff from attempt 1 waits about 30 seconds');
delete from public.analysis_documents
  where analysis_id = pg_temp.analysis_fixture_id('fail_r1');
delete from public.analyses where id = pg_temp.analysis_fixture_id('fail_r1');

-- (t) Retryable failure at attempt 2 waits about 2 minutes, still without incrementing.
insert into pg_temp.analysis_fixture_ids(name, analysis_id) values
  ('fail_r2', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001', 'processing', 1));
update public.analyses set attempt_count = 2
  where id = pg_temp.analysis_fixture_id('fail_r2');
insert into pg_temp.worker_ops(analysis_name, operation_id)
  select 'fail_r2', operation_id from public.analyses
  where id = pg_temp.analysis_fixture_id('fail_r2');
select is((select public.fail_analysis(
    pg_temp.analysis_fixture_id('fail_r2'),
    (select operation_id from pg_temp.worker_ops where analysis_name = 'fail_r2'),
    true, 'TIMEOUT'::public.analysis_failure_code)), 'queued',
  'A retryable failure at attempt 2 requeues the job');
select is((select attempt_count from public.analyses
  where id = pg_temp.analysis_fixture_id('fail_r2')), 2,
  'fail_analysis keeps attempt_count at 2');
select ok((select next_attempt_at between clock_timestamp() + interval '115 seconds'
    and clock_timestamp() + interval '125 seconds' from public.analyses
  where id = pg_temp.analysis_fixture_id('fail_r2')),
  'Backoff from attempt 2 waits about 2 minutes');
delete from public.analysis_documents
  where analysis_id = pg_temp.analysis_fixture_id('fail_r2');
delete from public.analyses where id = pg_temp.analysis_fixture_id('fail_r2');

-- (u) Retryable failure at attempt 3 ends the job as failed.
insert into pg_temp.analysis_fixture_ids(name, analysis_id) values
  ('fail_r3', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001', 'processing', 1));
update public.analyses set attempt_count = 3
  where id = pg_temp.analysis_fixture_id('fail_r3');
insert into pg_temp.worker_ops(analysis_name, operation_id)
  select 'fail_r3', operation_id from public.analyses
  where id = pg_temp.analysis_fixture_id('fail_r3');
select is((select public.fail_analysis(
    pg_temp.analysis_fixture_id('fail_r3'),
    (select operation_id from pg_temp.worker_ops where analysis_name = 'fail_r3'),
    true, 'TIMEOUT'::public.analysis_failure_code)), 'failed',
  'A retryable failure at attempt 3 ends the job as failed');
select is((select error_code::text from public.analyses
  where id = pg_temp.analysis_fixture_id('fail_r3')), 'TIMEOUT',
  'A terminal failure keeps the reported code');
select ok((select finished_at is not null and lease_expires_at is null from public.analyses
  where id = pg_temp.analysis_fixture_id('fail_r3')),
  'A terminal failure stamps finished_at and clears the lease');
select is((select count(*)::integer from public.credit_ledger
  where analysis_id = pg_temp.analysis_fixture_id('fail_r3')), 0,
  'A terminal failure moves no credits (TODO S2-08)');
select is((select count(*)::integer from public.notification_events
  where analysis_id = pg_temp.analysis_fixture_id('fail_r3')), 0,
  'A terminal failure emits no events (TODO S2-08)');
delete from public.analysis_documents
  where analysis_id = pg_temp.analysis_fixture_id('fail_r3');
delete from public.analyses where id = pg_temp.analysis_fixture_id('fail_r3');

-- (v) A non-retryable code fails fast even at attempt 1.
insert into pg_temp.analysis_fixture_ids(name, analysis_id) values
  ('fail_nr', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001', 'processing', 1));
insert into pg_temp.worker_ops(analysis_name, operation_id)
  select 'fail_nr', operation_id from public.analyses
  where id = pg_temp.analysis_fixture_id('fail_nr');
select is((select public.fail_analysis(
    pg_temp.analysis_fixture_id('fail_nr'),
    (select operation_id from pg_temp.worker_ops where analysis_name = 'fail_nr'),
    false, 'ESTIMATE_STALE'::public.analysis_failure_code)), 'failed',
  'A non-retryable failure ends the job without requeue');
select is((select error_code::text from public.analyses
  where id = pg_temp.analysis_fixture_id('fail_nr')), 'ESTIMATE_STALE',
  'A fast failure keeps ESTIMATE_STALE');
select is((select count(*)::integer from public.credit_ledger
  where analysis_id = pg_temp.analysis_fixture_id('fail_nr')), 0,
  'A fast failure moves no credits (TODO S2-08)');
delete from public.analysis_documents
  where analysis_id = pg_temp.analysis_fixture_id('fail_nr');
delete from public.analyses where id = pg_temp.analysis_fixture_id('fail_nr');

-- (w) Review Focus #5: a foreign operation_id is superseded without touching the row.
insert into pg_temp.analysis_fixture_ids(name, analysis_id) values
  ('fail_wrongop', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001', 'processing', 1));
insert into pg_temp.worker_ops(analysis_name, operation_id)
  select 'fail_wrongop', operation_id from public.analyses
  where id = pg_temp.analysis_fixture_id('fail_wrongop');
select is((select public.fail_analysis(
    pg_temp.analysis_fixture_id('fail_wrongop'),
    '00000000-0000-0000-0000-000000000000', true,
    'PROVIDER_UNAVAILABLE'::public.analysis_failure_code)), 'superseded',
  'A failure from a foreign worker is superseded');
select lives_ok(format('select public.complete_analysis(%L::uuid, %L::uuid)',
    pg_temp.analysis_fixture_id('fail_wrongop'),
    (select operation_id from pg_temp.worker_ops where analysis_name = 'fail_wrongop')),
  'The fenced row stays live for its owner');
delete from public.analysis_documents
  where analysis_id = pg_temp.analysis_fixture_id('fail_wrongop');
delete from public.analyses where id = pg_temp.analysis_fixture_id('fail_wrongop');

-- (x) A failure with an expired lease is superseded without touching the row.
insert into pg_temp.analysis_fixture_ids(name, analysis_id) values
  ('fail_expired', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001', 'processing', 1));
insert into pg_temp.worker_ops(analysis_name, operation_id)
  select 'fail_expired', operation_id from public.analyses
  where id = pg_temp.analysis_fixture_id('fail_expired');
update public.analyses set lease_expires_at = clock_timestamp() - interval '1 minute'
  where id = pg_temp.analysis_fixture_id('fail_expired');
select is((select public.fail_analysis(
    pg_temp.analysis_fixture_id('fail_expired'),
    (select operation_id from pg_temp.worker_ops where analysis_name = 'fail_expired'),
    true, 'TIMEOUT'::public.analysis_failure_code)), 'superseded',
  'A failure with an expired lease is superseded');
select is((select status::text from public.analyses
  where id = pg_temp.analysis_fixture_id('fail_expired')), 'processing',
  'A superseded row keeps its status');
delete from public.analysis_documents
  where analysis_id = pg_temp.analysis_fixture_id('fail_expired');
delete from public.analyses where id = pg_temp.analysis_fixture_id('fail_expired');

-- (y) A failure on a terminal row is superseded.
insert into pg_temp.analysis_fixture_ids(name, analysis_id) values
  ('fail_done', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001', 'completed', 1));
select is((select public.fail_analysis(
    pg_temp.analysis_fixture_id('fail_done'),
    '00000000-0000-0000-0000-000000000000', true,
    'INTERNAL_ERROR'::public.analysis_failure_code)), 'superseded',
  'A failure on a terminal row is superseded');
select is((select status::text from public.analyses
  where id = pg_temp.analysis_fixture_id('fail_done')), 'completed',
  'A terminal row keeps its status');
delete from public.analysis_documents
  where analysis_id = pg_temp.analysis_fixture_id('fail_done');
delete from public.analyses where id = pg_temp.analysis_fixture_id('fail_done');

-- (h) True concurrent SKIP LOCKED claim needs a second session.
select skip('Second-session SKIP LOCKED claim needs dblink (no repo precedent); method: hold a directed claim open in session A, claim via dblink in session B, assert disjoint rows', 1);

select * from finish();
rollback;
