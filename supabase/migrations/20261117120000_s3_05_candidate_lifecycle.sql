-- S3-05 T2: candidate lifecycle commands and read projections.
-- The candidate integrity transition (failed -> selected) already shipped in
-- 20261116120000. This migration only wires round transitions to durable
-- enqueue, adds explicit invalidation, and exposes processing state.

-- The security-invoker queue view needs the tenant keys that S3-01 did not
-- expose. These remain RLS-scoped; they are not a tenant authority.
grant select (workspace_id, active_candidate_id, updated_at)
  on public.correction_rounds to authenticated;
grant select (workspace_id, version_id)
  on public.correction_candidates to authenticated;

-- T2.1 A processing round owns exactly one durable candidate job. The trigger
-- keeps fixtures and future RPCs from bypassing enqueue, while the retry path
-- still distinguishes an explicit candidate retry from a first selection.
create function private.enqueue_candidate_processing() returns trigger
language plpgsql security definer
set search_path = '' set row_security = off
set lock_timeout = '1s' set statement_timeout = '3s'
as $$
declare
  parent_candidate public.correction_candidates%rowtype;
  parent_version public.document_versions%rowtype;
  enqueue_result text;
  retry_candidate boolean := (old.status = 'candidate_failed');
begin
  if new.active_candidate_id is null then
    raise exception 'candidate_processing requires processable candidate' using errcode = '23514';
  end if;

  select c.* into parent_candidate
  from public.correction_candidates c
  where c.id = new.active_candidate_id and c.workspace_id = new.workspace_id;
  if not found then
    raise exception 'candidate_processing requires processable candidate' using errcode = '23514';
  end if;

  select v.* into parent_version
  from public.document_versions v
  where v.id = parent_candidate.version_id and v.workspace_id = new.workspace_id;
  if not found then
    raise exception 'candidate_processing requires processable candidate' using errcode = '23514';
  end if;

  -- A direct manual retry calls enqueue, which revives the candidate and
  -- advances the round itself. Suppress only that nested round update.
  if coalesce(current_setting('s3_05.enqueue_round', true), '') = 'on' then
    return new;
  end if;

  enqueue_result := public.enqueue_ingestion_job(
    new.workspace_id, parent_candidate.version_id, retry_candidate
  );
  if enqueue_result = 'conflict' then
    -- Defense in depth: S3-02 should already prevent an unprocessable round.
    raise exception 'candidate_processing requires processable candidate' using errcode = '23514';
  end if;
  if enqueue_result <> 'queued' then
    raise exception 'Unexpected candidate processing enqueue result' using errcode = '22023';
  end if;
  return new;
end;
$$;
revoke all on function private.enqueue_candidate_processing()
  from public, anon, authenticated, service_role;

drop trigger if exists correction_rounds_candidate_processing_enqueue
  on public.correction_rounds;
create trigger correction_rounds_candidate_processing_enqueue
  after update of status on public.correction_rounds
  for each row
  when (
    new.status = 'candidate_processing'
    and old.status in ('consolidating', 'candidate_failed')
  )
  execute function private.enqueue_candidate_processing();

-- T2.1a The round trigger fires after the round has already reached
-- candidate_processing. A retry must therefore accept either the pre-trigger
-- candidate_failed round (manual enqueue) or the already-advanced processing
-- round (trigger). Everything else matches the T1 contract.
create or replace function public.enqueue_ingestion_job(
  p_workspace_id uuid, p_version_id uuid, p_retry boolean default false
)
returns text language plpgsql security definer
set search_path = '' set lock_timeout = '1s' set statement_timeout = '2s'
as $$
declare
  v public.document_versions%rowtype;
  j private.ingestion_jobs%rowtype;
  c public.correction_candidates%rowtype;
  r public.correction_rounds%rowtype;
  v_candidate boolean := false;
