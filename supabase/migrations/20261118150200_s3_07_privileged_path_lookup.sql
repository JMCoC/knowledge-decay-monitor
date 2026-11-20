-- Path lookup runs server-side because Member sessions cannot read workflow rows.
-- Execute privileges stay service-only; the function derives role/workspace from Profile.

create or replace function public.get_review_workflow_document_path(p_user_id uuid, p_version_id uuid)
returns text
language plpgsql security definer
set search_path = '' set row_security = off
as $$
declare
  actor_workspace_id uuid;
  actor_role text;
  canonical_path text;
begin
  select p.workspace_id, p.role::text into actor_workspace_id, actor_role
  from public.profiles p where p.id = p_user_id;
  if not found or actor_workspace_id is null then
    raise exception 'A workspace profile is required' using errcode = '42501';
  end if;

  if actor_role in ('Admin', 'QA Lead') then
    select v.storage_path into canonical_path
    from public.document_versions v
    where v.id = p_version_id and v.workspace_id = actor_workspace_id
      and v.upload_state = 'confirmed';
  else
    raise exception 'A document role is required' using errcode = '42501';
  end if;
  return canonical_path;
end;
$$;
revoke all on function public.get_review_workflow_document_path(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_review_workflow_document_path(uuid, uuid) to service_role;
