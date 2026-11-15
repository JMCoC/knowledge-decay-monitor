-- S3-02 separates submission authorization from the content it contributes.
-- All replacements are additive; S3-01 migrations remain immutable.

create or replace function private.guard_correction_round() returns trigger
language plpgsql security definer
set search_path = '' set row_security = off
as $$
declare
  active_version_id uuid;
  item_count bigint;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' or new.revision <> 1 or new.opened_at is not null
       or new.active_candidate_id is not null then
      raise exception 'A correction round must begin as a draft' using errcode = '23514';
    end if;
    if not private.review_profile_has_role(new.created_by, new.workspace_id, array['Admin', 'QA Lead']) then
      raise exception 'A reviewer profile is required to prepare a correction round' using errcode = '23514';
    end if;
    return new;
  end if;

  if new.id is distinct from old.id
     or new.workspace_id is distinct from old.workspace_id
     or new.document_id is distinct from old.document_id
     or new.mode is distinct from old.mode
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'Correction round identity is immutable' using errcode = '23514';
  end if;
  if old.status <> 'draft' and new.base_version_id is distinct from old.base_version_id then
    raise exception 'An opened correction round cannot change its base version' using errcode = '23514';
  end if;
  if new.revision < old.revision then
    raise exception 'Correction round revision cannot decrease' using errcode = '23514';
  end if;
  if new.coverage_revision < old.coverage_revision
     or new.coverage_revision > old.coverage_revision + 1 then
    raise exception 'Correction round coverage revision must stay or advance once' using errcode = '23514';
  end if;
  if new.status is distinct from old.status then
    if new.revision <> old.revision + 1 then
      raise exception 'A correction round transition must advance its revision' using errcode = '23514';
    end if;
    if not (
      (old.status = 'draft' and new.status in ('collecting', 'consolidating', 'cancelled'))
      or (old.status = 'collecting' and new.status in ('consolidating', 'cancelled'))
      or (old.status = 'consolidating' and new.status in ('collecting', 'candidate_processing', 'candidate_failed', 'cancelled'))
      or (old.status = 'candidate_processing' and new.status in ('pending_approval', 'candidate_failed'))
      or (old.status = 'candidate_failed' and new.status in ('candidate_processing', 'collecting', 'consolidating', 'cancelled'))
      or (old.status = 'pending_approval' and new.status in ('approved', 'collecting', 'consolidating', 'cancelled'))
    ) then
      raise exception 'Invalid correction round transition' using errcode = '23514';
    end if;
    if old.status = 'collecting' and new.status = 'consolidating'
       and new.mode = 'assigned_findings' and exists (
         select 1 from public.correction_round_items i
         where i.round_id = new.id and (
           i.current_submission_id is null or not exists (
             select 1 from public.correction_submissions s
             where s.id = i.current_submission_id and s.round_id = i.round_id
               and s.document_id = i.document_id and s.workspace_id = i.workspace_id
               and s.state = 'confirmed'
           )
         )
       ) then
      raise exception 'Assigned correction round requires complete confirmed coverage to consolidate' using errcode = '23514';
    end if;
  end if;
  if old.opened_at is not null and new.opened_at is distinct from old.opened_at then
    raise exception 'Correction round opening time is immutable' using errcode = '23514';
  end if;

  if old.status = 'draft' and new.status in ('collecting', 'consolidating') then
    select d.active_version_id into active_version_id
    from public.documents d
    join public.document_versions v
      on v.id = new.base_version_id and v.document_id = d.id and v.workspace_id = d.workspace_id
    where d.id = new.document_id and d.workspace_id = new.workspace_id
      and d.active_version_id = new.base_version_id
      and v.processing_status = 'ready' and v.version_status = 'active';
    if not found or active_version_id is distinct from new.base_version_id then
      raise exception 'Correction round base is not the active ready version' using errcode = '23514';
    end if;
    if new.opened_at is null then
      raise exception 'Opening a correction round requires an opening time' using errcode = '23514';
    end if;
    select count(*) into item_count from public.correction_round_items i
    where i.round_id = new.id and i.document_id = new.document_id and i.workspace_id = new.workspace_id;
    if new.mode = 'assigned_findings' and new.status = 'collecting' then
      update public.correction_round_items i
      set opened_assignee_id = i.assignee_id
      where i.round_id = new.id and i.opened_assignee_id is null;
    end if;
    if new.mode = 'administrative' then
      if new.status <> 'consolidating' or item_count <> 0 then
        raise exception 'Administrative drafts open directly to an empty consolidating round' using errcode = '23514';
      end if;
    elsif new.status <> 'collecting' then
      raise exception 'Assigned finding drafts open to collection' using errcode = '23514';
    elsif item_count = 0 or exists (
      select 1
      from public.correction_round_items i
      join public.findings f on f.id = i.finding_id and f.workspace_id = i.workspace_id
      where i.round_id = new.id and i.document_id = new.document_id and i.workspace_id = new.workspace_id
        and (f.status not in ('confirmed', 'update_planned')
          or f.assignee_id is null or f.assignee_id is distinct from i.assignee_id
          or i.opened_assignee_id is distinct from i.assignee_id
          or not private.review_profile_has_role(i.assignee_id, i.workspace_id, array['Member'])
          or not private.review_profile_has_role(i.opened_assignee_id, i.workspace_id, array['Member']))
    ) then
      raise exception 'Assigned correction round findings must be confirmed, evidenced, and snapshotted to Members' using errcode = '23514';
    end if;
  elsif new.status not in ('draft', 'cancelled') and new.mode = 'assigned_findings' then
    select count(*) into item_count from public.correction_round_items i
    where i.round_id = new.id and i.document_id = new.document_id and i.workspace_id = new.workspace_id;
    if item_count = 0 then
      raise exception 'An assigned correction round cannot be empty' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create or replace function private.guard_correction_round_item() returns trigger
