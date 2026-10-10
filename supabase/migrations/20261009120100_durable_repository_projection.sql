-- Only select granted source columns; v.* would require privileges on upload internals.
create or replace view public.repository_documents with(security_invoker=true) as
select d.id,d.workspace_id,d.name,d.category,d.owner_id,p.id as owner_profile_id,p.full_name as owner_full_name,
 d.active_version_id,d.created_at,latest.id as latest_version_id,latest.version_number as latest_version_number,
 latest.processing_status as latest_processing_status,latest.version_status as latest_version_status,
 latest.analysis_status as latest_analysis_status,latest.upload_state as latest_upload_state,
 latest.processing_started_at as latest_processing_started_at,
 latest.processing_queued as latest_processing_queued,latest.processing_lease_expires_at as latest_processing_lease_expires_at
from public.documents d left join public.profiles p on p.id=d.owner_id and p.workspace_id=d.workspace_id
left join lateral(select v.id,v.version_number,v.processing_status,v.version_status,v.analysis_status,v.upload_state,
 v.processing_started_at,v.processing_queued,v.processing_lease_expires_at
 from public.document_versions v where v.document_id=d.id and v.workspace_id=d.workspace_id
 order by v.version_number desc,v.id desc limit 1) latest on true;
revoke all on public.repository_documents from public,anon,authenticated;
grant select on public.repository_documents to authenticated;
notify pgrst,'reload schema';
