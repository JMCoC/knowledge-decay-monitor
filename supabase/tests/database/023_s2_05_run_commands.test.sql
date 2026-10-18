begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
\ir analysis-fixtures.psql
\ir credit-fixtures.psql
select no_plan();

select ok(to_regprocedure('public.run_analysis(uuid,uuid,text,jsonb)') is not null,
  'The atomic Run RPC exists');
select ok(to_regprocedure('public.retry_analysis(uuid,uuid,uuid,text,jsonb)') is not null,
  'The atomic Retry RPC exists');
select has_column('public', 'analyses', 'estimate_id', 'A run retains its trusted estimate reference');
select has_column('public', 'analyses', 'command_fingerprint', 'Command identity is separate from retrieval fingerprint');
select ok(coalesce(has_function_privilege(
  'service_role', to_regprocedure('public.run_analysis(uuid,uuid,text,jsonb)'), 'EXECUTE'), false),
  'Only the server role can execute Run');
select ok(not coalesce(has_function_privilege(
  'authenticated', to_regprocedure('public.run_analysis(uuid,uuid,text,jsonb)'), 'EXECUTE'), false),
  'Authenticated users cannot execute Run directly');
select ok(coalesce(has_function_privilege(
  'service_role', to_regprocedure('public.retry_analysis(uuid,uuid,uuid,text,jsonb)'), 'EXECUTE'), false),
  'Only the server role can execute Retry');
select ok(not coalesce(has_function_privilege(
  'authenticated', to_regprocedure('public.retry_analysis(uuid,uuid,uuid,text,jsonb)'), 'EXECUTE'), false),
  'Authenticated users cannot execute Retry directly');
select ok(not coalesce(has_function_privilege(
  'service_role', to_regprocedure('private.create_analysis_run(uuid,uuid,text,uuid,jsonb)'), 'EXECUTE'), false),
  'The internal command implementation is not exposed to the service client');
select ok((select coalesce(p.proconfig, '{}'::text[]) @> array['lock_timeout=3s', 'statement_timeout=30s']
  from pg_catalog.pg_proc p
  where p.oid = to_regprocedure('public.create_analysis_estimate(uuid,uuid[],uuid[],jsonb)')),
  'Estimate creation is bounded by the documented SQL lock and statement budgets');
select ok((select coalesce(p.proconfig, '{}'::text[]) @> array['lock_timeout=3s', 'statement_timeout=30s']
  from pg_catalog.pg_proc p
  where p.oid = to_regprocedure('public.run_analysis(uuid,uuid,text,jsonb)')),
  'Run is bounded by the documented SQL lock and statement budgets');
select ok((select coalesce(p.proconfig, '{}'::text[]) @> array['lock_timeout=3s', 'statement_timeout=30s']
  from pg_catalog.pg_proc p
  where p.oid = to_regprocedure('public.retry_analysis(uuid,uuid,uuid,text,jsonb)')),
  'Retry is bounded by the documented SQL lock and statement budgets');

select pg_temp.create_credit_workspace() from generate_series(1, 4);
select private.grant_promotional_credits(workspace_id) from pg_temp.credit_workspace;

create temporary table command_cases (
  name text primary key,
  workspace_id uuid not null,
  actor_id uuid not null,
  scope_analysis_id uuid not null,
  source_one uuid,
  source_two uuid,
  qa_id uuid,
  estimate_main uuid,
  estimate_alternate uuid,
  estimate_qa uuid,
  run_id uuid,
  qa_run_id uuid,
  retry_id uuid,
  estimate_retry uuid,
  estimate_no_release uuid,
  estimate_insufficient uuid
) on commit drop;

insert into pg_temp.command_cases(name, workspace_id, actor_id, scope_analysis_id)
select case row_number() over (order by c.workspace_id)
    when 1 then 'run' when 2 then 'retry' when 3 then 'no_release' else 'insufficient' end,
  c.workspace_id, c.user_id,
  pg_temp.create_analysis_fixture(c.workspace_id, c.user_id, 'completed', 2)
from pg_temp.credit_workspace c;