language plpgsql security definer
set search_path = '' set row_security = off
as $$
declare
  parent_round public.correction_rounds%rowtype;
  finding_assignee uuid;
begin
  if tg_op = 'DELETE' then
    select r.* into parent_round from public.correction_rounds r where r.id = old.round_id;
    if found and parent_round.status <> 'draft' then
      raise exception 'Opened correction round items are retained' using errcode = '23514';
    end if;
    return old;
  end if;

  select r.* into parent_round from public.correction_rounds r where r.id = new.round_id;
  if not found then
    raise exception 'Correction round item requires a parent round' using errcode = '23503';
  end if;
  if tg_op = 'INSERT' then
    if parent_round.status <> 'draft' or parent_round.mode <> 'assigned_findings' then
      raise exception 'Finding items can only be prepared on an assigned draft round' using errcode = '23514';
    end if;
    select f.assignee_id into finding_assignee
    from public.findings f where f.id = new.finding_id and f.workspace_id = new.workspace_id;
    if not found then raise exception 'Review finding was not found' using errcode = '23503'; end if;
    if not exists (
      select 1 from public.finding_evidence e
      where e.finding_id = new.finding_id and e.document_id = new.document_id
        and e.workspace_id = new.workspace_id
    ) then
      raise exception 'Finding has no evidence from the correction round document' using errcode = '23514';
    end if;
    if new.assignee_id is distinct from finding_assignee
       or new.initial_assignee_id is distinct from finding_assignee
       or new.opened_assignee_id is not null then
      raise exception 'Round item assignee must snapshot the finding assignment' using errcode = '23514';
    end if;
  else
    if new.id is distinct from old.id or new.workspace_id is distinct from old.workspace_id
       or new.round_id is distinct from old.round_id or new.document_id is distinct from old.document_id
       or new.finding_id is distinct from old.finding_id
       or new.initial_assignee_id is distinct from old.initial_assignee_id
       or new.created_at is distinct from old.created_at then
      raise exception 'Correction round item identity is immutable' using errcode = '23514';
    end if;
    if new.opened_assignee_id is distinct from old.opened_assignee_id then
      if old.opened_assignee_id is not null or parent_round.status <> 'draft'
         or new.opened_assignee_id is distinct from new.assignee_id
         or not private.review_profile_has_role(new.opened_assignee_id, new.workspace_id, array['Member']) then
        raise exception 'Opening assignee is set once from a draft item assignment' using errcode = '23514';
      end if;
    end if;
    if new.assignee_id is distinct from old.assignee_id then
      select f.assignee_id into finding_assignee
      from public.findings f where f.id = new.finding_id and f.workspace_id = new.workspace_id;
      if not found or finding_assignee is distinct from new.assignee_id then
        raise exception 'Round item assignment must match its finding assignment' using errcode = '23514';
      end if;
      if parent_round.status not in ('draft', 'collecting', 'consolidating', 'candidate_processing', 'candidate_failed', 'pending_approval')
         or new.revision <> old.revision + 1
         or new.current_submission_id is distinct from old.current_submission_id
         or new.coverage_revision is distinct from old.coverage_revision then
        raise exception 'Reassignment advances authorization and preserves confirmed coverage' using errcode = '23514';
      end if;
    elsif new.revision is distinct from old.revision then
      if new.revision <> old.revision + 1 then
        raise exception 'Round item revision must advance exactly once' using errcode = '23514';
      elsif new.current_submission_id is distinct from old.current_submission_id
         or new.coverage_revision is distinct from old.coverage_revision then
        if old.current_submission_id is null or new.current_submission_id is not null
           or new.coverage_revision <> old.coverage_revision + 1
           or not exists (
             select 1 from public.correction_return_items ri
             where ri.round_item_id = old.id and ri.round_id = old.round_id
               and ri.document_id = old.document_id and ri.workspace_id = old.workspace_id
               and ri.previous_submission_id = old.current_submission_id
           ) then
          raise exception 'Returned item must clear coverage under its recorded return' using errcode = '23514';
        end if;
      elsif not exists (
        select 1 from public.findings f
        where f.id = new.finding_id and f.workspace_id = new.workspace_id
          and f.status = 'resolved'
      ) then
        raise exception 'Round item revision changes only with a return or finding resolution' using errcode = '23514';
      end if;
    elsif new.current_submission_id is distinct from old.current_submission_id then
      if new.coverage_revision <> old.coverage_revision + 1 then
        raise exception 'Replacing item coverage must advance its coverage revision' using errcode = '23514';
      end if;
      if old.current_submission_id is not null and new.current_submission_id is null
         and not exists (
           select 1 from public.correction_return_items ri
           where ri.round_item_id = old.id and ri.round_id = old.round_id
             and ri.document_id = old.document_id and ri.workspace_id = old.workspace_id
             and ri.previous_submission_id = old.current_submission_id
         ) then
        raise exception 'Removing confirmed coverage requires its recorded return' using errcode = '23514';
      end if;
      if exists (
        select 1 from public.correction_candidates c
        where c.round_id = old.round_id and c.status in ('reserved', 'selected', 'processing', 'failed', 'pending_approval')
      ) then
        raise exception 'Current candidate must be invalidated before replacing item coverage' using errcode = '23514';
      end if;
    elsif new.coverage_revision is distinct from old.coverage_revision then
      raise exception 'Item coverage revision changes only with replacement or return' using errcode = '23514';
    end if;
  end if;

  if new.initial_assignee_id is not null
     and not private.review_profile_has_role(new.initial_assignee_id, new.workspace_id, array['Member']) then
    raise exception 'Initial assignee must be a Member in the workspace' using errcode = '23514';
  end if;
  if new.assignee_id is not null
     and not private.review_profile_has_role(new.assignee_id, new.workspace_id, array['Member']) then
    raise exception 'Current assignee must be a Member in the workspace' using errcode = '23514';
  end if;
  if new.opened_assignee_id is not null
     and not private.review_profile_has_role(new.opened_assignee_id, new.workspace_id, array['Member']) then
    raise exception 'Opening assignee must be a Member in the workspace' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function private.guard_correction_candidate() returns trigger
