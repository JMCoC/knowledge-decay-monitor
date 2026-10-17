begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

create function pg_temp.recovery_job_count()
returns bigint
language plpgsql
as $$
declare
  v_count bigint;
begin
  if to_regclass('cron.job') is null then
    return -1;
  end if;
  execute 'select count(*) from cron.job where jobname = $1'
    into v_count using 'kdm-analysis-recovery';
  return v_count;
end;
$$;

create function pg_temp.recovery_job_contract()
returns boolean
language plpgsql
as $$
declare
  v_valid boolean;
begin
  if to_regclass('cron.job') is null then
    return false;
  end if;
  execute $query$
    select exists (
      select 1 from cron.job
      where jobname = $1
        and schedule = '* * * * *'
        and command = 'select private.invoke_analysis_recovery();'
        and active
    )
  $query$ into v_valid using 'kdm-analysis-recovery';
  return coalesce(v_valid, false);
end;
$$;

create function pg_temp.recovery_execute_granted(p_role text, p_signature text)
returns boolean
language plpgsql
as $$
declare
  v_granted boolean;
begin
  if to_regprocedure(p_signature) is null then
    return false;
  end if;
  execute 'select has_function_privilege($1, $2, ''EXECUTE'')'
    into v_granted using p_role, p_signature;
  return coalesce(v_granted, false);
end;
$$;

select no_plan();

select has_extension('pg_cron', 'Local recovery scheduler extension is available');
select has_extension('pg_net', 'Local asynchronous HTTP extension is available');
select has_extension('supabase_vault', 'Vault extension is available');
select ok(to_regclass('cron.job') is not null, 'Cron exposes its job registry');
select has_function('private', 'invoke_analysis_recovery', array[]::text[],
  'Private recovery caller returns the pg_net request ID');
select has_function('public', 'configure_analysis_recovery', array['boolean'],
  'Service role can enable or disable recovery');
select ok(
  pg_temp.recovery_execute_granted('service_role', 'public.configure_analysis_recovery(boolean)')
  and not pg_temp.recovery_execute_granted('authenticated', 'public.configure_analysis_recovery(boolean)')
  and not pg_temp.recovery_execute_granted('anon', 'public.configure_analysis_recovery(boolean)')
  and not pg_temp.recovery_execute_granted('service_role', 'private.invoke_analysis_recovery()'),
  'Only service role can configure recovery; browser roles cannot invoke its secret-bearing caller');

select lives_ok($$select public.configure_analysis_recovery(false)$$,
  'Disabling an absent recovery job is safe');
select is(pg_temp.recovery_job_count(), 0::bigint,
  'Disable leaves no recovery cron job');
select lives_ok($$select public.configure_analysis_recovery(false)$$,
  'Repeated disable is idempotent');

delete from vault.secrets
 where name in ('analysis_function_url', 'analysis_internal_token');
select throws_ok($$select public.configure_analysis_recovery(true)$$,
  '22023', null, 'Missing Vault secrets prevent enabling recovery');
select is(pg_temp.recovery_job_count(), 0::bigint,
  'Missing secrets do not install a cron job');

do $secrets$
begin
  perform vault.create_secret(
    'http://127.0.0.1:54321/functions/v1/analyze',
    'analysis_function_url',
    'S2-05 SQL test URL',
    null
  );
  perform vault.create_secret(
    's2-05-test-token-0123456789abcdef0123456789abcdef',
    'analysis_internal_token',
    'S2-05 SQL test token',
    null
  );
end
$secrets$;
select throws_ok($$select public.configure_analysis_recovery(true)$$,
  '22023', null, 'A URL outside the authorized local or Supabase analyze target is rejected');
select is(pg_temp.recovery_job_count(), 0::bigint,
  'An unauthorized URL does not install a cron job');

delete from vault.secrets where name = 'analysis_function_url';
do $secret$
begin
  perform vault.create_secret(
    'http://api.supabase.internal:8000/functions/v1/analyze',
    'analysis_function_url',
    'S2-05 SQL test URL',
    null
  );
end
$secret$;
select lives_ok($$select public.configure_analysis_recovery(true)$$,
  'A configured local analyze URL and token enable recovery');
select is(pg_temp.recovery_job_count(), 1::bigint,
  'Enable creates one recovery cron job');
select ok(pg_temp.recovery_job_contract(),
  'Recovery runs every minute through the private pg_net caller');
select lives_ok($$select public.configure_analysis_recovery(true)$$,
  'Repeated enable is idempotent');
select is(pg_temp.recovery_job_count(), 1::bigint,
  'Repeated enable keeps exactly one job');
select ok(pg_temp.recovery_job_contract(),
  'Repeated enable retains the approved schedule and command');
select lives_ok($$select public.configure_analysis_recovery(false)$$,
  'Recovery can be disabled');
select lives_ok($$select public.configure_analysis_recovery(false)$$,
  'Repeated disable remains idempotent');
select is(pg_temp.recovery_job_count(), 0::bigint,
  'Disabled recovery leaves no scheduled job');

select * from finish();
rollback;
