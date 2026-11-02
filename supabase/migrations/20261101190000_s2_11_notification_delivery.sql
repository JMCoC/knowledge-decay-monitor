-- S2-11: durable, fenced delivery state for terminal analysis notifications.
-- The migration deliberately leaves every existing notification event untouched.

alter table public.notification_events
  add column operation_id uuid,
  add column lease_expires_at timestamptz,
  add constraint notification_events_lease_pair_check
    check ((operation_id is null) = (lease_expires_at is null)),
  add constraint notification_events_terminal_shape_check
    check (
      (status = 'pending' and sent_at is null)
      or (status = 'sent' and sent_at is not null and next_attempt_at is null
          and error_code is null and operation_id is null and lease_expires_at is null)
      or (status = 'failed' and sent_at is null and next_attempt_at is null
          and error_code is not null and operation_id is null and lease_expires_at is null)
    );

create index notification_events_pending_due_idx
  on public.notification_events(next_attempt_at, created_at, id)
  where status = 'pending';

create table private.notification_deliveries (
  event_id uuid primary key references public.notification_events(id) on delete cascade,
  request_json text,
  idempotency_key text,
  first_submission_at timestamptz,
  provider_message_id text,
  sent_operation_id uuid,
  failure_reported_at timestamptz,
  alert_operation_id uuid,
  alert_lease_expires_at timestamptz,
  alert_next_attempt_at timestamptz,
  constraint notification_deliveries_request_size_check
    check (request_json is null or octet_length(request_json) <= 16384),
  constraint notification_deliveries_request_pair_check
    check ((request_json is null and idempotency_key is null and first_submission_at is null)
        or (request_json is not null and idempotency_key is not null and first_submission_at is not null)),
  constraint notification_deliveries_provider_ack_pair_check
    check ((provider_message_id is null) = (sent_operation_id is null)),
  constraint notification_deliveries_alert_lease_pair_check
    check ((alert_operation_id is null) = (alert_lease_expires_at is null))
);

create index notification_deliveries_alert_due_idx
  on private.notification_deliveries(alert_next_attempt_at, event_id)
  where failure_reported_at is null;

create table private.notification_dispatch_settings (
  id boolean primary key default true check (id),
  enabled boolean not null default false
);
insert into private.notification_dispatch_settings(id, enabled) values (true, false);

alter table private.notification_deliveries enable row level security;
alter table private.notification_dispatch_settings enable row level security;
revoke all on private.notification_deliveries, private.notification_dispatch_settings
  from public, anon, authenticated, service_role;

create function public.claim_notification_event(p_event_id uuid)
returns setof public.notification_events
language plpgsql security definer set search_path = '' set row_security = off
set lock_timeout = '1s' set statement_timeout = '3s' as $$
declare
  v_event public.notification_events%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_event_id is null then
    raise exception 'Event id is required' using errcode = '22023';
  end if;

  perform 1
  from private.notification_dispatch_settings s
  where s.id and s.enabled
  for share;
  if not found then
    return;
  end if;

  select e.* into v_event
  from public.notification_events e
  where e.id = p_event_id
  for update skip locked;
  if not found
     or v_event.status <> 'pending'
     or v_event.attempt_count >= 3
     or (v_event.next_attempt_at is not null and v_event.next_attempt_at > v_now)
     or (v_event.operation_id is not null and v_event.lease_expires_at > v_now) then
    return;
  end if;

  -- Expired leases must pass through recover_notification_event so crashes
  -- consume the already-counted attempt and receive the required backoff.
  if v_event.operation_id is not null then
    return;
  end if;

  update public.notification_events e
     set operation_id = pg_catalog.gen_random_uuid(),
         lease_expires_at = v_now + interval '90 seconds',
         attempt_count = e.attempt_count + 1
   where e.id = p_event_id
   returning e.* into v_event;

  insert into private.notification_deliveries(event_id)
  values (p_event_id)
  on conflict (event_id) do nothing;

  return next v_event;
end;
$$;

