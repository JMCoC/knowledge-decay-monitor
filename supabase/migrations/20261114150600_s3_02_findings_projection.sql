-- Make S2 finding reads reflect S3's persisted review assignment state.

revoke select on public.profiles from authenticated;
grant select (id, workspace_id, role, full_name) on public.profiles to authenticated;

create or replace view public.analysis_findings with (security_invoker = true) as
select
  f.id,
  f.workspace_id,
  f.analysis_id,
  f.type,
  f.severity_original,
  f.severity_current,
  f.explanation,
  f.status,
  f.created_at,
  f.updated_at,
  f.review_revision,
  f.assignee_id,
  assignee.full_name as assignee_full_name
from public.findings f
join public.analyses a
  on a.id = f.analysis_id and a.workspace_id = f.workspace_id
left join public.profiles assignee
  on assignee.id = f.assignee_id and assignee.workspace_id = f.workspace_id
where a.status = 'completed';
