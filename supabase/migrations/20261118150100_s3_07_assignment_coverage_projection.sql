-- Keep Member-visible round progress scoped to the Member's own items only.

create function private.member_assignment_round_projection(
  p_workspace_id uuid,
  p_member_id uuid,
  p_finding_id uuid
) returns jsonb
language sql stable security definer
set search_path = '' set row_security = off
as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'roundId', r.id,
    'documentId', r.document_id,
    'phase', case r.status
      when 'collecting' then 'waiting'
      when 'consolidating' then 'consolidating'
      when 'candidate_processing' then 'processing'
      when 'candidate_failed' then 'processing_failed'
      when 'pending_approval' then 'review'
      when 'approved' then 'approved'
      else 'waiting'
    end,
    'ownCoverage', pg_catalog.jsonb_build_object(
      'complete', coverage.required_count > 0 and coverage.covered_count = coverage.required_count,
      'coveredItemCount', coverage.covered_count,
      'requiredItemCount', coverage.required_count
    )
  ) order by r.created_at desc, r.id), '[]'::jsonb)
  from public.correction_round_items own_item
  join public.correction_rounds r on r.id = own_item.round_id
    and r.document_id = own_item.document_id and r.workspace_id = own_item.workspace_id
  cross join lateral (
    select count(*)::integer as required_count,
      count(*) filter (where ri.current_submission_id is not null)::integer as covered_count
    from public.correction_round_items ri
    where ri.round_id = r.id and ri.workspace_id = p_workspace_id
      and ri.assignee_id = p_member_id
  ) coverage
  where own_item.finding_id = p_finding_id and own_item.workspace_id = p_workspace_id
    and own_item.assignee_id = p_member_id
    and r.status in ('collecting', 'consolidating', 'candidate_processing', 'candidate_failed', 'pending_approval', 'approved')
$$;
revoke all on function private.member_assignment_round_projection(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.review_list_assignments(
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
     or (p_status is not null and p_status not in ('pending_review', 'confirmed', 'update_planned')) then
    raise exception 'Invalid assignments page' using errcode = '22023';
  end if;

  select pg_catalog.count(*) into v_total
  from public.findings f join public.analyses a on a.id = f.analysis_id and a.workspace_id = f.workspace_id
  where f.workspace_id = v_workspace_id and f.assignee_id = p_actor_id
    and f.status in ('pending_review', 'confirmed', 'update_planned') and a.status = 'completed'
    and (p_status is null or f.status = p_status);

  select coalesce(pg_catalog.jsonb_agg(
    private.member_assignment_snapshot(v_workspace_id, p_actor_id, rows.id)
      || pg_catalog.jsonb_build_object(
        'rounds', private.member_assignment_round_projection(v_workspace_id, p_actor_id, rows.id)
      )
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

create or replace function public.review_get_assignment(p_actor_id uuid, p_finding_id uuid) returns jsonb
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
  return private.member_assignment_snapshot(v_workspace_id, p_actor_id, p_finding_id)
    || pg_catalog.jsonb_build_object(
      'rounds', private.member_assignment_round_projection(v_workspace_id, p_actor_id, p_finding_id)
    );
end;
$$;
