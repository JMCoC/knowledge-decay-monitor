-- Correct PL/pgSQL output-column qualification found by the first local
-- transition-suite run. Kept as a forward migration because these earlier
-- additive migrations have already been applied to local environments.

create or replace function public.claim_upload_verification(p_user_id uuid, p_version_id uuid, p_attempt_id uuid)
returns table (
  version_id uuid, attempt_id uuid, operation_id uuid, workspace_id uuid,
  temporary_path text, canonical_path text, expected_sha256 text,
  expected_size_bytes bigint, canonical_mime_type text, upload_state public.upload_state
)
language plpgsql security invoker set search_path = '' as $$
declare
  actor_workspace_id uuid;
  v public.document_versions%rowtype;
  op_id uuid := gen_random_uuid();
begin
  actor_workspace_id := private.authorized_document_workspace(p_user_id);
  if not private.uploads_enabled() then
    raise exception 'Upload flow is paused' using errcode = '55000';
  end if;
  select x.* into v from public.document_versions x
  where x.id = p_version_id and x.workspace_id = actor_workspace_id for update;
  if not found then raise exception 'Upload version not found' using errcode = 'P0002'; end if;
  if v.upload_state = 'confirmed' then
    return query select v.id, v.current_upload_attempt_id, null::uuid, v.workspace_id,
      a.storage_path, v.storage_path, v.expected_sha256, v.size_bytes,
      case when v.storage_path like '%.pdf' then 'application/pdf'
        when v.storage_path like '%.docx' then 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        else 'text/markdown' end,
      v.upload_state
    from public.document_upload_attempts a where a.id = v.current_upload_attempt_id;
    return;
  end if;
  if v.upload_state <> 'pending' and not
      (v.upload_state = 'verifying' and v.upload_lease_expires_at <= now()) then
    raise exception 'Upload state cannot be verified' using errcode = '40001';
  end if;
  if v.current_upload_attempt_id is distinct from p_attempt_id or not exists (
    select 1 from public.document_upload_attempts a
    where a.id = p_attempt_id and a.version_id = v.id and a.workspace_id = v.workspace_id
      and a.retired_at is null
  ) then
    raise exception 'Upload attempt is no longer current' using errcode = '40001';
  end if;
  update public.document_versions x set upload_state = 'verifying', upload_operation_id = op_id,
    upload_lease_expires_at = now() + interval '120 seconds'
  where x.id = v.id and x.workspace_id = actor_workspace_id;
  return query select v.id, p_attempt_id, op_id, v.workspace_id, a.storage_path, v.storage_path,
    v.expected_sha256, v.size_bytes,
    case when v.storage_path like '%.pdf' then 'application/pdf'
      when v.storage_path like '%.docx' then 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      else 'text/markdown' end,
    'verifying'::public.upload_state
  from public.document_upload_attempts a where a.id = p_attempt_id;
end;
$$;

create or replace function public.claim_upload_recovery(p_user_id uuid, p_version_id uuid)
returns table (
  version_id uuid, attempt_id uuid, operation_id uuid, workspace_id uuid,
  temporary_path text, canonical_path text, expected_sha256 text,
  expected_size_bytes bigint, canonical_mime_type text, upload_state public.upload_state
)
language plpgsql security invoker set search_path = '' as $$
declare
  actor_workspace_id uuid;
  v public.document_versions%rowtype;
  op_id uuid := gen_random_uuid();
begin
  actor_workspace_id := private.authorized_document_workspace(p_user_id);
  if not private.uploads_enabled() then
    raise exception 'Upload flow is paused' using errcode = '55000';
  end if;
  select x.* into v from public.document_versions x
  where x.id = p_version_id and x.workspace_id = actor_workspace_id for update;
  if not found then raise exception 'Upload version not found' using errcode = 'P0002'; end if;
  if v.upload_state is null or v.upload_state not in ('pending', 'rejected', 'verifying', 'recovering') then
    raise exception 'Upload state cannot be recovered' using errcode = '40001';
  end if;
  if v.upload_state in ('verifying', 'recovering') and v.upload_lease_expires_at > now() then
    raise exception 'Upload operation is still active' using errcode = '40001';
  end if;
  if v.current_upload_attempt_id is null then
    raise exception 'Legacy upload must be reconciled first' using errcode = '40001';
  end if;
  update public.document_upload_attempts a
    set retired_at = coalesce(a.retired_at, now()), cleanup_status = 'pending'
  where a.id = v.current_upload_attempt_id and a.version_id = v.id and a.workspace_id = v.workspace_id;
  update public.document_versions x set upload_state = 'recovering', upload_operation_id = op_id,
    upload_lease_expires_at = now() + interval '120 seconds'
  where x.id = v.id and x.workspace_id = actor_workspace_id;
  return query select v.id, v.current_upload_attempt_id, op_id, v.workspace_id, a.storage_path,
    v.storage_path, v.expected_sha256, v.size_bytes,
    case when v.storage_path like '%.pdf' then 'application/pdf'
      when v.storage_path like '%.docx' then 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      else 'text/markdown' end,
    'recovering'::public.upload_state
  from public.document_upload_attempts a where a.id = v.current_upload_attempt_id;
