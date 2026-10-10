begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

-- S1-04 finish_processing RPC + processing claim columns.
select has_function('public', 'finish_processing', array['uuid','uuid','jsonb'],
  'finish_processing(uuid,uuid,jsonb) exists');
select ok(has_function_privilege('service_role',
  'public.finish_processing(uuid,uuid,jsonb)', 'EXECUTE'),
  'the server role can invoke finish_processing');
select ok(not has_function_privilege('authenticated',
  'public.finish_processing(uuid,uuid,jsonb)', 'EXECUTE'),
  'authenticated callers cannot invoke finish_processing');
select ok(not has_function_privilege('anon',
  'public.finish_processing(uuid,uuid,jsonb)', 'EXECUTE'),
  'anonymous callers cannot invoke finish_processing');
select ok((select proconfig @> array[
  'search_path=""', 'statement_timeout=2s', 'lock_timeout=1s'
] from pg_proc where oid = 'public.finish_processing(uuid,uuid,jsonb)'::regprocedure),
  'completion RPC uses an empty search path and bounded statement and lock timeouts');
select is((select is_nullable from information_schema.columns
  where table_schema = 'public' and table_name = 'document_versions'
    and column_name = 'processing_operation_id'),
  'YES', 'processing_operation_id is nullable');
select is((select is_nullable from information_schema.columns
  where table_schema = 'public' and table_name = 'document_versions'
    and column_name = 'processing_started_at'),
  'YES', 'processing_started_at is nullable');

-- Fixtures: one document+version per guard, all in Workspace A.
insert into public.documents(id,workspace_id,name,category,owner_id) values
  ('20000000-0000-4000-8000-0000000000c1','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Processing happy','SOP','10000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-0000000000c2','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Processing not-processing','SOP','10000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-0000000000c3','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Processing not-confirmed','SOP','10000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-0000000000c4','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Processing stale','SOP','10000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-0000000000c5','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Processing not-v1','SOP','10000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-0000000000c6','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Processing empty-set','SOP','10000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-0000000000c7','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Processing empty-text','SOP','10000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-0000000000c8','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Processing bad-dims','SOP','10000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-0000000000c9','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Processing dup-index','SOP','10000000-0000-4000-8000-000000000001');
