-- S3-05 extends the durable ingestion pipeline to the final correction candidate.
-- Initial v1 keeps its exact auto-activation behavior; a live candidate is the
-- only correction version allowed into the queue and never changes the active
-- document pointer. Candidate, version and round states commit atomically so
-- the S3-01/S3-02 deferred integrity checks stay coherent.

-- T1.0 The only additive integrity change: an explicit retry may revive a failed
-- candidate for selection. Every pre-existing transition is preserved verbatim.
-- The active definition is the S3-02 replacement (coverage_revision based).
create or replace function private.guard_correction_candidate() returns trigger
language plpgsql security definer
set search_path = '' set row_security = off
as $$
declare
  parent_round public.correction_rounds%rowtype;
  file_version public.document_versions%rowtype;
  allowed_transition boolean;
begin
  if tg_op = 'DELETE' then
    raise exception 'Correction candidate history is append-only' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then
    select r.* into parent_round from public.correction_rounds r
    where r.id = new.round_id and r.document_id = new.document_id and r.workspace_id = new.workspace_id;
    if not found or parent_round.status <> 'consolidating'
       or parent_round.base_version_id is distinct from new.base_version_id then
      raise exception 'Final candidate requires a consolidating round and its fixed base' using errcode = '23514';
    end if;
    if not private.review_profile_has_role(new.selected_by, new.workspace_id, array['Admin', 'QA Lead']) then
      raise exception 'Only a workspace reviewer can select a final candidate' using errcode = '23514';
    end if;
    if parent_round.mode = 'administrative' and new.selection_kind <> 'consolidated' then
      raise exception 'Administrative correction proposals require a consolidated upload' using errcode = '23514';
    end if;
    select v.* into file_version from public.document_versions v
    where v.id = new.version_id and v.document_id = new.document_id and v.workspace_id = new.workspace_id;
    if not found then raise exception 'Candidate version was not found' using errcode = '23503'; end if;
    if new.selection_kind = 'direct' then
      if new.source_submission_id is null or new.status <> 'selected'
         or file_version.workflow_kind <> 'correction_submission'
         or not exists (
           select 1 from public.correction_submissions s
           where s.id = new.source_submission_id and s.round_id = new.round_id
             and s.document_id = new.document_id and s.workspace_id = new.workspace_id
             and s.version_id = new.version_id and s.state = 'confirmed'
         ) then
        raise exception 'Direct candidate must reuse one confirmed submission version' using errcode = '23514';
      end if;
    elsif file_version.workflow_kind <> 'correction_candidate'
       or new.source_submission_id is not null or new.status not in ('reserved', 'selected') then
      raise exception 'Consolidated candidate must reference its separately reserved candidate upload' using errcode = '23514';
    end if;
    if new.status = 'selected'
       and (file_version.upload_state <> 'confirmed' or file_version.upload_confirmed_at is null) then
      raise exception 'A final candidate can only be selected after upload confirmation' using errcode = '23514';
    end if;
    if new.status = 'selected' and new.coverage_revision is distinct from parent_round.coverage_revision then
      raise exception 'Candidate coverage revision must match the round at selection' using errcode = '23514';
    end if;
    return new;
  end if;

  if new.id is distinct from old.id or new.workspace_id is distinct from old.workspace_id
     or new.round_id is distinct from old.round_id or new.document_id is distinct from old.document_id
     or new.base_version_id is distinct from old.base_version_id or new.version_id is distinct from old.version_id
     or new.source_submission_id is distinct from old.source_submission_id
     or new.selected_by is distinct from old.selected_by or new.selection_kind is distinct from old.selection_kind
     or new.coverage_revision is distinct from old.coverage_revision
     or new.idempotency_key is distinct from old.idempotency_key
     or new.created_at is distinct from old.created_at then
    raise exception 'Correction candidate identity and source are immutable' using errcode = '23514';
  end if;
  if new.revision < old.revision then
    raise exception 'Correction candidate revision cannot decrease' using errcode = '23514';
  end if;
  if new.status is distinct from old.status then
    if new.revision <> old.revision + 1 then
      raise exception 'A correction candidate transition must advance its revision' using errcode = '23514';
    end if;
    allowed_transition :=
      (old.status = 'reserved' and new.status in ('selected', 'invalidated'))
      or (old.status = 'selected' and new.status in ('processing', 'failed', 'invalidated'))
      or (old.status = 'processing' and new.status in ('pending_approval', 'failed', 'invalidated'))
      or (old.status = 'failed' and new.status in ('selected', 'processing', 'invalidated'))
      or (old.status = 'pending_approval' and new.status in ('approved', 'rejected', 'invalidated'));
    if not allowed_transition then
      raise exception 'Invalid correction candidate transition' using errcode = '23514';
    end if;
  end if;
  if new.status = 'selected' then
    select r.* into parent_round from public.correction_rounds r
    where r.id = new.round_id and r.document_id = new.document_id and r.workspace_id = new.workspace_id;
    select v.* into file_version from public.document_versions v
    where v.id = new.version_id and v.document_id = new.document_id and v.workspace_id = new.workspace_id;
    if file_version.upload_state <> 'confirmed' or file_version.upload_confirmed_at is null then
      raise exception 'A final candidate can only be selected after upload confirmation' using errcode = '23514';
    end if;
    if new.coverage_revision is distinct from parent_round.coverage_revision then
      raise exception 'Candidate coverage revision must match the round at selection' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

