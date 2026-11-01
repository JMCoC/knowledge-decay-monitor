create or replace function public.notifications_dispatch_enabled()
returns boolean
language sql
stable
security definer
set search_path = ''
set row_security = off
as $$
  select coalesce((
    select s.enabled
    from private.notification_dispatch_settings s
    where s.id
  ), false);
$$;

revoke all on function public.notifications_dispatch_enabled()
  from public, anon, authenticated;
grant execute on function public.notifications_dispatch_enabled()
  to service_role;

comment on function public.notifications_dispatch_enabled() is
  'Returns the shared notification dispatch gate to the authenticated Edge runtime.';

create or replace function private.invoke_notifications_dispatch()
returns bigint
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_url text;
  v_token text;
  v_request_id bigint;
begin
  select decrypted_secret into v_url
    from vault.decrypted_secrets
   where name = 'notifications_function_url'
   limit 1;
  select decrypted_secret into v_token
    from vault.decrypted_secrets
   where name = 'notifications_internal_token'
   limit 1;

  if v_url is null
     or not (
       v_url in (
         'http://api.supabase.internal:8000/functions/v1/dispatch-notifications',
         'http://kong:8000/functions/v1/dispatch-notifications'
       )
       or v_url ~ '^https://[a-z0-9]{20}[.]supabase[.](co|in)/functions/v1/dispatch-notifications$'
     )
     or v_token is null
     or length(v_token) < 32
     or v_token ~ '[[:space:]]' then
    raise exception 'Notification dispatch secrets are missing or invalid'
      using errcode = '22023';
  end if;

  v_request_id := net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_token
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 2000
  );
  return v_request_id;
end;
$$;

revoke all on function private.invoke_notifications_dispatch()
  from public, anon, authenticated, service_role;
grant execute on function private.invoke_notifications_dispatch()
  to postgres;

comment on function private.invoke_notifications_dispatch() is
  'Enqueues one authenticated pg_net POST to the configured notification Edge dispatcher and returns only its request ID.';

create or replace function public.configure_notifications_dispatch(p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
set statement_timeout = '10s'
as $$
declare
  v_url text;
  v_token text;
  v_job_id bigint;
begin
  if p_enabled is null then
    raise exception 'Notification dispatch enabled flag is required'
      using errcode = '22023';
  end if;

  if not p_enabled then
    update private.notification_dispatch_settings
       set enabled = false
     where id;
    if not found then
      raise exception 'Notification dispatch settings are unavailable'
        using errcode = '55000';
    end if;

    for v_job_id in
      select jobid from cron.job
       where jobname = 'kdm-notifications-dispatch'
    loop
      perform cron.unschedule(v_job_id);
    end loop;
    return;
  end if;

  select decrypted_secret into v_url
    from vault.decrypted_secrets
   where name = 'notifications_function_url'
   limit 1;
  select decrypted_secret into v_token
    from vault.decrypted_secrets
   where name = 'notifications_internal_token'
   limit 1;

  if v_url is null
     or not (
       v_url in (
         'http://api.supabase.internal:8000/functions/v1/dispatch-notifications',
         'http://kong:8000/functions/v1/dispatch-notifications'
       )
       or v_url ~ '^https://[a-z0-9]{20}[.]supabase[.](co|in)/functions/v1/dispatch-notifications$'
     )
     or v_token is null
     or length(v_token) < 32
     or v_token ~ '[[:space:]]' then
    raise exception 'Notification dispatch secrets are missing or invalid'
      using errcode = '22023';
  end if;

  update private.notification_dispatch_settings
     set enabled = true
   where id;
  if not found then
    raise exception 'Notification dispatch settings are unavailable'
      using errcode = '55000';
  end if;

  for v_job_id in
    select jobid from cron.job
     where jobname = 'kdm-notifications-dispatch'
  loop
    perform cron.unschedule(v_job_id);
  end loop;

  perform cron.schedule(
    'kdm-notifications-dispatch',
    '* * * * *',
    'select private.invoke_notifications_dispatch();'
  );
end;
$$;

revoke all on function public.configure_notifications_dispatch(boolean)
  from public, anon, authenticated;
grant execute on function public.configure_notifications_dispatch(boolean)
  to service_role;

comment on function public.configure_notifications_dispatch(boolean) is
  'Idempotently enables or disables the one-minute notification dispatch schedule after validating its Vault configuration.';

create or replace function public.claim_notification_alert(p_event_id uuid)
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

  perform 1
  from private.notification_dispatch_settings s
  where s.id and s.enabled
  for share;
  if not found then
    return null;
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

revoke all on function public.claim_notification_alert(uuid)
  from public, anon, authenticated;
grant execute on function public.claim_notification_alert(uuid)
  to service_role;
