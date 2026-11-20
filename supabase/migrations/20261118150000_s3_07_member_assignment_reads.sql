-- Narrow, server-only projections for a Member's current review assignments.

create function private.review_assignment_workspace(p_actor_id uuid)
returns uuid
language plpgsql stable security definer
set search_path = '' set row_security = off
as $$
declare
  v_workspace_id uuid;
  v_role text;
begin
  select p.workspace_id, p.role::text into v_workspace_id, v_role
  from public.profiles p where p.id = p_actor_id;
  if not found or p_actor_id is null or v_role not in ('Admin', 'QA Lead', 'Member') then
    raise exception 'A workspace profile is required' using errcode = '42501';
  end if;
  return v_workspace_id;
end;
$$;
revoke all on function private.review_assignment_workspace(uuid)
  from public, anon, authenticated, service_role;

create function private.member_assignment_snapshot(
  p_workspace_id uuid,
  p_member_id uuid,
  p_finding_id uuid
) returns jsonb
language plpgsql stable security definer
set search_path = '' set row_security = off
as $$
declare
  v_finding public.findings%rowtype;
  v_member_name text;
  v_result jsonb;
begin
  select f.* into v_finding
  from public.findings f
  join public.analyses a on a.id = f.analysis_id and a.workspace_id = f.workspace_id
  where f.id = p_finding_id and f.workspace_id = p_workspace_id
    and f.assignee_id = p_member_id
    and f.status in ('pending_review', 'confirmed', 'update_planned')
    and a.status = 'completed';
  if not found then
    raise exception 'Assignment is unavailable' using errcode = 'P0002';
  end if;

  select p.full_name into v_member_name
  from public.profiles p where p.id = p_member_id and p.workspace_id = p_workspace_id
    and p.role = 'Member';
  if v_member_name is null then
    raise exception 'Assignment is unavailable' using errcode = 'P0002';
  end if;

  select pg_catalog.jsonb_build_object(
    'finding', pg_catalog.jsonb_build_object(
      'id', v_finding.id,
      'analysisId', v_finding.analysis_id,
      'type', v_finding.type,
      'explanation', v_finding.explanation,
      'severityOriginal', v_finding.severity_original,
      'severityCurrent', v_finding.severity_current,
      'status', v_finding.status,
      'assignee', pg_catalog.jsonb_build_object('id', p_member_id, 'fullName', v_member_name),
      'createdAt', v_finding.created_at,
      'revision', v_finding.review_revision,
      'canChangeStatus', false,
      'canChangeSeverity', false,
      'canAssign', false,
      'canPrepareRound', false
    ),
    'evidence', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', e.id,
        'documentId', e.document_id,
        'documentName', d.name,
        'versionId', e.version_id,
        'versionNumber', ev.version_number,
        'chunkId', e.chunk_id,
        'pageNumber', e.page_number,
        'section', e.section,
        'sectionHeading', e.section_heading,
        'snapshot', e.snapshot
      ) order by e.document_id, e.version_id, e.id)
      from public.finding_evidence e
      join public.documents d on d.id = e.document_id and d.workspace_id = e.workspace_id
      join public.document_versions ev on ev.id = e.version_id
        and ev.document_id = e.document_id and ev.workspace_id = e.workspace_id
      where e.finding_id = v_finding.id and e.workspace_id = p_workspace_id
    ), '[]'::jsonb),
    'documents', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'documentId', docs.id,
        'name', docs.name,
        'activeVersionId', docs.active_version_id,
        'activeVersionNumber', docs.active_version_number,
        'canSubmit', docs.can_submit
      ) order by docs.name, docs.id)
      from (
        select distinct d.id, d.name, av.id as active_version_id,
          av.version_number as active_version_number,
          av.id is not null and exists (
            select 1 from public.correction_round_items ri
            join public.correction_rounds r on r.id = ri.round_id
              and r.document_id = ri.document_id and r.workspace_id = ri.workspace_id
            where ri.finding_id = v_finding.id and ri.document_id = d.id
              and ri.workspace_id = p_workspace_id and ri.assignee_id = p_member_id
              and r.status = 'collecting' and r.base_version_id = d.active_version_id
          ) as can_submit
        from public.finding_evidence e
        join public.documents d on d.id = e.document_id and d.workspace_id = e.workspace_id
        left join public.document_versions av on av.id = d.active_version_id
          and av.document_id = d.id and av.workspace_id = d.workspace_id
          and av.version_status = 'active' and av.processing_status = 'ready'
        where e.finding_id = v_finding.id and e.workspace_id = p_workspace_id
      ) docs
    ), '[]'::jsonb),
    'rounds', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'roundId', r.id,
        'documentId', r.document_id,
        'phase', case r.status
          when 'collecting' then 'waiting'
          when 'consolidating' then 'consolidating'
          when 'candidate_processing' then 'processing'
          when 'candidate_failed' then 'processing'
          when 'pending_approval' then 'review'
          when 'approved' then 'approved'
          else 'waiting'
        end
      ) order by r.created_at desc, r.id)
      from public.correction_round_items ri
      join public.correction_rounds r on r.id = ri.round_id
        and r.document_id = ri.document_id and r.workspace_id = ri.workspace_id
      where ri.finding_id = v_finding.id and ri.workspace_id = p_workspace_id
        and ri.assignee_id = p_member_id
        and r.status in ('collecting', 'consolidating', 'candidate_processing', 'candidate_failed', 'pending_approval', 'approved')
    ), '[]'::jsonb),
    'ownSubmissions', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'submissionId', own.submission_id,
        'versionId', own.version_id,
        'state', own.state,
        'submitter', pg_catalog.jsonb_build_object('id', p_member_id, 'fullName', v_member_name),
        'itemIds', own.item_ids,
        'upload', own.upload,
        'confirmedAt', own.confirmed_at
      ) order by own.created_at, own.submission_id)
      from (
        select distinct s.id as submission_id, s.version_id, s.state, s.created_at, s.confirmed_at,
          coalesce((
            select pg_catalog.jsonb_agg(si.round_item_id order by si.round_item_id)
            from public.correction_submission_items si
            join public.correction_round_items ri on ri.id = si.round_item_id
              and ri.round_id = si.round_id and ri.document_id = si.document_id
              and ri.workspace_id = si.workspace_id
            where si.submission_id = s.id and si.workspace_id = p_workspace_id
              and ri.finding_id = v_finding.id and si.assignee_at_submit_id = p_member_id
          ), '[]'::jsonb) as item_ids,
          pg_catalog.jsonb_build_object(
            'versionId', v.id,
            'uploadState', v.upload_state,
            'attemptId', v.current_upload_attempt_id,
            'canOpen', v.upload_state = 'confirmed',
            'canResume', s.state = 'reserved' and s.expires_at > statement_timestamp(),
            'canRecover', false
          ) as upload
        from public.correction_submissions s
        join public.correction_rounds r on r.id = s.round_id
          and r.document_id = s.document_id and r.workspace_id = s.workspace_id
        join public.document_versions v on v.id = s.version_id
          and v.document_id = s.document_id and v.workspace_id = s.workspace_id
        join public.correction_submission_items si on si.submission_id = s.id
          and si.workspace_id = s.workspace_id
        join public.correction_round_items ri on ri.id = si.round_item_id
          and ri.round_id = si.round_id and ri.document_id = si.document_id
          and ri.workspace_id = si.workspace_id
        where s.workspace_id = p_workspace_id and s.submitter_id = p_member_id
          and ri.finding_id = v_finding.id and si.assignee_at_submit_id = p_member_id
          and s.state in ('reserved', 'confirmed')
          and r.status in ('collecting', 'consolidating', 'candidate_processing', 'candidate_failed', 'pending_approval')
      ) own
    ), '[]'::jsonb),
    'returns', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'itemId', ri.id,
        'reason', rti.reason,
        'createdAt', rti.created_at
      ) order by rti.created_at, ri.id)
      from public.correction_return_items rti
      join public.correction_returns rt on rt.id = rti.return_id
        and rt.round_id = rti.round_id and rt.document_id = rti.document_id
        and rt.workspace_id = rti.workspace_id
      join public.correction_round_items ri on ri.id = rti.round_item_id
        and ri.round_id = rti.round_id and ri.document_id = rti.document_id
        and ri.workspace_id = rti.workspace_id
      where ri.finding_id = v_finding.id and rti.workspace_id = p_workspace_id
        and rti.recipient_id = p_member_id
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;
revoke all on function private.member_assignment_snapshot(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

create function public.review_list_assignments(
  p_actor_id uuid, p_page bigint default 1, p_page_size integer default 25, p_status public.finding_status default null
) returns jsonb
language plpgsql security definer
set search_path = '' set row_security = off
set lock_timeout = '1s' set statement_timeout = '5s'
as $$
declare
  v_workspace_id uuid;
  v_role text;
  v_total bigint;
  v_items jsonb;
begin
  v_workspace_id := private.review_assignment_workspace(p_actor_id);
  select p.role::text into v_role from public.profiles p where p.id = p_actor_id;
  if v_role <> 'Member' then
    raise exception 'Member profile is required' using errcode = '42501';
  end if;
  if p_page is null or p_page < 1 or p_page > 9007199254740991
     or p_page_size is null or p_page_size < 1 or p_page_size > 100
     or p_status not in ('pending_review', 'confirmed', 'update_planned') then
    if p_status is not null or p_page is null or p_page < 1 or p_page_size is null or p_page_size < 1 or p_page_size > 100 then
      raise exception 'Invalid assignments page' using errcode = '22023';
    end if;
  end if;

  select pg_catalog.count(*) into v_total
  from public.findings f join public.analyses a on a.id = f.analysis_id and a.workspace_id = f.workspace_id
  where f.workspace_id = v_workspace_id and f.assignee_id = p_actor_id
    and f.status in ('pending_review', 'confirmed', 'update_planned') and a.status = 'completed'
    and (p_status is null or f.status = p_status);

  select coalesce(pg_catalog.jsonb_agg(private.member_assignment_snapshot(v_workspace_id, p_actor_id, rows.id)
    order by case rows.severity_current when 'High' then 1 when 'Medium' then 2 else 3 end,
      rows.created_at desc, rows.id), '[]'::jsonb)
  into v_items
  from (
    select f.id, f.severity_current, f.created_at
    from public.findings f join public.analyses a on a.id = f.analysis_id and a.workspace_id = f.workspace_id
    where f.workspace_id = v_workspace_id and f.assignee_id = p_actor_id
      and f.status in ('pending_review', 'confirmed', 'update_planned') and a.status = 'completed'
      and (p_status is null or f.status = p_status)
    order by case f.severity_current when 'High' then 1 when 'Medium' then 2 else 3 end,
      f.created_at desc, f.id
    limit p_page_size offset ((p_page - 1) * p_page_size)
  ) rows;

  return pg_catalog.jsonb_build_object(
    'items', v_items, 'total', v_total, 'page', p_page, 'pageSize', p_page_size
  );
end;
$$;
revoke all on function public.review_list_assignments(uuid, bigint, integer, public.finding_status)
  from public, anon, authenticated, service_role;
grant execute on function public.review_list_assignments(uuid, bigint, integer, public.finding_status) to service_role;

create function public.review_get_assignment(p_actor_id uuid, p_finding_id uuid) returns jsonb
language plpgsql security definer
set search_path = '' set row_security = off
set lock_timeout = '1s' set statement_timeout = '5s'
as $$
declare
  v_workspace_id uuid;
  v_role text;
begin
  v_workspace_id := private.review_assignment_workspace(p_actor_id);
  select p.role::text into v_role from public.profiles p where p.id = p_actor_id;
  if v_role <> 'Member' then
    raise exception 'Member profile is required' using errcode = '42501';
  end if;
  if p_finding_id is null then
    raise exception 'Assignment is unavailable' using errcode = 'P0002';
  end if;
  return private.member_assignment_snapshot(v_workspace_id, p_actor_id, p_finding_id);
end;
$$;
revoke all on function public.review_get_assignment(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.review_get_assignment(uuid, uuid) to service_role;

create function public.review_list_own_approvals(
  p_actor_id uuid, p_page bigint default 1, p_page_size integer default 25
) returns jsonb
language plpgsql security definer
set search_path = '' set row_security = off
set lock_timeout = '1s' set statement_timeout = '3s'
as $$
declare
  v_workspace_id uuid;
  v_role text;
  v_total bigint;
  v_items jsonb;
begin
  v_workspace_id := private.review_assignment_workspace(p_actor_id);
  select p.role::text into v_role from public.profiles p where p.id = p_actor_id;
  if v_role <> 'Member' then
    raise exception 'Member profile is required' using errcode = '42501';
  end if;
  if p_page is null or p_page < 1 or p_page > 9007199254740991
     or p_page_size is null or p_page_size < 1 or p_page_size > 100 then
    raise exception 'Invalid approval page' using errcode = '22023';
  end if;

  select pg_catalog.count(*) into v_total
  from public.correction_approval_contributions c
  where c.workspace_id = v_workspace_id and c.contributor_id = p_actor_id;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'approvalId', page_rows.approval_id,
    'documentId', page_rows.document_id,
    'approvedAt', page_rows.approved_at,
    'ownItemCount', page_rows.own_item_count
  ) order by page_rows.approved_at desc, page_rows.approval_id), '[]'::jsonb)
  into v_items
  from (
    select c.approval_id, c.document_id, c.approved_at, c.own_item_count
    from public.correction_approval_contributions c
    where c.workspace_id = v_workspace_id and c.contributor_id = p_actor_id
    order by c.approved_at desc, c.approval_id
    limit p_page_size offset ((p_page - 1) * p_page_size)
  ) page_rows;

  return pg_catalog.jsonb_build_object(
    'items', v_items, 'total', v_total, 'page', p_page, 'pageSize', p_page_size
  );
end;
$$;
revoke all on function public.review_list_own_approvals(uuid, bigint, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.review_list_own_approvals(uuid, bigint, integer) to service_role;

create or replace function public.get_review_workflow_document_path(p_user_id uuid, p_version_id uuid)
returns text
language plpgsql security invoker set search_path = '' as $$
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
            select 1 from public.findings f
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
    raise exception 'A document role is required' using errcode = '42501';
  end if;
  return canonical_path;
end;
$$;
revoke all on function public.get_review_workflow_document_path(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.get_review_workflow_document_path(uuid, uuid) to service_role;