-- T1.1 Queue a correction candidate only while its round is the live owner.
-- Initial v1 keeps the original branch. For a candidate:
--   selected  -> only the queued projection changes (version is already uploaded)
--   failed    -> explicit retry revives candidate and round, then resets the
--                version to uploaded so claim can start a fresh operation.
-- A retryable worker failure never calls this RPC and never resets the version.
create or replace function public.enqueue_ingestion_job(p_workspace_id uuid,p_version_id uuid,p_retry boolean default false)
returns text language plpgsql security definer set search_path='' set lock_timeout='1s' set statement_timeout='2s' as $$
declare
  v public.document_versions%rowtype;
  j private.ingestion_jobs%rowtype;
  c public.correction_candidates%rowtype;
  r public.correction_rounds%rowtype;
  v_candidate boolean := false;
begin
  perform pg_catalog.pg_advisory_xact_lock(19091001);
  select * into v from public.document_versions where id=p_version_id and workspace_id=p_workspace_id for update;
  if not found then return 'not_found'; end if;

  if v.workflow_kind = 'initial' then
    if v.upload_state<>'confirmed' or v.version_number<>1 or v.version_status is not null then return 'conflict'; end if;
  else
    -- A correction submission without a selected candidate is only intermediate input.
    select * into c from public.correction_candidates
    where version_id=v.id and workspace_id=p_workspace_id for update;
    if not found then return 'conflict'; end if;
    select * into r from public.correction_rounds
    where id=c.round_id and workspace_id=p_workspace_id for update;
    if not found or r.active_candidate_id is distinct from c.id then return 'conflict'; end if;
    if v.upload_state<>'confirmed' or v.version_status is not null then return 'conflict'; end if;
    if c.status='selected' then
      if r.status<>'candidate_processing' or v.processing_status<>'uploaded' then return 'conflict'; end if;
    elsif c.status='failed' then
      if not p_retry or r.status<>'candidate_failed' or v.processing_status<>'processing_failed' then return 'conflict'; end if;
    else
      return 'conflict';
    end if;
    v_candidate := true;
  end if;

  select * into j from private.ingestion_jobs where version_id=v.id for update;
  if found and (j.status='queued' or (j.status='running' and j.lease_expires_at>clock_timestamp())) then
    return case when p_retry then 'conflict' else 'queued' end;
  end if;

  if v_candidate then
    if c.status='failed' then
      if not p_retry then return 'conflict'; end if;
      update public.correction_candidates
      set status='selected', revision=c.revision+1, updated_at=clock_timestamp()
      where id=c.id and status='failed';
      if not found then raise exception 'Processing claim mismatch' using errcode='22023'; end if;
      update public.correction_rounds
      set status='candidate_processing', active_candidate_id=c.id, revision=revision+1, updated_at=clock_timestamp()
      where id=r.id and status='candidate_failed' and active_candidate_id=c.id;
      if not found then raise exception 'Processing claim mismatch' using errcode='22023'; end if;
      update public.document_versions set processing_status='uploaded',processing_queued=true,
        processing_operation_id=null,processing_started_at=null,processing_lease_expires_at=null where id=v.id;
    else
      -- Selection may not have queued yet; keep the uploaded version untouched.
      update public.document_versions set processing_queued=true where id=v.id;
    end if;
  else
    if v.processing_status not in ('uploaded','processing_failed','processing') then return 'conflict'; end if;
    -- Legacy running versions also need an expired claim before manual recovery.
    if j.version_id is null and v.processing_status='processing'
       and (v.processing_started_at is null or v.processing_started_at>clock_timestamp()-interval '180 seconds') then return 'conflict'; end if;
    if not p_retry and v.processing_status<>'uploaded' then return 'conflict'; end if;
  end if;

  insert into private.ingestion_jobs(version_id,workspace_id)
  values(v.id,v.workspace_id)
  on conflict(version_id) do update set status='queued',attempt_count=0,operation_id=null,
    started_at=null,lease_expires_at=null,available_at=clock_timestamp(),updated_at=clock_timestamp();
  if not v_candidate then
    update public.document_versions set processing_status='uploaded',processing_queued=true,
      processing_operation_id=null,processing_started_at=null,processing_lease_expires_at=null where id=v.id;
  end if;
  return 'queued';
