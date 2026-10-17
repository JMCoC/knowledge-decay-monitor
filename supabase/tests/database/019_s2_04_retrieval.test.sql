begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

-- S2-04 retrieval + estimation: analysis_estimates, HNSW, retrieve_candidate_pairs.
-- Fixtures live in Workspace A; Admin B / Member assertions use seed identities.

-- 1. HNSW index verbatim contract §4.2.
select ok((select indexdef ilike '%hnsw%cosine%'
  from pg_indexes
  where schemaname = 'public' and tablename = 'document_chunks'
    and indexname = 'document_chunks_embedding_hnsw'),
  'HNSW cosine index exists on document_chunks.embedding');
select ok((select indexdef ilike '%ef_construction%64%'
  from pg_indexes
  where schemaname = 'public' and tablename = 'document_chunks'
    and indexname = 'document_chunks_embedding_hnsw'),
  'HNSW index carries the contract build parameters');

-- 2. analysis_estimates base columns plus the nullable S2-05 snapshot fields.
select is((select count(*)
  from information_schema.columns
  where table_schema = 'public' and table_name = 'analysis_estimates'
    and column_name in ('id','workspace_id','initiator_id',
      'source_version_ids','comparison_version_ids',
      'request_fingerprint','retrieval_config',
      'chunk_count','candidate_pair_count','fixed_cost',
      'pricing_version','expires_at','created_at',
      'execution_manifest','fingerprint_version')),
  15::bigint, 'analysis_estimates exposes the S2-04 columns and S2-05 snapshot');

-- 3. RPC signature verbatim contract §5.1.
select has_function('public', 'retrieve_candidate_pairs',
  array['uuid','uuid[]','uuid[]','integer','double precision'],
  'retrieve_candidate_pairs(uuid,uuid[],uuid[],integer,double precision) exists');
select ok((select not prosecdef and provolatile = 's'
    and proconfig @> array['search_path=""']
  from pg_proc
  where oid = 'public.retrieve_candidate_pairs(uuid,uuid[],uuid[],integer,double precision)'::regprocedure),
  'retrieval RPC is security invoker, stable, with an empty search path');
select ok(has_function_privilege('authenticated',
  'public.retrieve_candidate_pairs(uuid,uuid[],uuid[],integer,double precision)', 'EXECUTE'),
  'authenticated callers can invoke the retrieval RPC');
select ok(not has_function_privilege('anon',
  'public.retrieve_candidate_pairs(uuid,uuid[],uuid[],integer,double precision)', 'EXECUTE'),
  'anonymous callers cannot invoke the retrieval RPC');

-- Fixtures: source doc/version (V1, 2 chunks) + comparison doc/version
-- (V2, 10 chunks) + self-pair doc/version (V4, 2 parallel chunks).
-- e1/e_ortho are orthogonal; e_hi ~= 0.751 vs e1 (in); e_lo ~= 0.749 (out).
insert into public.documents(id,workspace_id,name,category,owner_id) values
  ('20000000-0000-4000-8000-0000000000d1','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Retrieval source','SOP','10000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-0000000000d2','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Retrieval comparison','SOP','10000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-0000000000d3','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Retrieval self','SOP','10000000-0000-4000-8000-000000000001');
insert into public.document_versions(id,workspace_id,document_id,version_number,storage_path) values
  ('30000000-0000-4000-8000-0000000000d1','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '20000000-0000-4000-8000-0000000000d1',1,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-0000000000d1/30000000-0000-4000-8000-0000000000d1/original.md'),
  ('30000000-0000-4000-8000-0000000000d2','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '20000000-0000-4000-8000-0000000000d2',1,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-0000000000d2/30000000-0000-4000-8000-0000000000d2/original.md'),
  ('30000000-0000-4000-8000-0000000000d4','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '20000000-0000-4000-8000-0000000000d3',1,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-0000000000d3/30000000-0000-4000-8000-0000000000d4/original.md');
