create or replace view public.eligible_analysis_documents with (security_invoker = true) as
select
  d.id as document_id,
  d.workspace_id,
  d.name,
  d.category,
  d.owner_id,
  p.id as owner_profile_id,
  p.full_name as owner_full_name,
  v.id as version_id,
  v.version_number,
  v.analysis_status,
  d.created_at
from public.documents d
inner join public.document_versions v
  on d.active_version_id = v.id and d.workspace_id = v.workspace_id
left join public.profiles p
  on p.id = d.owner_id and p.workspace_id = d.workspace_id
where v.version_status = 'active'
  and v.processing_status = 'ready';

revoke all on public.eligible_analysis_documents from public, anon, authenticated;
grant select on public.eligible_analysis_documents to authenticated;

comment on view public.eligible_analysis_documents is
  'Projects only active and ready document versions for authorized analysis scope selection under tenant RLS.';

notify pgrst, 'reload schema';