language plpgsql security definer
set search_path = '' set row_security = off
as $$
declare
  parent_round public.correction_rounds%rowtype;
  file_version public.document_versions%rowtype;
  allowed_transition boolean;
begin
  if tg_op = 'DELETE' then
    raise exception 'Correction candidate history is append-only' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then
    select r.* into parent_round from public.correction_rounds r
    where r.id = new.round_id and r.document_id = new.document_id and r.workspace_id = new.workspace_id;
    if not found or parent_round.status <> 'consolidating'
       or parent_round.base_version_id is distinct from new.base_version_id then
      raise exception 'Final candidate requires a consolidating round and its fixed base' using errcode = '23514';
    end if;
    if not private.review_profile_has_role(new.selected_by, new.workspace_id, array['Admin', 'QA Lead']) then
      raise exception 'Only a workspace reviewer can select a final candidate' using errcode = '23514';
    end if;
    if parent_round.mode = 'administrative' and new.selection_kind <> 'consolidated' then
      raise exception 'Administrative correction proposals require a consolidated upload' using errcode = '23514';
    end if;
    select v.* into file_version from public.document_versions v
    where v.id = new.version_id and v.document_id = new.document_id and v.workspace_id = new.workspace_id;
    if not found then raise exception 'Candidate version was not found' using errcode = '23503'; end if;
    if new.selection_kind = 'direct' then
      if new.source_submission_id is null or new.status <> 'selected'
         or file_version.workflow_kind <> 'correction_submission'
         or not exists (
           select 1 from public.correction_submissions s
           where s.id = new.source_submission_id and s.round_id = new.round_id
             and s.document_id = new.document_id and s.workspace_id = new.workspace_id
             and s.version_id = new.version_id and s.state = 'confirmed'
         ) then
        raise exception 'Direct candidate must reuse one confirmed submission version' using errcode = '23514';
      end if;
    elsif file_version.workflow_kind <> 'correction_candidate'
       or new.source_submission_id is not null or new.status not in ('reserved', 'selected') then
      raise exception 'Consolidated candidate must reference its separately reserved candidate upload' using errcode = '23514';
    end if;
    if new.status = 'selected'
       and (file_version.upload_state <> 'confirmed' or file_version.upload_confirmed_at is null) then
      raise exception 'A final candidate can only be selected after upload confirmation' using errcode = '23514';
    end if;
    if new.status = 'selected' and new.coverage_revision is distinct from parent_round.coverage_revision then
      raise exception 'Candidate coverage revision must match the round at selection' using errcode = '23514';
    end if;
    return new;
  end if;

  if new.id is distinct from old.id or new.workspace_id is distinct from old.workspace_id
     or new.round_id is distinct from old.round_id or new.document_id is distinct from old.document_id
     or new.base_version_id is distinct from old.base_version_id or new.version_id is distinct from old.version_id
     or new.source_submission_id is distinct from old.source_submission_id
     or new.selected_by is distinct from old.selected_by or new.selection_kind is distinct from old.selection_kind
     or new.coverage_revision is distinct from old.coverage_revision
     or new.idempotency_key is distinct from old.idempotency_key
     or new.created_at is distinct from old.created_at then
    raise exception 'Correction candidate identity and source are immutable' using errcode = '23514';
  end if;
  if new.revision < old.revision then
    raise exception 'Correction candidate revision cannot decrease' using errcode = '23514';
  end if;
  if new.status is distinct from old.status then
    if new.revision <> old.revision + 1 then
      raise exception 'A correction candidate transition must advance its revision' using errcode = '23514';
    end if;
    allowed_transition :=
      (old.status = 'reserved' and new.status in ('selected', 'invalidated'))
      or (old.status = 'selected' and new.status in ('processing', 'failed', 'invalidated'))
      or (old.status = 'processing' and new.status in ('pending_approval', 'failed', 'invalidated'))
      or (old.status = 'failed' and new.status in ('processing', 'invalidated'))
      or (old.status = 'pending_approval' and new.status in ('approved', 'rejected', 'invalidated'));
    if not allowed_transition then
      raise exception 'Invalid correction candidate transition' using errcode = '23514';
    end if;
  end if;
  if new.status = 'selected' then
    select r.* into parent_round from public.correction_rounds r
    where r.id = new.round_id and r.document_id = new.document_id and r.workspace_id = new.workspace_id;
    select v.* into file_version from public.document_versions v
    where v.id = new.version_id and v.document_id = new.document_id and v.workspace_id = new.workspace_id;
    if file_version.upload_state <> 'confirmed' or file_version.upload_confirmed_at is null then
      raise exception 'A final candidate can only be selected after upload confirmation' using errcode = '23514';
    end if;
    if new.coverage_revision is distinct from parent_round.coverage_revision then
      raise exception 'Candidate coverage revision must match the round at selection' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create or replace function private.guard_correction_candidate_item() returns trigger