insert into public.document_chunks(id,workspace_id,version_id,chunk_index,text_content,embedding) values
  ('40000000-0000-4000-8000-0000000000d1','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '30000000-0000-4000-8000-0000000000d1',0,'source one',
    ('[1' || repeat(',0', 383) || ']')::extensions.vector(384)),
  ('40000000-0000-4000-8000-0000000000d2','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '30000000-0000-4000-8000-0000000000d1',1,'source two',
    ('[0,1' || repeat(',0', 382) || ']')::extensions.vector(384)),
  ('40000000-0000-4000-8000-0000000000d3','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '30000000-0000-4000-8000-0000000000d2',0,'comparison parallel one',
    ('[1' || repeat(',0', 383) || ']')::extensions.vector(384)),
  ('40000000-0000-4000-8000-0000000000d4','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '30000000-0000-4000-8000-0000000000d2',1,'comparison parallel two',
    ('[0,1' || repeat(',0', 382) || ']')::extensions.vector(384)),
  ('40000000-0000-4000-8000-0000000000d5','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '30000000-0000-4000-8000-0000000000d2',2,'comparison boundary high',
    ('[1,0.8794' || repeat(',0', 382) || ']')::extensions.vector(384)),
  ('40000000-0000-4000-8000-0000000000d6','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '30000000-0000-4000-8000-0000000000d2',3,'comparison boundary low',
    ('[1,0.8848' || repeat(',0', 382) || ']')::extensions.vector(384)),
  ('40000000-0000-4000-8000-0000000000d7','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '30000000-0000-4000-8000-0000000000d2',4,'comparison filler one',
    ('[1' || repeat(',0', 383) || ']')::extensions.vector(384)),
  ('40000000-0000-4000-8000-0000000000d8','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '30000000-0000-4000-8000-0000000000d2',5,'comparison filler two',
    ('[1' || repeat(',0', 383) || ']')::extensions.vector(384)),
  ('40000000-0000-4000-8000-0000000000d9','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '30000000-0000-4000-8000-0000000000d2',6,'comparison filler three',
    ('[1' || repeat(',0', 383) || ']')::extensions.vector(384)),
  ('40000000-0000-4000-8000-0000000000da','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '30000000-0000-4000-8000-0000000000d2',7,'comparison filler four',
    ('[1' || repeat(',0', 383) || ']')::extensions.vector(384)),
  ('40000000-0000-4000-8000-0000000000db','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '30000000-0000-4000-8000-0000000000d2',8,'comparison filler five',
    ('[1' || repeat(',0', 383) || ']')::extensions.vector(384)),
  ('40000000-0000-4000-8000-0000000000dc','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '30000000-0000-4000-8000-0000000000d2',9,'comparison filler six',
    ('[1' || repeat(',0', 383) || ']')::extensions.vector(384)),
  ('40000000-0000-4000-8000-0000000000e1','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '30000000-0000-4000-8000-0000000000d4',0,'self one',
    ('[1' || repeat(',0', 383) || ']')::extensions.vector(384)),
  ('40000000-0000-4000-8000-0000000000e2','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '30000000-0000-4000-8000-0000000000d4',1,'self two',
    ('[1' || repeat(',0', 383) || ']')::extensions.vector(384));
-- Task 2 edges: single-chunk source version (V5) + tight-boundary
-- comparison version (V6: 0.7501 in, 0.7499 out vs e1).
insert into public.documents(id,workspace_id,name,category,owner_id) values
  ('20000000-0000-4000-8000-0000000000d4','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Retrieval single','SOP','10000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-0000000000d5','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Retrieval boundary','SOP','10000000-0000-4000-8000-000000000001');
insert into public.document_versions(id,workspace_id,document_id,version_number,storage_path) values
  ('30000000-0000-4000-8000-0000000000d5','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '20000000-0000-4000-8000-0000000000d4',1,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-0000000000d4/30000000-0000-4000-8000-0000000000d5/original.md'),
  ('30000000-0000-4000-8000-0000000000d6','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '20000000-0000-4000-8000-0000000000d5',1,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-0000000000d5/30000000-0000-4000-8000-0000000000d6/original.md');
