begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
\ir analysis-fixtures.psql
select no_plan();

select ok(has_function_privilege(
  'service_role',
  'public.create_analysis_estimate(uuid,uuid[],uuid[],jsonb)',
  'EXECUTE'
), 'The estimate RPC is executable by the server service role');
select ok(not has_function_privilege(
  'authenticated',
  'public.create_analysis_estimate(uuid,uuid[],uuid[],jsonb)',
  'EXECUTE'
), 'Authenticated users cannot call the privileged estimate RPC');
select ok(not has_function_privilege(
  'anon',
  'public.create_analysis_estimate(uuid,uuid[],uuid[],jsonb)',
  'EXECUTE'
), 'Anonymous users cannot call the privileged estimate RPC');
select ok(not has_table_privilege('authenticated', 'public.analysis_estimates', 'INSERT'),
  'Authenticated users cannot insert arbitrary estimates');
select ok(has_column_privilege('authenticated', 'public.analysis_estimates', 'fixed_cost', 'SELECT'),
  'Authenticated users can read the estimate cost projection');
select ok(not has_column_privilege('authenticated', 'public.analysis_estimates', 'request_fingerprint', 'SELECT'),
  'The retrieval fingerprint remains private');
select ok(not has_column_privilege('authenticated', 'public.analysis_estimates', 'execution_manifest', 'SELECT'),
  'The provider execution manifest remains private');

insert into pg_temp.analysis_fixture_ids(name, analysis_id) values
  ('estimate_twenty', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '10000000-0000-4000-8000-000000000001', 'completed', 20));

create temporary table estimate_results (
  actor text not null,
  estimate_ref uuid not null,
  fixed_cost integer not null,
  expires_at timestamptz not null,
  source_version_ids uuid[] not null,
  comparison_version_ids uuid[] not null
) on commit drop;

insert into pg_temp.estimate_results
select 'Admin', e.estimate_ref, e.fixed_cost, e.expires_at,
  e.source_version_ids, e.comparison_version_ids
from public.create_analysis_estimate(
  '10000000-0000-4000-8000-000000000001',
  (select array_agg(version_id order by ordinal) from pg_temp.analysis_case
   where analysis_id = pg_temp.analysis_fixture_id('estimate_twenty')),
  '{}'::uuid[],
  '{"fingerprintVersion":"s2-05-v2","pricingVersion":"s2-04-v1","promptVersion":"prompt-test-v1","outputSchemaVersion":"schema-test-v1","providers":{"primary":{"provider":"provider-a","model":"model-a"},"fallback":{"provider":"provider-b","model":"model-b"}}}'::jsonb
) e;

select is((select fixed_cost from pg_temp.estimate_results where actor = 'Admin'),
  2, 'Twenty chunks without pairs are priced from the complete scope');
select is((select chunk_count from public.analysis_estimates where id = (
  select estimate_ref from pg_temp.estimate_results where actor = 'Admin')),
  20, 'The trusted estimate persists all scope chunks');
select is((select candidate_pair_count from public.analysis_estimates where id = (
  select estimate_ref from pg_temp.estimate_results where actor = 'Admin')),
  0, 'The trusted estimate persists zero candidate pairs');
select is((select expires_at - created_at from public.analysis_estimates where id = (
  select estimate_ref from pg_temp.estimate_results where actor = 'Admin')),
  interval '30 minutes', 'The SQL clock sets an exact thirty-minute TTL');
select is((select fingerprint_version from public.analysis_estimates where id = (
  select estimate_ref from pg_temp.estimate_results where actor = 'Admin')),
  's2-05-v2', 'The estimate records the fingerprint contract version');
select is((select execution_manifest ->> 'promptVersion' from public.analysis_estimates where id = (
  select estimate_ref from pg_temp.estimate_results where actor = 'Admin')),
  'prompt-test-v1', 'The estimate freezes its server execution manifest');
select is((select source_version_ids from pg_temp.estimate_results where actor = 'Admin'),
  (select array_agg(version_id order by version_id) from pg_temp.analysis_case
   where analysis_id = pg_temp.analysis_fixture_id('estimate_twenty')),
  'The estimate stores the normalized source scope');

insert into pg_temp.estimate_results
select 'QA Lead', e.estimate_ref, e.fixed_cost, e.expires_at,
  e.source_version_ids, e.comparison_version_ids
from public.create_analysis_estimate(
  '10000000-0000-4000-8000-000000000002',
  (select array_agg(version_id order by ordinal) from pg_temp.analysis_case
   where analysis_id = pg_temp.analysis_fixture_id('estimate_twenty')),
  '{}'::uuid[],
  '{"fingerprintVersion":"s2-05-v2","pricingVersion":"s2-04-v1","promptVersion":"prompt-test-v1","outputSchemaVersion":"schema-test-v1","providers":{"primary":{"provider":"provider-a","model":"model-a"},"fallback":{"provider":"provider-b","model":"model-b"}}}'::jsonb
) e;
select is((select fixed_cost from pg_temp.estimate_results where actor = 'QA Lead'),
  2, 'A QA Lead profile in the same workspace can request the estimate');

