begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();
select has_table('private', 'ingestion_jobs', 'durable jobs are private');
select ok(not has_function_privilege('authenticated', 'public.claim_ingestion_job()', 'EXECUTE'), 'browser cannot claim');
select ok(not has_function_privilege('anon', 'public.enqueue_ingestion_job(uuid,uuid,boolean)', 'EXECUTE'), 'anonymous cannot enqueue');
select ok(not has_table_privilege('authenticated', 'private.ingestion_jobs', 'SELECT'), 'browser cannot read jobs');
select ok(not has_function_privilege('service_role', 'private.guard_durable_processing_claim()', 'EXECUTE'), 'service role cannot call the trigger helper');

insert into public.documents(id,workspace_id,name,category) values
 ('20000000-0000-4000-8000-0000000000e1','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Durable one','SOP'),
 ('20000000-0000-4000-8000-0000000000e2','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Durable two','SOP');
insert into public.document_versions(id,workspace_id,document_id,version_number,storage_path,processing_status,upload_state,
 size_bytes,expected_sha256,hash_source,current_upload_attempt_id,reference_set_at,reference_set_by,upload_confirmed_at) values
 ('30000000-0000-4000-8000-0000000000e1','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','20000000-0000-4000-8000-0000000000e1',1,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-0000000000e1/30000000-0000-4000-8000-0000000000e1/original.md','uploaded','confirmed',1024,repeat('a',64),'client_declared','50000000-0000-4000-8000-0000000000e1',now(),'10000000-0000-4000-8000-000000000001',now()),
 ('30000000-0000-4000-8000-0000000000e2','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','20000000-0000-4000-8000-0000000000e2',1,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-0000000000e2/30000000-0000-4000-8000-0000000000e2/original.md','uploaded','confirmed',1024,repeat('a',64),'client_declared','50000000-0000-4000-8000-0000000000e2',now(),'10000000-0000-4000-8000-000000000001',now());
insert into public.document_upload_attempts(id,workspace_id,version_id,storage_path)
select ('50000000-0000-4000-8000-0000000000e'||s)::uuid,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 ('30000000-0000-4000-8000-0000000000e'||s)::uuid,
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-0000000000e'||s||'/30000000-0000-4000-8000-0000000000e'||s||'/attempts/50000000-0000-4000-8000-0000000000e'||s||'/original.md'
from(values('1'),('2')) t(s);
select is((select count(*)::integer from private.ingestion_jobs where version_id::text like '%0000000000e_'),2,'confirmation enqueues transactionally');
-- Ignore other fixtures for this transaction only.
update private.ingestion_jobs set available_at=clock_timestamp()+interval '1 day' where version_id::text not like '%0000000000e_';
select is(public.enqueue_ingestion_job('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','30000000-0000-4000-8000-0000000000e1',true),'not_found','cross tenant hidden');
select is(public.enqueue_ingestion_job('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','30000000-0000-4000-8000-0000000000e1',true),'conflict','manual retry cannot duplicate pending job');
set local role service_role;
select throws_ok($$update public.document_versions set processing_status='processing',processing_queued=false,
  processing_operation_id='60000000-0000-4000-8000-0000000000e1',processing_started_at=clock_timestamp()
  where id='30000000-0000-4000-8000-0000000000e1'$$,
  '22023','Durable processing claim requires a live worker job','legacy CAS cannot bypass the durable queue');
reset role;
select is((select processing_status::text from public.document_versions where id='30000000-0000-4000-8000-0000000000e1'),'uploaded','blocked legacy CAS leaves version uploaded');
select ok((select processing_queued from public.document_versions where id='30000000-0000-4000-8000-0000000000e1'),'blocked legacy CAS leaves queued projection intact');
select is((select status from private.ingestion_jobs where version_id='30000000-0000-4000-8000-0000000000e1'),'queued','blocked legacy CAS leaves the job queued');
create temporary table claimed as select * from public.claim_ingestion_job();
update private.ingestion_jobs set available_at=clock_timestamp()+interval '1 day' where version_id not in(select version_id from claimed);
select is((select count(*)::integer from claimed),1,'one claim');
set local role service_role;
select throws_ok(format($$update public.document_versions set processing_operation_id=%L::uuid,processing_started_at=clock_timestamp() where id=%L::uuid$$,
  '60000000-0000-4000-8000-0000000000ff','30000000-0000-4000-8000-0000000000e1'),
  '22023','Durable processing claim requires a live worker job','legacy update cannot replace the active operation');
reset role;
select is((select d.processing_operation_id from public.document_versions d join claimed c on c.version_id=d.id),
  (select operation_id from claimed),'blocked operation replacement preserves the durable claim');
select is((select count(*)::integer from public.claim_ingestion_job()),0,'global capacity applies across callers');
select ok(public.heartbeat_ingestion_job((select version_id from claimed),(select operation_id from claimed)),'live heartbeat renews');
select ok(not public.heartbeat_ingestion_job((select version_id from claimed),gen_random_uuid()),'old operation cannot renew');
update private.ingestion_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where version_id=(select version_id from claimed);
update public.document_versions set processing_lease_expires_at=clock_timestamp()-interval '1 second' where id=(select version_id from claimed);
select throws_ok(format('select public.finish_processing(%L::uuid,%L::uuid,%L::jsonb)',(select version_id from claimed),(select operation_id from claimed),'[]'),'22023','Processing lease expired','expired completion fenced');
create temporary table reclaimed as select * from public.claim_ingestion_job();
select isnt((select operation_id from reclaimed),(select operation_id from claimed),'crash redelivery creates a fresh operation');
select is((select attempt_count from private.ingestion_jobs where version_id=(select version_id from reclaimed)),2,'crash consumes bounded attempt');
select ok(not public.heartbeat_ingestion_job((select version_id from claimed),(select operation_id from claimed)),'old worker fenced after reclaim');
select is(public.fail_ingestion_job((select version_id from reclaimed),(select operation_id from reclaimed),true),'queued','transient failure requeues');
update private.ingestion_jobs set available_at=clock_timestamp()-interval '1 second', attempt_count=2 where version_id=(select version_id from reclaimed);
create temporary table last_claim as select * from public.claim_ingestion_job();
select is(public.fail_ingestion_job((select version_id from last_claim),(select operation_id from last_claim),true),'failed','third attempt ends automatically');
select is((select processing_status::text from public.document_versions where id=(select version_id from last_claim)),'processing_failed','exhaustion visible in Repository');
select is(public.enqueue_ingestion_job('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',(select version_id from last_claim),true),'queued','explicit retry starts new cycle');
select is((select attempt_count from private.ingestion_jobs where version_id=(select version_id from last_claim)),0,'manual retry resets bounded cycle');
select * from finish();
rollback;