insert into public.document_chunks(id,workspace_id,version_id,chunk_index,text_content,embedding) values
  ('40000000-0000-4000-8000-0000000000f1','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '30000000-0000-4000-8000-0000000000d5',0,'single anchor',
    ('[1' || repeat(',0', 383) || ']')::extensions.vector(384)),
  ('40000000-0000-4000-8000-0000000000f2','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '30000000-0000-4000-8000-0000000000d6',0,'boundary just above',
    ('[1,0.881640' || repeat(',0', 382) || ']')::extensions.vector(384)),
  ('40000000-0000-4000-8000-0000000000f3','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '30000000-0000-4000-8000-0000000000d6',1,'boundary just below',
    ('[1,0.882184' || repeat(',0', 382) || ']')::extensions.vector(384));

-- 4. RPC behaviour: S1 qualifies 8 externals -> Top 5; S2 qualifies 1.
-- Expected total: 5 (S1: d3,d7,d8,d9,da) + 1 (S2: d4) = 6.
select is((select count(*)
  from public.retrieve_candidate_pairs(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    array['30000000-0000-4000-8000-0000000000d1']::uuid[],
    array['30000000-0000-4000-8000-0000000000d2']::uuid[],
    5, 0.75)),
  6::bigint, 'Top-K bounds each source chunk: 5 + 1 pairs');
select is((select count(*)
  from public.retrieve_candidate_pairs(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    array['30000000-0000-4000-8000-0000000000d1']::uuid[],
    array['30000000-0000-4000-8000-0000000000d2']::uuid[],
    5, 0.75)
  where source_chunk_id = '40000000-0000-4000-8000-0000000000d1'),
  5::bigint, 'source one keeps exactly its Top 5');
select is((select array_agg(comparison_chunk_id order by comparison_chunk_id)
  from public.retrieve_candidate_pairs(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    array['30000000-0000-4000-8000-0000000000d1']::uuid[],
    array['30000000-0000-4000-8000-0000000000d2']::uuid[],
    5, 0.75)
  where source_chunk_id = '40000000-0000-4000-8000-0000000000d1'),
  array['40000000-0000-4000-8000-0000000000d3','40000000-0000-4000-8000-0000000000d7',
    '40000000-0000-4000-8000-0000000000d8','40000000-0000-4000-8000-0000000000d9',
    '40000000-0000-4000-8000-0000000000da']::uuid[],
  'Top 5 keeps the parallel chunks, drops the boundary and the largest ids');
select is((select count(*)
  from public.retrieve_candidate_pairs(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    array['30000000-0000-4000-8000-0000000000d1']::uuid[],
    array['30000000-0000-4000-8000-0000000000d2']::uuid[],
    100, 0.75)),
  9::bigint, 'without Top-K pressure all qualifying pairs return');
select is((select count(*)
  from public.retrieve_candidate_pairs(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    array['30000000-0000-4000-8000-0000000000d1']::uuid[],
    array['30000000-0000-4000-8000-0000000000d2']::uuid[],
    100, 0.75)
  where comparison_chunk_id = '40000000-0000-4000-8000-0000000000d5'),
  1::bigint, 'boundary 0.751 chunk is included');
select is((select count(*)
  from public.retrieve_candidate_pairs(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    array['30000000-0000-4000-8000-0000000000d1']::uuid[],
    array['30000000-0000-4000-8000-0000000000d2']::uuid[],
    5, 0.75)
  where comparison_chunk_id = '40000000-0000-4000-8000-0000000000d6'),
  0::bigint, 'boundary 0.749 chunk is excluded');
select is((select max(similarity)
  from public.retrieve_candidate_pairs(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    array['30000000-0000-4000-8000-0000000000d1']::uuid[],
    array['30000000-0000-4000-8000-0000000000d2']::uuid[],
    5, 0.75)),
  1::double precision, 'parallel chunks score similarity 1');
select is((select count(*)
  from public.retrieve_candidate_pairs(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    array['30000000-0000-4000-8000-0000000000d1']::uuid[],
    array['30000000-0000-4000-8000-0000000000d2']::uuid[],
    5, 0.75)
  where source_chunk_id = comparison_chunk_id),
  0::bigint, 'no self-pairs survive canonicalization');

