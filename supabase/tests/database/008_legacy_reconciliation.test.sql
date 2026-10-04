begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

insert into public.documents(id,workspace_id,name,category,owner_id)
values
  ('20000000-0000-4000-8000-000000000101','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'Legacy uploaded without object','SOP','10000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000102','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'Legacy ready without object','Policy','10000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000103','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'Legacy upload with verified object','Manual','10000000-0000-4000-8000-000000000001');
insert into public.document_versions(
  id,workspace_id,document_id,version_number,storage_path,processing_status,version_status,size_bytes
) values
  ('30000000-0000-4000-8000-000000000101','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '20000000-0000-4000-8000-000000000101',1,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-000000000101/30000000-0000-4000-8000-000000000101/original.md',
    'uploaded',null,null),
  ('30000000-0000-4000-8000-000000000102','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '20000000-0000-4000-8000-000000000102',1,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-000000000102/30000000-0000-4000-8000-000000000102/original.md',
    'ready','active',1),
  ('30000000-0000-4000-8000-000000000103','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '20000000-0000-4000-8000-000000000103',1,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-000000000103/30000000-0000-4000-8000-000000000103/original.md',
    'uploaded',null,1);
update public.documents set active_version_id = '30000000-0000-4000-8000-000000000102'
where id = '20000000-0000-4000-8000-000000000102';
insert into public.document_chunks(id,workspace_id,version_id,chunk_index,text_content,embedding)
values ('40000000-0000-4000-8000-000000000102','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '30000000-0000-4000-8000-000000000102',0,'Keep this legacy chunk unchanged.',
  ('[1,' || repeat('0,',382) || '0]')::extensions.vector(384));
update private.upload_control set mode = 'paused' where singleton;

set local role service_role;
select is((select outcome from public.reconcile_legacy_upload(
  '10000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000101','missing',null,null)),
  'missing_unprocessed','missing unprocessed legacy uploads remain unbound and recoverable');
select is((select upload_state::text from public.document_versions
  where id = '30000000-0000-4000-8000-000000000101'), null,
  'missing legacy objects do not receive an invented hash or attempt');
select is((select outcome from public.reconcile_legacy_upload(
  '10000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000102','missing',null,null)),
  'missing_processed','missing processed originals are reported as incidents');
select is((select d.active_version_id from public.documents d
  where d.id = '20000000-0000-4000-8000-000000000102'),
  '30000000-0000-4000-8000-000000000102'::uuid,
  'missing processed reconciliation preserves the active pointer');
select is((select count(*)::integer from public.document_chunks
  where version_id = '30000000-0000-4000-8000-000000000102'),1,
  'missing processed reconciliation preserves chunks');
select is((select outcome from public.reconcile_legacy_upload(
  '10000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000103','valid',1,repeat('a',64))),
  'confirmed','valid legacy originals can be confirmed without starting processing');
select is((select hash_source::text from public.document_versions
  where id = '30000000-0000-4000-8000-000000000103'),
  'legacy_reconciled','reconciled originals record their distinct hash provenance');
select is((select processing_status::text || ':' || coalesce(version_status::text,'NULL')
  from public.document_versions where id = '30000000-0000-4000-8000-000000000103'),
  'uploaded:NULL','legacy confirmation preserves the unprocessed state');
select is((select count(*)::integer from public.document_upload_attempts
  where version_id = '30000000-0000-4000-8000-000000000103'
    and retired_at is not null and cleanup_status = 'absent'),1,
  'confirmed legacy rows have one retired non-transfer attempt');
select is((select outcome from public.reconcile_legacy_upload(
  '10000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000103','valid',1,repeat('a',64))),
  'confirmed','reapplying valid legacy reconciliation is idempotent');
select throws_ok($$select * from public.reconcile_legacy_upload(
  '10000000-0000-4000-8000-000000000003',
  '30000000-0000-4000-8000-000000000101','missing',null,null)$$,
  '42501',null,'Member cannot reconcile documents');
reset role;
update private.upload_control set mode = 'active' where singleton;
set local role service_role;
select throws_ok($$select * from public.reconcile_legacy_upload(
  '10000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000101','missing',null,null)$$,
  '55000',null,'reconciliation is blocked while uploads are active');
reset role;
select * from finish();
rollback;
