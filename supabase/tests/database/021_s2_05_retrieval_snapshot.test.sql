begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
\ir analysis-fixtures.psql
select no_plan();

create temporary table retrieval_summary_results (
  name text primary key,
  chunk_count integer not null,
  candidate_pair_count integer not null,
  chunks_revision text not null,
  request_fingerprint text not null,
  fixed_cost integer not null
) on commit drop;

insert into pg_temp.analysis_fixture_ids(name, analysis_id) values
  ('zero_pair_scope', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '10000000-0000-4000-8000-000000000001', 'completed', 20));

insert into pg_temp.retrieval_summary_results
select 'zero_before', chunk_count, candidate_pair_count, chunks_revision,
  request_fingerprint, fixed_cost
from private.analysis_retrieval_summary(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  (select array_agg(version_id order by ordinal) from pg_temp.analysis_case
   where analysis_id = pg_temp.analysis_fixture_id('zero_pair_scope')),
  '{}'::uuid[],
  '{"fingerprintVersion":"s2-05-v2","pricingVersion":"s2-04-v1","promptVersion":"prompt-test-v1","outputSchemaVersion":"schema-test-v1","providers":{"primary":{"provider":"provider-a","model":"model-a"},"fallback":{"provider":"provider-b","model":"model-b"}}}'::jsonb
);

select is((select chunk_count from pg_temp.retrieval_summary_results where name = 'zero_before'),
  20, 'The summary counts all 20 chunks even when retrieval finds no pairs');
select is((select candidate_pair_count from pg_temp.retrieval_summary_results where name = 'zero_before'),
  0, 'Twenty isolated chunks produce no candidate pairs');
select is((select fixed_cost from pg_temp.retrieval_summary_results where name = 'zero_before'),
  2, 'Twenty chunks and zero pairs cost two credits');

insert into public.document_chunks(id, workspace_id, version_id, chunk_index, text_content, embedding)
select extensions.gen_random_uuid(), c.workspace_id, c.version_id, 1,
  'Unpaired synthetic chunk', ('[1,' || repeat('0,', 382) || '0]')::extensions.vector(384)
from pg_temp.analysis_case c
where c.analysis_id = pg_temp.analysis_fixture_id('zero_pair_scope') and c.ordinal = 1;

insert into pg_temp.retrieval_summary_results
select 'zero_after', chunk_count, candidate_pair_count, chunks_revision,
  request_fingerprint, fixed_cost
from private.analysis_retrieval_summary(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  (select array_agg(version_id order by ordinal) from pg_temp.analysis_case
   where analysis_id = pg_temp.analysis_fixture_id('zero_pair_scope')),
  '{}'::uuid[],
  '{"fingerprintVersion":"s2-05-v2","pricingVersion":"s2-04-v1","promptVersion":"prompt-test-v1","outputSchemaVersion":"schema-test-v1","providers":{"primary":{"provider":"provider-a","model":"model-a"},"fallback":{"provider":"provider-b","model":"model-b"}}}'::jsonb
);
select is((select chunk_count from pg_temp.retrieval_summary_results where name = 'zero_after'),
  21, 'An unpaired chunk changes the complete scope count');
select isnt((select chunks_revision from pg_temp.retrieval_summary_results where name = 'zero_after'),
  (select chunks_revision from pg_temp.retrieval_summary_results where name = 'zero_before'),
  'An unpaired chunk changes the chunk revision');
select isnt((select request_fingerprint from pg_temp.retrieval_summary_results where name = 'zero_after'),
  (select request_fingerprint from pg_temp.retrieval_summary_results where name = 'zero_before'),
  'An unpaired chunk changes the estimate fingerprint');

insert into pg_temp.analysis_fixture_ids(name, analysis_id) values
  ('large_scope', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '10000000-0000-4000-8000-000000000001', 'completed', 2));

delete from public.document_chunks c
using pg_temp.analysis_case f
where f.analysis_id = pg_temp.analysis_fixture_id('large_scope')
  and c.version_id = f.version_id;

