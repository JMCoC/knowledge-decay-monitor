begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

create function pg_temp.notification_job_count()
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
    into v_count using 'kdm-notifications-dispatch';
  return v_count;
end;
$$;

create function pg_temp.notification_job_contract()
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
        and command = 'select private.invoke_notifications_dispatch();'
        and active
    )
  $query$ into v_valid using 'kdm-notifications-dispatch';
  return coalesce(v_valid, false);
end;
$$;

create function pg_temp.notification_execute_granted(p_role text, p_signature text)
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

select has_extension('pg_cron', 'Cron is available for local notification scheduling');
select has_extension('pg_net', 'pg_net is available for local notification scheduling');
select has_extension('supabase_vault', 'Vault is available for private notification scheduler configuration');
select ok(to_regclass('cron.job') is not null, 'Cron exposes its job registry');
select ok(to_regprocedure('public.configure_notifications_dispatch(boolean)') is not null,
  'The notification scheduler toggle exists');
select ok(to_regprocedure('private.invoke_notifications_dispatch()') is not null,
  'The private cron caller exists');
select ok(to_regprocedure('public.notifications_dispatch_enabled()') is not null,
  'The Edge readiness check exists');
select ok(
  lower(pg_get_functiondef('public.claim_notification_alert(uuid)'::regprocedure))
    like '%notification_dispatch_settings%'
  and lower(pg_get_functiondef('public.claim_notification_alert(uuid)'::regprocedure))
    like '%for share%',
  'Alert claims hold the shared dispatch gate lock');
select ok(
  pg_temp.notification_execute_granted('service_role', 'public.configure_notifications_dispatch(boolean)')
  and not pg_temp.notification_execute_granted('authenticated', 'public.configure_notifications_dispatch(boolean)')
  and not pg_temp.notification_execute_granted('anon', 'public.configure_notifications_dispatch(boolean)')
  and not pg_temp.notification_execute_granted('service_role', 'private.invoke_notifications_dispatch()')
  and pg_temp.notification_execute_granted('service_role', 'public.notifications_dispatch_enabled()')
  and not pg_temp.notification_execute_granted('authenticated', 'public.notifications_dispatch_enabled()')
  and not pg_temp.notification_execute_granted('anon', 'public.notifications_dispatch_enabled()'),
  'Only service_role can change/read dispatch readiness; the cron caller is postgres-only');

select is(public.notifications_dispatch_enabled(), false,
  'Installing the scheduler leaves dispatch disabled');
select is(pg_temp.notification_job_count(), 0::bigint,
  'Installing the scheduler does not create a cron job');
select throws_ok($$select public.configure_notifications_dispatch(null)$$,
  '22023', null, 'A NULL scheduler toggle is rejected');

delete from vault.secrets
 where name in ('notifications_function_url', 'notifications_internal_token');
select throws_ok($$select public.configure_notifications_dispatch(true)$$,
  '22023', null, 'Missing Vault secrets prevent scheduler activation');
select is(pg_temp.notification_job_count(), 0::bigint,
  'Missing secrets do not install a cron job');

do $secrets$
begin
  perform vault.create_secret(
    'https://attacker.example/functions/v1/dispatch-notifications',
    'notifications_function_url',
    'S2-11 scheduler SQL test URL',
    null
  );
  perform vault.create_secret(
    's2-11-test-token-0123456789abcdef0123456789abcdef',
    'notifications_internal_token',
    'S2-11 scheduler SQL test token',
    null
  );
end
$secrets$;
select throws_ok($$select public.configure_notifications_dispatch(true)$$,
  '22023', null, 'An unapproved function host is rejected');
select is(pg_temp.notification_job_count(), 0::bigint,
  'An unapproved host does not install a cron job');
select is(public.notifications_dispatch_enabled(), false,
  'An unapproved host keeps dispatch disabled');

delete from vault.secrets where name = 'notifications_function_url';
do $secret$
begin
  perform vault.create_secret(
    'http://kong:8000/functions/v1/dispatch-notifications-extra',
    'notifications_function_url',
    'S2-11 scheduler SQL test URL',
    null
  );
end
$secret$;
select throws_ok($$select public.configure_notifications_dispatch(true)$$,
  '22023', null, 'An extra path suffix is rejected');
select is(pg_temp.notification_job_count(), 0::bigint,
  'An unapproved path does not install a cron job');

delete from vault.secrets where name = 'notifications_function_url';
delete from vault.secrets where name = 'notifications_internal_token';
do $secrets$
begin
  perform vault.create_secret(
    'http://kong:8000/functions/v1/dispatch-notifications',
    'notifications_function_url',
    'S2-11 scheduler SQL test URL',
    null
  );
  perform vault.create_secret(
    'short-token',
    'notifications_internal_token',
    'S2-11 scheduler SQL test token',
    null
  );
end
$secrets$;
select throws_ok($$select public.configure_notifications_dispatch(true)$$,
  '22023', null, 'A short scheduler token is rejected');
select is(pg_temp.notification_job_count(), 0::bigint,
  'A short token does not install a cron job');

delete from vault.secrets where name = 'notifications_internal_token';
do $secret$
begin
  perform vault.create_secret(
    's2-11-token-with-whitespace -0123456789abcdef0123456789abcdef',
    'notifications_internal_token',
    'S2-11 scheduler SQL test token',
    null
  );
end
$secret$;
select throws_ok($$select public.configure_notifications_dispatch(true)$$,
  '22023', null, 'Whitespace in the scheduler token is rejected');
select is(pg_temp.notification_job_count(), 0::bigint,
  'A token with whitespace does not install a cron job');

delete from vault.secrets where name = 'notifications_internal_token';
do $secret$
begin
  perform vault.create_secret(
    's2-11-test-token-0123456789abcdef0123456789abcdef',
    'notifications_internal_token',
    'S2-11 scheduler SQL test token',
    null
  );
end
$secret$;
select lives_ok($$select public.configure_notifications_dispatch(true)$$,
  'An approved Docker endpoint and private token enable the scheduler');
select is(public.notifications_dispatch_enabled(), true,
  'Enabling the scheduler opens the shared database claim gate');
select is(pg_temp.notification_job_count(), 1::bigint,
  'Enable creates exactly one notification cron job');
select ok(pg_temp.notification_job_contract(),
  'The notification dispatcher runs every minute through the private pg_net caller');
select lives_ok($$select public.configure_notifications_dispatch(true)$$,
  'Repeated enable is idempotent');
select is(pg_temp.notification_job_count(), 1::bigint,
  'Repeated enable keeps exactly one notification job');

select lives_ok($$select public.configure_notifications_dispatch(false)$$,
  'Notifications can be disabled');
select is(public.notifications_dispatch_enabled(), false,
  'Disabling closes the shared database claim gate');
select is(pg_temp.notification_job_count(), 0::bigint,
  'Disabled notifications have no scheduled job');
select lives_ok($$select public.configure_notifications_dispatch(false)$$,
  'Repeated disable is idempotent');

select * from finish();
rollback;