insert into public.document_versions(
  id,workspace_id,document_id,version_number,storage_path,
  processing_status,upload_state,processing_operation_id,processing_started_at,
  size_bytes,expected_sha256,hash_source,current_upload_attempt_id,
  reference_set_at,reference_set_by,upload_confirmed_at
) values
  ('30000000-0000-4000-8000-0000000000c1','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '20000000-0000-4000-8000-0000000000c1',1,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-0000000000c1/30000000-0000-4000-8000-0000000000c1/original.md',
    'processing','confirmed','60000000-0000-4000-8000-0000000000c1',now(),
    1024,repeat('a',64),'client_declared','50000000-0000-4000-8000-0000000000c1',
    now(),'10000000-0000-4000-8000-000000000001',now()),
  ('30000000-0000-4000-8000-0000000000c2','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '20000000-0000-4000-8000-0000000000c2',1,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-0000000000c2/30000000-0000-4000-8000-0000000000c2/original.md',
    'uploaded','confirmed','60000000-0000-4000-8000-0000000000c2',now(),
    1024,repeat('b',64),'client_declared','50000000-0000-4000-8000-0000000000c2',
    now(),'10000000-0000-4000-8000-000000000001',now()),
  ('30000000-0000-4000-8000-0000000000c3','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '20000000-0000-4000-8000-0000000000c3',1,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-0000000000c3/30000000-0000-4000-8000-0000000000c3/original.md',
    'processing','pending','60000000-0000-4000-8000-0000000000c3',now(),
    1024,repeat('c',64),'client_declared','50000000-0000-4000-8000-0000000000c3',
    now(),'10000000-0000-4000-8000-000000000001',null),
  ('30000000-0000-4000-8000-0000000000c4','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '20000000-0000-4000-8000-0000000000c4',1,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-0000000000c4/30000000-0000-4000-8000-0000000000c4/original.md',
    'processing','confirmed','60000000-0000-4000-8000-0000000000c4',now(),
    1024,repeat('d',64),'client_declared','50000000-0000-4000-8000-0000000000c4',
    now(),'10000000-0000-4000-8000-000000000001',now()),
  ('30000000-0000-4000-8000-0000000000c5','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '20000000-0000-4000-8000-0000000000c5',2,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-0000000000c5/30000000-0000-4000-8000-0000000000c5/original.md',
    'processing','confirmed','60000000-0000-4000-8000-0000000000c5',now(),
    1024,repeat('e',64),'client_declared','50000000-0000-4000-8000-0000000000c5',
    now(),'10000000-0000-4000-8000-000000000001',now()),
  ('30000000-0000-4000-8000-0000000000c6','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '20000000-0000-4000-8000-0000000000c6',1,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-0000000000c6/30000000-0000-4000-8000-0000000000c6/original.md',
    'processing','confirmed','60000000-0000-4000-8000-0000000000c6',now(),
    1024,repeat('1',64),'client_declared','50000000-0000-4000-8000-0000000000c6',
    now(),'10000000-0000-4000-8000-000000000001',now()),
  ('30000000-0000-4000-8000-0000000000c7','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '20000000-0000-4000-8000-0000000000c7',1,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-0000000000c7/30000000-0000-4000-8000-0000000000c7/original.md',
    'processing','confirmed','60000000-0000-4000-8000-0000000000c7',now(),
    1024,repeat('2',64),'client_declared','50000000-0000-4000-8000-0000000000c7',
    now(),'10000000-0000-4000-8000-000000000001',now()),
  ('30000000-0000-4000-8000-0000000000c8','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '20000000-0000-4000-8000-0000000000c8',1,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-0000000000c8/30000000-0000-4000-8000-0000000000c8/original.md',
    'processing','confirmed','60000000-0000-4000-8000-0000000000c8',now(),
    1024,repeat('3',64),'client_declared','50000000-0000-4000-8000-0000000000c8',
    now(),'10000000-0000-4000-8000-000000000001',now()),
  ('30000000-0000-4000-8000-0000000000c9','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '20000000-0000-4000-8000-0000000000c9',1,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-0000000000c9/30000000-0000-4000-8000-0000000000c9/original.md',
    'processing','confirmed','60000000-0000-4000-8000-0000000000c9',now(),
    1024,repeat('4',64),'client_declared','50000000-0000-4000-8000-0000000000c9',
    now(),'10000000-0000-4000-8000-000000000001',now());
-- Attempt rows satisfy the deferred current_upload_attempt FK and the
-- attempt-path guard (attempt path derived from the canonical path).
insert into public.document_upload_attempts(id,workspace_id,version_id,storage_path)
select ('50000000-0000-4000-8000-0000000000c' || s)::uuid,
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  ('30000000-0000-4000-8000-0000000000c' || s)::uuid,
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-0000000000c' || s
    || '/30000000-0000-4000-8000-0000000000c' || s
    || '/attempts/50000000-0000-4000-8000-0000000000c' || s || '/original.md'
from (values ('1'),('2'),('3'),('4'),('5'),('6'),('7'),('8'),('9')) as t(s);

-- SQL fixtures explicitly model live queue claims; no worker runs during these transactional tests.
insert into private.ingestion_jobs(version_id,workspace_id,status,attempt_count,operation_id,started_at,lease_expires_at)
select id,workspace_id,'running',1,processing_operation_id,clock_timestamp(),clock_timestamp()+interval '180 seconds'
from public.document_versions where id::text like '%0000000000c_' and processing_status='processing';
-- Happy path: valid CAS claim persists chunks + ready/active + pointer.
select lives_ok($$select public.finish_processing(
  '30000000-0000-4000-8000-0000000000c1'::uuid,
  '60000000-0000-4000-8000-0000000000c1'::uuid,
  (select jsonb_build_array(
    jsonb_build_object('chunk_index',0,'text_content','Triage procedure','page_number',1,'section_heading','Intro','embedding','[1,' || repeat('0,',382) || '0]'),
    jsonb_build_object('chunk_index',1,'text_content','Recovery steps','page_number',2,'section_heading','Recovery','embedding','[0,1,' || repeat('0,',381) || '0]')
  )))$$, 'finish_processing persists a valid claimed version');
select is((select processing_status::text from public.document_versions
  where id = '30000000-0000-4000-8000-0000000000c1'), 'ready',
  'the finished version is ready');