insert into public.document_chunks(id, workspace_id, version_id, chunk_index, text_content, embedding)
select
  (case when f.ordinal = 1 then 'f0000000-0000-4000-8000-'
        else '00000000-0000-4000-8000-' end || lpad(to_hex(g.i), 12, '0'))::uuid,
  f.workspace_id,
  f.version_id,
  g.i - 1,
  'Synthetic candidate pair fixture',
  ('[1,' || repeat('0,', 382) || '0]')::extensions.vector(384)
from pg_temp.analysis_case f
cross join generate_series(1, 250) as g(i)
where f.analysis_id = pg_temp.analysis_fixture_id('large_scope');

create temporary table collected_pair_page (
  pair_low_id uuid not null,
  pair_high_id uuid not null,
  primary key (pair_low_id, pair_high_id)
) on commit drop;

create function pg_temp.collect_analysis_pair_pages(
  p_workspace_id uuid,
  p_source_version_ids uuid[],
  p_comparison_version_ids uuid[]
) returns integer
language plpgsql
set search_path = pg_temp, public, private, extensions
as $$
declare
  v_after_low uuid;
  v_after_high uuid;
  v_page_count integer;
  v_total integer := 0;
  v_pair record;
begin
  loop
    v_page_count := 0;
    for v_pair in
      select p.pair_low_id, p.pair_high_id
      from private.analysis_candidate_pair_page(
        p_workspace_id, p_source_version_ids, p_comparison_version_ids,
        v_after_low, v_after_high, 10
      ) p
      order by p.pair_low_id, p.pair_high_id
    loop
      insert into pg_temp.collected_pair_page(pair_low_id, pair_high_id)
      values (v_pair.pair_low_id, v_pair.pair_high_id);
      v_after_low := v_pair.pair_low_id;
      v_after_high := v_pair.pair_high_id;
      v_total := v_total + 1;
      v_page_count := v_page_count + 1;
    end loop;
    exit when v_page_count = 0;
  end loop;
  return v_total;
end;
$$;

insert into pg_temp.retrieval_summary_results
select 'large', chunk_count, candidate_pair_count, chunks_revision,
  request_fingerprint, fixed_cost
from private.analysis_retrieval_summary(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  (select array_agg(version_id order by ordinal) from pg_temp.analysis_case
   where analysis_id = pg_temp.analysis_fixture_id('large_scope') and ordinal = 1),
  (select array_agg(version_id order by ordinal) from pg_temp.analysis_case
   where analysis_id = pg_temp.analysis_fixture_id('large_scope') and ordinal = 2),
  '{"fingerprintVersion":"s2-05-v2","pricingVersion":"s2-04-v1","promptVersion":"prompt-test-v1","outputSchemaVersion":"schema-test-v1","providers":{"primary":{"provider":"provider-a","model":"model-a"},"fallback":{"provider":"provider-b","model":"model-b"}}}'::jsonb
);

select is((select chunk_count from pg_temp.retrieval_summary_results where name = 'large'),
  500, 'The large summary counts every chunk across both versions');
select is((select candidate_pair_count from pg_temp.retrieval_summary_results where name = 'large'),
  1250, 'SQL summary includes more than the PostgREST 1000-row limit');
select is(pg_temp.collect_analysis_pair_pages(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  (select array_agg(version_id order by ordinal) from pg_temp.analysis_case
   where analysis_id = pg_temp.analysis_fixture_id('large_scope') and ordinal = 1),
  (select array_agg(version_id order by ordinal) from pg_temp.analysis_case
   where analysis_id = pg_temp.analysis_fixture_id('large_scope') and ordinal = 2)
), 1250, 'Cursor pages return every candidate pair without duplicates');

select ok(not has_function_privilege('anon',
  'private.analysis_retrieval_summary(uuid,uuid[],uuid[],jsonb)', 'EXECUTE'),
  'Anonymous callers cannot execute the summary helper');
select ok(not has_function_privilege('authenticated',
  'private.analysis_retrieval_summary(uuid,uuid[],uuid[],jsonb)', 'EXECUTE'),
  'Authenticated callers cannot execute the summary helper');
select ok(has_function_privilege('service_role',
  'private.analysis_retrieval_summary(uuid,uuid[],uuid[],jsonb)', 'EXECUTE'),
  'Only the service role can execute the summary helper');

select * from finish();
rollback;