-- 5. D4b overlap: same version as source and comparison collapses to 1 pair.
select is((select count(*)
  from public.retrieve_candidate_pairs(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    array['30000000-0000-4000-8000-0000000000d4']::uuid[],
    array['30000000-0000-4000-8000-0000000000d4']::uuid[],
    5, 0.75)),
  1::bigint, 'UNION plus DISTINCT ON collapses role-swapped duplicates');

-- 6. Empty comparison list returns no rows without error.
select is((select count(*)
  from public.retrieve_candidate_pairs(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    array['30000000-0000-4000-8000-0000000000d1']::uuid[],
    array[]::uuid[],
    5, 0.75)),
  0::bigint, 'empty comparison list yields zero pairs');

-- 7. Determinism: repeated calls return identical pairs.
select is(
  (select string_agg(t::text, '|' order by t::text)
    from public.retrieve_candidate_pairs(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      array['30000000-0000-4000-8000-0000000000d1']::uuid[],
      array['30000000-0000-4000-8000-0000000000d2']::uuid[],
      5, 0.75) t),
  (select string_agg(t::text, '|' order by t::text)
    from public.retrieve_candidate_pairs(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      array['30000000-0000-4000-8000-0000000000d1']::uuid[],
      array['30000000-0000-4000-8000-0000000000d2']::uuid[],
      5, 0.75) t),
  'repeated retrieval calls are byte-identical');

-- Task 2 edges. V5 holds a single chunk (no internos possible);
-- V6 holds the tight-boundary pair (0.7501 in, 0.7499 out).
select is((select count(*)
  from public.retrieve_candidate_pairs(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    array['30000000-0000-4000-8000-0000000000d5']::uuid[],
    array['30000000-0000-4000-8000-0000000000d6']::uuid[],
    5, 0.75)),
  1::bigint, 'single-chunk source pairs through externals only');
select is((select count(*)
  from public.retrieve_candidate_pairs(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    array['30000000-0000-4000-8000-0000000000d5']::uuid[],
    array['30000000-0000-4000-8000-0000000000d6']::uuid[],
    5, 0.75)
  where comparison_chunk_id = '40000000-0000-4000-8000-0000000000f2'),
  1::bigint, 'similarity 0.7501 clears the threshold');
select is((select count(*)
  from public.retrieve_candidate_pairs(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    array['30000000-0000-4000-8000-0000000000d5']::uuid[],
    array['30000000-0000-4000-8000-0000000000d6']::uuid[],
    5, 0.75)
  where comparison_chunk_id = '40000000-0000-4000-8000-0000000000f3'),
  0::bigint, 'similarity 0.7499 stays below the threshold');
select is((select count(*)
  from public.retrieve_candidate_pairs(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    array['30000000-0000-4000-8000-0000000000d5']::uuid[],
    array['30000000-0000-4000-8000-0000000000d6']::uuid[],
    5, 0.75)
  where source_chunk_id = comparison_chunk_id),
  0::bigint, 'single-chunk source never self-pairs');
select is((select count(*)
  from public.retrieve_candidate_pairs(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    array['30000000-0000-4000-8000-0000000000d5']::uuid[],
    array['30000000-0000-4000-8000-0000000000d6']::uuid[],
    10, 0.75)),
  1::bigint, 'Top-K above the candidate count returns all qualifiers');
select is((select count(*)
  from public.retrieve_candidate_pairs(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    array['30000000-0000-4000-8000-0000000000d4']::uuid[],
    array['30000000-0000-4000-8000-0000000000d4']::uuid[],
    5, 0.75)
  where source_version_id = '30000000-0000-4000-8000-0000000000d4'
    and comparison_version_id = '30000000-0000-4000-8000-0000000000d4'
    and source_chunk_id <> comparison_chunk_id),
  1::bigint, 'overlap lists pair cross-role, never self');