end $$;

-- T1.2 Claim initial v1 or a live candidate, and recover stale candidate jobs.
create or replace function public.claim_ingestion_job()
returns table(version_id uuid,workspace_id uuid,operation_id uuid,started_at timestamptz)
language plpgsql security definer set search_path='' set lock_timeout='1s' set statement_timeout='2s' as $$
declare j private.ingestion_jobs%rowtype; v public.document_versions%rowtype; op uuid; ts timestamptz;
begin
  -- Capacity is global, not per app instance. All queue RPCs serialize short state changes.
  perform pg_catalog.pg_advisory_xact_lock(19091001);
  if exists(select 1 from private.ingestion_jobs where status='running' and lease_expires_at>clock_timestamp()) then return; end if;
  -- Expired third attempts are terminal, without needing the crashed worker to report failure.
  with terminal as (
    select d.id as version_id, d.workspace_id, c.id as candidate_id
    from private.ingestion_jobs q
    join public.document_versions d on d.id=q.version_id and d.workspace_id=q.workspace_id
    join public.correction_candidates c on c.version_id=d.id and c.workspace_id=d.workspace_id
    where q.status='running' and q.lease_expires_at<=clock_timestamp() and q.attempt_count>=3
      and d.processing_operation_id=q.operation_id and c.status in ('selected','processing')
  )
  update public.correction_candidates c
  set status='failed', revision=c.revision+1, updated_at=clock_timestamp()
  from terminal t where c.id=t.candidate_id;
  with terminal as (
    select d.id as version_id, d.workspace_id, c.id as candidate_id, c.round_id
    from private.ingestion_jobs q
    join public.document_versions d on d.id=q.version_id and d.workspace_id=q.workspace_id
    join public.correction_candidates c on c.version_id=d.id and c.workspace_id=d.workspace_id
    join public.correction_rounds r on r.id=c.round_id and r.workspace_id=c.workspace_id
    where q.status='running' and q.lease_expires_at<=clock_timestamp() and q.attempt_count>=3
      and d.processing_operation_id=q.operation_id and r.status='candidate_processing'
  )
  update public.correction_rounds r
  set status='candidate_failed', revision=r.revision+1, updated_at=clock_timestamp()
  from terminal t where r.id=t.round_id and r.active_candidate_id=t.candidate_id;
  update public.document_versions d set processing_status='processing_failed',processing_queued=false,
    processing_operation_id=null,processing_started_at=null,processing_lease_expires_at=null
  from private.ingestion_jobs q where q.version_id=d.id and q.status='running'
    and q.lease_expires_at<=clock_timestamp() and q.attempt_count>=3 and d.processing_operation_id=q.operation_id;
  update private.ingestion_jobs set status='failed',operation_id=null,started_at=null,lease_expires_at=null,updated_at=clock_timestamp()
    where status='running' and lease_expires_at<=clock_timestamp() and attempt_count>=3;
  select q.* into j from private.ingestion_jobs q join public.document_versions d on d.id=q.version_id and d.workspace_id=q.workspace_id
  where ((q.status='queued' and q.available_at<=clock_timestamp()) or (q.status='running' and q.lease_expires_at<=clock_timestamp()))
    and q.attempt_count<3 and d.upload_state='confirmed' and d.version_status is null
    and d.processing_status in ('uploaded','processing')
    and (
      (d.workflow_kind='initial' and d.version_number=1)
      or exists (
        select 1 from public.correction_candidates c
        join public.correction_rounds r on r.id=c.round_id and r.workspace_id=c.workspace_id
        where c.version_id=d.id and c.workspace_id=d.workspace_id
          and c.status in ('selected','processing')
          and r.status='candidate_processing' and r.active_candidate_id=c.id
      )
    )
  order by q.available_at,q.created_at,q.version_id for update of q skip locked limit 1;
  if not found then return; end if;
  select * into v from public.document_versions where id=j.version_id for update;
  ts:=clock_timestamp(); op:=gen_random_uuid();
  update public.correction_candidates c
  set status='processing', revision=c.revision+1, updated_at=clock_timestamp()
  from public.correction_rounds r
  where c.version_id=j.version_id and c.workspace_id=j.workspace_id and c.status='selected'
    and r.id=c.round_id and r.workspace_id=c.workspace_id
    and r.status='candidate_processing' and r.active_candidate_id=c.id;
  update private.ingestion_jobs q set status='running',attempt_count=j.attempt_count+1,operation_id=op,
    started_at=ts,lease_expires_at=ts+interval '180 seconds',updated_at=ts where q.version_id=j.version_id;
  update public.document_versions set processing_status='processing',processing_queued=false,
    processing_operation_id=op,processing_started_at=ts,processing_lease_expires_at=ts+interval '180 seconds' where id=v.id;
  return query select j.version_id,j.workspace_id,op,ts;
