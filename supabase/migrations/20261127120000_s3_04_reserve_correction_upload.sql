-- S3-04 T2: reserve_correction_upload
-- Reserves a Member correction upload: creates submission + items + version + attempt.
-- Does NOT verify bytes/hash (claim/finish, T3), does NOT confirm (T3), does NOT create
-- candidates (S3-06), does NOT touch credits, does NOT emit signed URLs (T4),
-- does NOT call worker (S3-05 handles that via workflow_kind='correction_submission').
--
-- Replay semantics:
-- - state='reserved' + not expired  -> return target as-is
-- - state='confirmed'                -> return target as-is (T3 must validate upload_state, not TTL)
-- - state='reserved' + expired       -> mark expired (sub-tx), raise 23505 (retry with new key)
-- - state='expired' or 'invalidated' -> raise 23505 (terminal)
-- - fingerprint mismatch             -> raise 23505

create or replace function public.reserve_correction_upload(
  p_user_id uuid,
  p_workspace_id uuid,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_round_id uuid,
  p_document_id uuid,
  p_finding_ids uuid[],
  p_expected_revisions bigint[],
  p_base_version_id uuid,
  p_extension text,
  p_size_bytes bigint,
  p_expected_sha256 text
) returns table (
  submission_id uuid,
  version_id uuid,
  attempt_id uuid,
  storage_path text,
  canonical_mime_type text,
  upload_state public.upload_state,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
set row_security = off
set lock_timeout = '1s'
set statement_timeout = '8s'
as $$
declare
  v_canonical_mime text;
  v_actor_profile record;
  v_round record;
  v_document record;
  v_submission record;
  v_finding record;
  v_round_item record;
  v_round_item_ids uuid[] := '{}';
  v_finding_id uuid;
  v_expected_revision bigint;
  v_version_id uuid;
  v_submission_id uuid;
  v_vn integer;
  v_attempt_id uuid;
  v_attempt_path text;
  v_reserved_at timestamptz := pg_catalog.now();
  v_expires_at timestamptz;
  v_previous_submission_id uuid;
  v_upload_state public.upload_state;
begin
  -- 1) Cheap input validation.
  if p_user_id is null
     or p_workspace_id is null
     or p_idempotency_key is null
     or pg_catalog.char_length(pg_catalog.btrim(p_idempotency_key)) not between 1 and 128
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$'
     or p_round_id is null
     or p_document_id is null
     or p_finding_ids is null
     or pg_catalog.cardinality(p_finding_ids) not between 1 and 100
     or pg_catalog.array_ndims(p_finding_ids) <> 1
     or exists (
       select 1 from pg_catalog.unnest(p_finding_ids) x where x is null
     )
     or pg_catalog.cardinality(p_finding_ids) <> (
       select pg_catalog.count(distinct x)::integer
       from pg_catalog.unnest(p_finding_ids) x
     )
     or p_expected_revisions is null
     or pg_catalog.cardinality(p_expected_revisions) <> pg_catalog.cardinality(p_finding_ids)
     or pg_catalog.array_ndims(p_expected_revisions) <> 1
     or exists (
       select 1 from pg_catalog.unnest(p_expected_revisions) x
       where x is null or x <= 0
     )
     or p_base_version_id is null
     or p_extension is null
     or p_extension not in ('pdf', 'docx', 'md')
     or p_size_bytes is null
     or p_size_bytes not between 1 and 10485760
     or p_expected_sha256 is null
     or p_expected_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid correction upload reservation' using errcode = '22023';
  end if;

  -- 2) Actor authorization.
  select p.workspace_id, p.role into v_actor_profile
  from public.profiles p
  where p.id = p_user_id
  for share;
  if not found
     or v_actor_profile.workspace_id is distinct from p_workspace_id
     or v_actor_profile.role <> 'Member' then
    raise exception 'Correction upload requires a Member in the workspace' using errcode = '42501';
  end if;

  -- 3) Global upload pause.
  if not private.uploads_enabled() then
    raise exception 'Upload flow is paused' using errcode = '55000';
  end if;

  -- 4) Lock document and validate the fixed base.
  select d.id, d.workspace_id, d.active_version_id into v_document
  from public.documents d
  where d.id = p_document_id and d.workspace_id = p_workspace_id
  for update;
  if not found then
    raise exception 'Correction document not found' using errcode = 'P0002';
  end if;
  if v_document.active_version_id is distinct from p_base_version_id then
    raise exception 'Correction base changed; refresh the round' using errcode = '23514';
  end if;
  if not exists (
    select 1
    from public.document_versions v
    where v.id = p_base_version_id
      and v.document_id = p_document_id
      and v.workspace_id = p_workspace_id
      and v.processing_status = 'ready'
      and v.version_status = 'active'
  ) then
    raise exception 'Correction base is not the active ready version' using errcode = '23514';
  end if;

  -- 5) Serialize replay for the business idempotency key.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_workspace_id::text || ':' || p_user_id::text || ':' || p_idempotency_key, 0
  ));

  -- 6) Replay an existing submission.
  select s.* into v_submission
  from public.correction_submissions s
  where s.workspace_id = p_workspace_id
    and s.submitter_id = p_user_id
    and s.idempotency_key = p_idempotency_key
  for update;

  if found then
    if v_submission.request_fingerprint is distinct from p_request_fingerprint then
      raise exception 'Correction upload idempotency key conflicts with another request'
        using errcode = '23505';
    end if;

    if v_submission.state = 'reserved' and v_submission.expires_at > v_reserved_at then
      select v.upload_state, v.current_upload_attempt_id, a.storage_path
      into v_upload_state, v_attempt_id, v_attempt_path
      from public.document_versions v
      join public.document_upload_attempts a
        on a.id = v.current_upload_attempt_id
       and a.version_id = v.id
       and a.workspace_id = v.workspace_id
      where v.id = v_submission.version_id
        and v.workspace_id = p_workspace_id;
      if not found then
        raise exception 'Correction upload target is unavailable' using errcode = 'P0002';
      end if;

      v_canonical_mime := case
        when v_attempt_path like '%.pdf' then 'application/pdf'
        when v_attempt_path like '%.docx'
          then 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        else 'text/markdown'
      end;
      return query
        select v_submission.id, v_submission.version_id, v_attempt_id,
          v_attempt_path, v_canonical_mime, v_upload_state, v_submission.expires_at;
      return;
    end if;

    if v_submission.state = 'confirmed' then
      select v.upload_state, v.current_upload_attempt_id, a.storage_path
      into v_upload_state, v_attempt_id, v_attempt_path
      from public.document_versions v
      join public.document_upload_attempts a
        on a.id = v.current_upload_attempt_id
       and a.version_id = v.id
       and a.workspace_id = v.workspace_id
      where v.id = v_submission.version_id
        and v.workspace_id = p_workspace_id;
      if not found then
        raise exception 'Correction upload target is unavailable' using errcode = 'P0002';
      end if;

      v_canonical_mime := case
        when v_attempt_path like '%.pdf' then 'application/pdf'
        when v_attempt_path like '%.docx'
          then 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        else 'text/markdown'
      end;
      return query
        select v_submission.id, v_submission.version_id, v_attempt_id,
          v_attempt_path, v_canonical_mime, v_upload_state, v_submission.expires_at;
      return;
    end if;

    if v_submission.state = 'reserved' then
      begin
        update public.correction_submissions
        set state = 'expired'
        where id = v_submission.id
          and state = 'reserved'
          and expires_at <= v_reserved_at;
        if not found then
          raise exception 'Correction reservation expired concurrently' using errcode = '23505';
        end if;
      exception when others then
        raise exception 'Correction reservation expired and cannot be reused; retry with a new idempotency key'
          using errcode = '23505';
      end;
      raise exception 'Correction reservation expired; retry with a new idempotency key'
        using errcode = '23505';
    end if;

    raise exception 'Correction reservation is terminal; retry with a new idempotency key'
      using errcode = '23505';
  end if;

  -- 7) New reservation: lock the round, findings, and items in that order.
  select r.* into v_round
  from public.correction_rounds r
  where r.id = p_round_id and r.workspace_id = p_workspace_id
  for update;
  if not found then
    raise exception 'Correction round not found' using errcode = 'P0002';
  end if;
  if v_round.document_id is distinct from p_document_id then
    raise exception 'Correction round belongs to another document' using errcode = '23514';
  end if;
  if v_round.mode <> 'assigned_findings' or v_round.status <> 'collecting' then
    raise exception 'Correction round is not collecting assigned findings' using errcode = '23514';
  end if;
  if v_round.base_version_id is distinct from p_base_version_id then
    raise exception 'Correction round base changed; refresh the round' using errcode = '23514';
  end if;

  for v_finding_id in
    select f.finding_id
    from pg_catalog.unnest(p_finding_ids) with ordinality as f(finding_id, ordinal)
    order by f.finding_id
  loop
    select x.* into v_finding
    from public.findings x
    where x.id = v_finding_id and x.workspace_id = p_workspace_id
    for update;
    if not found then
      raise exception 'Correction finding is unavailable' using errcode = 'P0002';
    end if;
  end loop;

  for v_finding_id, v_expected_revision in
    select f.finding_id, r.expected_revision
    from pg_catalog.unnest(p_finding_ids) with ordinality as f(finding_id, ordinal)
    join pg_catalog.unnest(p_expected_revisions) with ordinality as r(expected_revision, ordinal)
      on r.ordinal = f.ordinal
    order by f.finding_id
  loop
    select i.* into v_round_item
    from public.correction_round_items i
    where i.round_id = p_round_id
      and i.workspace_id = p_workspace_id
      and i.document_id = p_document_id
      and i.finding_id = v_finding_id
    for update;
    if not found then
      raise exception 'Correction round item is unavailable' using errcode = 'P0002';
    end if;
    if v_round_item.assignee_id is distinct from p_user_id then
      raise exception 'Correction round item is assigned to another Member' using errcode = '42501';
    end if;
    if v_round_item.revision is distinct from v_expected_revision then
      raise exception 'Correction round item changed; refresh the round' using errcode = '23514';
    end if;

    select x.* into v_finding
    from public.findings x
    where x.id = v_finding_id and x.workspace_id = p_workspace_id;
    if v_finding.assignee_id is distinct from p_user_id then
      raise exception 'Correction finding is assigned to another Member' using errcode = '42501';
    end if;
    if v_finding.status not in ('confirmed', 'update_planned') then
      raise exception 'Correction finding is no longer eligible' using errcode = '23514';
    end if;
    if not exists (
      select 1 from public.analyses a
      where a.id = v_finding.analysis_id
        and a.workspace_id = p_workspace_id
        and a.status = 'completed'
    ) then
      raise exception 'Correction finding analysis is not completed' using errcode = '23514';
    end if;
    if not exists (
      select 1 from public.finding_evidence e
      where e.finding_id = v_finding_id
        and e.document_id = p_document_id
        and e.workspace_id = p_workspace_id
    ) then
      raise exception 'Correction finding has no evidence on the document' using errcode = '23514';
    end if;

    v_round_item_ids := pg_catalog.array_append(v_round_item_ids, v_round_item.id);
  end loop;

  -- 8) Canonical MIME type from the validated extension.
  v_canonical_mime := case p_extension
    when 'pdf' then 'application/pdf'
    when 'docx' then 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    else 'text/markdown'
  end;

  -- 9) A single 24-hour reservation window.
  v_expires_at := v_reserved_at + interval '24 hours';

  -- 10) Derive the previous confirmed submission that covered any selected item.
  select s.id into v_previous_submission_id
  from public.correction_submissions s
  join public.correction_submission_items si
    on si.submission_id = s.id
   and si.round_id = s.round_id
   and si.document_id = s.document_id
   and si.workspace_id = s.workspace_id
  where s.workspace_id = p_workspace_id
    and s.round_id = p_round_id
    and s.document_id = p_document_id
    and s.state = 'confirmed'
    and si.round_item_id = any (v_round_item_ids)
  order by s.confirmed_at desc nulls last, s.created_at desc, s.id desc
  limit 1;

  -- 11) Insert the immutable correction version. The upload-attempt FK is
  -- deferrable, so the version can reference the attempt before it exists.
  v_version_id := pg_catalog.gen_random_uuid();
  v_submission_id := pg_catalog.gen_random_uuid();
  v_attempt_id := pg_catalog.gen_random_uuid();
  v_vn := private.allocate_document_version_number(p_document_id, p_workspace_id);

  insert into public.document_versions(
    id, workspace_id, document_id, version_number, storage_path, size_bytes,
    processing_status, version_status, workflow_kind, upload_state,
    expected_sha256, hash_source, upload_initiator_id,
    current_upload_attempt_id, reference_set_at, reference_set_by
  ) values (
    v_version_id, p_workspace_id, p_document_id, v_vn,
    p_workspace_id::text || '/' || p_document_id::text || '/' || v_version_id::text
      || '/original.' || p_extension,
    p_size_bytes, 'uploaded', null, 'correction_submission', 'pending',
    p_expected_sha256, 'client_declared', p_user_id,
    v_attempt_id, v_reserved_at, p_user_id
  );

  -- 12) Create the temporary upload attempt.
  v_attempt_path := private.insert_upload_attempt(
    p_workspace_id, p_document_id, v_version_id, v_attempt_id
  );

  -- 13) Insert the business reservation.
  insert into public.correction_submissions(
    id, workspace_id, round_id, document_id, base_version_id, version_id,
    submitter_id, state, idempotency_key, request_fingerprint,
    reserved_at, expires_at, previous_submission_id
  ) values (
    v_submission_id, p_workspace_id, p_round_id, p_document_id, p_base_version_id,
    v_version_id, p_user_id, 'reserved', p_idempotency_key,
    p_request_fingerprint, v_reserved_at, v_expires_at, v_previous_submission_id
  );

  -- 14) Snapshot one item per selected finding.
  for v_round_item in
    select i.id, rev.expected_revision
    from pg_catalog.unnest(p_finding_ids) with ordinality as f(finding_id, ordinal)
    join pg_catalog.unnest(p_expected_revisions) with ordinality as rev(expected_revision, ordinal)
      on rev.ordinal = f.ordinal
    join public.correction_round_items i
      on i.round_id = p_round_id
     and i.workspace_id = p_workspace_id
     and i.document_id = p_document_id
     and i.finding_id = f.finding_id
    order by i.id
  loop
    insert into public.correction_submission_items(
      submission_id, round_item_id, workspace_id, round_id, document_id,
      assignee_at_submit_id, expected_revision
    ) values (
      v_submission_id, v_round_item.id, p_workspace_id, p_round_id, p_document_id,
      p_user_id, v_round_item.expected_revision
    );
  end loop;

  -- 15) Return the reserved target.
  return query
    select v_submission_id, v_version_id, v_attempt_id, v_attempt_path,
      v_canonical_mime, 'pending'::public.upload_state, v_expires_at;
end;
$$;

revoke all on function public.reserve_correction_upload(
  uuid, uuid, text, text, uuid, uuid, uuid[], bigint[], uuid, text, bigint, text
) from public, anon, authenticated, service_role;

grant execute on function public.reserve_correction_upload(
  uuid, uuid, text, text, uuid, uuid, uuid[], bigint[], uuid, text, bigint, text
) to service_role;

comment on function public.reserve_correction_upload(
  uuid, uuid, text, text, uuid, uuid, uuid[], bigint[], uuid, text, bigint, text
) is
  'S3-04 T2: reserve Member correction upload. No byte/hash verification, no confirmation, no candidate. Idempotent via (workspace_id, submitter_id, idempotency_key).';