update pg_temp.command_cases c
set source_one = scope.version_id
from pg_temp.analysis_case scope
where scope.analysis_id = c.scope_analysis_id and scope.ordinal = 1;
update pg_temp.command_cases c
set source_two = scope.version_id
from pg_temp.analysis_case scope
where scope.analysis_id = c.scope_analysis_id and scope.ordinal = 2;

create function pg_temp.create_analysis_test_actor(p_workspace uuid, p_role public.workspace_role)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid := gen_random_uuid();
  v_email text := 'kdm-' || v_id::text || '@example.test';
begin
  insert into auth.users(id, email, aud, role)
  values (v_id, v_email, 'authenticated', 'authenticated');
  insert into public.profiles(id, workspace_id, role, full_name, email)
  values (v_id, p_workspace, p_role, 'Synthetic analysis command actor', v_email);
  return v_id;
end;
$$;

update pg_temp.command_cases c
set qa_id = pg_temp.create_analysis_test_actor(c.workspace_id, 'QA Lead')
where c.name = 'run';

create function pg_temp.create_analysis_test_estimate(p_actor uuid, p_source uuid[], p_comparison uuid[])
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_estimate uuid;
begin
  select e.estimate_ref into strict v_estimate
  from public.create_analysis_estimate(
    p_actor, p_source, p_comparison,
    '{"fingerprintVersion":"s2-05-v2","pricingVersion":"s2-04-v1","promptVersion":"prompt-test-v1","outputSchemaVersion":"schema-test-v1","providers":{"primary":{"provider":"provider-a","model":"model-a"},"fallback":{"provider":"provider-b","model":"model-b"}}}'::jsonb
  ) e;
  return v_estimate;
end;
$$;

update pg_temp.command_cases c
set estimate_main = pg_temp.create_analysis_test_estimate(c.actor_id, array[c.source_one], array[c.source_two]),
    estimate_alternate = pg_temp.create_analysis_test_estimate(c.actor_id, array[c.source_two], '{}'::uuid[])
where c.name = 'run';
update pg_temp.command_cases c
set estimate_qa = pg_temp.create_analysis_test_estimate(c.qa_id, array[c.source_one], array[c.source_one])
where c.name = 'run';

create temporary table command_results (
  name text primary key,
  analysis_id uuid not null,
  status public.analysis_job_status not null,
  retry_of_analysis_id uuid
) on commit drop;

select lives_ok(format(
  'insert into pg_temp.command_results(name, analysis_id, status) select ''first'', r.analysis_id, r.status from public.run_analysis(%L::uuid, %L::uuid, %L, %L::jsonb) r',
  (select actor_id from pg_temp.command_cases where name = 'run'),
  (select estimate_main from pg_temp.command_cases where name = 'run'),
  'run-key',
  '{"fingerprintVersion":"s2-05-v2","pricingVersion":"s2-04-v1","promptVersion":"prompt-test-v1","outputSchemaVersion":"schema-test-v1","providers":{"primary":{"provider":"provider-a","model":"model-a"},"fallback":{"provider":"provider-b","model":"model-b"}}}'
), 'A valid Run creates its analysis and credit reservation atomically');

update public.analysis_estimates
set expires_at = clock_timestamp() - interval '1 second'
where id = (select estimate_main from pg_temp.command_cases where name = 'run');

select lives_ok(format(
  'insert into pg_temp.command_results(name, analysis_id, status) select ''replay'', r.analysis_id, r.status from public.run_analysis(%L::uuid, %L::uuid, %L, null) r',
  (select actor_id from pg_temp.command_cases where name = 'run'),
  (select estimate_main from pg_temp.command_cases where name = 'run'),
  'run-key'
), 'An exact replay succeeds after expiry even without current configuration');
select is((select analysis_id from pg_temp.command_results where name = 'replay'),
  (select analysis_id from pg_temp.command_results where name = 'first'),
  'A replay returns the original analysis ID');
select is((select count(*)::integer from public.analyses a
  where a.estimate_id = (select estimate_main from pg_temp.command_cases where name = 'run')),
  1, 'A replay does not create another analysis');