create function public.get_notification_context(p_event_id uuid, p_operation_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' set row_security = off
set lock_timeout = '1s' set statement_timeout = '3s' as $$
declare
  v_workspace_id uuid;
  v_analysis_id uuid;
  v_recipient_id uuid;
  v_type public.notification_type;
  v_analysis_status public.analysis_job_status;
  v_initiator_id uuid;
  v_finished_at timestamptz;
  v_profile_workspace_id uuid;
  v_profile_role text;
  v_profile_email text;
  v_auth_email text;
  v_banned_until timestamptz;
  v_deleted_at timestamptz;
begin
  if p_event_id is null or p_operation_id is null then
    return pg_catalog.jsonb_build_object('ok', false, 'code', 'LEASE_LOST');
  end if;

  select e.workspace_id, e.analysis_id, e.recipient_id, e.type,
         a.status, a.initiator_id, a.finished_at,
         p.workspace_id, p.role::text, p.email,
         u.email, u.banned_until, u.deleted_at
    into v_workspace_id, v_analysis_id, v_recipient_id, v_type,
         v_analysis_status, v_initiator_id, v_finished_at,
         v_profile_workspace_id, v_profile_role, v_profile_email,
         v_auth_email, v_banned_until, v_deleted_at
  from public.notification_events e
  join public.analyses a on a.id = e.analysis_id and a.workspace_id = e.workspace_id
  left join public.profiles p on p.id = e.recipient_id and p.workspace_id = e.workspace_id
  left join auth.users u on u.id = e.recipient_id
  where e.id = p_event_id
    and e.status = 'pending'
    and e.operation_id = p_operation_id
    and e.lease_expires_at > pg_catalog.clock_timestamp()
  for key share of e;

  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'code', 'LEASE_LOST');
  end if;

  if v_recipient_id is distinct from v_initiator_id
     or v_profile_workspace_id is distinct from v_workspace_id
     or v_profile_role not in ('Admin', 'QA Lead')
     or not ((v_type = 'analysis_completed' and v_analysis_status = 'completed')
          or (v_type = 'analysis_failed' and v_analysis_status = 'failed'))
     or v_finished_at is null
     or v_profile_email is null or pg_catalog.btrim(v_profile_email) = ''
     or v_auth_email is null or pg_catalog.btrim(v_auth_email) = ''
     or pg_catalog.lower(pg_catalog.btrim(v_profile_email))
          is distinct from pg_catalog.lower(pg_catalog.btrim(v_auth_email))
     or (v_banned_until is not null and v_banned_until > pg_catalog.clock_timestamp())
     or v_deleted_at is not null then
    return pg_catalog.jsonb_build_object('ok', false, 'code', 'RECIPIENT_UNAVAILABLE');
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'data', pg_catalog.jsonb_build_object(
      'eventId', p_event_id,
      'analysisId', v_analysis_id,
      'workspaceId', v_workspace_id,
      'recipientId', v_recipient_id,
      'recipientEmail', pg_catalog.btrim(v_auth_email),
      'type', v_type,
      'finishedAt', v_finished_at
    )
  );
end;
$$;

create function public.prepare_notification_delivery(
  p_event_id uuid, p_operation_id uuid, p_request_json text
) returns jsonb
language plpgsql security definer set search_path = '' set row_security = off
set lock_timeout = '1s' set statement_timeout = '3s' as $$
declare
  v_context jsonb;
  v_request jsonb;
  v_saved_request text;
  v_idempotency_key text;
  v_first_submission_at timestamptz;
  v_recipient_email text;
  v_key_count integer;