language plpgsql security definer
set search_path = '' set row_security = off
as $$
declare
  parent_candidate public.correction_candidates%rowtype;
  round_item public.correction_round_items%rowtype;
begin
  if tg_op <> 'INSERT' then
    raise exception 'Candidate coverage snapshots are immutable' using errcode = '23514';
  end if;
  select c.* into parent_candidate from public.correction_candidates c
  where c.id = new.candidate_id and c.round_id = new.round_id
    and c.document_id = new.document_id and c.workspace_id = new.workspace_id;
  if not found or parent_candidate.status <> 'selected' then
    raise exception 'Candidate coverage can only be snapshotted at selection' using errcode = '23514';
  end if;
  select i.* into round_item from public.correction_round_items i
  where i.id = new.round_item_id and i.round_id = new.round_id
    and i.document_id = new.document_id and i.workspace_id = new.workspace_id;
  if not found or round_item.current_submission_id is distinct from new.submission_id
     or round_item.coverage_revision is distinct from new.item_revision
     or not exists (select 1 from public.correction_rounds r
       where r.id = new.round_id and r.coverage_revision = parent_candidate.coverage_revision) then
    raise exception 'Candidate snapshot does not match current confirmed item coverage' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function private.assert_review_round(p_round_id uuid) returns void
language plpgsql security definer
set search_path = '' set row_security = off
as $$
declare
  r public.correction_rounds%rowtype;
  item_count bigint;
  candidate_status public.correction_candidate_status;
