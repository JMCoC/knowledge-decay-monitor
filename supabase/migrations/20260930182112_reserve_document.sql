-- Dev 2. Registered with Dev 1 before creation; the timestamp above is reserved.
-- The storage path is built here, in one place, next to the
-- storage_path_matches_identity CHECK that enforces it. A caller can supply
-- only an extension from a three-value allowlist, never a path.

-- Nullable so the Day Cero seed rows keep working and no default invents data
-- for them. This function never writes null: every version it creates carries
-- the size the caller declared, which is what finalizeUpload compares Storage
-- against. Seed rows predate the column and stay null. The column is added
-- before the function that uses it.
alter table public.document_versions
  add column size_bytes bigint;

alter table public.document_versions
  add constraint document_versions_size_bytes_within_limit
    check (size_bytes is null or size_bytes between 1 and 10485760);

create function public.reserve_document(
  p_document_id uuid,
  p_version_id uuid,
  p_name text,
  p_category public.document_category,
  p_owner_id uuid,
  p_extension text,
  p_size_bytes bigint
) returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_workspace_id uuid := private.current_workspace_id();
  v_storage_path text;
begin
  if v_workspace_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 200 then
    raise exception 'Invalid document name' using errcode = '22023';
  end if;
  if p_extension is null or p_extension not in ('pdf', 'docx', 'md') then
    raise exception 'Unsupported extension' using errcode = '22023';
  end if;
  if p_size_bytes is null or p_size_bytes not between 1 and 10485760 then
    raise exception 'Invalid file size' using errcode = '22023';
  end if;

  v_storage_path := v_workspace_id::text || '/' || p_document_id::text
    || '/' || p_version_id::text || '/original.' || p_extension;

  insert into public.documents (id, name, category, owner_id)
    values (p_document_id, btrim(p_name), p_category, p_owner_id);

  insert into public.document_versions (id, document_id, version_number, storage_path, size_bytes)
    values (p_version_id, p_document_id, 1, v_storage_path, p_size_bytes);

  return v_storage_path;
end;
$$;

revoke all on function public.reserve_document(uuid,uuid,text,public.document_category,uuid,text,bigint)
  from public, anon, authenticated;
grant execute on function public.reserve_document(uuid,uuid,text,public.document_category,uuid,text,bigint)
  to authenticated;