begin
  if p_event_id is null or p_operation_id is null or p_request_json is null
     or pg_catalog.octet_length(p_request_json) > 16384 then
    return pg_catalog.jsonb_build_object('ok', false, 'code', 'INTERNAL_ERROR');
  end if;

  begin
    v_request := p_request_json::jsonb;
  exception when invalid_text_representation then
    return pg_catalog.jsonb_build_object('ok', false, 'code', 'INTERNAL_ERROR');
  end;

  if pg_catalog.jsonb_typeof(v_request) <> 'object' then
    return pg_catalog.jsonb_build_object('ok', false, 'code', 'INTERNAL_ERROR');
  end if;
  select count(*) into v_key_count from pg_catalog.jsonb_object_keys(v_request);
  if v_key_count <> 5
     or not (v_request ?& array['from', 'to', 'subject', 'html', 'text'])
     or pg_catalog.jsonb_typeof(v_request->'from') <> 'string'
     or v_request->>'from' <> 'Knowledge Decay Monitor <notifications@knowledge-decay-monitor.online>'
     or pg_catalog.jsonb_typeof(v_request->'to') <> 'array'
     or pg_catalog.jsonb_array_length(v_request->'to') <> 1
     or pg_catalog.jsonb_typeof(v_request->'to'->0) <> 'string'
     or pg_catalog.jsonb_typeof(v_request->'subject') <> 'string'
     or pg_catalog.jsonb_typeof(v_request->'html') <> 'string'
     or pg_catalog.jsonb_typeof(v_request->'text') <> 'string'
     or pg_catalog.btrim(v_request->>'subject') = ''
     or pg_catalog.btrim(v_request->>'html') = ''
     or pg_catalog.btrim(v_request->>'text') = '' then
    return pg_catalog.jsonb_build_object('ok', false, 'code', 'INTERNAL_ERROR');
  end if;

  v_context := public.get_notification_context(p_event_id, p_operation_id);
  if coalesce((v_context->>'ok')::boolean, false) is not true then
    return v_context;
  end if;
  v_recipient_email := v_context->'data'->>'recipientEmail';
  if pg_catalog.lower(pg_catalog.btrim(v_request->'to'->>0))
       is distinct from pg_catalog.lower(pg_catalog.btrim(v_recipient_email)) then
    return pg_catalog.jsonb_build_object('ok', false, 'code', 'RECIPIENT_UNAVAILABLE');
  end if;

  perform 1 from public.notification_events e
  where e.id = p_event_id and e.status = 'pending'
    and e.operation_id = p_operation_id
    and e.lease_expires_at > pg_catalog.clock_timestamp()
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'code', 'LEASE_LOST');
  end if;

  select d.request_json, d.idempotency_key, d.first_submission_at
    into v_saved_request, v_idempotency_key, v_first_submission_at
  from private.notification_deliveries d
  where d.event_id = p_event_id
  for update;

  if v_saved_request is null then
    v_saved_request := p_request_json;
    v_idempotency_key := 'kdm-terminal/' || p_event_id::text || '/v1';
    v_first_submission_at := pg_catalog.clock_timestamp();
    update private.notification_deliveries d
       set request_json = v_saved_request,
           idempotency_key = v_idempotency_key,
           first_submission_at = v_first_submission_at
     where d.event_id = p_event_id;
  elsif pg_catalog.lower(pg_catalog.btrim(v_saved_request::jsonb->'to'->>0))
          is distinct from pg_catalog.lower(pg_catalog.btrim(v_recipient_email)) then
    return pg_catalog.jsonb_build_object('ok', false, 'code', 'RECIPIENT_UNAVAILABLE');
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'data', pg_catalog.jsonb_build_object(
      'body', v_saved_request::jsonb,
      'requestJson', v_saved_request,
      'idempotencyKey', v_idempotency_key,
      'firstSubmissionAt', v_first_submission_at
    )
  );
end;
$$;

create function public.confirm_notification_sent(
  p_event_id uuid, p_operation_id uuid, p_provider_message_id text
) returns boolean
language plpgsql security definer set search_path = '' set row_security = off
set lock_timeout = '1s' set statement_timeout = '3s' as $$
declare
  v_event public.notification_events%rowtype;
  v_sent_operation_id uuid;
  v_message_id text;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_event_id is null or p_operation_id is null
     or p_provider_message_id is null or pg_catalog.btrim(p_provider_message_id) = ''
     or pg_catalog.length(p_provider_message_id) > 200 then
    return false;
  end if;

  select e.* into v_event from public.notification_events e
  where e.id = p_event_id for update;
  if not found then
    return false;
  end if;

  if v_event.status = 'sent' then
    select d.sent_operation_id, d.provider_message_id
      into v_sent_operation_id, v_message_id
    from private.notification_deliveries d where d.event_id = p_event_id;
    return v_sent_operation_id = p_operation_id and v_message_id = p_provider_message_id;
  end if;

  if v_event.status <> 'pending'
     or v_event.operation_id is distinct from p_operation_id
     or v_event.lease_expires_at is null or v_event.lease_expires_at <= v_now then
    return false;
  end if;

  update private.notification_deliveries d
     set provider_message_id = p_provider_message_id,
         sent_operation_id = p_operation_id
   where d.event_id = p_event_id and d.request_json is not null;
  if not found then
    return false;
  end if;

  update public.notification_events e
     set status = 'sent', sent_at = v_now, next_attempt_at = null,
         error_code = null, operation_id = null, lease_expires_at = null
   where e.id = p_event_id;
  return true;
