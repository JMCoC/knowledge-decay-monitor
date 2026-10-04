create function public.authorize_upload_resume_reference(
  p_user_id uuid,
  p_version_id uuid,
  p_size_bytes bigint,
  p_expected_sha256 text
) returns table (authorized boolean)
language plpgsql security invoker set search_path = '' as $$
declare
  actor_workspace_id uuid;
  v public.document_versions%rowtype;
begin
  actor_workspace_id := private.authorized_document_workspace(p_user_id);
  if p_size_bytes is null or p_size_bytes not between 1 and 10485760
    or p_expected_sha256 is null or p_expected_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid upload resume reference' using errcode = '22023';
  end if;

  select x.* into v
  from public.document_versions x
  where x.id = p_version_id and x.workspace_id = actor_workspace_id
  for share;
  if not found then
    raise exception 'Upload version not found' using errcode = 'P0002';
  end if;
  if v.upload_state <> 'pending'
    or v.size_bytes is distinct from p_size_bytes
    or v.expected_sha256 is distinct from p_expected_sha256 then
    raise exception 'Upload resume reference does not match' using errcode = '22023';
  end if;

  return query select true;
end;
$$;

revoke all on function public.authorize_upload_resume_reference(uuid,uuid,bigint,text)
  from public, anon, authenticated;
grant execute on function public.authorize_upload_resume_reference(uuid,uuid,bigint,text)
  to service_role;