end $$;

-- T1.3 Fail initial v1 as before; correction candidates atomically follow.
-- Retryable correction failure keeps the version in processing with the old
-- operation so the next claim can replace the lease; only the job is queued.
create or replace function public.fail_ingestion_job(p_version_id uuid,p_operation_id uuid,p_retryable boolean)
returns text language plpgsql security definer set search_path='' set lock_timeout='1s' set statement_timeout='2s' as $$
declare
  j private.ingestion_jobs%rowtype;
  v public.document_versions%rowtype;
  c public.correction_candidates%rowtype;
  next_status text;
  v_candidate boolean := false;
begin
  perform pg_catalog.pg_advisory_xact_lock(19091001);
  select * into j from private.ingestion_jobs where version_id=p_version_id for update;
  if not found or j.status<>'running' or j.operation_id is distinct from p_operation_id then return 'superseded'; end if;
  if j.lease_expires_at<=clock_timestamp() then return 'superseded'; end if;
  select * into v from public.document_versions where id=j.version_id and workspace_id=j.workspace_id for update;
  if not found then raise exception 'Version not found' using errcode='22023'; end if;
  select * into c from public.correction_candidates where version_id=v.id and workspace_id=v.workspace_id for update;
  v_candidate := found;
  if v.workflow_kind<>'initial' and not v_candidate then return 'superseded'; end if;
  if v_candidate and c.status not in ('selected','processing') then return 'superseded'; end if;
  next_status:=case when p_retryable and j.attempt_count<3 then 'queued' else 'failed' end;
  update private.ingestion_jobs set status=next_status,operation_id=null,started_at=null,lease_expires_at=null,
    available_at=clock_timestamp()+case when j.attempt_count=1 then interval '5 seconds' else interval '15 seconds' end,
    updated_at=clock_timestamp() where version_id=j.version_id;

  if v_candidate and next_status='queued' then
    -- assert_review_candidate keeps a processing candidate on a processing version.
    -- The next claim replaces the stale operation and lease; a retry from
    -- candidate_failed must call enqueue explicitly instead.
    if not exists(select 1 from public.document_versions d
      where d.id=v.id and d.processing_status='processing'
        and d.version_status is null and d.processing_operation_id=p_operation_id) then
      raise exception 'Processing claim mismatch' using errcode='22023';
    end if;
  elsif v_candidate then
    update public.correction_candidates set status='failed', revision=c.revision+1, updated_at=clock_timestamp()
    where id=c.id and status in ('selected','processing');
    if not found then raise exception 'Processing claim mismatch' using errcode='22023'; end if;
    update public.correction_rounds set status='candidate_failed', revision=revision+1, updated_at=clock_timestamp()
    where id=c.round_id and status='candidate_processing' and active_candidate_id=c.id;
    if not found then raise exception 'Processing claim mismatch' using errcode='22023'; end if;
    update public.document_versions set processing_status='processing_failed',version_status=null,
      processing_queued=false,processing_operation_id=null,processing_started_at=null,processing_lease_expires_at=null
    where id=v.id and processing_operation_id=p_operation_id;
    if not found then raise exception 'Processing claim mismatch' using errcode='22023'; end if;
  else
    update public.document_versions set processing_status=case when next_status='queued' then 'uploaded'::public.processing_status else 'processing_failed'::public.processing_status end,
      processing_queued=(next_status='queued'),processing_operation_id=null,processing_started_at=null,processing_lease_expires_at=null
    where id=j.version_id and processing_operation_id=p_operation_id;
    if not found then raise exception 'Processing claim mismatch' using errcode='22023'; end if;
  end if;
  return next_status;
