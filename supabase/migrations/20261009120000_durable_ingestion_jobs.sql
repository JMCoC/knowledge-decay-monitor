-- A durable, tenant-bound queue for the ingestion module. No document content is queued.
create table private.ingestion_jobs (
  version_id uuid primary key,
  workspace_id uuid not null,
  status text not null default 'queued' check (status in ('queued','running','completed','failed')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 3),
  operation_id uuid,
  available_at timestamptz not null default clock_timestamp(),
  started_at timestamptz,
  lease_expires_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key (workspace_id,version_id) references public.document_versions(workspace_id,id) on delete cascade,
  check ((status = 'running') = (operation_id is not null and started_at is not null and lease_expires_at is not null))
);
alter table private.ingestion_jobs enable row level security;
revoke all on private.ingestion_jobs from public, anon, authenticated, service_role;
create index ingestion_jobs_available on private.ingestion_jobs(available_at,created_at) where status='queued';
create index ingestion_jobs_running on private.ingestion_jobs(lease_expires_at) where status='running';

alter table public.document_versions
  add column processing_queued boolean not null default false,
  add column processing_lease_expires_at timestamptz;
grant select(processing_queued,processing_lease_expires_at) on public.document_versions to authenticated;

create function public.enqueue_ingestion_job(p_workspace_id uuid,p_version_id uuid,p_retry boolean default false)
returns text language plpgsql security definer set search_path='' set lock_timeout='1s' set statement_timeout='2s' as $$
declare v public.document_versions%rowtype; j private.ingestion_jobs%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(19091001);
  select * into v from public.document_versions where id=p_version_id and workspace_id=p_workspace_id for update;
  if not found then return 'not_found'; end if;
  if v.upload_state<>'confirmed' or v.version_number<>1 or v.version_status is not null then return 'conflict'; end if;
  select * into j from private.ingestion_jobs where version_id=v.id for update;
  if found and (j.status='queued' or (j.status='running' and j.lease_expires_at>clock_timestamp())) then
    return case when p_retry then 'conflict' else 'queued' end;
  end if;
  if v.processing_status not in ('uploaded','processing_failed','processing') then return 'conflict'; end if;
  -- Legacy running versions also need an expired claim before manual recovery.
  if j.version_id is null and v.processing_status='processing'
     and (v.processing_started_at is null or v.processing_started_at>clock_timestamp()-interval '180 seconds') then return 'conflict'; end if;
  if not p_retry and v.processing_status<>'uploaded' then return 'conflict'; end if;
  insert into private.ingestion_jobs(version_id,workspace_id)
  values(v.id,v.workspace_id)
  on conflict(version_id) do update set status='queued',attempt_count=0,operation_id=null,
    started_at=null,lease_expires_at=null,available_at=clock_timestamp(),updated_at=clock_timestamp();
  update public.document_versions set processing_status='uploaded',processing_queued=true,
    processing_operation_id=null,processing_started_at=null,processing_lease_expires_at=null where id=v.id;
  return 'queued';
end $$;

create function private.enqueue_confirmed_ingestion() returns trigger language plpgsql security definer set search_path='' as $$
begin
  perform public.enqueue_ingestion_job(new.workspace_id,new.id,false);
  return new;
end $$;
create trigger enqueue_confirmed_ingestion_insert after insert on public.document_versions
for each row when(new.upload_state='confirmed' and new.processing_status='uploaded' and new.version_number=1 and new.version_status is null)
execute function private.enqueue_confirmed_ingestion();
create trigger enqueue_confirmed_ingestion_update after update of upload_state on public.document_versions
for each row when(new.upload_state='confirmed' and old.upload_state is distinct from new.upload_state
  and new.processing_status='uploaded' and new.version_number=1 and new.version_status is null)
execute function private.enqueue_confirmed_ingestion();