begin
  perform pg_catalog.pg_advisory_xact_lock(19091001);
  select * into v from public.document_versions
  where id = p_version_id and workspace_id = p_workspace_id for update;
  if not found then return 'not_found'; end if;

  if v.workflow_kind = 'initial' then
    if v.upload_state <> 'confirmed' or v.version_number <> 1 or v.version_status is not null
    then return 'conflict'; end if;
  else
    select * into c from public.correction_candidates
    where version_id = v.id and workspace_id = p_workspace_id for update;
    if not found then return 'conflict'; end if;
    select * into r from public.correction_rounds
    where id = c.round_id and workspace_id = p_workspace_id for update;
    if not found or r.active_candidate_id is distinct from c.id then return 'conflict'; end if;
    if v.upload_state <> 'confirmed' or v.version_status is not null then return 'conflict'; end if;
    if c.status = 'selected' then
      if r.status <> 'candidate_processing' or v.processing_status <> 'uploaded'
      then return 'conflict'; end if;
    elsif c.status = 'failed' then
      if not p_retry
         or r.status not in ('candidate_failed', 'candidate_processing')
         or v.processing_status <> 'processing_failed'
      then return 'conflict'; end if;
    else
      return 'conflict';
    end if;
    v_candidate := true;
  end if;

  select * into j from private.ingestion_jobs where version_id = v.id for update;
  if found and (
    j.status = 'queued'
    or (j.status = 'running' and j.lease_expires_at > clock_timestamp())
  ) then
    return case when p_retry then 'conflict' else 'queued' end;
  end if;

  if v_candidate then
    if c.status = 'failed' then
      if not p_retry then return 'conflict'; end if;
      update public.correction_candidates
      set status = 'selected', revision = c.revision + 1, updated_at = clock_timestamp()
      where id = c.id and status = 'failed';
      if not found then raise exception 'Processing claim mismatch' using errcode = '22023'; end if;
      if r.status = 'candidate_failed' then
        -- The round trigger skips this nested update; enqueue owns the
        -- manual retry transition and the revision bump.
        perform pg_catalog.set_config('s3_05.enqueue_round', 'on', true);
        update public.correction_rounds
        set status = 'candidate_processing', active_candidate_id = c.id,
            revision = revision + 1, updated_at = clock_timestamp()
        where id = r.id and status = 'candidate_failed' and active_candidate_id = c.id;
        if not found then raise exception 'Processing claim mismatch' using errcode = '22023'; end if;
        perform pg_catalog.set_config('s3_05.enqueue_round', '', true);
      end if;
      update public.document_versions
      set processing_status = 'uploaded', processing_queued = true,
          processing_operation_id = null, processing_started_at = null,
          processing_lease_expires_at = null, updated_at = clock_timestamp()
      where id = v.id;
    else
      -- Selection may not have queued yet; keep the uploaded version untouched.
      update public.document_versions set processing_queued = true where id = v.id;
    end if;
  else
    if v.processing_status not in ('uploaded', 'processing_failed', 'processing')
    then return 'conflict'; end if;
    if j.version_id is null and v.processing_status = 'processing'
       and (v.processing_started_at is null
         or v.processing_started_at > clock_timestamp() - interval '180 seconds')
    then return 'conflict'; end if;
    if not p_retry and v.processing_status <> 'uploaded' then return 'conflict'; end if;
  end if;

  insert into private.ingestion_jobs(version_id, workspace_id)
  values (v.id, v.workspace_id)
  on conflict (version_id) do update
  set status = 'queued', attempt_count = 0, operation_id = null,
      started_at = null, lease_expires_at = null,
      available_at = clock_timestamp(), updated_at = clock_timestamp();
  if not v_candidate then
    update public.document_versions
    set processing_status = 'uploaded', processing_queued = true,
        processing_operation_id = null, processing_started_at = null,
        processing_lease_expires_at = null
    where id = v.id;
  end if;
  return 'queued';
end;
$$;

-- T2.2 Explicit reviewer invalidation. Selected, failed, and processing
-- candidates are abandoned; approval-stage candidates are outside this command.
create function public.invalidate_review_candidate(
  p_workspace_id uuid,
  p_round_id uuid,
  p_actor_id uuid,
  p_reason text default null
) returns text
language plpgsql security definer
set search_path = '' set row_security = off
set lock_timeout = '1s' set statement_timeout = '8s'
as $$
declare
  v_workspace_id uuid;
  v_round public.correction_rounds%rowtype;
  v_candidate public.correction_candidates%rowtype;
  v_version public.document_versions%rowtype;
  v_reason text;
  v_round_target public.correction_round_status;
