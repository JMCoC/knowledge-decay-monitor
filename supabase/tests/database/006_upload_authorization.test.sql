begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();
update private.upload_control set mode = 'paused', updated_at = now() where singleton;

-- Seed private rows only for the duration of this rollback-only policy test.
insert into public.document_upload_attempts(id, workspace_id, version_id, storage_path)
values (
  '50000000-0000-4000-8000-000000000001',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '30000000-0000-4000-8000-000000000001',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-000000000001/30000000-0000-4000-8000-000000000001/attempts/50000000-0000-4000-8000-000000000001/original.md'
);
insert into storage.objects(bucket_id, name) values
  ('documents','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-000000000001/30000000-0000-4000-8000-000000000001/attempts/50000000-0000-4000-8000-000000000001/original.md');

select has_type('public', 'upload_state', 'upload lifecycle has a dedicated enum');
select has_table('public', 'document_upload_attempts', 'each immutable transfer attempt is persisted');
select ok((select relrowsecurity from pg_class where oid = 'public.document_upload_attempts'::regclass),
  'attempt metadata has row-level security enabled');
select has_function('public', 'reserve_document_upload',
  array['uuid','uuid','text','text','document_category','uuid','text','bigint','text'],
  'reservation takes verified identity and typed upload metadata');
select has_function('public', 'get_document_upload_state', array['uuid','uuid'],
  'resume state is scoped by persisted actor and version');
select has_function('public', 'claim_upload_verification', array['uuid','uuid','uuid'],
  'verification claim is version and attempt scoped');
select has_function('public', 'finish_upload_verification', array['uuid','uuid','uuid','uuid','upload_state'],
  'verification finish uses a compare-and-set operation id');
select has_function('public', 'claim_upload_recovery', array['uuid','uuid'],
  'recovery claim is actor and version scoped');
select has_function('public', 'finish_upload_recovery', array['uuid','uuid','uuid','uuid','boolean'],
  'recovery finish creates a fresh attempt only after absence is verified');
select has_function('public', 'bind_legacy_upload_reference', array['uuid','uuid','bigint','text'],
  'legacy references can be fixed once by an authorized actor');
select ok((select count(*) = 1 from private.upload_control where singleton and mode = 'paused'),
  'new upload flow remains paused until an explicit cutover');

select ok(not has_function_privilege('authenticated',
  'public.reserve_document_upload(uuid,uuid,text,text,public.document_category,uuid,text,bigint,text)', 'EXECUTE'),
  'authenticated callers cannot invoke privileged reservation');
select ok(not has_function_privilege('anon',
  'public.finish_upload_verification(uuid,uuid,uuid,uuid,public.upload_state)', 'EXECUTE'),
  'anonymous callers cannot invoke privileged verification');
select ok(has_function_privilege('service_role',
  'public.reserve_document_upload(uuid,uuid,text,text,public.document_category,uuid,text,bigint,text)', 'EXECUTE'),
  'the server role can invoke the reservation RPC');
select ok(not has_table_privilege('authenticated', 'public.documents', 'INSERT'),
  'authenticated callers cannot bypass reservation with direct document inserts');
select ok(not has_table_privilege('authenticated', 'public.document_versions', 'INSERT'),
  'authenticated callers cannot bypass reservation with direct version inserts');
select ok(has_column_privilege('authenticated', 'public.document_versions', 'upload_state', 'SELECT'),
  'authenticated callers can read only the upload state projection');
select ok(not has_column_privilege('authenticated', 'public.document_versions', 'expected_sha256', 'SELECT'),
  'expected byte hashes are not exposed through the Data API');
select ok(not has_column_privilege('authenticated', 'public.document_versions', 'storage_path', 'SELECT'),
  'canonical and temporary paths are not exposed through the Data API');
select ok(has_column_privilege('authenticated', 'public.document_upload_attempts', 'version_id', 'SELECT'),
  'attempt metadata is readable for authorized workspace projections');
select ok(not has_column_privilege('authenticated', 'public.document_upload_attempts', 'storage_path', 'SELECT'),
  'temporary paths are not exposed through attempt metadata');
select is((select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects'
  and policyname in ('document_original_read', 'document_upload_attempt_returning')), 2::bigint,
  'Storage has separate confirmed-read and upload-returning policies');
select is((select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects'
  and policyname = 'document_upload_attempt_insert' and cmd = 'INSERT'), 1::bigint,
  'Storage INSERT is constrained to registered attempts');
select ok(not has_function_privilege('anon', 'private.current_upload_attempt_allowed(text)', 'EXECUTE'),
  'anonymous callers cannot probe upload-attempt authorization');

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is((select count(*) from public.document_upload_attempts
  where id = '50000000-0000-4000-8000-000000000001'), 1::bigint,
  'Admin A can read attempt metadata in Workspace A');
select is((select count(*) from storage.objects where bucket_id = 'documents'
  and name like '%/attempts/50000000-0000-4000-8000-000000000001/original.md'), 0::bigint,
  'Admin A cannot list or download a temporary object');
select throws_ok($$select storage_path from public.document_upload_attempts
  where id = '50000000-0000-4000-8000-000000000001'$$,
  '42501', null, 'Admin A cannot read a temporary path through the Data API');
select set_config('request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select is((select count(*) from public.document_upload_attempts
  where id = '50000000-0000-4000-8000-000000000001'), 0::bigint,
  'Member cannot read attempt metadata even when Owner');
select set_config('request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
select is((select count(*) from public.document_upload_attempts
  where id = '50000000-0000-4000-8000-000000000001'), 0::bigint,
  'Admin B cannot read Workspace A attempts');
reset role;

select * from finish();
rollback;
