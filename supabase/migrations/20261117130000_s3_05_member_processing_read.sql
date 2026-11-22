create function private.review_processing_reader_workspace(
  p_actor_id uuid, p_round_id uuid
) returns uuid
language sql stable security definer
set search_path = '' set row_security = off
as $$
  select p.workspace_id
  from public.profiles p
  join public.correction_rounds r
    on r.id = p_round_id and r.workspace_id = p.workspace_id
  where p.id = p_actor_id
    and (
      p.role in ('Admin', 'QA Lead')
      or (
        p.role = 'Member'
        and exists (
          select 1
          from public.correction_submissions s
          where s.round_id = p_round_id
            and s.workspace_id = p.workspace_id
            and s.submitter_id = p.id
        )
      )
    )
$$;
revoke all on function private.review_processing_reader_workspace(uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.review_get_round_processing_status(
  p_actor_id uuid, p_round_id uuid
) returns table(
  round_id uuid,
  workspace_id uuid,
  candidate_id uuid,
  version_id uuid,
  document_id uuid,
  round_status public.correction_round_status,
  candidate_status public.correction_candidate_status,
  version_processing_status public.processing_status,
  version_version_status public.version_status,
  selection_kind public.correction_selection_kind,
  round_revision bigint,
  candidate_revision bigint,
  last_activity_at timestamptz
)
language sql stable security definer
set search_path = '' set row_security = off
as $$
  select q.round_id, q.workspace_id, q.candidate_id, q.version_id, q.document_id,
    q.round_status, q.candidate_status, q.version_processing_status,
    q.version_version_status, q.selection_kind, q.round_revision,
    q.candidate_revision, q.last_activity_at
  from public.correction_candidate_queue q
  where q.workspace_id = private.review_processing_reader_workspace(p_actor_id, p_round_id)
    and q.round_id = p_round_id
$$;
revoke all on function public.review_get_round_processing_status(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.review_get_round_processing_status(uuid, uuid)
  to service_role;

notify pgrst, 'reload schema';