select is((select count(*)::integer from public.credit_ledger l
  where l.analysis_id = (select analysis_id from pg_temp.command_results where name = 'first')
    and l.event_type = 'Reserved'), 1, 'A replay creates exactly one reservation');
select is((select count(*)::integer from public.analysis_documents d
  where d.analysis_id = (select analysis_id from pg_temp.command_results where name = 'first')),
  2, 'Run stores the confirmed source and comparison roles');

select throws_ok(format(
  'select * from public.run_analysis(%L::uuid, %L::uuid, %L, %L::jsonb)',
  (select actor_id from pg_temp.command_cases where name = 'run'),
  (select estimate_alternate from pg_temp.command_cases where name = 'run'),
  'run-key',
  '{"fingerprintVersion":"s2-05-v2","pricingVersion":"s2-04-v1","promptVersion":"prompt-test-v1","outputSchemaVersion":"schema-test-v1","providers":{"primary":{"provider":"provider-a","model":"model-a"},"fallback":{"provider":"provider-b","model":"model-b"}}}'
), 'P2002', null, 'A key reused for another estimate is a conflict');
select throws_ok(format(
  'select * from public.run_analysis(%L::uuid, %L::uuid, %L, null)',
  (select actor_id from pg_temp.command_cases where name = 'run'),
  (select estimate_alternate from pg_temp.command_cases where name = 'run'),
  'missing-current-config'
), 'P2102', null, 'A new Run cannot use an estimate without current configuration');
update public.analysis_estimates
set expires_at = clock_timestamp() - interval '1 second'
where id = (select estimate_alternate from pg_temp.command_cases where name = 'run');
select throws_ok(format(
  'select * from public.run_analysis(%L::uuid, %L::uuid, %L, %L::jsonb)',
  (select actor_id from pg_temp.command_cases where name = 'run'),
  (select estimate_alternate from pg_temp.command_cases where name = 'run'),
  'expired-new-command',
  '{"fingerprintVersion":"s2-05-v2","pricingVersion":"s2-04-v1","promptVersion":"prompt-test-v1","outputSchemaVersion":"schema-test-v1","providers":{"primary":{"provider":"provider-a","model":"model-a"},"fallback":{"provider":"provider-b","model":"model-b"}}}'
), 'P2101', null, 'An expired estimate cannot create a new Run');
update public.analysis_estimates
set expires_at = clock_timestamp() + interval '30 minutes', fixed_cost = fixed_cost + 1
where id = (select estimate_alternate from pg_temp.command_cases where name = 'run');
select throws_ok(format(
  'select * from public.run_analysis(%L::uuid, %L::uuid, %L, %L::jsonb)',
  (select actor_id from pg_temp.command_cases where name = 'run'),
  (select estimate_alternate from pg_temp.command_cases where name = 'run'),
  'altered-cost',
  '{"fingerprintVersion":"s2-05-v2","pricingVersion":"s2-04-v1","promptVersion":"prompt-test-v1","outputSchemaVersion":"schema-test-v1","providers":{"primary":{"provider":"provider-a","model":"model-a"},"fallback":{"provider":"provider-b","model":"model-b"}}}'
), 'P2102', null, 'A changed estimate cost fails the snapshot check');
update public.analysis_estimates
set fixed_cost = fixed_cost - 1, request_fingerprint = pg_catalog.repeat('f', 64)
where id = (select estimate_alternate from pg_temp.command_cases where name = 'run');
select throws_ok(format(
  'select * from public.run_analysis(%L::uuid, %L::uuid, %L, %L::jsonb)',
  (select actor_id from pg_temp.command_cases where name = 'run'),
  (select estimate_alternate from pg_temp.command_cases where name = 'run'),
  'altered-fingerprint',
  '{"fingerprintVersion":"s2-05-v2","pricingVersion":"s2-04-v1","promptVersion":"prompt-test-v1","outputSchemaVersion":"schema-test-v1","providers":{"primary":{"provider":"provider-a","model":"model-a"},"fallback":{"provider":"provider-b","model":"model-b"}}}'
), 'P2102', null, 'A changed retrieval fingerprint fails the snapshot check');
select throws_ok(format(
  'select * from public.run_analysis(%L::uuid, %L::uuid, %L, %L::jsonb)',
  (select qa_id from pg_temp.command_cases where name = 'run'),
  (select estimate_qa from pg_temp.command_cases where name = 'run'),
  'qa-key',
  '{"fingerprintVersion":"s2-05-v2","pricingVersion":"s2-04-v1","promptVersion":"prompt-test-v1","outputSchemaVersion":"schema-test-v1","providers":{"primary":{"provider":"provider-a","model":"model-a"},"fallback":{"provider":"provider-b","model":"model-b"}}}'
), 'P2002', null, 'A second actor cannot create an active run in the workspace');

