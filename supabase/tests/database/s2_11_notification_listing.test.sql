begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
\ir analysis-fixtures.psql
select no_plan();

select ok(has_function_privilege('service_role', 'public.list_notification_candidates(integer)', 'EXECUTE'),
  'The server role can list notification candidates');
select ok(not has_function_privilege('anon', 'public.list_notification_candidates(integer)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.list_notification_candidates(integer)', 'EXECUTE'),
  'Browser roles cannot list notification candidates');
select ok(has_function_privilege('service_role', 'public.list_notification_alerts(integer)', 'EXECUTE'),
  'The server role can list due failure alerts');
select ok(not has_function_privilege('anon', 'public.list_notification_alerts(integer)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.list_notification_alerts(integer)', 'EXECUTE'),
  'Browser roles cannot list failure alerts');

create temporary table notification_listing_fixture (
  name text primary key,
  event_id uuid not null,
  analysis_id uuid not null,
  status public.notification_status not null,
  type public.notification_type not null,
  attempt_count integer not null,
  next_attempt_at timestamptz,
  operation_id uuid,
  lease_expires_at timestamptz,
  error_code text
) on commit drop;

insert into notification_listing_fixture(name, event_id, analysis_id, status, type, attempt_count,
  next_attempt_at, operation_id, lease_expires_at, error_code)
values
  ('due', '20000000-0000-4000-8000-000000000001', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001', 'completed', 0),
    'pending', 'analysis_completed', 0, null, null, null, null),
  ('future', '20000000-0000-4000-8000-000000000002', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001', 'completed', 0),
    'pending', 'analysis_completed', 0, now() + interval '1 hour', null, null, null),
  ('expired', '20000000-0000-4000-8000-000000000003', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001', 'completed', 0),
    'pending', 'analysis_completed', 1, null, '30000000-0000-4000-8000-000000000001', now() - interval '1 second', 'DELIVERY_FAILED'),
  ('active', '20000000-0000-4000-8000-000000000004', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001', 'completed', 0),
    'pending', 'analysis_completed', 1, null, '30000000-0000-4000-8000-000000000002', now() + interval '1 minute', null),
  ('exhausted', '20000000-0000-4000-8000-000000000005', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001', 'completed', 0),
    'pending', 'analysis_completed', 3, null, null, null, 'DELIVERY_FAILED'),
  ('alert', '20000000-0000-4000-8000-000000000006', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001', 'failed', 0),
    'failed', 'analysis_failed', 3, null, null, null, 'DELIVERY_FAILED'),
  ('backoff', '20000000-0000-4000-8000-000000000007', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001', 'completed', 0),
    'pending', 'analysis_completed', 0, null, null, null, null),
  ('retry_after', '20000000-0000-4000-8000-000000000008', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001', 'completed', 0),
    'pending', 'analysis_completed', 0, null, null, null, null);

insert into public.notification_events(id, workspace_id, analysis_id, type, recipient_id, created_at,
  status, attempt_count, next_attempt_at, operation_id, lease_expires_at, error_code)
select event_id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', analysis_id, type,
       '10000000-0000-4000-8000-000000000001', '1900-01-01T00:00:00Z'::timestamptz,
       status, attempt_count, next_attempt_at,
       operation_id, lease_expires_at, error_code
from notification_listing_fixture;

insert into private.notification_deliveries(event_id)
select event_id from notification_listing_fixture where name in ('expired', 'active', 'alert');

update private.notification_dispatch_settings set enabled = true where id;

select ok(exists(select 1 from public.list_notification_candidates(5)
  where event_id = '20000000-0000-4000-8000-000000000001' and not recover_expired),
  'The DB-clock listing includes a due unleased event');
select ok(exists(select 1 from public.list_notification_candidates(5)
  where event_id = '20000000-0000-4000-8000-000000000003' and recover_expired),
  'The DB-clock listing identifies an expired lease for recovery');
select ok(not exists(select 1 from public.list_notification_candidates(5)
  where event_id in ('20000000-0000-4000-8000-000000000002',
                     '20000000-0000-4000-8000-000000000004',
                     '20000000-0000-4000-8000-000000000005')),
  'Future, actively leased, and exhausted events are excluded');
select is((select count(*)::integer from public.list_notification_candidates(999) c
  where c.event_id in (select event_id from notification_listing_fixture)), 4,
  'The candidate RPC clamps the requested limit and returns only eligible metadata');