select is((select count(*)
  from public.retrieve_candidate_pairs(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    array['30000000-0000-4000-8000-0000000000d4']::uuid[],
    array[]::uuid[],
    5, 0.75)),
  1::bigint, 'empty comparison list still evaluates internos');

-- Threshold equality, both sides, with exact measured similarities.
select is((select count(*)
  from public.retrieve_candidate_pairs(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    array['30000000-0000-4000-8000-0000000000d1']::uuid[],
    array['30000000-0000-4000-8000-0000000000d2']::uuid[],
    100,
    (select 1 - (x.embedding operator(extensions.<=>) y.embedding)
      from public.document_chunks x, public.document_chunks y
      where x.id = '40000000-0000-4000-8000-0000000000d1'
        and y.id = '40000000-0000-4000-8000-0000000000d3'))),
  8::bigint, 'similarity equal to the threshold enters');
select is((select count(*)
  from public.retrieve_candidate_pairs(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    array['30000000-0000-4000-8000-0000000000d1']::uuid[],
    array['30000000-0000-4000-8000-0000000000d2']::uuid[],
    100,
    (select 1 - (x.embedding operator(extensions.<=>) y.embedding)
      from public.document_chunks x, public.document_chunks y
      where x.id = '40000000-0000-4000-8000-0000000000d1'
        and y.id = '40000000-0000-4000-8000-0000000000d3')
      + 0.0001)),
  0::bigint, 'similarity epsilon above the top score filters it out');

-- Explicit tie-break: five similarity-1.0 pairs order by chunk id.
-- Overlaps the Top-5 set assertion; this one pins sim-first ordering.
select is((select array_agg(comparison_chunk_id
    order by similarity desc, comparison_chunk_id asc)
  from public.retrieve_candidate_pairs(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    array['30000000-0000-4000-8000-0000000000d1']::uuid[],
    array['30000000-0000-4000-8000-0000000000d2']::uuid[],
    5, 0.75)
  where source_chunk_id = '40000000-0000-4000-8000-0000000000d1'),
  array['40000000-0000-4000-8000-0000000000d3','40000000-0000-4000-8000-0000000000d7',
    '40000000-0000-4000-8000-0000000000d8','40000000-0000-4000-8000-0000000000d9',
    '40000000-0000-4000-8000-0000000000da']::uuid[],
  'identical similarities break ties by chunk id ascending');

-- NULL inputs: pinned behaviour (contract is silent; Zod forbids null).
select is((select count(*)
  from public.retrieve_candidate_pairs(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    null::uuid[],
    array['30000000-0000-4000-8000-0000000000d2']::uuid[],
    5, 0.75)),
  0::bigint, 'null source list yields zero pairs without error');
select is((select count(*)
  from public.retrieve_candidate_pairs(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    array['30000000-0000-4000-8000-0000000000d4']::uuid[],
    null::uuid[],
    5, 0.75)),
  1::bigint, 'null comparison list falls back to internos');
select is((select count(*)
  from public.retrieve_candidate_pairs(
    null::uuid,
    array['30000000-0000-4000-8000-0000000000d1']::uuid[],
    array['30000000-0000-4000-8000-0000000000d2']::uuid[],
    5, 0.75)),
  0::bigint, 'null workspace yields zero pairs without error');

-- Foreign workspace scoping at the SQL level.
select is((select count(*)
  from public.retrieve_candidate_pairs(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    array['30000000-0000-4000-8000-0000000000d1']::uuid[],
    array['30000000-0000-4000-8000-0000000000d2']::uuid[],
    5, 0.75)),
  0::bigint, 'another workspace scope sees no Workspace A chunks');

-- 8. dims != 384 rejects with 22000 (Task 0 verdict).
select throws_ok($$insert into public.document_chunks
  (workspace_id,version_id,chunk_index,text_content,embedding) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','30000000-0000-4000-8000-0000000000d1',
    99,'bad dims', ('[0.5' || repeat(',0', 382) || ']')::extensions.vector(384))$$,
  '22000', null, 'a 383-dimension embedding rejects with 22000');

