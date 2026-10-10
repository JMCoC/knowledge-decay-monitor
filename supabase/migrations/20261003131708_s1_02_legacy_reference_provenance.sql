create or replace function public.bind_legacy_upload_reference(
  p_user_id uuid, p_version_id uuid, p_size_bytes bigint, p_expected_sha256 text
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
  if private.uploads_enabled() then
    raise exception 'Legacy upload maintenance requires paused mode' using errcode = '55000';
  end if;
  if p_size_bytes is null or p_size_bytes not between 1 and 10485760
    or p_expected_sha256 is null or p_expected_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid legacy upload reference' using errcode = '22023';
  end if;

  select x.* into v from public.document_versions x
  where x.id = p_version_id and x.workspace_id = actor_workspace_id for update;
  if not found then raise exception 'Upload version not found' using errcode = 'P0002'; end if;
  if v.upload_state is not null or v.expected_sha256 is not null or v.reference_set_at is not null
    or v.processing_status <> 'uploaded' or v.version_status is not null
    or (v.size_bytes is not null and v.size_bytes <> p_size_bytes) then
    raise exception 'Legacy upload is not eligible for a new reference' using errcode = '40001';
  end if;

  perform private.insert_upload_attempt(v.workspace_id, v.document_id, v.id, fresh_attempt_id);
  update public.document_versions x set
    size_bytes = coalesce(v.size_bytes, p_size_bytes),
    expected_sha256 = p_expected_sha256,
    hash_source = 'client_declared',
    upload_initiator_id = p_user_id,
    current_upload_attempt_id = fresh_attempt_id,
    upload_state = 'pending',
    reference_set_at = now(),
    reference_set_by = p_user_id
  where x.id = v.id and x.workspace_id = actor_workspace_id;

  return query select * from private.upload_snapshot(p_version_id, actor_workspace_id);
end;
$$;

revoke all on function public.bind_legacy_upload_reference(uuid,uuid,bigint,text)
  from public, anon, authenticated;
grant execute on function public.bind_legacy_upload_reference(uuid,uuid,bigint,text) to service_role;
