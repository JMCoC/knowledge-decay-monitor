-- An idempotency fingerprint mismatch is a business uniqueness conflict, not
-- a retryable serialization failure. PostgreSQL 40001 left the local RPC
-- request open until the gateway returned 504; 23505 maps cleanly to HTTP 409.
create or replace function public.reserve_document_upload(
  p_user_id uuid,
  p_idempotency_key uuid,
  p_request_fingerprint text,
  p_name text,
  p_category public.document_category,
  p_owner_id uuid,
  p_extension text,
  p_size_bytes bigint,
  p_expected_sha256 text
) returns table (
  document_id uuid, version_id uuid, attempt_id uuid, storage_path text,
  canonical_mime_type text, upload_state public.upload_state
)
language plpgsql security invoker set search_path = '' as $$
declare
  actor_workspace_id uuid;
  existing_version public.document_versions%rowtype;
  new_document_id uuid := gen_random_uuid();
  new_version_id uuid := gen_random_uuid();
  new_attempt_id uuid := gen_random_uuid();
  canonical_path text;
  transfer_path text;
begin
  actor_workspace_id := private.authorized_document_workspace(p_user_id);
  if not private.uploads_enabled() then
    raise exception 'Upload flow is paused' using errcode = '55000';
  end if;
  if p_idempotency_key is null
    or p_request_fingerprint is null or p_request_fingerprint !~ '^[0-9a-f]{64}$'
    or p_name is null or char_length(btrim(p_name)) not between 1 and 200
    or p_category is null or p_owner_id is null
    or p_extension is null or p_extension not in ('pdf', 'docx', 'md')
    or p_size_bytes is null or p_size_bytes not between 1 and 10485760
    or p_expected_sha256 is null or p_expected_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid upload reservation' using errcode = '22023';
  end if;
  if not exists (select 1 from public.profiles p
    where p.id = p_owner_id and p.workspace_id = actor_workspace_id) then
    raise exception 'Invalid upload owner' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    actor_workspace_id::text || ':' || p_user_id::text || ':' || p_idempotency_key::text, 0));
  select v.* into existing_version
  from public.document_versions v
  where v.workspace_id = actor_workspace_id
    and v.upload_initiator_id = p_user_id and v.idempotency_key = p_idempotency_key
  for update;
  if found then
    if existing_version.request_fingerprint is distinct from p_request_fingerprint then
      raise exception 'Upload idempotency key conflicts with another request' using errcode = '23505';
    end if;
    return query
      select existing_version.document_id, existing_version.id, a.id, a.storage_path,
        case when existing_version.storage_path like '%.pdf' then 'application/pdf'
          when existing_version.storage_path like '%.docx' then 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          else 'text/markdown' end,
        existing_version.upload_state
      from public.document_upload_attempts a
      where a.id = existing_version.current_upload_attempt_id;
    return;
  end if;

  canonical_path := actor_workspace_id::text || '/' || new_document_id::text || '/'
    || new_version_id::text || '/original.' || p_extension;
  transfer_path := actor_workspace_id::text || '/' || new_document_id::text || '/'
    || new_version_id::text || '/attempts/' || new_attempt_id::text || '/original.' || p_extension;
  insert into public.documents(id, workspace_id, name, category, owner_id)
    values (new_document_id, actor_workspace_id, btrim(p_name), p_category, p_owner_id);
  insert into public.document_versions(
    id, workspace_id, document_id, version_number, storage_path, size_bytes,
    upload_state, expected_sha256, hash_source, upload_initiator_id,
    idempotency_key, request_fingerprint, current_upload_attempt_id,
    reference_set_at, reference_set_by
  ) values (
    new_version_id, actor_workspace_id, new_document_id, 1, canonical_path, p_size_bytes,
    'pending', p_expected_sha256, 'client_declared', p_user_id,
    p_idempotency_key, p_request_fingerprint, new_attempt_id,
    now(), p_user_id
  );
  perform private.insert_upload_attempt(actor_workspace_id, new_document_id, new_version_id, new_attempt_id);
  return query select new_document_id, new_version_id, new_attempt_id, transfer_path,
    case when p_extension = 'pdf' then 'application/pdf'
      when p_extension = 'docx' then 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      else 'text/markdown' end,
    'pending'::public.upload_state;
end;
$$;
