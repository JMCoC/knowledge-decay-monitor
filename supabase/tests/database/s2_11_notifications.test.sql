begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
\ir analysis-fixtures.psql
select no_plan();

select has_table('private', 'notification_deliveries',
  'Delivery envelopes are held in a private table');
select has_table('private', 'notification_dispatch_settings',
  'Dispatch enablement has a private control row');
select has_column('public', 'notification_events', 'operation_id',
  'Notification events have a fencing token');
select has_column('public', 'notification_events', 'lease_expires_at',
  'Notification events have an expiring lease');
select ok(not has_table_privilege('anon', 'public.notification_events', 'SELECT'),
  'anon cannot read notification events');
select ok(not has_table_privilege('anon', 'public.notification_events', 'INSERT')
    and not has_table_privilege('anon', 'public.notification_events', 'UPDATE'),
  'anon cannot write notification events');
select ok(not has_table_privilege('authenticated', 'public.notification_events', 'SELECT'),
  'authenticated cannot read notification events');
select ok(not has_table_privilege('authenticated', 'public.notification_events', 'INSERT')
    and not has_table_privilege('authenticated', 'public.notification_events', 'UPDATE'),
  'authenticated cannot write notification events');
select ok(not has_table_privilege('anon', 'private.notification_deliveries', 'SELECT'),
  'anon cannot read private delivery envelopes');
select ok(not has_table_privilege('anon', 'private.notification_deliveries', 'INSERT')
    and not has_table_privilege('anon', 'private.notification_deliveries', 'UPDATE'),
  'anon cannot write private delivery envelopes');
select ok(not has_table_privilege('authenticated', 'private.notification_deliveries', 'SELECT'),
  'authenticated cannot read private delivery envelopes');
select ok(not has_table_privilege('authenticated', 'private.notification_deliveries', 'INSERT')
    and not has_table_privilege('authenticated', 'private.notification_deliveries', 'UPDATE'),
  'authenticated cannot write private delivery envelopes');
select ok(not has_table_privilege('anon', 'private.notification_dispatch_settings', 'SELECT')
    and not has_table_privilege('anon', 'private.notification_dispatch_settings', 'INSERT')
    and not has_table_privilege('anon', 'private.notification_dispatch_settings', 'UPDATE')
    and not has_table_privilege('authenticated', 'private.notification_dispatch_settings', 'SELECT')
    and not has_table_privilege('authenticated', 'private.notification_dispatch_settings', 'INSERT')
    and not has_table_privilege('authenticated', 'private.notification_dispatch_settings', 'UPDATE'),
  'Users cannot read or change the private dispatch setting');
select ok(not has_function_privilege('anon', 'public.claim_notification_event(uuid)', 'EXECUTE'),
  'anon cannot claim notification events');
select ok(not has_function_privilege('authenticated', 'public.prepare_notification_delivery(uuid,uuid,text)', 'EXECUTE'),
  'authenticated cannot prepare notification deliveries');
select ok(has_function_privilege('service_role', 'public.claim_notification_event(uuid)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.prepare_notification_delivery(uuid,uuid,text)', 'EXECUTE'),
  'The server role can call the notification RPCs');

create function pg_temp.notification_analysis(p_name text)
returns uuid
language plpgsql
set search_path = pg_temp, public
as $$
declare
  v_analysis_id uuid;
begin
  v_analysis_id := pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '10000000-0000-4000-8000-000000000001',
    'completed', 0);
  insert into pg_temp.analysis_fixture_ids(name, analysis_id)
  values (p_name, v_analysis_id);
  return v_analysis_id;
end;
$$;

create temporary table notification_fixture (
  name text primary key,
  event_id uuid not null,
  analysis_id uuid not null,
  workspace_id uuid not null,
  recipient_id uuid not null
) on commit drop;