begin
  select x.* into r from public.correction_rounds x where x.id = p_round_id;
  if not found then return; end if;
  select count(*) into item_count from public.correction_round_items i where i.round_id = r.id;
  if r.mode = 'administrative' and item_count <> 0 then
    raise exception 'Administrative correction rounds cannot contain finding items' using errcode = '23514';
  end if;
  if r.mode = 'assigned_findings' and r.status not in ('draft', 'cancelled') and item_count = 0 then
    raise exception 'An assigned correction round cannot be empty' using errcode = '23514';
  end if;
  if r.mode = 'assigned_findings' and r.status in ('consolidating', 'candidate_processing', 'candidate_failed', 'pending_approval')
     and exists (
       select 1 from public.correction_round_items i
       where i.round_id = r.id and (
         i.current_submission_id is null or not exists (
           select 1 from public.correction_submissions s
           where s.id = i.current_submission_id and s.round_id = i.round_id
             and s.document_id = i.document_id and s.workspace_id = i.workspace_id
             and s.state = 'confirmed'
         )
       )
     ) then
    raise exception 'Consolidating correction round requires complete confirmed coverage' using errcode = '23514';
  end if;
  if r.status in ('collecting', 'consolidating', 'candidate_processing', 'candidate_failed', 'pending_approval')
     and not exists (
       select 1 from public.documents d join public.document_versions v
         on v.id = r.base_version_id and v.document_id = d.id and v.workspace_id = d.workspace_id
       where d.id = r.document_id and d.workspace_id = r.workspace_id
         and d.active_version_id = r.base_version_id
         and v.processing_status = 'ready' and v.version_status = 'active'
     ) then
    raise exception 'An active correction round must retain its active ready base' using errcode = '23514';
  end if;
  if r.status <> 'draft' and r.status <> 'cancelled' and r.opened_at is null then
    raise exception 'A non-draft correction round requires an opening time' using errcode = '23514';
  end if;
  if r.status in ('candidate_processing', 'candidate_failed', 'pending_approval', 'approved')
     and r.active_candidate_id is null then
    raise exception 'Candidate workflow round requires an active candidate pointer' using errcode = '23514';
  end if;
  if r.active_candidate_id is not null then
    select c.status into candidate_status from public.correction_candidates c
    where c.id = r.active_candidate_id and c.round_id = r.id
      and c.document_id = r.document_id and c.workspace_id = r.workspace_id;
    if not found or candidate_status not in ('selected', 'processing', 'failed', 'pending_approval', 'approved') then
      raise exception 'Correction round active candidate pointer is stale' using errcode = '23514';
    end if;
    if exists (select 1 from public.correction_candidates c
      where c.id = r.active_candidate_id and c.coverage_revision is distinct from r.coverage_revision) then
      raise exception 'Active candidate must retain the round coverage fence' using errcode = '23514';
    end if;
  end if;
  if r.status = 'candidate_processing' and not exists (
    select 1 from public.correction_candidates c
    where c.id = r.active_candidate_id and c.status in ('selected', 'processing')
  ) then
    raise exception 'Processing round requires a selected or processing candidate' using errcode = '23514';
  end if;
  if r.status = 'candidate_failed' and not exists (
    select 1 from public.correction_candidates c
    where c.id = r.active_candidate_id and c.status = 'failed'
  ) then
    raise exception 'Failed round requires a failed candidate' using errcode = '23514';
  end if;
  if r.status = 'pending_approval' and not exists (
    select 1 from public.correction_candidates c
    where c.id = r.active_candidate_id and c.status = 'pending_approval'
  ) then
    raise exception 'Approval round requires a ready pending candidate' using errcode = '23514';
  end if;
  if r.status = 'approved' and not exists (
    select 1 from public.correction_candidates c
    where c.id = r.active_candidate_id and c.status = 'approved'
  ) then
    raise exception 'Approved round requires an approved candidate' using errcode = '23514';
  end if;
  if r.status in ('collecting', 'consolidating', 'cancelled') and r.active_candidate_id is not null then
    raise exception 'A collecting, consolidating, or cancelled round cannot retain an active candidate pointer' using errcode = '23514';
  end if;
