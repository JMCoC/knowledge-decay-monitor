create view public.repository_documents
with (security_invoker = true)
as
select
  d.id,
  d.workspace_id,
  d.name,
  d.category,
  d.owner_id,
  p.id as owner_profile_id,
  p.full_name as owner_full_name,
  d.active_version_id,
  d.created_at,
  latest.id as latest_version_id,
  latest.version_number as latest_version_number,
  latest.processing_status as latest_processing_status,
  latest.version_status as latest_version_status,
  latest.analysis_status as latest_analysis_status,
  latest.upload_state as latest_upload_state
from public.documents d
left join public.profiles p
  on p.id = d.owner_id and p.workspace_id = d.workspace_id
left join lateral (
  select v.id, v.version_number, v.processing_status,
    v.version_status, v.analysis_status, v.upload_state
  from public.document_versions v
  where v.document_id = d.id and v.workspace_id = d.workspace_id
  order by v.version_number desc, v.id desc
  limit 1
) latest on true;

revoke all on public.repository_documents from public, anon, authenticated;
grant select on public.repository_documents to authenticated;
comment on view public.repository_documents is
  'Tenant-scoped Repository projection; lateral query selects latest version before application filters.';

create function public.get_confirmed_document_path(p_user_id uuid, p_version_id uuid)
returns text
language plpgsql security invoker set search_path = '' as $$
declare
  actor_workspace_id uuid;
  canonical_path text;
begin
  actor_workspace_id := private.authorized_document_workspace(p_user_id);
  select v.storage_path into canonical_path
  from public.document_versions v
  where v.id = p_version_id
    and v.workspace_id = actor_workspace_id
    and v.upload_state = 'confirmed';
  return canonical_path;
end;
$$;
revoke all on function public.get_confirmed_document_path(uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.get_confirmed_document_path(uuid,uuid) to service_role;