end;
$$;

create function public.record_notification_failure(
  p_event_id uuid,
  p_operation_id uuid,
  p_error_code text,
  p_retry_after_seconds integer default null
) returns text
language plpgsql security definer set search_path = '' set row_security = off
set lock_timeout = '1s' set statement_timeout = '3s' as $$
declare
  v_event public.notification_events%rowtype;
  v_first_submission_at timestamptz;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_backoff integer;
  v_retry_after integer;
  v_terminal_code text;
begin
  if p_error_code not in ('DELIVERY_FAILED', 'RECIPIENT_UNAVAILABLE', 'INTERNAL_ERROR') then
    raise exception 'Unsupported notification failure code' using errcode = '22023';
  end if;
  if p_event_id is null or p_operation_id is null then
    return 'lost';
  end if;

  select e.* into v_event from public.notification_events e
  where e.id = p_event_id for update;
  if not found or v_event.status <> 'pending'
     or v_event.operation_id is distinct from p_operation_id
     or v_event.lease_expires_at is null or v_event.lease_expires_at <= v_now then
    return 'lost';
  end if;

  select d.first_submission_at into v_first_submission_at
  from private.notification_deliveries d where d.event_id = p_event_id for update;

  v_backoff := case v_event.attempt_count when 1 then 60 when 2 then 300 else 300 end;
  v_retry_after := pg_catalog.least(pg_catalog.greatest(coalesce(p_retry_after_seconds, 0), 0), 3600);
  v_terminal_code := case
    when v_first_submission_at is not null
      and v_first_submission_at + interval '23 hours' <= v_now then 'DELIVERY_FAILED'
    else p_error_code
  end;

  if p_error_code = 'RECIPIENT_UNAVAILABLE'
     or v_event.attempt_count >= 3
     or (v_first_submission_at is not null
         and v_first_submission_at + interval '23 hours' <= v_now) then
    update public.notification_events e
       set status = 'failed', error_code = v_terminal_code,
           next_attempt_at = null, operation_id = null, lease_expires_at = null
     where e.id = p_event_id;
    return 'failed';
  end if;

  update public.notification_events e
     set status = 'pending', error_code = p_error_code,
         next_attempt_at = v_now + pg_catalog.greatest(v_backoff, v_retry_after) * interval '1 second',
         operation_id = null, lease_expires_at = null
   where e.id = p_event_id;
  return 'pending';
end;
$$;

create function public.recover_notification_event(p_event_id uuid)
returns text
language plpgsql security definer set search_path = '' set row_security = off
set lock_timeout = '1s' set statement_timeout = '3s' as $$
declare
  v_event public.notification_events%rowtype;
  v_first_submission_at timestamptz;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_event_id is null then
    raise exception 'Event id is required' using errcode = '22023';
  end if;

  select e.* into v_event from public.notification_events e
  where e.id = p_event_id for update;
  if not found or v_event.status <> 'pending'
     or v_event.operation_id is null or v_event.lease_expires_at > v_now then
    return 'unchanged';
  end if;

  select d.first_submission_at into v_first_submission_at
  from private.notification_deliveries d where d.event_id = p_event_id for update;

  if v_event.attempt_count >= 3
     or (v_first_submission_at is not null
         and v_first_submission_at + interval '23 hours' <= v_now) then
    update public.notification_events e
       set status = 'failed',
           error_code = 'DELIVERY_FAILED',
           next_attempt_at = null,
           operation_id = null,
           lease_expires_at = null
     where e.id = p_event_id;
    return 'failed';
  end if;

  update public.notification_events e
     set error_code = 'DELIVERY_FAILED',
         next_attempt_at = v_now + case v_event.attempt_count
           when 1 then interval '60 seconds'
           else interval '300 seconds'
         end,
         operation_id = null,
         lease_expires_at = null
   where e.id = p_event_id;
  return 'pending';
end;
$$;