select is((select version_status::text from public.document_versions
  where id = '30000000-0000-4000-8000-0000000000c1'), 'active',
  'the finished v1 is active');
select ok((select processing_operation_id is null from public.document_versions
  where id = '30000000-0000-4000-8000-0000000000c1'),
  'the claim lease is cleared on success');
select ok((select processing_started_at is null from public.document_versions
  where id = '30000000-0000-4000-8000-0000000000c1'),
  'the claim timestamp is cleared on success');
select is((select count(*) from public.document_chunks
  where version_id = '30000000-0000-4000-8000-0000000000c1'), 2::bigint,
  'both chunks were inserted');
select is((select text_content from public.document_chunks
  where version_id = '30000000-0000-4000-8000-0000000000c1' and chunk_index = 0),
  'Triage procedure', 'chunk text is preserved');
select is((select workspace_id from public.document_chunks
  where version_id = '30000000-0000-4000-8000-0000000000c1' and chunk_index = 0),
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'chunks inherit the version workspace');
select is((select active_version_id from public.documents
  where id = '20000000-0000-4000-8000-0000000000c1'),
  '30000000-0000-4000-8000-0000000000c1'::uuid, 'the document pointer targets the finished v1');

-- Guards: every rejection uses 22023.
select throws_ok($$select public.finish_processing(
  '30000000-0000-4000-8000-ffffffffffff'::uuid,
  '60000000-0000-4000-8000-0000000000c1'::uuid,
  (select jsonb_build_array(jsonb_build_object('chunk_index',0,'text_content','x','page_number',1,'section_heading','h','embedding','[1,' || repeat('0,',382) || '0]'))))$$,
  '22023', null, 'unknown version is rejected');
select throws_ok($$select public.finish_processing(
  '30000000-0000-4000-8000-0000000000c2'::uuid,
  '60000000-0000-4000-8000-0000000000c2'::uuid,
  (select jsonb_build_array(jsonb_build_object('chunk_index',0,'text_content','x','page_number',1,'section_heading','h','embedding','[1,' || repeat('0,',382) || '0]'))))$$,
  '22023', null, 'a version that is not processing is rejected');
select throws_ok($$select public.finish_processing(
  '30000000-0000-4000-8000-0000000000c3'::uuid,
  '60000000-0000-4000-8000-0000000000c3'::uuid,
  (select jsonb_build_array(jsonb_build_object('chunk_index',0,'text_content','x','page_number',1,'section_heading','h','embedding','[1,' || repeat('0,',382) || '0]'))))$$,
  '22023', null, 'a version without confirmed upload is rejected');
select throws_ok($$select public.finish_processing(
  '30000000-0000-4000-8000-0000000000c4'::uuid,
  '60000000-0000-4000-8000-0000000000d4'::uuid,
  (select jsonb_build_array(jsonb_build_object('chunk_index',0,'text_content','x','page_number',1,'section_heading','h','embedding','[1,' || repeat('0,',382) || '0]'))))$$,
  '22023', null, 'a stale operation id is rejected');

-- A correct operation is fenced by an expired renewable lease.
update private.ingestion_jobs
   set lease_expires_at = clock_timestamp() - interval '1 second'
 where version_id = '30000000-0000-4000-8000-0000000000c4';
select throws_ok($$select public.finish_processing(
  '30000000-0000-4000-8000-0000000000c4'::uuid,
  '60000000-0000-4000-8000-0000000000c4'::uuid,
  (select jsonb_build_array(jsonb_build_object('chunk_index',0,'text_content','late result','page_number',1,'section_heading','h','embedding','[1,' || repeat('0,',382) || '0]'))))$$,
  '22023', null, 'a result after lease expiry is rejected');
select is((select count(*) from public.document_chunks
  where version_id = '30000000-0000-4000-8000-0000000000c4'), 0::bigint,
  'a late result inserts no chunks');
select ok((select processing_status = 'processing' and version_status is null
  from public.document_versions where id = '30000000-0000-4000-8000-0000000000c4'),
  'a late result leaves the processing claim and inactive version intact');
update private.ingestion_jobs
   set lease_expires_at = clock_timestamp()+interval '180 seconds'
 where version_id = '30000000-0000-4000-8000-0000000000c4';