begin
  if p_workspace_id is null or p_round_id is null or p_actor_id is null then
    return 'not_found';
  end if;
  v_reason := pg_catalog.btrim(coalesce(p_reason, ''));
  if v_reason = '' then v_reason := 'Candidate invalidated by reviewer'; end if;
  if pg_catalog.char_length(v_reason) > 2000 then
    raise exception 'Invalid candidate invalidation reason' using errcode = '22023';
  end if;

  v_workspace_id := private.lock_review_actor(p_actor_id);
  if v_workspace_id is distinct from p_workspace_id then
    raise exception 'Reviewer workspace mismatch' using errcode = '42501';
  end if;
  -- Serialize against claim/fail/finish without taking a second lock order.
  perform pg_catalog.pg_advisory_xact_lock(19091001);

  select r.* into v_round
  from public.correction_rounds r
  where r.id = p_round_id and r.workspace_id = v_workspace_id
  for update;
  if not found then return 'not_found'; end if;
  if v_round.status not in ('candidate_processing', 'candidate_failed')
     or v_round.active_candidate_id is null then
    return 'conflict';
  end if;

  select c.* into v_candidate
  from public.correction_candidates c
  where c.id = v_round.active_candidate_id
    and c.round_id = v_round.id
    and c.workspace_id = v_workspace_id
  for update;
  if not found then return 'conflict'; end if;
  if v_candidate.status not in ('reserved', 'selected', 'processing', 'failed') then
    return 'conflict';
  end if;

  select v.* into v_version
  from public.document_versions v
  where v.id = v_candidate.version_id and v.workspace_id = v_workspace_id
  for update;
  if not found then return 'conflict'; end if;

  insert into public.correction_candidate_decisions(
    workspace_id, round_id, document_id, candidate_id, actor_id, outcome, private_reason
  ) values (
    v_workspace_id, v_round.id, v_round.document_id, v_candidate.id,
    p_actor_id, 'invalidated', v_reason
  );

  update public.correction_candidates
  set status = 'invalidated', revision = revision + 1, updated_at = clock_timestamp()
  where id = v_candidate.id and status = v_candidate.status;
  if not found then raise exception 'Candidate invalidation mismatch' using errcode = '22023'; end if;

  update public.document_versions
  set processing_status = case
        when v_candidate.status = 'processing' then 'processing_failed'::public.processing_status
        else 'uploaded'::public.processing_status
      end,
      version_status = null,
      processing_queued = false,
      processing_operation_id = null,
      processing_started_at = null,
      processing_lease_expires_at = null,
      updated_at = clock_timestamp()
  where id = v_version.id;
  if not found then raise exception 'Candidate version invalidation mismatch' using errcode = '22023'; end if;

  if v_candidate.status = 'processing' then
    update private.ingestion_jobs
    set status = 'failed', operation_id = null, started_at = null,
        lease_expires_at = null, updated_at = clock_timestamp()
    where version_id = v_version.id and workspace_id = v_workspace_id;
  end if;

  if v_round.status = 'candidate_processing' then
    update public.correction_rounds
    set status = 'candidate_failed', revision = revision + 1,
        updated_at = clock_timestamp()
    where id = v_round.id and status = 'candidate_processing'
      and active_candidate_id = v_candidate.id;
    if not found then raise exception 'Candidate round invalidation mismatch' using errcode = '22023'; end if;
  end if;

  v_round_target := case when v_round.mode = 'administrative'
    then 'consolidating'::public.correction_round_status
    else 'collecting'::public.correction_round_status end;
  update public.correction_rounds
  set status = v_round_target, active_candidate_id = null,
      revision = revision + 1, updated_at = clock_timestamp()
  where id = v_round.id and status = 'candidate_failed'
    and active_candidate_id = v_candidate.id;
  if not found then raise exception 'Candidate round invalidation mismatch' using errcode = '22023'; end if;

  return 'invalidated';
end;
$$;
revoke all on function public.invalidate_review_candidate(uuid, uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.invalidate_review_candidate(uuid, uuid, uuid, text)
  to service_role;

-- T2.3 Read projection: phase, candidate phase, and version states stay
-- separate; readiness is never projected as approval.
create view public.correction_candidate_queue with (security_invoker = true) as
select
  r.id as round_id,
  r.workspace_id,
  c.id as candidate_id,
  c.version_id,
  v.document_id,
  r.status as round_status,
  c.status as candidate_status,
  v.processing_status as version_processing_status,
  v.version_status as version_version_status,
  c.selection_kind,
  r.revision as round_revision,
  c.revision as candidate_revision,
  greatest(v.updated_at, c.updated_at, r.updated_at) as last_activity_at
from public.correction_rounds r
join public.correction_candidates c
  on c.id = r.active_candidate_id and c.workspace_id = r.workspace_id
join public.document_versions v
  on v.id = c.version_id and v.workspace_id = r.workspace_id
where r.status in ('candidate_processing', 'candidate_failed', 'pending_approval');

revoke all on public.correction_candidate_queue from public, anon, authenticated;
grant select on public.correction_candidate_queue to authenticated, service_role;

create function public.review_get_round_processing_status(
  p_actor_id uuid, p_round_id uuid
) returns table(
  round_id uuid,
  workspace_id uuid,
  candidate_id uuid,
  version_id uuid,
  document_id uuid,
  round_status public.correction_round_status,
  candidate_status public.correction_candidate_status,
  version_processing_status public.processing_status,
  version_version_status public.version_status,
  selection_kind public.correction_selection_kind,
  round_revision bigint,
  candidate_revision bigint,
  last_activity_at timestamptz
)
language sql stable security definer
set search_path = '' set row_security = off
as $$
  select q.round_id, q.workspace_id, q.candidate_id, q.version_id, q.document_id,
    q.round_status, q.candidate_status, q.version_processing_status,
    q.version_version_status, q.selection_kind, q.round_revision,
    q.candidate_revision, q.last_activity_at
  from public.correction_candidate_queue q
  where q.workspace_id = private.review_reader_workspace(p_actor_id)
    and q.round_id = p_round_id
$$;
revoke all on function public.review_get_round_processing_status(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.review_get_round_processing_status(uuid, uuid)
  to service_role;

notify pgrst, 'reload schema';