insert into notification_fixture(name, event_id, analysis_id, workspace_id, recipient_id)
values
  ('main', gen_random_uuid(), pg_temp.notification_analysis('main'),
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001'),
  ('stale', gen_random_uuid(), pg_temp.notification_analysis('stale'),
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001'),
  ('future', gen_random_uuid(), pg_temp.notification_analysis('future'),
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001'),
  ('exhausted', gen_random_uuid(), pg_temp.notification_analysis('exhausted'),
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001');

insert into public.notification_events(id, workspace_id, analysis_id, type, recipient_id,
  status, attempt_count, next_attempt_at)
select event_id, workspace_id, analysis_id, 'analysis_completed', recipient_id,
       'pending', case when name = 'exhausted' then 3 else 0 end,
       case when name = 'future' then now() + interval '1 hour' else null end
from notification_fixture;

select throws_ok(format(
  'insert into public.notification_events(id, workspace_id, analysis_id, type, recipient_id) values (%L, %L, %L, %L, %L)',
  gen_random_uuid(), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  (select analysis_id from notification_fixture where name = 'main'),
  'analysis_completed', '10000000-0000-4000-8000-000000000002'),
  '23503', null, 'A notification cannot cross the analysis workspace foreign key');

select is((select enabled from private.notification_dispatch_settings where id), false,
  'Notification dispatch starts disabled');
select is((select count(*)::integer from public.claim_notification_event(
  (select event_id from notification_fixture where name = 'main'))), 0,
  'A disabled claim does not return work');
select is((select attempt_count from public.notification_events
  where id = (select event_id from notification_fixture where name = 'main')), 0,
  'A disabled claim does not increment attempts');
select ok((select operation_id is null and lease_expires_at is null
  from public.notification_events where id = (select event_id from notification_fixture where name = 'main')),
  'A disabled claim does not write a lease');

update private.notification_dispatch_settings set enabled = true where id;
select is((select count(*)::integer from public.claim_notification_event(
  (select event_id from notification_fixture where name = 'main'))), 1,
  'An enabled due event is claimed once');
select ok((select request_json is null and idempotency_key is null and first_submission_at is null
  from private.notification_deliveries
  where event_id = (select event_id from notification_fixture where name = 'main')),
  'The first claim creates only private delivery metadata, before preparing an envelope');
select is((select count(*)::integer from public.claim_notification_event(
  (select event_id from notification_fixture where name = 'main'))), 0,
  'A second claim cannot take an unexpired lease');
select is((select count(*)::integer from public.claim_notification_event(
  (select event_id from notification_fixture where name = 'future'))), 0,
  'A not-yet-due event is not claimed');
select is((select count(*)::integer from public.claim_notification_event(
  (select event_id from notification_fixture where name = 'exhausted'))), 0,
  'An event at the three-claim ceiling is never claimed a fourth time');
select throws_ok(format(
  'update public.notification_events set attempt_count = 4 where id = %L',
  (select event_id from notification_fixture where name = 'main')),
  '23514', null, 'The attempt counter remains bounded at three');

create temporary table notification_request on commit drop as
select f.event_id, e.operation_id,
  jsonb_build_object(
    'from', 'Knowledge Decay Monitor <notifications@knowledge-decay-monitor.online>',
    'to', jsonb_build_array(c.context->'data'->>'recipientEmail'),
    'subject', 'Analysis completed',
    'html', '<p>Analysis completed</p>',
    'text', 'Analysis completed'
  )::text as request_json
from notification_fixture f
join public.notification_events e on e.id = f.event_id
cross join lateral (select public.get_notification_context(f.event_id, e.operation_id) as context) c
where f.name = 'main';

select ok((public.get_notification_context(event_id, operation_id)->'ok')::boolean,
  'The persisted Admin recipient and terminal analysis produce a delivery context')
from notification_request;
select ok((public.prepare_notification_delivery(event_id, operation_id, request_json)->'ok')::boolean,
  'The first prepare stores the exact validated request before sending')
from notification_request;
select is((select idempotency_key from private.notification_deliveries
  where event_id = (select event_id from notification_request)),
  'kdm-terminal/' || (select event_id::text from notification_request) || '/v1',
  'The Resend idempotency key is stable for the event');
create temporary table notification_first_submission on commit drop as
select event_id, first_submission_at, idempotency_key
from private.notification_deliveries
where event_id = (select event_id from notification_request);
select is((select request_json from private.notification_deliveries
  where event_id = (select event_id from notification_request)),
  (select request_json from notification_request),
  'The prepared request bytes are persisted exactly');

select is((public.prepare_notification_delivery(
  event_id, operation_id,
  jsonb_set(request_json::jsonb, '{subject}', '"Changed template"')::text
)->'data'->>'requestJson'), request_json,
  'A retry receives the original immutable request even if its template changed')
from notification_request;
select is((select idempotency_key from private.notification_deliveries
  where event_id = (select event_id from notification_request)),
  (select idempotency_key from notification_first_submission),
  'The retry keeps the original idempotency key');
select is((select first_submission_at from private.notification_deliveries
  where event_id = (select event_id from notification_request)),
  (select first_submission_at from notification_first_submission),
  'The retry keeps the original submission-window start');
select is(public.recover_notification_event(
  (select event_id from notification_fixture where name = 'main')), 'unchanged',
  'Recovery does not invalidate an active lease');

select ok(public.confirm_notification_sent(
  event_id, operation_id, 'resend-message-synthetic'),
  'A valid provider acknowledgement marks the event sent')
from notification_request;
select ok(public.confirm_notification_sent(
  event_id, operation_id, 'resend-message-synthetic'),
  'Repeating the same acknowledgement remains idempotent after lease cleanup')
from notification_request;
select ok((select status = 'sent' and sent_at is not null and next_attempt_at is null
    and error_code is null and operation_id is null and lease_expires_at is null
  from public.notification_events where id = (select event_id from notification_request)),
  'Sent state clears the lease, retry time and previous error');
select is((select sent_operation_id from private.notification_deliveries
  where event_id = (select event_id from notification_request)),
  (select operation_id from notification_request),
  'The delivery row retains the operation that received the provider acknowledgement');

select is((select count(*)::integer from public.claim_notification_event(
  (select event_id from notification_fixture where name = 'stale'))), 1,
  'A second event obtains a lease for the stale-token check');
create temporary table stale_operation on commit drop as
select id as event_id, operation_id from public.notification_events
where id = (select event_id from notification_fixture where name = 'stale');
update public.notification_events
set operation_id = gen_random_uuid(), lease_expires_at = now() + interval '90 seconds'
where id = (select event_id from stale_operation);
select ok(not public.confirm_notification_sent(event_id, operation_id, 'stale-message'),
  'A stale operation token cannot acknowledge a send')
from stale_operation;
select is(public.record_notification_failure(
  event_id, operation_id, 'DELIVERY_FAILED', null), 'lost',
  'A stale operation token cannot record a failure')
from stale_operation;
select ok((select status = 'pending' and attempt_count = 1
    and operation_id is not null and lease_expires_at > now()
  from public.notification_events where id = (select event_id from stale_operation)),
  'Stale acknowledgements leave the current lease and attempt unchanged');

select * from finish();
rollback;
