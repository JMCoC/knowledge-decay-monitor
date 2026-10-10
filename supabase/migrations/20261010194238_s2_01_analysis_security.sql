-- S2-01: expose analysis data through persisted-role RLS and curated views.

create policy analyses_read on public.analyses for select to authenticated
using (
  workspace_id = (select private.current_workspace_id())
  and (select private.current_workspace_role()) in ('Admin', 'QA Lead')
);

create policy analysis_scope_read on public.analysis_documents for select to authenticated
using (
  workspace_id = (select private.current_workspace_id())
  and (select private.current_workspace_role()) in ('Admin', 'QA Lead')
);

create policy ledger_read on public.credit_ledger for select to authenticated
using (
  workspace_id = (select private.current_workspace_id())
  and (select private.current_workspace_role()) in ('Admin', 'QA Lead')
);

create policy findings_read on public.findings for select to authenticated
using (
  workspace_id = (select private.current_workspace_id())
  and (select private.current_workspace_role()) in ('Admin', 'QA Lead')
  and exists (
    select 1 from public.analyses a
    where a.id = findings.analysis_id
      and a.workspace_id = findings.workspace_id
      and a.status = 'completed'
  )
);

create policy evidence_read on public.finding_evidence for select to authenticated
using (
  workspace_id = (select private.current_workspace_id())
  and (select private.current_workspace_role()) in ('Admin', 'QA Lead')
  and exists (
    select 1 from public.analyses a
    where a.id = finding_evidence.analysis_id
      and a.workspace_id = finding_evidence.workspace_id
      and a.status = 'completed'
  )
);

-- Client reads are restricted to fields suitable for a product projection.
-- In particular, the technical error taxonomy remains server-only.
grant select (
  id, workspace_id, initiator_id, status, fixed_cost, retry_of_analysis_id,
  created_at, started_at, finished_at
) on public.analyses to authenticated;
grant select (analysis_id, workspace_id, document_id, version_id, role)
  on public.analysis_documents to authenticated;
grant select (id, workspace_id, event_type, amount, analysis_id, created_at)
  on public.credit_ledger to authenticated;
grant select (
  id, workspace_id, analysis_id, type, severity_original, severity_current,
  explanation, status, created_at, updated_at
) on public.findings to authenticated;
grant select (
  id, workspace_id, analysis_id, finding_id, document_id, version_id, chunk_id,
  page_number, section, section_heading, snapshot
) on public.finding_evidence to authenticated;

-- Server writes are limited to creating analysis data, advancing owned state,
-- and appending immutable ledger movements.
grant select, insert, update
  on public.analyses, public.findings, public.notification_events to service_role;
grant select, insert
  on public.analysis_documents, public.finding_evidence, public.credit_ledger to service_role;
grant execute on function private.lock_analysis_references() to service_role;
grant execute on function private.validate_analysis_integrity(uuid) to service_role;
grant execute on function private.check_analysis_integrity() to service_role;

create view public.analysis_runs with (security_invoker = true) as
select
  a.id,
  a.workspace_id,
  a.initiator_id,
  a.status,
  a.fixed_cost,
  a.retry_of_analysis_id,
  a.created_at,
  a.started_at,
  a.finished_at,
  case when a.status = 'failed' then 'ANALYSIS_FAILED' else null end as public_error_code,
  p.full_name as initiator_full_name
from public.analyses a
join public.profiles p
  on p.id = a.initiator_id and p.workspace_id = a.workspace_id;

create view public.analysis_scope with (security_invoker = true) as
select
  s.analysis_id,
  s.workspace_id,
  s.document_id,
  d.name as document_name,
  d.category as document_category,
  d.owner_id,
  owner_profile.full_name as owner_full_name,
  s.version_id,
  v.version_number,
  s.role
from public.analysis_documents s
join public.documents d
  on d.id = s.document_id and d.workspace_id = s.workspace_id
join public.document_versions v
  on v.id = s.version_id
  and v.document_id = s.document_id
  and v.workspace_id = s.workspace_id
left join public.profiles owner_profile
  on owner_profile.id = d.owner_id and owner_profile.workspace_id = d.workspace_id;

create view public.analysis_findings with (security_invoker = true) as
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
  f.updated_at
from public.findings f
join public.analyses a
  on a.id = f.analysis_id and a.workspace_id = f.workspace_id
where a.status = 'completed';

create view public.analysis_finding_evidence with (security_invoker = true) as
select
  e.id,
  e.workspace_id,
  e.analysis_id,
  e.finding_id,
  e.document_id,
  e.version_id,
  e.chunk_id,
  e.page_number,
  e.section,
  e.section_heading,
  e.snapshot
from public.finding_evidence e
join public.analyses a
  on a.id = e.analysis_id and a.workspace_id = e.workspace_id
where a.status = 'completed';

revoke all on public.analysis_runs, public.analysis_scope,
  public.analysis_findings, public.analysis_finding_evidence
  from public, anon, authenticated, service_role;
grant select on public.analysis_runs, public.analysis_scope,
  public.analysis_findings, public.analysis_finding_evidence to authenticated;