end $$;

-- T1.4 Completion keeps v1 activation and sends a candidate to approval only.
create or replace function public.finish_processing(p_version_id uuid,p_operation_id uuid,p_chunks jsonb)
returns void language plpgsql security definer set search_path='' set statement_timeout='2s' set lock_timeout='1s' as $$
declare
  v public.document_versions%rowtype;
  j private.ingestion_jobs%rowtype;
  candidate public.correction_candidates%rowtype;
  v_candidate boolean := false;
begin
  perform pg_catalog.pg_advisory_xact_lock(19091001);
  select * into v from public.document_versions where id=p_version_id for update;
  if not found then raise exception 'Version not found' using errcode='22023'; end if;
  select * into candidate from public.correction_candidates where version_id=v.id and workspace_id=v.workspace_id for update;
  v_candidate := found;
  if v.workflow_kind<>'initial' and not v_candidate then
    raise exception 'Version is not a correction candidate' using errcode='22023';
  end if;
  select * into j from private.ingestion_jobs where version_id=v.id for update;

  -- A response lost after commit can safely be repeated by the exact completed operation.
  if v_candidate then
    if v.processing_status='ready' and v.version_status='pending_approval' and j.status='completed' and j.operation_id=p_operation_id
      and candidate.status='pending_approval'
      and exists(select 1 from public.correction_rounds r
        where r.id=candidate.round_id and r.workspace_id=candidate.workspace_id
          and r.status='pending_approval' and r.active_candidate_id=candidate.id) then return; end if;
  else
    if v.processing_status='ready' and v.version_status='active' and j.status='completed' and j.operation_id=p_operation_id
      and exists(select 1 from public.documents where id=v.document_id and active_version_id=v.id) then return; end if;
  end if;

  if v.processing_status<>'processing' then raise exception 'Version is not processing' using errcode='22023'; end if;
  if v.upload_state is distinct from 'confirmed' then raise exception 'Upload is not confirmed' using errcode='22023'; end if;
  if v.processing_operation_id is distinct from p_operation_id then raise exception 'Stale processing operation' using errcode='22023'; end if;
  if j.status is distinct from 'running' or j.operation_id is distinct from p_operation_id
    or j.workspace_id<>v.workspace_id or j.lease_expires_at<=clock_timestamp()
    or j.started_at+interval '15 minutes'<=clock_timestamp() then raise exception 'Processing lease expired' using errcode='22023'; end if;
  if v.version_status is not null then raise exception 'Version already decided' using errcode='22023'; end if;
  if v_candidate then
    if candidate.status<>'processing' then raise exception 'Correction candidate is not processing' using errcode='22023'; end if;
    if not exists(select 1 from public.correction_rounds r
      where r.id=candidate.round_id and r.workspace_id=candidate.workspace_id
        and r.status='candidate_processing' and r.active_candidate_id=candidate.id) then
      raise exception 'Correction round is not processing' using errcode='22023';
    end if;
  elsif v.version_number<>1 then
    raise exception 'Only v1 auto-activates' using errcode='22023';
  end if;
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

  if v_candidate then
    update public.document_versions set processing_status='ready',version_status='pending_approval',processing_operation_id=null,
      processing_started_at=null,processing_lease_expires_at=null,processing_queued=false where id=v.id;
    update public.correction_candidates set status='pending_approval',revision=revision+1,updated_at=clock_timestamp()
    where id=candidate.id and status='processing';
    if not found then raise exception 'Correction candidate is not processing' using errcode='22023'; end if;
    update public.correction_rounds set status='pending_approval',revision=revision+1,updated_at=clock_timestamp()
    where id=candidate.round_id and workspace_id=candidate.workspace_id
      and status='candidate_processing' and active_candidate_id=candidate.id;
    if not found then raise exception 'Correction round is not processing' using errcode='22023'; end if;
  else
    update public.document_versions set processing_status='ready',version_status='active',processing_operation_id=null,
      processing_started_at=null,processing_lease_expires_at=null,processing_queued=false where id=v.id;
    update public.documents set active_version_id=v.id where id=v.document_id and workspace_id=v.workspace_id;
  end if;
  -- Keep completed operation for idempotent reconciliation, clear live-lease columns.
  update private.ingestion_jobs set status='completed',started_at=null,lease_expires_at=null,updated_at=clock_timestamp() where version_id=v.id;
end $$;

revoke all on function public.enqueue_ingestion_job(uuid,uuid,boolean),public.claim_ingestion_job(),
  public.fail_ingestion_job(uuid,uuid,boolean),public.finish_processing(uuid,uuid,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.enqueue_ingestion_job(uuid,uuid,boolean),public.claim_ingestion_job(),
  public.fail_ingestion_job(uuid,uuid,boolean),public.finish_processing(uuid,uuid,jsonb) to service_role;

-- T1 correction: restore lock budget lost in CREATE OR REPLACE (originally set by 20261009134833)
alter function public.enqueue_ingestion_job(uuid, uuid, boolean) set lock_timeout='3s';
alter function public.enqueue_ingestion_job(uuid, uuid, boolean) set statement_timeout='5s';