end;
$$;

create or replace function public.finish_upload_recovery(
  p_user_id uuid, p_version_id uuid, p_attempt_id uuid,
  p_operation_id uuid, p_object_absent boolean
) returns table (
  version_id uuid, upload_state public.upload_state, attempt_id uuid,
  can_open boolean, can_resume boolean, can_recover boolean
)
language plpgsql security invoker set search_path = '' as $$
declare
  actor_workspace_id uuid;
  v public.document_versions%rowtype;
  fresh_attempt_id uuid := gen_random_uuid();
begin
  actor_workspace_id := private.authorized_document_workspace(p_user_id);
  if p_object_absent is null then
    raise exception 'Recovery result is required' using errcode = '22023';
  end if;
  select x.* into v from public.document_versions x
  where x.id = p_version_id and x.workspace_id = actor_workspace_id for update;
  if not found then raise exception 'Upload version not found' using errcode = 'P0002'; end if;
  if v.current_upload_attempt_id is distinct from p_attempt_id
    or v.upload_operation_id is distinct from p_operation_id
    or v.upload_state <> 'recovering' or v.upload_lease_expires_at <= now() then
    raise exception 'Upload recovery lease is stale' using errcode = '40001';
  end if;
  update public.document_upload_attempts a set cleanup_checked_at = now(),
    cleanup_status = case when p_object_absent then 'absent'::public.upload_cleanup_status
      else 'failed'::public.upload_cleanup_status end
  where a.id = p_attempt_id and a.version_id = p_version_id and a.workspace_id = actor_workspace_id;
  if p_object_absent then
    perform private.insert_upload_attempt(v.workspace_id, v.document_id, v.id, fresh_attempt_id);
    update public.document_versions x set current_upload_attempt_id = fresh_attempt_id,
      upload_state = 'pending', upload_operation_id = null, upload_lease_expires_at = null,
      upload_confirmed_at = null
    where x.id = v.id and x.workspace_id = actor_workspace_id;
  else
    update public.document_versions x set upload_state = 'rejected', upload_operation_id = null,
      upload_lease_expires_at = null, upload_confirmed_at = null
    where x.id = v.id and x.workspace_id = actor_workspace_id;
  end if;
  return query select * from private.upload_snapshot(p_version_id, actor_workspace_id);
end;
$$;

create or replace function public.bind_legacy_upload_reference(
  p_user_id uuid, p_version_id uuid, p_size_bytes bigint, p_expected_sha256 text
) returns table (
  version_id uuid, upload_state public.upload_state, attempt_id uuid,
  can_open boolean, can_resume boolean, can_recover boolean
)
language plpgsql security invoker set search_path = '' as $$
declare
  actor_workspace_id uuid;
  affected integer;
begin
  actor_workspace_id := private.authorized_document_workspace(p_user_id);
  if private.uploads_enabled() then
    raise exception 'Legacy upload maintenance requires paused mode' using errcode = '55000';
  end if;
  if p_size_bytes is null or p_size_bytes not between 1 and 10485760
    or p_expected_sha256 is null or p_expected_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid legacy upload reference' using errcode = '22023';
  end if;
  update public.document_versions v set size_bytes = coalesce(v.size_bytes, p_size_bytes),
    expected_sha256 = p_expected_sha256, hash_source = 'legacy_reconciled',
    reference_set_at = now(), reference_set_by = p_user_id
  where v.id = p_version_id and v.workspace_id = actor_workspace_id
    and v.upload_state is null and v.expected_sha256 is null and v.reference_set_at is null
    and (v.size_bytes is null or v.size_bytes = p_size_bytes);
  get diagnostics affected = row_count;
  if affected <> 1 then
    if not exists (select 1 from public.document_versions v
      where v.id = p_version_id and v.workspace_id = actor_workspace_id) then
      raise exception 'Upload version not found' using errcode = 'P0002';
    end if;
    raise exception 'Legacy upload reference was already set' using errcode = '40001';
  end if;
  return query select * from private.upload_snapshot(p_version_id, actor_workspace_id);
end;
$$;