create function public.claim_ingestion_job()
returns table(version_id uuid,workspace_id uuid,operation_id uuid,started_at timestamptz)
language plpgsql security definer set search_path='' set lock_timeout='1s' set statement_timeout='2s' as $$
declare j private.ingestion_jobs%rowtype; v public.document_versions%rowtype; op uuid; ts timestamptz;
begin
  -- Capacity is global, not per app instance. All queue RPCs serialize short state changes.
  perform pg_catalog.pg_advisory_xact_lock(19091001);
  if exists(select 1 from private.ingestion_jobs where status='running' and lease_expires_at>clock_timestamp()) then return; end if;
  -- Expired third attempts are terminal, without needing the crashed worker to report failure.
  update public.document_versions d set processing_status='processing_failed',processing_queued=false,
    processing_operation_id=null,processing_started_at=null,processing_lease_expires_at=null
  from private.ingestion_jobs q where q.version_id=d.id and q.status='running'
    and q.lease_expires_at<=clock_timestamp() and q.attempt_count>=3 and d.processing_operation_id=q.operation_id;
  update private.ingestion_jobs set status='failed',operation_id=null,started_at=null,lease_expires_at=null,updated_at=clock_timestamp()
    where status='running' and lease_expires_at<=clock_timestamp() and attempt_count>=3;
  select q.* into j from private.ingestion_jobs q join public.document_versions d on d.id=q.version_id and d.workspace_id=q.workspace_id
  where ((q.status='queued' and q.available_at<=clock_timestamp()) or (q.status='running' and q.lease_expires_at<=clock_timestamp()))
    and q.attempt_count<3 and d.upload_state='confirmed' and d.version_number=1 and d.version_status is null
    and d.processing_status in ('uploaded','processing')
  order by q.available_at,q.created_at,q.version_id for update of q skip locked limit 1;
  if not found then return; end if;
  select * into v from public.document_versions where id=j.version_id for update;
  ts:=clock_timestamp(); op:=gen_random_uuid();
  update private.ingestion_jobs q set status='running',attempt_count=j.attempt_count+1,operation_id=op,
    started_at=ts,lease_expires_at=ts+interval '180 seconds',updated_at=ts where q.version_id=j.version_id;
  update public.document_versions set processing_status='processing',processing_queued=false,
    processing_operation_id=op,processing_started_at=ts,processing_lease_expires_at=ts+interval '180 seconds' where id=v.id;
  return query select j.version_id,j.workspace_id,op,ts;
end $$;

create function public.heartbeat_ingestion_job(p_version_id uuid,p_operation_id uuid)
returns boolean language plpgsql security definer set search_path='' set lock_timeout='1s' set statement_timeout='2s' as $$
declare expires timestamptz;
begin
  perform pg_catalog.pg_advisory_xact_lock(19091001);
  update private.ingestion_jobs set lease_expires_at=least(clock_timestamp()+interval '180 seconds',started_at+interval '15 minutes'),updated_at=clock_timestamp()
  where version_id=p_version_id and operation_id=p_operation_id and status='running'
    and lease_expires_at>clock_timestamp() and started_at+interval '15 minutes'>clock_timestamp()
  returning lease_expires_at into expires;
  if not found then return false; end if;
  update public.document_versions set processing_lease_expires_at=expires
    where id=p_version_id and processing_operation_id=p_operation_id and processing_status='processing';
  if not found then raise exception 'Processing claim mismatch' using errcode='22023'; end if;
  return true;
end $$;

create function public.fail_ingestion_job(p_version_id uuid,p_operation_id uuid,p_retryable boolean)
returns text language plpgsql security definer set search_path='' set lock_timeout='1s' set statement_timeout='2s' as $$
declare j private.ingestion_jobs%rowtype; next_status text;
begin
  perform pg_catalog.pg_advisory_xact_lock(19091001);
  select * into j from private.ingestion_jobs where version_id=p_version_id for update;
  if not found or j.status<>'running' or j.operation_id is distinct from p_operation_id then return 'superseded'; end if;
  if j.lease_expires_at<=clock_timestamp() then return 'superseded'; end if;
  next_status:=case when p_retryable and j.attempt_count<3 then 'queued' else 'failed' end;
  update private.ingestion_jobs set status=next_status,operation_id=null,started_at=null,lease_expires_at=null,
    available_at=clock_timestamp()+case when j.attempt_count=1 then interval '5 seconds' else interval '15 seconds' end,
    updated_at=clock_timestamp() where version_id=j.version_id;
  update public.document_versions set processing_status=case when next_status='queued' then 'uploaded'::public.processing_status else 'processing_failed'::public.processing_status end,
    processing_queued=(next_status='queued'),processing_operation_id=null,processing_started_at=null,processing_lease_expires_at=null
    where id=j.version_id and processing_operation_id=p_operation_id;
  if not found then raise exception 'Processing claim mismatch' using errcode='22023'; end if;
  return next_status;
end $$;

revoke all on function public.enqueue_ingestion_job(uuid,uuid,boolean),public.claim_ingestion_job(),
  public.heartbeat_ingestion_job(uuid,uuid),public.fail_ingestion_job(uuid,uuid,boolean),private.enqueue_confirmed_ingestion()
  from public,anon,authenticated;
grant execute on function public.enqueue_ingestion_job(uuid,uuid,boolean),public.claim_ingestion_job(),
  public.heartbeat_ingestion_job(uuid,uuid),public.fail_ingestion_job(uuid,uuid,boolean) to service_role;