end;
$$;

create or replace function private.assert_review_round_item(p_item_id uuid) returns void
language plpgsql security definer
set search_path = '' set row_security = off
as $$
declare
  i public.correction_round_items%rowtype;
  r public.correction_rounds%rowtype;
begin
  select x.* into i from public.correction_round_items x where x.id = p_item_id;
  if not found then return; end if;
  select x.* into r from public.correction_rounds x where x.id = i.round_id;
  if not found or r.mode <> 'assigned_findings' then
    raise exception 'Round finding item requires an assigned findings round' using errcode = '23514';
  end if;
  if not exists (
    select 1 from public.finding_evidence e
    where e.finding_id = i.finding_id and e.document_id = i.document_id and e.workspace_id = i.workspace_id
  ) then
    raise exception 'Round finding must have evidence from its document' using errcode = '23514';
  end if;
  if (i.initial_assignee_id is not null and not private.review_profile_has_role(i.initial_assignee_id, i.workspace_id, array['Member']))
     or (i.assignee_id is not null and not private.review_profile_has_role(i.assignee_id, i.workspace_id, array['Member'])) then
    raise exception 'Round assignments must belong to Members in the workspace' using errcode = '23514';
  end if;
  if i.current_submission_id is not null and not exists (
    select 1 from public.correction_submissions s
    join public.correction_submission_items si
      on si.submission_id = s.id and si.round_id = s.round_id
        and si.document_id = s.document_id and si.workspace_id = s.workspace_id
    where s.id = i.current_submission_id and s.round_id = i.round_id
      and s.document_id = i.document_id and s.workspace_id = i.workspace_id
      and s.state = 'confirmed' and si.round_item_id = i.id
      and si.assignee_at_submit_id = s.submitter_id
  ) then
    raise exception 'Current round item coverage must be its confirmed assignment at this revision' using errcode = '23514';
  end if;
end;
$$;

create or replace function private.assert_review_submission(p_submission_id uuid) returns void
language plpgsql security definer
set search_path = '' set row_security = off
as $$
declare
  s public.correction_submissions%rowtype;
  v public.document_versions%rowtype;
  item_count bigint;
begin
  select x.* into s from public.correction_submissions x where x.id = p_submission_id;
  if not found then return; end if;
  select count(*) into item_count from public.correction_submission_items si where si.submission_id = s.id;
  if item_count = 0 then
    raise exception 'A correction submission must cover at least one round item' using errcode = '23514';
  end if;
  select x.* into v from public.document_versions x
  where x.id = s.version_id and x.document_id = s.document_id and x.workspace_id = s.workspace_id;
  if not found or v.workflow_kind <> 'correction_submission' then
    raise exception 'Correction submission provenance must match its workflow version' using errcode = '23514';
  end if;
  if s.state = 'confirmed' and (
    v.upload_state <> 'confirmed' or v.upload_confirmed_at is null
      or s.confirmed_at is distinct from v.upload_confirmed_at
  ) then
    raise exception 'Confirmed correction submission must retain its verified upload timestamp' using errcode = '23514';
  end if;
  if exists (
    select 1 from public.correction_round_items i
    where i.current_submission_id = s.id and not exists (
      select 1 from public.correction_submission_items si
      where si.submission_id = s.id and si.round_item_id = i.id
        and si.assignee_at_submit_id = s.submitter_id
    )
  ) then
    raise exception 'Current submission pointer must agree with its item snapshot' using errcode = '23514';
  end if;
end;
$$;

create or replace function private.assert_review_candidate(p_candidate_id uuid) returns void
language plpgsql security definer
set search_path = '' set row_security = off
as $$
declare
  c public.correction_candidates%rowtype;
  r public.correction_rounds%rowtype;
  v public.document_versions%rowtype;
  item_count bigint;
  expected_count bigint;
  decision public.correction_candidate_decisions%rowtype;
