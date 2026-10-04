begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

-- Metadata only, rolled back. Real blob access is tested separately over HTTP.
insert into storage.objects (bucket_id, name)
select 'documents', storage_path from public.document_versions
on conflict do nothing;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is((select count(*) from workspaces), 1::bigint, 'Admin A sees one workspace');
select is((select count(*) from profiles), 3::bigint, 'Admin A sees only A profiles');
select is((select count(*) from documents), 3::bigint, 'Admin A sees all three A documents');
select is((select count(*) from document_versions), 3::bigint, 'Admin A sees only A versions');
select is((select count(*) from document_chunks), 2::bigint, 'Admin A sees only A chunks');
select is((select count(*) from storage.objects where bucket_id = 'documents'),
  (select count(*) from document_versions where workspace_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    and upload_state = 'confirmed'),
  'Admin sees only fixture originals whose bytes have been confirmed');
select is((select count(*) from documents where id = '20000000-0000-4000-8000-000000000004'), 0::bigint, 'Known B ID does not bypass RLS');
select throws_ok($$insert into documents (workspace_id, name, category, owner_id) values
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Attack', 'Other', '10000000-0000-4000-8000-000000000004')$$,
 '42501', null, 'Cross-tenant document insert denied');
select results_eq($$update documents set name = 'Attack' where id = '20000000-0000-4000-8000-000000000004' returning id$$,
 array[]::uuid[], 'Cross-tenant document update affects no rows');
select throws_ok($$delete from documents where id = '20000000-0000-4000-8000-000000000004'$$,
 '42501', null, 'Direct document deletion not granted');
select throws_ok($$update documents set workspace_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' where id = '20000000-0000-4000-8000-000000000001'$$,
 '42501', null, 'Cannot move own document to B');
select throws_ok($$update documents set owner_id = '10000000-0000-4000-8000-000000000004' where id = '20000000-0000-4000-8000-000000000001'$$,
 '23503', null, 'Cannot set cross-tenant owner');
select throws_ok($$update profiles set role = 'Admin' where id = '10000000-0000-4000-8000-000000000003'$$,
 '42501', null, 'Profile roles are not directly mutable');
select throws_ok($$update document_versions set processing_status = 'ready' where id = '30000000-0000-4000-8000-000000000003'$$,
 '42501', null, 'User cannot forge pipeline success');
select throws_ok($$insert into document_chunks (workspace_id, version_id, chunk_index, text_content, embedding)
 values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','30000000-0000-4000-8000-000000000001',10,'Forged',('[1,' || repeat('0,',382) || '0]')::vector)$$,
 '42501', null, 'Users cannot write chunks');
select throws_ok($$insert into storage.objects(bucket_id,name) values ('documents','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/unregistered.md')$$,
 '42501', null, 'Tenant prefix alone does not authorize upload');

select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select is((select count(*) from documents), 3::bigint, 'QA Lead sees A repository');
select is((select count(*) from profiles), 3::bigint, 'QA Lead can choose tenant owners');
select results_eq($$update workspaces set name = 'Not allowed' returning id$$, array[]::uuid[], 'QA cannot rename workspace');
select throws_ok($$insert into documents (id,name,category,owner_id) values
 ('20000000-0000-4000-8000-000000000010','QA upload','Other','10000000-0000-4000-8000-000000000002')$$,
 '42501', null, 'QA cannot bypass upload reservation with a direct document insert');
select throws_ok($$insert into document_versions (id,document_id,version_number,storage_path) values
 ('30000000-0000-4000-8000-000000000010','20000000-0000-4000-8000-000000000010',1,
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-000000000010/30000000-0000-4000-8000-000000000010/original.md')$$,
 '42501', null, 'QA cannot create a version without the server reservation');
select throws_ok($$insert into storage.objects(bucket_id,name) values ('documents',
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-000000000010/30000000-0000-4000-8000-000000000010/original.md')$$,
 '42501', null, 'QA cannot upload directly to a canonical original');
select throws_ok($$insert into document_versions(document_id,version_number,storage_path) values
 ('20000000-0000-4000-8000-000000000004',2,'invalid')$$, '42501', null, 'Cross-tenant version reservation denied');

select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select is((select count(*) from profiles), 1::bigint, 'Member sees only self');
select is((select count(*) from documents), 0::bigint, 'Member has no global document access, even when Owner');
select is((select count(*) from document_versions), 0::bigint, 'Member cannot read versions');
select is((select count(*) from document_chunks), 0::bigint, 'Member cannot read chunks');
select is((select count(*) from storage.objects where bucket_id = 'documents'), 0::bigint, 'Member cannot read Storage objects');
select throws_ok($$insert into documents(name,category,owner_id) values ('Attack','Other','10000000-0000-4000-8000-000000000003')$$,
 '42501', null, 'Member cannot create logical documents');
select results_eq($$update documents set name = 'Attack' returning id$$, array[]::uuid[], 'Member cannot update any document');
select throws_ok($$update profiles set role = 'Admin' where id = auth.uid()$$, '42501', null, 'Member cannot escalate role');
select throws_ok($$update profiles set workspace_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' where id = auth.uid()$$,
 '42501', null, 'Member cannot move tenant');

select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
select is((select count(*) from documents), 1::bigint, 'B sees only B document');
select is((select count(*) from document_chunks), 1::bigint, 'B sees only B chunk');
select is((select count(*) from profiles), 1::bigint, 'B sees only B profile');
select is((select count(*) from storage.objects where bucket_id = 'documents'),
  (select count(*) from document_versions where workspace_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    and upload_state = 'confirmed'),
  'Workspace B sees only fixture originals whose bytes have been confirmed');
select results_eq($$update documents set name = 'Attack' where id = '20000000-0000-4000-8000-000000000001' returning id$$,
 array[]::uuid[], 'B cannot mutate A');

set local role anon;
select set_config('request.jwt.claims', '{}', true);
select throws_ok($$select * from documents$$, '42501', null, 'Anonymous document access denied');
select throws_ok($$select * from profiles$$, '42501', null, 'Anonymous profile access denied');
reset role;
select * from finish();
rollback;
