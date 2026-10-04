begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

insert into public.documents(id,workspace_id,name,category,owner_id)
values
  ('20000000-0000-4000-8000-000000000201','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'Repository latest-version fixture','Policy','10000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000202','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'Repository no-version fixture','SOP','10000000-0000-4000-8000-000000000001');
insert into public.document_versions(
  id,workspace_id,document_id,version_number,storage_path,processing_status,version_status
) values
  ('30000000-0000-4000-8000-000000000201','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '20000000-0000-4000-8000-000000000201',1,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-000000000201/30000000-0000-4000-8000-000000000201/original.md',
    'ready','active'),
  ('30000000-0000-4000-8000-000000000202','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '20000000-0000-4000-8000-000000000201',2,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-000000000201/30000000-0000-4000-8000-000000000202/original.md',
    'uploaded',null);
update public.documents set active_version_id = '30000000-0000-4000-8000-000000000201'
where id = '20000000-0000-4000-8000-000000000201';

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
select is((select latest_version_id from public.repository_documents
  where id = '20000000-0000-4000-8000-000000000201'),
  '30000000-0000-4000-8000-000000000202'::uuid,
  'view selects the latest version before state filtering');
select is((select count(*)::integer from public.repository_documents
  where id = '20000000-0000-4000-8000-000000000201'
    and latest_version_status = 'active'),0,
  'filtering active does not resurrect an older matching version');
select is((select count(*)::integer from public.repository_documents
  where id = '20000000-0000-4000-8000-000000000201'
    and latest_version_status is null),1,
  'explicit NULL matches the latest pending version');
select is((select count(*)::integer from public.repository_documents
  where id = '20000000-0000-4000-8000-000000000202'
    and latest_version_id is null),1,
  'documents with no versions remain in the projection');
select is((select count(*)::integer from public.repository_documents
  where id = '20000000-0000-4000-8000-000000000004'),0,
  'security-invoker projection preserves tenant RLS');
select is((select count(*)::integer from information_schema.columns
  where table_schema = 'public' and table_name = 'repository_documents'
    and column_name in ('storage_path','expected_sha256','upload_operation_id')),
  0,'projection excludes paths, hashes, and operation leases');
select set_config('request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
select is((select count(*)::integer from public.repository_documents),0,
  'Member cannot access the Repository projection');
reset role;
select * from finish();
rollback;