select throws_ok($$select public.finish_processing(
  '30000000-0000-4000-8000-0000000000c4'::uuid,
  '60000000-0000-4000-8000-0000000000c4'::uuid,
  (select jsonb_agg(jsonb_build_object(
    'chunk_index',g.chunk_index,'text_content','synthetic chunk','page_number',1,
    'section_heading','limit','embedding','[1,' || repeat('0,',382) || '0]'
  ) order by g.chunk_index) from generate_series(0,500) as g(chunk_index)))$$,
  '22023', null, 'more than 500 chunks are rejected');
select is((select count(*) from public.document_chunks
  where version_id = '30000000-0000-4000-8000-0000000000c4'), 0::bigint,
  'over-limit chunk sets insert nothing');
select throws_ok($$select public.finish_processing(
  '30000000-0000-4000-8000-0000000000c5'::uuid,
  '60000000-0000-4000-8000-0000000000c5'::uuid,
  (select jsonb_build_array(jsonb_build_object('chunk_index',0,'text_content','x','page_number',1,'section_heading','h','embedding','[1,' || repeat('0,',382) || '0]'))))$$,
  '22023', null, 'a non-v1 version never auto-activates');
select lives_ok($$select public.finish_processing(
  '30000000-0000-4000-8000-0000000000c1'::uuid,
  '60000000-0000-4000-8000-0000000000c1'::uuid,
  (select jsonb_build_array(jsonb_build_object('chunk_index',0,'text_content','x','page_number',1,'section_heading','h','embedding','[1,' || repeat('0,',382) || '0]'))))$$,
  'the exact completed operation can be acknowledged again');
select throws_ok($$select public.finish_processing(
  '30000000-0000-4000-8000-0000000000c6'::uuid,
  '60000000-0000-4000-8000-0000000000c6'::uuid,
  '[]'::jsonb)$$,
  '22023', null, 'an empty chunk set is rejected');
select throws_ok($$select public.finish_processing(
  '30000000-0000-4000-8000-0000000000c7'::uuid,
  '60000000-0000-4000-8000-0000000000c7'::uuid,
  (select jsonb_build_array(jsonb_build_object('chunk_index',0,'text_content','   ','page_number',1,'section_heading','h','embedding','[1,' || repeat('0,',382) || '0]'))))$$,
  '22023', null, 'an empty chunk text is rejected');

-- pgvector rejects dims != 384 with its native 22000 (Task 0 measured).
select throws_ok($$select public.finish_processing(
  '30000000-0000-4000-8000-0000000000c8'::uuid,
  '60000000-0000-4000-8000-0000000000c8'::uuid,
  (select jsonb_build_array(jsonb_build_object('chunk_index',0,'text_content','x','page_number',1,'section_heading','h','embedding','[1,2,3]'))))$$,
  '22000', null, 'an embedding with dims != 384 is rejected');

-- Duplicate chunk_index violates unique(version_id, chunk_index) (non-blocking note).
select throws_ok($$select public.finish_processing(
  '30000000-0000-4000-8000-0000000000c9'::uuid,
  '60000000-0000-4000-8000-0000000000c9'::uuid,
  (select jsonb_build_array(
    jsonb_build_object('chunk_index',0,'text_content','first','page_number',1,'section_heading','h','embedding','[1,' || repeat('0,',382) || '0]'),
    jsonb_build_object('chunk_index',0,'text_content','second','page_number',1,'section_heading','h','embedding','[0,1,' || repeat('0,',381) || '0]')
  )))$$,
  '22023', null, 'a duplicate chunk_index is rejected');

-- Cross-tenant chunk insert fails on the composite FK, not on RLS.
select throws_ok($$insert into public.document_chunks(workspace_id,version_id,chunk_index,text_content,embedding) values
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','30000000-0000-4000-8000-0000000000c1',99,'Cross tenant',
  ('[1,' || repeat('0,',382) || '0]')::extensions.vector(384))$$,
  '23503', null, 'chunk tenant must match parent version');

-- Deferred trigger coherence: ready + active without pointer reverts.
set constraints all immediate;
select throws_ok($$update public.documents set active_version_id = null
  where id = '20000000-0000-4000-8000-0000000000c1'$$,
  '23514', null, 'an active version cannot be disconnected from its pointer');
set constraints all deferred;

select * from finish();
rollback;