create function pg_temp.try_estimate(p_actor_id uuid, p_analysis_id uuid, p_manifest jsonb)
returns uuid
language plpgsql
set search_path = pg_temp, public
as $$
declare v_estimate_id uuid;
begin
  select estimate_ref into v_estimate_id
  from public.create_analysis_estimate(
    p_actor_id,
    (select array_agg(version_id order by ordinal) from pg_temp.analysis_case
     where analysis_id = p_analysis_id),
    '{}'::uuid[], p_manifest
  );
  return v_estimate_id;
end;
$$;

select throws_ok(format(
  'select pg_temp.try_estimate(%L::uuid, %L::uuid, null)',
  '10000000-0000-4000-8000-000000000001',
  pg_temp.analysis_fixture_id('estimate_twenty')
), '22023', null, 'A missing execution manifest creates no estimate');
select throws_ok(format(
  'select pg_temp.try_estimate(%L::uuid, %L::uuid, %L::jsonb)',
  '10000000-0000-4000-8000-000000000001',
  pg_temp.analysis_fixture_id('estimate_twenty'),
  '{"fingerprintVersion":"unknown-v9","pricingVersion":"s2-04-v1","promptVersion":"p","outputSchemaVersion":"s","providers":{"primary":{"provider":"a","model":"a"},"fallback":{"provider":"b","model":"b"}}}'
), '22023', null, 'An unknown fingerprint revision creates no estimate');
select throws_ok(format(
  'select pg_temp.try_estimate(%L::uuid, %L::uuid, %L::jsonb)',
  '10000000-0000-4000-8000-000000000001',
  pg_temp.analysis_fixture_id('estimate_twenty'),
  '{"fingerprintVersion":"s2-05-v2","pricingVersion":"unknown-v9","promptVersion":"p","outputSchemaVersion":"s","providers":{"primary":{"provider":"a","model":"a"},"fallback":{"provider":"b","model":"b"}}}'
), '22023', null, 'An unknown pricing revision creates no estimate');
select throws_ok(format(
  'select pg_temp.try_estimate(%L::uuid, %L::uuid, %L::jsonb)',
  '10000000-0000-4000-8000-000000000001',
  pg_temp.analysis_fixture_id('estimate_twenty'),
  '{"fingerprintVersion":"s2-05-v2","pricingVersion":"s2-04-v1","promptVersion":"p","outputSchemaVersion":"s","providers":{"primary":{"provider":"a","model":" "},"fallback":{"provider":"b","model":"b"}}}'
), '22023', null, 'An empty model reference creates no estimate');
select throws_ok(format(
  'select pg_temp.try_estimate(%L::uuid, %L::uuid, %L::jsonb)',
  '10000000-0000-4000-8000-000000000003',
  pg_temp.analysis_fixture_id('estimate_twenty'),
  '{"fingerprintVersion":"s2-05-v2","pricingVersion":"s2-04-v1","promptVersion":"p","outputSchemaVersion":"s","providers":{"primary":{"provider":"a","model":"a"},"fallback":{"provider":"b","model":"b"}}}'
), '42501', null, 'A Member profile cannot request an estimate');
select throws_ok(format(
  'select pg_temp.try_estimate(%L::uuid, %L::uuid, %L::jsonb)',
  '10000000-0000-4000-8000-000000000004',
  pg_temp.analysis_fixture_id('estimate_twenty'),
  '{"fingerprintVersion":"s2-05-v2","pricingVersion":"s2-04-v1","promptVersion":"p","outputSchemaVersion":"s","providers":{"primary":{"provider":"a","model":"a"},"fallback":{"provider":"b","model":"b"}}}'
), '22023', null, 'A different workspace cannot estimate the known scope');

select throws_ok(format(
  'update public.analysis_estimates set execution_manifest = %L::jsonb where id = %L::uuid',
  '{}', (select estimate_ref from pg_temp.estimate_results where actor = 'Admin')
), '42501', null, 'An estimate execution snapshot cannot be changed');

update public.analyses a set request_fingerprint = e.request_fingerprint
from public.analysis_estimates e
where a.id = pg_temp.analysis_fixture_id('estimate_twenty')
  and e.id = (select estimate_ref from pg_temp.estimate_results where actor = 'Admin');
select throws_ok(format(
  'delete from public.analysis_estimates where id = %L::uuid',
  (select estimate_ref from pg_temp.estimate_results where actor = 'Admin')
), '23503', null, 'An estimate snapshot referenced by an analysis cannot be deleted');

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select throws_ok($$insert into public.analysis_estimates(
  workspace_id, initiator_id, source_version_ids, comparison_version_ids,
  request_fingerprint, retrieval_config, chunk_count, candidate_pair_count,
  fixed_cost, pricing_version, expires_at
) values (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '10000000-0000-4000-8000-000000000001',
  array['30000000-0000-4000-8000-000000000001']::uuid[], '{}'::uuid[],
  'arbitrary', '{"topK":5}'::jsonb, 1, 0, 1, 's2-04-v1', clock_timestamp() + interval '30 minutes'
)$$, '42501', null, 'Even an Admin cannot directly insert an estimate');

reset role;
select * from finish();
rollback;
