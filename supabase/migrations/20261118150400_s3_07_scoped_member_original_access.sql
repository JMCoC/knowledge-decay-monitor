-- S3-07 grants a narrow workflow exception to S1's Repository restriction.
-- Members may open only a related active original or their own operational
-- correction submission. This does not grant table, version-history, or
-- Repository access.
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
  elsif actor_role = 'Member' then
    select v.storage_path into canonical_path
    from public.document_versions v
    join public.documents d on d.id = v.document_id and d.workspace_id = v.workspace_id
    where v.id = p_version_id and v.workspace_id = actor_workspace_id
      and v.upload_state = 'confirmed'
      and (
        (
          v.processing_status = 'ready' and v.version_status = 'active'
          and d.active_version_id = v.id
          and exists (
            select 1
            from public.findings f
            join public.analyses a on a.id = f.analysis_id and a.workspace_id = f.workspace_id
            join public.finding_evidence e on e.finding_id = f.id
              and e.analysis_id = f.analysis_id and e.workspace_id = f.workspace_id
            where f.workspace_id = actor_workspace_id and f.assignee_id = p_user_id
              and f.status in ('pending_review', 'confirmed', 'update_planned')
              and a.status = 'completed' and e.document_id = v.document_id
          )
        )
        or (
          v.workflow_kind = 'correction_submission'
          and exists (
            select 1
            from public.correction_submissions s
            join public.correction_rounds r on r.id = s.round_id
              and r.document_id = s.document_id and r.workspace_id = s.workspace_id
            join public.correction_submission_items si on si.submission_id = s.id
              and si.workspace_id = s.workspace_id
            join public.correction_round_items ri on ri.id = si.round_item_id
              and ri.round_id = si.round_id and ri.document_id = si.document_id
              and ri.workspace_id = si.workspace_id
            join public.findings f on f.id = ri.finding_id and f.workspace_id = ri.workspace_id
            where s.version_id = v.id and s.workspace_id = actor_workspace_id
              and s.submitter_id = p_user_id and s.state in ('reserved', 'confirmed')
              and r.status in ('collecting', 'consolidating', 'candidate_processing', 'candidate_failed', 'pending_approval')
              and si.assignee_at_submit_id = p_user_id and ri.assignee_id = p_user_id
              and ri.revision = si.expected_revision and f.assignee_id = p_user_id
              and f.status in ('pending_review', 'confirmed', 'update_planned')
              and (s.state = 'confirmed' or (r.status = 'collecting' and s.expires_at > statement_timestamp()))
          )
        )
      );
  else
    raise exception 'A repository role is required' using errcode = '42501';
  end if;

  return canonical_path;
end;
$$;

revoke all on function public.get_review_workflow_document_path(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_review_workflow_document_path(uuid, uuid) to service_role;