update public.analyses
set status = 'completed', attempt_count = 1, started_at = clock_timestamp(), finished_at = clock_timestamp()
where id = (select analysis_id from pg_temp.command_results where name = 'first');
select private.settle_analysis_credits(
  (select analysis_id from pg_temp.command_results where name = 'first'),
  (select fixed_cost from public.analyses where id = (select analysis_id from pg_temp.command_results where name = 'first')),
  'Consumed'
);
insert into pg_temp.command_results(name, analysis_id, status)
select 'qa-independent-key', r.analysis_id, r.status
from public.run_analysis(
  (select qa_id from pg_temp.command_cases where name = 'run'),
  (select estimate_qa from pg_temp.command_cases where name = 'run'),
  'run-key',
  '{"fingerprintVersion":"s2-05-v2","pricingVersion":"s2-04-v1","promptVersion":"prompt-test-v1","outputSchemaVersion":"schema-test-v1","providers":{"primary":{"provider":"provider-a","model":"model-a"},"fallback":{"provider":"provider-b","model":"model-b"}}}'::jsonb
) r;
select isnt((select analysis_id from pg_temp.command_results where name = 'qa-independent-key'),
  (select analysis_id from pg_temp.command_results where name = 'first'),
  'Idempotency keys are scoped to their actor');
select is((select count(*)::integer from public.analysis_documents d
  where d.analysis_id = (select analysis_id from pg_temp.command_results where name = 'qa-independent-key')
    and d.version_id = (select source_one from pg_temp.command_cases where name = 'run')),
  2, 'Run preserves source and comparison roles when one version has both roles');

update pg_temp.command_cases c
set estimate_retry = pg_temp.create_analysis_test_estimate(c.actor_id, array[c.source_two], '{}'::uuid[])
where c.name = 'retry';
update public.analyses a
set status = 'queued', attempt_count = 0, started_at = null, finished_at = null, error_code = null
where a.id = (select scope_analysis_id from pg_temp.command_cases where name = 'retry');
select private.reserve_analysis_credits(
  (select scope_analysis_id from pg_temp.command_cases where name = 'retry'), 3
);
update public.analyses
set status = 'failed', attempt_count = 1, started_at = clock_timestamp(),
  finished_at = clock_timestamp(), error_code = 'INTERNAL_ERROR'
