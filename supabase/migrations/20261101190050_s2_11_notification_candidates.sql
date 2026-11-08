-- Minimal service-role listing RPCs keep due/lease decisions on the DB clock
-- and never expose private request or alert-delivery metadata.

create function public.list_notification_candidates(p_limit integer default 5)
returns table(event_id uuid, recover_expired boolean)
language sql security definer set search_path = '' set row_security = off
set lock_timeout = '1s' set statement_timeout = '3s' as $$
  with db_time as (select pg_catalog.clock_timestamp() as now)
  select e.id, e.operation_id is not null
  from public.notification_events e
  cross join db_time t
  where e.status = 'pending'
    and e.attempt_count < 3
    and (e.next_attempt_at is null or e.next_attempt_at <= t.now)
    and (e.operation_id is null or e.lease_expires_at <= t.now)
    and exists (
      select 1 from private.notification_dispatch_settings s
      where s.id and s.enabled
    )
  order by e.created_at, e.id
  limit least(greatest(coalesce(p_limit, 1), 1), 5);
$$;

create function public.list_notification_alerts(p_limit integer default 5)
returns table(event_id uuid)
language sql security definer set search_path = '' set row_security = off
set lock_timeout = '1s' set statement_timeout = '3s' as $$
  with db_time as (select pg_catalog.clock_timestamp() as now)
  select e.id
  from public.notification_events e
  join private.notification_deliveries d on d.event_id = e.id
  cross join db_time t
  where e.status = 'failed'
    and e.error_code is not null
    and d.failure_reported_at is null
    and (d.alert_operation_id is null or d.alert_lease_expires_at <= t.now)
    and (d.alert_next_attempt_at is null or d.alert_next_attempt_at <= t.now)
  order by e.created_at, e.id
  limit least(greatest(coalesce(p_limit, 1), 1), 50);
$$;

-- Task 1's PL/pgSQL body had not exercised the real retry path: GREATEST and
-- LEAST are SQL expression forms and cannot be schema-qualified as functions.
-- Replace it additively so live retries use the required persisted backoff.
create or replace function public.record_notification_failure(
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
  v_retry_after := least(greatest(coalesce(p_retry_after_seconds, 0), 0), 3600);
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
         next_attempt_at = v_now + greatest(v_backoff, v_retry_after) * interval '1 second',
         operation_id = null, lease_expires_at = null
   where e.id = p_event_id;
  return 'pending';
end;
$$;

revoke all on function public.list_notification_candidates(integer) from public, anon, authenticated;
revoke all on function public.list_notification_alerts(integer) from public, anon, authenticated;
grant execute on function public.list_notification_candidates(integer) to service_role;
grant execute on function public.list_notification_alerts(integer) to service_role;