-- 9. CHECK violations reject with 23514.
select throws_ok($$insert into public.analysis_estimates
  (workspace_id,initiator_id,source_version_ids,comparison_version_ids,
   request_fingerprint,retrieval_config,chunk_count,candidate_pair_count,
   fixed_cost,pricing_version,expires_at) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','10000000-0000-4000-8000-000000000001',
   array['30000000-0000-4000-8000-0000000000d1']::uuid[],
   array['30000000-0000-4000-8000-0000000000d2']::uuid[],
   repeat('f', 64),'{}',2,6,
   0,'s2-04-v1',now() + interval '30 minutes')$$,
  '23514', null, 'fixed_cost below 1 rejects');
select throws_ok($$insert into public.analysis_estimates
  (workspace_id,initiator_id,source_version_ids,comparison_version_ids,
   request_fingerprint,retrieval_config,chunk_count,candidate_pair_count,
   fixed_cost,pricing_version,expires_at) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','10000000-0000-4000-8000-000000000001',
   array[]::uuid[],
   array['30000000-0000-4000-8000-0000000000d2']::uuid[],
   repeat('f', 64),'{}',0,0,
   1,'s2-04-v1',now() + interval '30 minutes')$$,
  '23514', null, 'an empty source list rejects');

-- Seed one estimate for the RLS block below.
insert into public.analysis_estimates
  (workspace_id,initiator_id,source_version_ids,comparison_version_ids,
   request_fingerprint,retrieval_config,chunk_count,candidate_pair_count,
   fixed_cost,pricing_version,expires_at) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','10000000-0000-4000-8000-000000000001',
   array['30000000-0000-4000-8000-0000000000d1']::uuid[],
   array['30000000-0000-4000-8000-0000000000d2']::uuid[],
   repeat('f', 64),'{}',2,6,
   3,'s2-04-v1',now() + interval '30 minutes');

-- 10. RLS: same-workspace Admin reads; Member reads nothing;
-- Tenant B reads nothing and cannot insert.
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is((select count(*) from public.analysis_estimates), 1::bigint,
  'Admin A reads the Workspace A estimate');
select throws_ok($$insert into public.analysis_estimates
  (workspace_id,initiator_id,source_version_ids,comparison_version_ids,
   request_fingerprint,retrieval_config,chunk_count,candidate_pair_count,
   fixed_cost,pricing_version,expires_at) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','10000000-0000-4000-8000-000000000001',
   array['30000000-0000-4000-8000-0000000000d1']::uuid[],
   array['30000000-0000-4000-8000-0000000000d2']::uuid[],
   repeat('e', 64),'{}',2,6,
   3,'s2-04-v1',now() + interval '30 minutes')$$,
  '42501', null, 'Admin A cannot insert an estimate outside the trusted RPC');
select set_config('request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select is((select count(*) from public.analysis_estimates), 0::bigint,
  'Member reads no estimates');
select set_config('request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
select is((select count(*) from public.analysis_estimates), 0::bigint,
  'Admin B reads no Workspace A estimates');
select is((select count(*)
  from public.retrieve_candidate_pairs(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    array['30000000-0000-4000-8000-0000000000d1']::uuid[],
    array['30000000-0000-4000-8000-0000000000d2']::uuid[],
    5, 0.75)),
  0::bigint,
  'Admin B retrieval over Workspace A sees no chunks through chunk_read RLS');
select throws_ok($$insert into public.analysis_estimates
  (workspace_id,initiator_id,source_version_ids,comparison_version_ids,
   request_fingerprint,retrieval_config,chunk_count,candidate_pair_count,
   fixed_cost,pricing_version,expires_at) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','10000000-0000-4000-8000-000000000004',
   array['30000000-0000-4000-8000-0000000000d1']::uuid[],
   array['30000000-0000-4000-8000-0000000000d2']::uuid[],
   repeat('d', 64),'{}',2,6,
   3,'s2-04-v1',now() + interval '30 minutes')$$,
  '42501', null, 'Admin B cannot insert into Workspace A');
reset role;

select * from finish();
rollback;
