-- Narrow, session-derived capabilities for the human review workflow.

create function private.current_review_finding_allowed(p_finding_id uuid)
returns boolean
language sql stable security definer
set search_path = '' set row_security = off
as $$
  select exists (
    select 1
    from public.findings f
    join public.analyses a on a.id = f.analysis_id and a.workspace_id = f.workspace_id
    join public.profiles p on p.id = (select auth.uid()) and p.workspace_id = f.workspace_id
    where f.id = p_finding_id
      and p.role = 'Member'
      and f.assignee_id = p.id
      and f.status in ('pending_review', 'confirmed', 'update_planned')
      and a.status = 'completed'
  )
$$;

create function private.current_review_item_allowed(p_round_item_id uuid)
returns boolean
language sql stable security definer
set search_path = '' set row_security = off
as $$
  select exists (
    select 1
    from public.correction_round_items i
    join public.correction_rounds r
      on r.id = i.round_id and r.workspace_id = i.workspace_id
    where i.id = p_round_item_id
      and i.assignee_id = (select auth.uid())
      and r.status in ('collecting', 'consolidating', 'candidate_processing', 'candidate_failed', 'pending_approval')
      and private.current_review_finding_allowed(i.finding_id)
  )
$$;

create function private.current_review_submission_allowed(p_submission_id uuid)
returns boolean
language sql stable security definer
set search_path = '' set row_security = off
as $$
  select exists (
    select 1
    from public.correction_submissions s
    join public.correction_rounds r
      on r.id = s.round_id and r.document_id = s.document_id and r.workspace_id = s.workspace_id
    join public.profiles p on p.id = (select auth.uid()) and p.workspace_id = s.workspace_id
    where s.id = p_submission_id
      and p.role = 'Member'
      and s.submitter_id = p.id
      and s.state in ('reserved', 'confirmed')
      and r.status in ('collecting', 'consolidating', 'candidate_processing', 'candidate_failed', 'pending_approval')
      and (s.state <> 'reserved' or (r.status = 'collecting' and s.expires_at > statement_timestamp()))
      and exists (
        select 1
        from public.correction_submission_items si
        join public.correction_round_items i
          on i.id = si.round_item_id and i.round_id = si.round_id
         and i.document_id = si.document_id and i.workspace_id = si.workspace_id
        where si.submission_id = s.id
          and i.assignee_id = p.id
          and i.revision = si.expected_revision
          and private.current_review_item_allowed(i.id)
          and (s.state = 'reserved' or i.current_submission_id = s.id)
      )
  )
$$;

create function private.current_review_version_allowed(p_version_id uuid)
returns boolean
language sql stable security definer
set search_path = '' set row_security = off
as $$
  select exists (
    select 1
    from public.document_versions v
    join public.documents d on d.id = v.document_id and d.workspace_id = v.workspace_id
    join public.profiles p on p.id = (select auth.uid()) and p.workspace_id = v.workspace_id
    where v.id = p_version_id
      and p.role = 'Member'
      and (
        (
          v.processing_status = 'ready'
          and v.version_status = 'active'
          and d.active_version_id = v.id
          and exists (
            select 1
            from public.findings f
            join public.analyses a on a.id = f.analysis_id and a.workspace_id = f.workspace_id
            join public.finding_evidence e
              on e.finding_id = f.id and e.analysis_id = f.analysis_id and e.workspace_id = f.workspace_id
            where f.workspace_id = v.workspace_id
              and e.document_id = v.document_id
              and f.assignee_id = p.id
              and f.status in ('pending_review', 'confirmed', 'update_planned')
              and a.status = 'completed'
          )
        )
        or (
          v.workflow_kind = 'correction_submission'
          and v.upload_state = 'confirmed'
          and exists (
            select 1 from public.correction_submissions s
            where s.version_id = v.id
              and private.current_review_submission_allowed(s.id)
          )
        )
      )
  )
$$;

create policy findings_review_assignment_read on public.findings
  for select to authenticated
  using (private.current_review_finding_allowed(id));

create policy finding_evidence_review_assignment_read on public.finding_evidence
  for select to authenticated
  using (private.current_review_finding_allowed(finding_id));

create policy correction_rounds_review_read on public.correction_rounds
  for select to authenticated
  using (
    (workspace_id = (select private.current_workspace_id())
      and (select private.current_workspace_role()) in ('Admin', 'QA Lead'))
    or (
      exists (
        select 1 from public.correction_round_items i
        where i.round_id = correction_rounds.id
          and private.current_review_item_allowed(i.id)
      )
    )
  );

create policy correction_round_items_review_read on public.correction_round_items
  for select to authenticated
  using (
    (workspace_id = (select private.current_workspace_id())
      and (select private.current_workspace_role()) in ('Admin', 'QA Lead'))
    or private.current_review_item_allowed(id)
  );