-- Completion stays a single atomic transaction and also acknowledges the durable job.
create or replace function public.finish_processing(p_version_id uuid,p_operation_id uuid,p_chunks jsonb)
returns void language plpgsql security definer set search_path='' set statement_timeout='2s' set lock_timeout='1s' as $$
declare v public.document_versions%rowtype; j private.ingestion_jobs%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(19091001);
  select * into v from public.document_versions where id=p_version_id for update;
  if not found then raise exception 'Version not found' using errcode='22023'; end if;
  select * into j from private.ingestion_jobs where version_id=v.id for update;
  -- A response lost after commit can safely be repeated by the exact completed operation.
  if v.processing_status='ready' and v.version_status='active' and j.status='completed' and j.operation_id=p_operation_id
    and exists(select 1 from public.documents where id=v.document_id and active_version_id=v.id) then return; end if;
  if v.processing_status<>'processing' then raise exception 'Version is not processing' using errcode='22023'; end if;
  if v.upload_state is distinct from 'confirmed' then raise exception 'Upload is not confirmed' using errcode='22023'; end if;
  if v.processing_operation_id is distinct from p_operation_id then raise exception 'Stale processing operation' using errcode='22023'; end if;
  if j.status is distinct from 'running' or j.operation_id is distinct from p_operation_id
    or j.workspace_id<>v.workspace_id or j.lease_expires_at<=clock_timestamp()
    or j.started_at+interval '15 minutes'<=clock_timestamp() then raise exception 'Processing lease expired' using errcode='22023'; end if;
  if v.version_number<>1 then raise exception 'Only v1 auto-activates' using errcode='22023'; end if;
  if v.version_status is not null then raise exception 'Version already decided' using errcode='22023'; end if;
  if p_chunks is null or jsonb_typeof(p_chunks)<>'array' or jsonb_array_length(p_chunks)=0 then raise exception 'Empty chunk set' using errcode='22023'; end if;
  if jsonb_array_length(p_chunks)>500 then raise exception 'Chunk limit exceeded' using errcode='22023'; end if;
  if exists(select 1 from jsonb_to_recordset(p_chunks) c(text_content text) where nullif(btrim(c.text_content),'') is null)
    then raise exception 'Empty chunk text' using errcode='22023'; end if;
  if (select count(distinct c.chunk_index)<>jsonb_array_length(p_chunks) or min(c.chunk_index)<>0 or max(c.chunk_index)<>jsonb_array_length(p_chunks)-1
      from jsonb_to_recordset(p_chunks) c(chunk_index integer)) then raise exception 'Invalid chunk indices' using errcode='22023'; end if;
  insert into public.document_chunks(workspace_id,version_id,chunk_index,text_content,page_number,section_heading,embedding)
  select v.workspace_id,v.id,c.chunk_index,btrim(c.text_content),c.page_number,nullif(btrim(c.section_heading),''),c.embedding::extensions.vector(384)
    from jsonb_to_recordset(p_chunks) c(chunk_index integer,text_content text,page_number integer,section_heading text,embedding text);
  if clock_timestamp()>=j.lease_expires_at or clock_timestamp()>=j.started_at+interval '15 minutes' then raise exception 'Processing lease expired' using errcode='22023'; end if;
  update public.document_versions set processing_status='ready',version_status='active',processing_operation_id=null,
    processing_started_at=null,processing_lease_expires_at=null,processing_queued=false where id=v.id;
  update public.documents set active_version_id=v.id where id=v.document_id and workspace_id=v.workspace_id;
  -- Keep completed operation for idempotent reconciliation, clear live-lease columns.
  update private.ingestion_jobs set status='completed',started_at=null,lease_expires_at=null,updated_at=clock_timestamp() where version_id=v.id;
end $$;
-- Completed jobs keep operation_id; the running invariant needs to allow this acknowledgement token.
alter table private.ingestion_jobs drop constraint ingestion_jobs_check;
alter table private.ingestion_jobs add constraint ingestion_jobs_lease_check check (
  (status='running' and operation_id is not null and started_at is not null and lease_expires_at is not null)
  or (status='completed' and operation_id is not null and started_at is null and lease_expires_at is null)
  or (status in ('queued','failed') and operation_id is null and started_at is null and lease_expires_at is null)
);

create or replace view public.repository_documents with(security_invoker=true) as
select d.id,d.workspace_id,d.name,d.category,d.owner_id,p.id as owner_profile_id,p.full_name as owner_full_name,
  d.active_version_id,d.created_at,latest.id as latest_version_id,latest.version_number as latest_version_number,
  latest.processing_status as latest_processing_status,latest.version_status as latest_version_status,
  latest.analysis_status as latest_analysis_status,latest.upload_state as latest_upload_state,
  latest.processing_started_at as latest_processing_started_at,
  latest.processing_queued as latest_processing_queued,latest.processing_lease_expires_at as latest_processing_lease_expires_at
from public.documents d left join public.profiles p on p.id=d.owner_id and p.workspace_id=d.workspace_id
left join lateral(select v.* from public.document_versions v where v.document_id=d.id and v.workspace_id=d.workspace_id
  order by v.version_number desc,v.id desc limit 1) latest on true;
revoke all on public.repository_documents from public,anon,authenticated;
grant select on public.repository_documents to authenticated;
notify pgrst,'reload schema';