select is((select array_agg(event_id order by ord)
  from public.list_notification_candidates(5) with ordinality as candidates(event_id, recover_expired, ord)
  where event_id in (select event_id from notification_listing_fixture)),
  array['20000000-0000-4000-8000-000000000001'::uuid,
        '20000000-0000-4000-8000-000000000003'::uuid,
        '20000000-0000-4000-8000-000000000007'::uuid,
        '20000000-0000-4000-8000-000000000008'::uuid],
  'Candidate listing is deterministically ordered by created_at and event id');
update private.notification_dispatch_settings set enabled = false where id;
select is((select count(*)::integer from public.list_notification_candidates(5)), 0,
  'The candidate listing stays closed while dispatch is disabled');
update private.notification_dispatch_settings set enabled = true where id;

select is((select array_agg(event_id) from public.list_notification_alerts(50)
  where event_id = '20000000-0000-4000-8000-000000000006'),
  array['20000000-0000-4000-8000-000000000006'::uuid],
  'Only an unreported, due failure alert is listed');
update private.notification_deliveries
set alert_next_attempt_at = now() + interval '1 minute'
where event_id = '20000000-0000-4000-8000-000000000006';
select is((select count(*)::integer from public.list_notification_alerts(50)
  where event_id = '20000000-0000-4000-8000-000000000006'), 0,
  'Alert backoff is evaluated with database time');
update private.notification_deliveries
set alert_next_attempt_at = null, failure_reported_at = now()
where event_id = '20000000-0000-4000-8000-000000000006';
select is((select count(*)::integer from public.list_notification_alerts(50)
  where event_id = '20000000-0000-4000-8000-000000000006'), 0,
  'An acknowledged alert is no longer a candidate');

create temporary table first_retry_lease on commit drop as
select e.id as event_id, e.operation_id, e.attempt_count
from notification_listing_fixture f
cross join lateral public.claim_notification_event(f.event_id) e
where f.name = 'backoff';
select is((select attempt_count from first_retry_lease), 1,
  'The first retry fixture claim starts attempt one');
select is(public.record_notification_failure(event_id, operation_id, 'DELIVERY_FAILED', 0), 'pending',
  'A real first attempt failure is persisted') from first_retry_lease;
select ok((select next_attempt_at >= transaction_timestamp() + interval '59 seconds'
  from public.notification_events where id = '20000000-0000-4000-8000-000000000007'),
  'The first failure receives at least the 60 second backoff');
update public.notification_events set next_attempt_at = clock_timestamp() where id = '20000000-0000-4000-8000-000000000007';
create temporary table second_retry_lease on commit drop as
select e.id as event_id, e.operation_id, e.attempt_count
from notification_listing_fixture f
cross join lateral public.claim_notification_event(f.event_id) e
where f.name = 'backoff';
select is((select attempt_count from second_retry_lease), 2,
  'The second retry fixture claim starts attempt two');
select is(public.record_notification_failure(event_id, operation_id, 'DELIVERY_FAILED', null), 'pending',
  'A real second attempt failure is persisted') from second_retry_lease;
select ok((select next_attempt_at >= transaction_timestamp() + interval '299 seconds'
  from public.notification_events where id = '20000000-0000-4000-8000-000000000007'),
  'The second failure receives at least the 300 second backoff');
update public.notification_events set next_attempt_at = clock_timestamp() where id = '20000000-0000-4000-8000-000000000007';
create temporary table third_retry_lease on commit drop as
select e.id as event_id, e.operation_id, e.attempt_count
from notification_listing_fixture f
cross join lateral public.claim_notification_event(f.event_id) e
where f.name = 'backoff';
select is((select attempt_count from third_retry_lease), 3,
  'The final allowed attempt is claimed exactly once');
select is(public.record_notification_failure(event_id, operation_id, 'DELIVERY_FAILED', null), 'failed',
  'The third failure becomes terminal') from third_retry_lease;
select is((select count(*)::integer from public.claim_notification_event(
  '20000000-0000-4000-8000-000000000007')), 0,
  'No fourth attempt is available');

create temporary table retry_after_lease on commit drop as
select e.id as event_id, e.operation_id
from notification_listing_fixture f
cross join lateral public.claim_notification_event(f.event_id) e
where f.name = 'retry_after';
select is(public.record_notification_failure(event_id, operation_id, 'DELIVERY_FAILED', 3600), 'pending',
  'A bounded Retry-After is accepted by the retry policy') from retry_after_lease;
select ok((select next_attempt_at >= clock_timestamp() + interval '3599 seconds'
  from public.notification_events where id = '20000000-0000-4000-8000-000000000008'),
  'A 3600 second Retry-After is not shortened below its provider hint');

select * from finish();
rollback;