begin
  select x.* into c from public.correction_candidates x where x.id = p_candidate_id;
  if not found then return; end if;
  select x.* into r from public.correction_rounds x where x.id = c.round_id;
  select x.* into v from public.document_versions x
  where x.id = c.version_id and x.document_id = c.document_id and x.workspace_id = c.workspace_id;
  if not found or v.workflow_kind is distinct from (
    case c.selection_kind
      when 'direct' then 'correction_submission'
      else 'correction_candidate'
    end
  ) then
    raise exception 'Candidate version provenance does not match its selection kind' using errcode = '23514';
  end if;
  select count(*) into item_count from public.correction_candidate_items ci where ci.candidate_id = c.id;
  select count(*) into expected_count from public.correction_round_items i where i.round_id = c.round_id;
  if r.mode = 'administrative' and item_count <> 0 then
    raise exception 'Administrative candidate cannot fabricate Member contributions' using errcode = '23514';
  end if;
  if c.status in ('selected', 'processing', 'failed', 'pending_approval', 'approved') then
    if c.coverage_revision is distinct from r.coverage_revision then
      raise exception 'Active candidate must match the current round coverage revision' using errcode = '23514';
    end if;
    if r.mode = 'assigned_findings' and (expected_count = 0 or item_count <> expected_count) then
      raise exception 'Selected candidate must snapshot complete round coverage' using errcode = '23514';
    end if;
    if r.mode = 'assigned_findings' and exists (
      select 1
      from public.correction_candidate_items ci
      join public.correction_round_items i
        on i.id = ci.round_item_id and i.round_id = ci.round_id
          and i.document_id = ci.document_id and i.workspace_id = ci.workspace_id
      join public.correction_submissions s
        on s.id = ci.submission_id and s.round_id = ci.round_id
          and s.document_id = ci.document_id and s.workspace_id = ci.workspace_id
      join public.correction_submission_items si
        on si.submission_id = ci.submission_id and si.round_item_id = ci.round_item_id
          and si.round_id = ci.round_id and si.document_id = ci.document_id and si.workspace_id = ci.workspace_id
      where ci.candidate_id = c.id
        and (i.current_submission_id is distinct from ci.submission_id
          or i.coverage_revision is distinct from ci.item_revision or s.state <> 'confirmed'
          or si.assignee_at_submit_id is distinct from s.submitter_id)
    ) then
      raise exception 'Candidate snapshot must match the current confirmed coverage and revision' using errcode = '23514';
    end if;
    if c.selection_kind = 'direct' and (
      exists (
        select 1 from public.correction_candidate_items ci
        where ci.candidate_id = c.id and ci.submission_id is distinct from c.source_submission_id
      ) or not exists (
        select 1 from public.correction_submissions s
        where s.id = c.source_submission_id and s.version_id = c.version_id and s.state = 'confirmed'
      )
    ) then
      raise exception 'Direct candidate must reuse one confirmed submission for all its items' using errcode = '23514';
    end if;
  end if;
  if c.status = 'reserved' then
    if v.processing_status <> 'uploaded' or v.version_status is not null or item_count <> 0 then
      raise exception 'Reserved consolidated candidate has no selected coverage or processing state' using errcode = '23514';
    end if;
  elsif c.status = 'selected' then
    if v.upload_state <> 'confirmed' or v.upload_confirmed_at is null
       or v.processing_status <> 'uploaded' or v.version_status is not null
       or r.status <> 'candidate_processing' or r.active_candidate_id is distinct from c.id then
      raise exception 'Selected candidate requires confirmed bytes and an active processing round' using errcode = '23514';
    end if;
  elsif c.status = 'processing' then
    if v.processing_status <> 'processing' or v.version_status is not null
       or r.status <> 'candidate_processing' or r.active_candidate_id is distinct from c.id then
      raise exception 'Processing candidate and version states must agree' using errcode = '23514';
    end if;
  elsif c.status = 'failed' then
    if v.processing_status <> 'processing_failed' or v.version_status is not null
       or r.status <> 'candidate_failed' or r.active_candidate_id is distinct from c.id then
      raise exception 'Failed candidate must preserve a failed non-functional version' using errcode = '23514';
    end if;
  elsif c.status = 'pending_approval' then
    if v.processing_status <> 'ready' or v.version_status <> 'pending_approval'
       or r.status <> 'pending_approval' or r.active_candidate_id is distinct from c.id then
      raise exception 'Approval candidate requires ready bytes and pending approval status' using errcode = '23514';
    end if;
  elsif c.status = 'approved' then
    select d.* into decision from public.correction_candidate_decisions d
    where d.candidate_id = c.id and d.outcome = 'approved';
    if not found or v.processing_status <> 'ready' or v.version_status <> 'active'
       or r.status <> 'approved' or r.active_candidate_id is distinct from c.id then
      raise exception 'Approved candidate requires a ready active version and an approval decision' using errcode = '23514';
    end if;
    if r.mode = 'administrative' and exists (
      select 1 from public.correction_approval_contributions ac where ac.approval_id = decision.id
    ) then
      raise exception 'Administrative approval cannot invent Member contributions' using errcode = '23514';
    end if;
    if r.mode = 'assigned_findings' and exists (
      (select s.submitter_id as contributor_id, count(*)::integer as item_count
       from public.correction_candidate_items ci
       join public.correction_submissions s on s.id = ci.submission_id
       where ci.candidate_id = c.id group by s.submitter_id)
      except
      (select ac.contributor_id, ac.own_item_count
       from public.correction_approval_contributions ac where ac.approval_id = decision.id)
    ) then
      raise exception 'Approval contributions must preserve each Member own item count' using errcode = '23514';
    end if;
    if r.mode = 'assigned_findings' and exists (
      (select ac.contributor_id, ac.own_item_count
       from public.correction_approval_contributions ac where ac.approval_id = decision.id)
      except
      (select s.submitter_id as contributor_id, count(*)::integer as item_count
       from public.correction_candidate_items ci
       join public.correction_submissions s on s.id = ci.submission_id
       where ci.candidate_id = c.id group by s.submitter_id)
    ) then
      raise exception 'Approval history cannot include a non-contributing Member' using errcode = '23514';
    end if;
  elsif c.status = 'rejected' then
    select d.* into decision from public.correction_candidate_decisions d
    where d.candidate_id = c.id and d.outcome = 'rejected';
    if not found or v.processing_status <> 'ready' or v.version_status <> 'rejected'
       or r.status not in ('collecting', 'consolidating') or r.active_candidate_id is not null then
      raise exception 'Rejected candidate must retain its ready rejected version and clear active pointer' using errcode = '23514';
    end if;
  elsif c.status = 'invalidated' then
    select d.* into decision from public.correction_candidate_decisions d
    where d.candidate_id = c.id and d.outcome = 'invalidated';
    if not found or v.version_status is not null
       or v.processing_status not in ('uploaded', 'processing_failed')
       or r.status not in ('collecting', 'consolidating', 'cancelled') or r.active_candidate_id is not null then
      raise exception 'Invalidated candidate cannot become a rejection or retain active coverage' using errcode = '23514';
    end if;
  end if;
