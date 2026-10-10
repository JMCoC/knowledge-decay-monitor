begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();
select ok((select count(*) >= 4 from auth.users where email like '%@example.test'), 'Local Auth seed users exist');
select ok((select not exists (
  select 1 from profiles p
  where not exists (select 1 from auth.identities i where i.user_id = p.id and i.provider = 'email')
)), 'All profiles have email identities');
select is((select count(*) from document_chunks c
  join document_versions v on v.id = c.version_id
  where c.id in (
    '40000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000002',
    '40000000-0000-4000-8000-000000000003'
  ) and v.document_id in (
    '20000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000004'
  ) and vector_dims(c.embedding) = 384), 3::bigint, 'All seed mock vectors have 384 dimensions');
select is((select count(*) from documents where active_version_id is null and id in (
  '20000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000003',
  '20000000-0000-4000-8000-000000000004'
)), 2::bigint, 'Incomplete seed v1 documents have no active pointer');
select ok((select bool_and(version_status is null) from document_versions where processing_status <> 'ready'), 'Incomplete processing has no functional status');
select ok((select not public from storage.buckets where id = 'documents'), 'Document bucket is private');
select is((select file_size_limit from storage.buckets where id = 'documents'), 10485760::bigint, 'Bucket enforces 10 MiB');
select is((select count(*) from pg_class where oid in ('workspaces'::regclass,'profiles'::regclass,'documents'::regclass,'document_versions'::regclass,'document_chunks'::regclass) and relrowsecurity), 5::bigint, 'RLS enabled on all business tables');

-- Exercise constraints as a privileged writer: RLS bypass is not an FK bypass.
select throws_ok($$insert into documents(workspace_id,name,category,owner_id) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Wrong owner','Other','10000000-0000-4000-8000-000000000004')$$,
 '23503', null, 'Privileged writer cannot assign foreign tenant owner');
select throws_ok($$insert into document_versions(id,workspace_id,document_id,version_number,storage_path) values
 ('30000000-0000-4000-8000-000000000020','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','20000000-0000-4000-8000-000000000004',2,
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-000000000004/30000000-0000-4000-8000-000000000020/original.md')$$,
 '23503', null, 'Version tenant must match parent document');
select throws_ok($$insert into document_chunks(workspace_id,version_id,chunk_index,text_content,embedding) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','30000000-0000-4000-8000-000000000004',9,'Cross tenant',('[1,' || repeat('0,',382) || '0]')::vector)$$,
 '23503', null, 'Chunk tenant must match parent version');
select throws_ok($$update document_versions set version_status = 'active' where id = '30000000-0000-4000-8000-000000000003'$$,
 '23514', null, 'Failed version cannot be active');
select throws_ok($$update documents set active_version_id = '30000000-0000-4000-8000-000000000004' where id = '20000000-0000-4000-8000-000000000001'$$,
 '23503', null, 'Active pointer cannot reference another document');
set constraints all immediate;
select throws_ok($$update documents set active_version_id = '30000000-0000-4000-8000-000000000003' where id = '20000000-0000-4000-8000-000000000003'$$,
 '23514', null, 'Pointer cannot reference failed v1');
select throws_ok($$update documents set active_version_id = null where id = '20000000-0000-4000-8000-000000000001'$$,
 '23514', null, 'Active status cannot be disconnected from pointer');
set constraints all deferred;
select lives_ok($$update document_versions set processing_status = 'ready', version_status = 'active'
 where id = '30000000-0000-4000-8000-000000000003';
 update documents set active_version_id = '30000000-0000-4000-8000-000000000003'
 where id = '20000000-0000-4000-8000-000000000003';
 set constraints all immediate$$, 'Successful processing and activation may be committed atomically');
select lives_ok($$delete from profiles where id = '10000000-0000-4000-8000-000000000003'$$, 'Removing Owner preserves document');
select ok((select owner_id is null and workspace_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' from documents where id = '20000000-0000-4000-8000-000000000001'), 'Owner becomes Unassigned without losing tenant');
select * from finish();
rollback;
