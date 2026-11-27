-- S3-04 T1b: correction upload base primitives.
-- - private.allocate_document_version_number: atomic vN allocator (T2/T3 consumers).
-- - public.expire_stale_correction_reservations: system sweep for TTL-expired reservations.
-- No RPCs (reserve/claim/finish/resume) here; those live in T2/T3.

create or replace function private.allocate_document_version_number(
  p_document_id uuid,
  p_workspace_id uuid
) returns integer
language plpgsql
security definer
set search_path = ''
set lock_timeout = '1s'
set statement_timeout = '5s'
as $$
declare
  v_next integer;
begin
  -- Lock the document row to serialize version_number allocation.
  perform 1 from public.documents
  where id = p_document_id and workspace_id = p_workspace_id
  for update;
  if not found then
    raise exception 'Document not found for version allocation.' using errcode = '23503';
  end if;

  select coalesce(max(v.version_number), 0) + 1 into v_next
  from public.document_versions v
  where v.document_id = p_document_id and v.workspace_id = p_workspace_id;

  if v_next <= 1 then
    raise exception 'Allocated version_number must be > 1 for corrections.' using errcode = '23514';
  end if;

  return v_next;
end;
$$;

revoke all on function private.allocate_document_version_number(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function private.allocate_document_version_number(uuid, uuid)
  to postgres, service_role;

comment on function private.allocate_document_version_number(uuid, uuid) is
  'Allocates the next version_number for a document under row lock. Rejects <= 1 (initial upload uses v1 via S1).';

create or replace function public.expire_stale_correction_reservations(
  p_limit integer default 100
) returns table (submission_id uuid, outcome text)
language plpgsql
security definer
set search_path = ''
set lock_timeout = '1s'
set statement_timeout = '30s'
as $$
declare
  v_submission record;
  v_version record;
  v_candidate_alive boolean;
  v_version_eligible boolean;
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'p_limit must be between 1 and 1000.' using errcode = '22023';
  end if;

  -- Serialize concurrent sweeps.
  perform pg_advisory_xact_lock(26061601);

  for v_submission in
    select s.id, s.workspace_id, s.round_id, s.document_id, s.version_id,
           s.submitter_id, s.state, s.expires_at, s.confirmed_at
    from public.correction_submissions s
    where s.state = 'reserved'
      and s.expires_at <= now()
    order by s.expires_at, s.id
    limit p_limit
    for update skip locked
  loop
    -- Candidate alive check (unique partial index: one live per round).
    select exists (
      select 1 from public.correction_candidates c
      where c.round_id = v_submission.round_id
        and c.status not in ('approved','rejected','invalidated')
    ) into v_candidate_alive;

    if v_candidate_alive then
      submission_id := v_submission.id;
      outcome := 'skipped_candidate_alive';
      return next;
      continue;
    end if;

    -- Version eligibility: not verifying/recovering with active lease.
    select v.upload_state, v.upload_lease_expires_at
    into v_version
    from public.document_versions v
    where v.id = v_submission.version_id and v.workspace_id = v_submission.workspace_id;

    v_version_eligible := v_version.upload_state in ('pending','rejected','recovering')
      and (v_version.upload_lease_expires_at is null or v_version.upload_lease_expires_at <= now());

    if not v_version_eligible then
      submission_id := v_submission.id;
      outcome := 'skipped_not_confirmed';
      return next;
      continue;
    end if;

    begin
      -- 1) Mark submission expired.
      update public.correction_submissions
      set state = 'expired'
      where id = v_submission.id
        and state = 'reserved';

      if not found then
        submission_id := v_submission.id;
        outcome := 'invalidated';
        return next;
        continue;
      end if;

      -- 2) Mark version rejected.
      update public.document_versions
      set upload_state = 'rejected',
          processing_status = 'uploaded',
          version_status = null,
          processing_operation_id = null,
          processing_lease_expires_at = null,
          upload_operation_id = null,
          upload_lease_expires_at = null
      where id = v_submission.version_id
        and workspace_id = v_submission.workspace_id
        and upload_state in ('pending','recovering');

      -- 3) Retire attempts.
      update public.document_upload_attempts
      set retired_at = now(),
          cleanup_status = 'pending'
      where version_id = v_submission.version_id
        and workspace_id = v_submission.workspace_id
        and retired_at is null;

      -- 4) Audit (direct insert; no append_review_audit for system sweep).
      insert into public.audit_events (id, workspace_id, actor_id, action, entity_type, entity_id, metadata)
      values (
        gen_random_uuid(),
        v_submission.workspace_id,
        v_submission.submitter_id,
        'correction_submission_expired',
        'correction_submission',
        v_submission.id,
        jsonb_build_object('round_id', v_submission.round_id, 'reason', 'ttl_expired')
      );

      submission_id := v_submission.id;
      outcome := 'expired';
      return next;
    exception when others then
      -- Do not abort the sweep on a single inconsistent row.
      submission_id := v_submission.id;
      outcome := 'skipped_version_inconsistent';
      return next;
    end;
  end loop;
end;
$$;

revoke all on function public.expire_stale_correction_reservations(integer)
  from public, anon, authenticated;
grant execute on function public.expire_stale_correction_reservations(integer)
  to service_role;

comment on function public.expire_stale_correction_reservations(integer) is
  'Sweep: expires TTL-expired correction_submissions, marks versions rejected, retires attempts, audits. Cron wiring (kdm-correction-sweep) deferred to S3-10.';

-- Wire the sweep into the correction policies' inventories in T1.4 (after T1a+T1b confirmed).