end;
$$;

create or replace function private.current_review_submission_allowed(p_submission_id uuid)
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
      and exists (select 1 from public.correction_submission_items si where si.submission_id = s.id)
      and not exists (
        select 1
        from public.correction_submission_items si
        left join public.correction_round_items i
          on i.id = si.round_item_id and i.round_id = si.round_id
         and i.document_id = si.document_id and i.workspace_id = si.workspace_id
        where si.submission_id = s.id
          and (i.id is null
            or i.assignee_id is distinct from p.id
            or i.revision is distinct from si.expected_revision
            or not private.current_review_item_allowed(i.id)
            or (s.state = 'confirmed' and i.current_submission_id is distinct from s.id))
      )
  )
$$;

grant select (coverage_revision) on public.correction_rounds to authenticated;
grant select (coverage_revision) on public.correction_round_items to authenticated;
comment on column public.correction_rounds.coverage_revision is
  'Changes only when round correction coverage changes; distinct from the general reviewer revision.';
comment on column public.correction_round_items.coverage_revision is
  'Changes only when the confirmed submission covering this finding changes.';
comment on column public.correction_round_items.opened_assignee_id is
  'Member assignment snapshot taken when an assigned-finding round opens.';
comment on function private.current_review_submission_allowed(uuid) is
  'Member capability for an own submission only while every covered item remains authorized and, when confirmed, current.';