create policy correction_submissions_review_read on public.correction_submissions
  for select to authenticated
  using (
    (workspace_id = (select private.current_workspace_id())
      and (select private.current_workspace_role()) in ('Admin', 'QA Lead'))
    or private.current_review_submission_allowed(id)
  );

create policy correction_submission_items_review_read on public.correction_submission_items
  for select to authenticated
  using (
    (workspace_id = (select private.current_workspace_id())
      and (select private.current_workspace_role()) in ('Admin', 'QA Lead'))
    or (
      private.current_review_submission_allowed(submission_id)
      and private.current_review_item_allowed(round_item_id)
      and assignee_at_submit_id = (select auth.uid())
    )
  );

create policy correction_candidates_review_read on public.correction_candidates
  for select to authenticated
  using (workspace_id = (select private.current_workspace_id())
    and (select private.current_workspace_role()) in ('Admin', 'QA Lead'));

create policy correction_candidate_items_review_read on public.correction_candidate_items
  for select to authenticated
  using (workspace_id = (select private.current_workspace_id())
    and (select private.current_workspace_role()) in ('Admin', 'QA Lead'));

create policy correction_returns_review_read on public.correction_returns
  for select to authenticated
  using (
    (workspace_id = (select private.current_workspace_id())
      and (select private.current_workspace_role()) in ('Admin', 'QA Lead'))
    or exists (
      select 1 from public.correction_return_items i
      where i.return_id = correction_returns.id
        and i.recipient_id = (select auth.uid())
        and private.current_review_item_allowed(i.round_item_id)
    )
  );

create policy correction_return_items_review_read on public.correction_return_items
  for select to authenticated
  using (
    (workspace_id = (select private.current_workspace_id())
      and (select private.current_workspace_role()) in ('Admin', 'QA Lead'))
    or (recipient_id = (select auth.uid())
      and private.current_review_item_allowed(round_item_id))
  );

create policy correction_candidate_decisions_review_read on public.correction_candidate_decisions
  for select to authenticated
  using (workspace_id = (select private.current_workspace_id())
    and (select private.current_workspace_role()) in ('Admin', 'QA Lead'));

create policy correction_approval_contributions_review_read on public.correction_approval_contributions
  for select to authenticated
  using (
    (workspace_id = (select private.current_workspace_id())
      and (select private.current_workspace_role()) in ('Admin', 'QA Lead'))
    or (workspace_id = (select private.current_workspace_id())
      and contributor_id = (select auth.uid())
      and (select private.current_workspace_role()) = 'Member')
  );

grant select (assignee_id, review_revision) on public.findings to authenticated;

grant select (id, mode, status, revision, opened_at, created_at)
  on public.correction_rounds to authenticated;
grant select (id, round_id, finding_id, assignee_id, revision, current_submission_id, created_at)
  on public.correction_round_items to authenticated;
grant select (id, round_id, submitter_id, state, reserved_at, expires_at, confirmed_at, created_at)
  on public.correction_submissions to authenticated;
grant select (submission_id, round_item_id, assignee_at_submit_id, expected_revision, created_at)
  on public.correction_submission_items to authenticated;
grant select (id, round_id, document_id, selection_kind, status, coverage_revision, revision, selected_by, created_at, updated_at)
  on public.correction_candidates to authenticated;
grant select (candidate_id, round_item_id, submission_id, item_revision, created_at)
  on public.correction_candidate_items to authenticated;
grant select (id, round_id, created_at)
  on public.correction_returns to authenticated;
grant select (return_id, round_item_id, recipient_id, reason, created_at)
  on public.correction_return_items to authenticated;
grant select (id, document_id, candidate_id, actor_id, outcome, retention, created_at)
  on public.correction_candidate_decisions to authenticated;
grant select (approval_id, contributor_id, own_item_count, approved_at)
  on public.correction_approval_contributions to authenticated;

revoke all on function private.current_review_finding_allowed(uuid),
  private.current_review_item_allowed(uuid), private.current_review_submission_allowed(uuid),
  private.current_review_version_allowed(uuid)
  from public, anon, service_role;
grant execute on function private.current_review_finding_allowed(uuid),
  private.current_review_item_allowed(uuid), private.current_review_submission_allowed(uuid),
  private.current_review_version_allowed(uuid)
  to authenticated;

comment on function private.current_review_finding_allowed(uuid) is
  'Member capability for a completed-analysis finding with a current persisted assignment and operational status.';
comment on function private.current_review_submission_allowed(uuid) is
  'Member capability for an own current reservation or confirmed submission in an active correction round.';
comment on function private.current_review_version_allowed(uuid) is
  'Member capability for a related active document version or an own confirmed submission with current assignment access.';