where id = (select scope_analysis_id from pg_temp.command_cases where name = 'retry');
select private.settle_analysis_credits(
  (select scope_analysis_id from pg_temp.command_cases where name = 'retry'), 3, 'Released'
);
select throws_ok(format(
  'select * from public.retry_analysis(%L::uuid, %L::uuid, %L::uuid, %L, %L::jsonb)',
  (select actor_id from pg_temp.command_cases where name = 'retry'),
  (select scope_analysis_id from pg_temp.command_cases where name = 'retry'),
  (select estimate_retry from pg_temp.command_cases where name = 'retry'),
  (select idempotency_key from public.analyses
   where id = (select scope_analysis_id from pg_temp.command_cases where name = 'retry')),
  '{"fingerprintVersion":"s2-05-v2","pricingVersion":"s2-04-v1","promptVersion":"prompt-test-v1","outputSchemaVersion":"schema-test-v1","providers":{"primary":{"provider":"provider-a","model":"model-a"},"fallback":{"provider":"provider-b","model":"model-b"}}}'
), 'P2002', null, 'Retry cannot reuse the failed run idempotency key');
insert into pg_temp.command_results(name, analysis_id, status, retry_of_analysis_id)
select 'retry-first', r.analysis_id, r.status, r.retry_of_analysis_id
from public.retry_analysis(
  (select actor_id from pg_temp.command_cases where name = 'retry'),
  (select scope_analysis_id from pg_temp.command_cases where name = 'retry'),
  (select estimate_retry from pg_temp.command_cases where name = 'retry'),
  'retry-key',
  '{"fingerprintVersion":"s2-05-v2","pricingVersion":"s2-04-v1","promptVersion":"prompt-test-v1","outputSchemaVersion":"schema-test-v1","providers":{"primary":{"provider":"provider-a","model":"model-a"},"fallback":{"provider":"provider-b","model":"model-b"}}}'::jsonb
) r;
insert into pg_temp.command_results(name, analysis_id, status, retry_of_analysis_id)
select 'retry-replay', r.analysis_id, r.status, r.retry_of_analysis_id
from public.retry_analysis(
  (select actor_id from pg_temp.command_cases where name = 'retry'),
  (select scope_analysis_id from pg_temp.command_cases where name = 'retry'),
  (select estimate_retry from pg_temp.command_cases where name = 'retry'),
  'retry-key', null
) r;
select is((select retry_of_analysis_id from pg_temp.command_results where name = 'retry-first'),
  (select scope_analysis_id from pg_temp.command_cases where name = 'retry'), 'Retry preserves its failed parent');
select is((select analysis_id from pg_temp.command_results where name = 'retry-replay'),
  (select analysis_id from pg_temp.command_results where name = 'retry-first'), 'Retry replay returns its original run');

update pg_temp.command_cases c
set estimate_no_release = pg_temp.create_analysis_test_estimate(c.actor_id, array[c.source_one], '{}'::uuid[])
where c.name = 'no_release';
update public.analyses
set status = 'failed', attempt_count = 1, started_at = clock_timestamp(),
  finished_at = clock_timestamp(), error_code = 'INTERNAL_ERROR'
where id = (select scope_analysis_id from pg_temp.command_cases where name = 'no_release');
select throws_ok(format(
  'select * from public.retry_analysis(%L::uuid, %L::uuid, %L::uuid, %L, %L::jsonb)',
  (select actor_id from pg_temp.command_cases where name = 'no_release'),
  (select scope_analysis_id from pg_temp.command_cases where name = 'no_release'),
  (select estimate_no_release from pg_temp.command_cases where name = 'no_release'),
  'no-release-key',
  '{"fingerprintVersion":"s2-05-v2","pricingVersion":"s2-04-v1","promptVersion":"prompt-test-v1","outputSchemaVersion":"schema-test-v1","providers":{"primary":{"provider":"provider-a","model":"model-a"},"fallback":{"provider":"provider-b","model":"model-b"}}}'
), 'P2002', null, 'Retry rejects a failed analysis without a full Released movement');
insert into public.credit_ledger(workspace_id, event_type, amount, analysis_id)
select workspace_id, 'Reserved', 3, scope_analysis_id
from pg_temp.command_cases where name = 'no_release';
insert into public.credit_ledger(workspace_id, event_type, amount, analysis_id)
select workspace_id, 'Consumed', 3, scope_analysis_id
from pg_temp.command_cases where name = 'no_release';
select throws_ok(format(
  'select * from public.retry_analysis(%L::uuid, %L::uuid, %L::uuid, %L, %L::jsonb)',
  (select actor_id from pg_temp.command_cases where name = 'no_release'),
  (select scope_analysis_id from pg_temp.command_cases where name = 'no_release'),
  (select estimate_no_release from pg_temp.command_cases where name = 'no_release'),
  'failed-with-consumed',
  '{"fingerprintVersion":"s2-05-v2","pricingVersion":"s2-04-v1","promptVersion":"prompt-test-v1","outputSchemaVersion":"schema-test-v1","providers":{"primary":{"provider":"provider-a","model":"model-a"},"fallback":{"provider":"provider-b","model":"model-b"}}}'
), 'P2002', null, 'Retry rejects a failed analysis with a Consumed movement');

