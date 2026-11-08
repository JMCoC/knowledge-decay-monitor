create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault with schema vault;

grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

create or replace function private.invoke_analysis_recovery()
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
   where name = 'analysis_function_url';
  select decrypted_secret into v_token
    from vault.decrypted_secrets
   where name = 'analysis_internal_token';

  if v_url is null
     or not (
       v_url in (
         'http://api.supabase.internal:8000/functions/v1/analyze',
         'http://kong:8000/functions/v1/analyze'
       )
       or v_url ~ '^https://[a-z0-9]{20}\.supabase\.(co|in)/functions/v1/analyze$'
     )
     or v_token is null
     or length(v_token) < 32
     or v_token ~ '[[:space:]]' then
    raise exception 'Analysis recovery secrets are missing or invalid'
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

revoke all on function private.invoke_analysis_recovery()
  from public, anon, authenticated, service_role;
grant execute on function private.invoke_analysis_recovery() to postgres;

comment on function private.invoke_analysis_recovery() is
  'Enqueues one authenticated pg_net POST to the configured analysis Edge recovery endpoint and returns only its request ID.';

create or replace function public.configure_analysis_recovery(p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = ''
set lock_timeout = '1s'
set statement_timeout = '5s'
as $$
declare
  v_url text;
  v_token text;
  v_job_id bigint;
begin
  if p_enabled is null then
    raise exception 'Analysis recovery enabled flag is required'
      using errcode = '22023';
  end if;

  if not p_enabled then
    for v_job_id in
      select jobid from cron.job
       where jobname = 'kdm-analysis-recovery'
    loop
      perform cron.unschedule(v_job_id);
    end loop;
    return;
  end if;

  select decrypted_secret into v_url
    from vault.decrypted_secrets
   where name = 'analysis_function_url';
  select decrypted_secret into v_token
    from vault.decrypted_secrets
   where name = 'analysis_internal_token';

  if v_url is null
     or not (
       v_url in (
         'http://api.supabase.internal:8000/functions/v1/analyze',
         'http://kong:8000/functions/v1/analyze'
       )
       or v_url ~ '^https://[a-z0-9]{20}\.supabase\.(co|in)/functions/v1/analyze$'
     )
     or v_token is null
     or length(v_token) < 32
     or v_token ~ '[[:space:]]' then
    raise exception 'Analysis recovery secrets are missing or invalid'
      using errcode = '22023';
  end if;

  for v_job_id in
    select jobid from cron.job
     where jobname = 'kdm-analysis-recovery'
  loop
    perform cron.unschedule(v_job_id);
  end loop;

  perform cron.schedule(
    'kdm-analysis-recovery',
    '* * * * *',
    'select private.invoke_analysis_recovery();'
  );
end;
$$;

revoke all on function public.configure_analysis_recovery(boolean)
  from public, anon, authenticated;
grant execute on function public.configure_analysis_recovery(boolean)
  to service_role;

comment on function public.configure_analysis_recovery(boolean) is
  'Idempotently enables or disables the one-minute analysis recovery schedule after validating its Vault configuration.';