create function public.claim_notification_alert(p_event_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' set row_security = off
set lock_timeout = '1s' set statement_timeout = '3s' as $$
declare
  v_event public.notification_events%rowtype;
  v_operation_id uuid;
  v_lease_expires_at timestamptz;
  v_next_attempt_at timestamptz;
  v_reported_at timestamptz;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_event_id is null then
    raise exception 'Event id is required' using errcode = '22023';
  end if;

  select e.* into v_event from public.notification_events e
  where e.id = p_event_id and e.status = 'failed' for update skip locked;
  if not found then
    return null;
  end if;

  insert into private.notification_deliveries(event_id)
  values (p_event_id) on conflict (event_id) do nothing;

  select d.alert_operation_id, d.alert_lease_expires_at,
         d.alert_next_attempt_at, d.failure_reported_at
    into v_operation_id, v_lease_expires_at, v_next_attempt_at, v_reported_at
  from private.notification_deliveries d
  where d.event_id = p_event_id for update;

  if v_reported_at is not null
     or (v_lease_expires_at is not null and v_lease_expires_at > v_now)
     or (v_next_attempt_at is not null and v_next_attempt_at > v_now) then
    return null;
  end if;

  v_operation_id := pg_catalog.gen_random_uuid();
  v_lease_expires_at := v_now + interval '90 seconds';
  update private.notification_deliveries d
     set alert_operation_id = v_operation_id,
         alert_lease_expires_at = v_lease_expires_at
   where d.event_id = p_event_id;

  return pg_catalog.jsonb_build_object(
    'eventId', p_event_id,
    'operationId', v_operation_id,
    'code', v_event.error_code
  );
end;
$$;

create function public.confirm_notification_alert(p_event_id uuid, p_operation_id uuid)
returns boolean
language plpgsql security definer set search_path = '' set row_security = off
set lock_timeout = '1s' set statement_timeout = '3s' as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_event_id is null or p_operation_id is null then
    return false;
  end if;

  update private.notification_deliveries d
     set failure_reported_at = v_now,
         alert_operation_id = null,
         alert_lease_expires_at = null,
         alert_next_attempt_at = null
   where d.event_id = p_event_id
     and d.failure_reported_at is null
     and d.alert_operation_id = p_operation_id
     and d.alert_lease_expires_at > v_now
     and exists (select 1 from public.notification_events e
       where e.id = p_event_id and e.status = 'failed');
  return found;
end;
$$;

create function public.retry_notification_alert(p_event_id uuid, p_operation_id uuid)
returns boolean
language plpgsql security definer set search_path = '' set row_security = off
set lock_timeout = '1s' set statement_timeout = '3s' as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_event_id is null or p_operation_id is null then
    return false;
  end if;

  update private.notification_deliveries d
     set alert_operation_id = null,
         alert_lease_expires_at = null,
         alert_next_attempt_at = v_now + interval '60 seconds'
   where d.event_id = p_event_id
     and d.failure_reported_at is null
     and d.alert_operation_id = p_operation_id
     and d.alert_lease_expires_at > v_now
     and exists (select 1 from public.notification_events e
       where e.id = p_event_id and e.status = 'failed');
  return found;
end;
$$;

revoke all on function public.claim_notification_event(uuid) from public, anon, authenticated;
revoke all on function public.get_notification_context(uuid, uuid) from public, anon, authenticated;
revoke all on function public.prepare_notification_delivery(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.confirm_notification_sent(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.record_notification_failure(uuid, uuid, text, integer) from public, anon, authenticated;
revoke all on function public.recover_notification_event(uuid) from public, anon, authenticated;
revoke all on function public.claim_notification_alert(uuid) from public, anon, authenticated;
revoke all on function public.confirm_notification_alert(uuid, uuid) from public, anon, authenticated;
revoke all on function public.retry_notification_alert(uuid, uuid) from public, anon, authenticated;

grant execute on function public.claim_notification_event(uuid) to service_role;
grant execute on function public.get_notification_context(uuid, uuid) to service_role;
grant execute on function public.prepare_notification_delivery(uuid, uuid, text) to service_role;
grant execute on function public.confirm_notification_sent(uuid, uuid, text) to service_role;
grant execute on function public.record_notification_failure(uuid, uuid, text, integer) to service_role;
grant execute on function public.recover_notification_event(uuid) to service_role;
grant execute on function public.claim_notification_alert(uuid) to service_role;
grant execute on function public.confirm_notification_alert(uuid, uuid) to service_role;
grant execute on function public.retry_notification_alert(uuid, uuid) to service_role;