create temporary table overflow_case (
  actor_id uuid not null,
  workspace_id uuid not null,
  twenty_version_analysis_id uuid not null,
  extra_version_analysis_id uuid not null,
  estimate_ref uuid
) on commit drop;
insert into pg_temp.overflow_case
select c.actor_id, c.workspace_id,
  pg_temp.create_analysis_fixture(c.workspace_id, c.actor_id, 'completed', 20),
  pg_temp.create_analysis_fixture(c.workspace_id, c.actor_id, 'completed', 1),
  null
from pg_temp.command_cases c where c.name = 'no_release';
update pg_temp.overflow_case o
set estimate_ref = pg_temp.create_analysis_test_estimate(
  o.actor_id,
  (select pg_catalog.array_agg(version_id order by ordinal)
   from pg_temp.analysis_case where analysis_id = o.twenty_version_analysis_id),
  '{}'::uuid[]
);
update public.analysis_estimates e
set comparison_version_ids = array[(
  select version_id from pg_temp.analysis_case
  where analysis_id = (select extra_version_analysis_id from pg_temp.overflow_case)
    and ordinal = 1
)]::uuid[]
where e.id = (select estimate_ref from pg_temp.overflow_case);
select throws_ok(format(
  'select * from public.run_analysis(%L::uuid, %L::uuid, %L, %L::jsonb)',
  (select actor_id from pg_temp.overflow_case),
  (select estimate_ref from pg_temp.overflow_case),
  'twenty-one-scope',
  '{"fingerprintVersion":"s2-05-v2","pricingVersion":"s2-04-v1","promptVersion":"prompt-test-v1","outputSchemaVersion":"schema-test-v1","providers":{"primary":{"provider":"provider-a","model":"model-a"},"fallback":{"provider":"provider-b","model":"model-b"}}}'
), 'P2102', null, 'A tampered estimate cannot expand a 20-version union to 21');

update pg_temp.command_cases c
set estimate_insufficient = pg_temp.create_analysis_test_estimate(c.actor_id, array[c.source_one], array[c.source_two])
where c.name = 'insufficient';
do $consume_all$
declare
  v_workspace uuid;
  v_actor uuid;
  v_dummy uuid;
begin
  select workspace_id, actor_id into v_workspace, v_actor
  from pg_temp.command_cases where name = 'insufficient';
  v_dummy := pg_temp.create_analysis_fixture(v_workspace, v_actor, 'queued', 1);
  update public.analyses set fixed_cost = 50, reserved_credits = 50 where id = v_dummy;
  perform private.reserve_analysis_credits(v_dummy, 50);
  update public.analyses set status = 'completed', attempt_count = 1,
    started_at = clock_timestamp(), finished_at = clock_timestamp() where id = v_dummy;
  perform private.settle_analysis_credits(v_dummy, 50, 'Consumed');
end;
$consume_all$;
select throws_ok(format(
  'select * from public.run_analysis(%L::uuid, %L::uuid, %L, %L::jsonb)',
  (select actor_id from pg_temp.command_cases where name = 'insufficient'),
  (select estimate_insufficient from pg_temp.command_cases where name = 'insufficient'),
  'insufficient-key',
  '{"fingerprintVersion":"s2-05-v2","pricingVersion":"s2-04-v1","promptVersion":"prompt-test-v1","outputSchemaVersion":"schema-test-v1","providers":{"primary":{"provider":"provider-a","model":"model-a"},"fallback":{"provider":"provider-b","model":"model-b"}}}'
), 'P2001', null, 'Insufficient credits fail the command');
select is((select count(*)::integer from public.analyses
  where estimate_id = (select estimate_insufficient from pg_temp.command_cases where name = 'insufficient')),
  0, 'A failed reservation rolls back the analysis insert');
select is((select count(*)::integer from public.credit_ledger l
  join public.analyses a on a.id = l.analysis_id
  where a.estimate_id = (select estimate_insufficient from pg_temp.command_cases where name = 'insufficient')),
  0, 'A failed reservation leaves no partial ledger movement');

select * from finish();
rollback;
