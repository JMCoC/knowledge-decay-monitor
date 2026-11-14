-- Enforce tenant provenance, immutable workflow identities, and end-of-transaction
-- coverage/state consistency. Product commands remain owned by later S3 tickets.

create function private.review_profile_has_role(
  p_user_id uuid,
  p_workspace_id uuid,
  p_allowed_roles text[]
) returns boolean
language sql stable security definer
set search_path = '' set row_security = off
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = p_user_id and p.workspace_id = p_workspace_id
      and p.role::text = any (p_allowed_roles)
  )
$$;

create function private.guard_correction_round() returns trigger
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
  if new.status is distinct from old.status then
    if new.revision <> old.revision + 1 then
      raise exception 'A correction round transition must advance its revision' using errcode = '23514';
    end if;
    if not (
      (old.status = 'draft' and new.status in ('collecting', 'cancelled'))
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

  if old.status = 'draft' and new.status = 'collecting' then
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
    if new.mode = 'administrative' and item_count <> 0 then
      raise exception 'Administrative correction rounds cannot include finding items' using errcode = '23514';
    elsif new.mode = 'assigned_findings' and item_count = 0 then
      raise exception 'Assigned correction rounds require a non-empty finding set' using errcode = '23514';
    elsif new.mode = 'assigned_findings' and exists (
      select 1
      from public.correction_round_items i
      join public.findings f on f.id = i.finding_id and f.workspace_id = i.workspace_id
      where i.round_id = new.id and i.document_id = new.document_id and i.workspace_id = new.workspace_id
        and (f.status not in ('confirmed', 'update_planned')
          or f.assignee_id is null or f.assignee_id is distinct from i.assignee_id
          or i.initial_assignee_id is distinct from i.assignee_id
          or not private.review_profile_has_role(i.assignee_id, i.workspace_id, array['Member']))
    ) then
      raise exception 'Assigned correction round findings must be confirmed, evidenced, and assigned to Members' using errcode = '23514';
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

create function private.guard_correction_round_item() returns trigger
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
       or new.initial_assignee_id is distinct from finding_assignee then
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
    if new.assignee_id is distinct from old.assignee_id then
      if parent_round.status not in ('collecting', 'consolidating', 'candidate_failed', 'pending_approval')
         or new.revision <> old.revision + 1 or new.current_submission_id is not null then
        raise exception 'Reassignment must advance the item revision and revoke current coverage' using errcode = '23514';
      end if;
      if exists (
        select 1 from public.correction_candidates c
        where c.round_id = old.round_id and c.status in ('reserved', 'selected', 'processing', 'failed', 'pending_approval')
      ) then
        raise exception 'Current candidate must be invalidated before item reassignment' using errcode = '23514';
      end if;
    elsif new.revision is distinct from old.revision then
      if new.revision <> old.revision + 1 or old.current_submission_id is null
         or new.current_submission_id is not null or not exists (
           select 1 from public.correction_return_items ri
           where ri.round_item_id = old.id and ri.round_id = old.round_id
             and ri.document_id = old.document_id and ri.workspace_id = old.workspace_id
             and ri.previous_submission_id = old.current_submission_id
         ) then
        raise exception 'Round item revision changes only with reassignment or a recorded return' using errcode = '23514';
      end if;
    end if;
    if new.current_submission_id is distinct from old.current_submission_id
       and new.assignee_id is not distinct from old.assignee_id
       and exists (
         select 1 from public.correction_candidates c
         where c.round_id = old.round_id and c.status in ('reserved', 'selected', 'processing', 'failed', 'pending_approval')
       ) then
      raise exception 'Current candidate must be invalidated before replacing item coverage' using errcode = '23514';
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
  return new;
end;
$$;

create function private.guard_correction_submission() returns trigger
language plpgsql security definer
set search_path = '' set row_security = off
as $$
declare
  parent_round public.correction_rounds%rowtype;
  file_version public.document_versions%rowtype;
begin
  if tg_op = 'INSERT' then
    select r.* into parent_round from public.correction_rounds r
    where r.id = new.round_id and r.document_id = new.document_id and r.workspace_id = new.workspace_id;
    if not found or parent_round.mode <> 'assigned_findings' or parent_round.status <> 'collecting'
       or parent_round.base_version_id is distinct from new.base_version_id then
      raise exception 'Correction submission does not match a collecting assigned round' using errcode = '23514';
    end if;
    if not private.review_profile_has_role(new.submitter_id, new.workspace_id, array['Member']) then
      raise exception 'Correction submission requires a Member profile' using errcode = '23514';
    end if;
    select v.* into file_version from public.document_versions v
    where v.id = new.version_id and v.document_id = new.document_id and v.workspace_id = new.workspace_id;
    if not found or file_version.workflow_kind <> 'correction_submission'
       or file_version.upload_initiator_id is distinct from new.submitter_id
       or file_version.upload_state not in ('pending', 'verifying', 'recovering') then
      raise exception 'Correction submission must reference its Member-owned reserved upload' using errcode = '23514';
    end if;
    if new.state <> 'reserved' or new.confirmed_at is not null
       or new.reserved_at > now() or new.expires_at <= now()
       or new.expires_at is distinct from new.reserved_at + interval '24 hours' then
      raise exception 'Correction submissions begin as 24-hour reservations' using errcode = '23514';
    end if;
    return new;
  end if;

  if new.id is distinct from old.id or new.workspace_id is distinct from old.workspace_id
     or new.round_id is distinct from old.round_id or new.document_id is distinct from old.document_id
     or new.base_version_id is distinct from old.base_version_id or new.version_id is distinct from old.version_id
     or new.submitter_id is distinct from old.submitter_id or new.idempotency_key is distinct from old.idempotency_key
     or new.request_fingerprint is distinct from old.request_fingerprint
     or new.reserved_at is distinct from old.reserved_at or new.expires_at is distinct from old.expires_at
     or new.previous_submission_id is distinct from old.previous_submission_id
     or new.created_at is distinct from old.created_at then
    raise exception 'Correction submission identity is immutable' using errcode = '23514';
  end if;
  if new.state is distinct from old.state and not (
    (old.state = 'reserved' and new.state in ('confirmed', 'expired', 'invalidated'))
    or (old.state = 'confirmed' and new.state = 'invalidated')
  ) then
    raise exception 'Invalid correction submission transition' using errcode = '23514';
  end if;
  if new.state = 'confirmed' then
    select v.* into file_version from public.document_versions v
    where v.id = new.version_id and v.document_id = new.document_id and v.workspace_id = new.workspace_id;
    if not found or file_version.upload_state <> 'confirmed'
       or file_version.upload_confirmed_at is null
       or new.confirmed_at is distinct from file_version.upload_confirmed_at
       or new.confirmed_at > new.expires_at or new.expires_at <= now() then
      raise exception 'A correction submission requires a confirmed upload' using errcode = '23514';
    end if;
    if exists (
      select 1
      from public.correction_submission_items si
      join public.correction_round_items ri
        on ri.id = si.round_item_id and ri.round_id = si.round_id
          and ri.document_id = si.document_id and ri.workspace_id = si.workspace_id
      where si.submission_id = new.id
        and (si.expected_revision <> ri.revision or ri.assignee_id is distinct from new.submitter_id
          or si.assignee_at_submit_id is distinct from new.submitter_id)
    ) then
      raise exception 'Correction submission assignment or revision is stale' using errcode = '23514';
    end if;
  elsif new.state = 'expired' then
    if new.confirmed_at is not null or new.expires_at > now() then
      raise exception 'A correction reservation cannot expire before its deadline' using errcode = '23514';
    end if;
  elsif new.state = 'reserved' and new.confirmed_at is not null then
    raise exception 'Unconfirmed correction reservation cannot have a confirmation time' using errcode = '23514';
  end if;
  return new;
end;
$$;

create function private.guard_correction_submission_item() returns trigger
language plpgsql security definer
set search_path = '' set row_security = off
as $$
declare
  parent_submission public.correction_submissions%rowtype;
  round_item public.correction_round_items%rowtype;
begin
  if tg_op <> 'INSERT' then
    raise exception 'Correction submission coverage is immutable' using errcode = '23514';
  end if;
  select s.* into parent_submission from public.correction_submissions s
  where s.id = new.submission_id and s.round_id = new.round_id
    and s.document_id = new.document_id and s.workspace_id = new.workspace_id;
  if not found or parent_submission.state <> 'reserved' then
    raise exception 'Coverage can only be added to a reserved correction submission' using errcode = '23514';
  end if;
  select i.* into round_item from public.correction_round_items i
  where i.id = new.round_item_id and i.round_id = new.round_id
    and i.document_id = new.document_id and i.workspace_id = new.workspace_id;
  if not found or new.assignee_at_submit_id is distinct from parent_submission.submitter_id
     or new.assignee_at_submit_id is distinct from round_item.assignee_id
     or new.expected_revision is distinct from round_item.revision then
    raise exception 'Grouped submission must match one Member assignment and its current revision' using errcode = '23514';
  end if;
  return new;
end;
$$;

create function private.guard_correction_candidate() returns trigger
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
    if new.status = 'selected' and new.coverage_revision is distinct from parent_round.revision then
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
    if new.coverage_revision is distinct from parent_round.revision then
      raise exception 'Candidate coverage revision must match the round at selection' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create function private.guard_correction_candidate_item() returns trigger
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
     or round_item.revision is distinct from new.item_revision then
    raise exception 'Candidate snapshot does not match current confirmed item coverage' using errcode = '23514';
  end if;
  return new;
end;
$$;

create function private.guard_correction_return() returns trigger
language plpgsql security definer
set search_path = '' set row_security = off
as $$
declare
  parent_round public.correction_rounds%rowtype;
begin
  if tg_op <> 'INSERT' then
    raise exception 'Correction return decisions are append-only' using errcode = '23514';
  end if;
  select r.* into parent_round from public.correction_rounds r
  where r.id = new.round_id and r.document_id = new.document_id and r.workspace_id = new.workspace_id;
  if not found or parent_round.status not in ('consolidating', 'candidate_failed', 'pending_approval')
     or not private.review_profile_has_role(new.actor_id, new.workspace_id, array['Admin', 'QA Lead']) then
    raise exception 'Correction return requires a reviewer and a returnable round state' using errcode = '23514';
  end if;
  if new.candidate_id is not null and not exists (
    select 1 from public.correction_candidates c
    where c.id = new.candidate_id and c.round_id = new.round_id
      and c.document_id = new.document_id and c.workspace_id = new.workspace_id
      and c.status in ('failed', 'pending_approval')
  ) then
    raise exception 'Correction return candidate is not returnable' using errcode = '23514';
  end if;
  return new;
end;
$$;

create function private.guard_correction_return_item() returns trigger
language plpgsql security definer
set search_path = '' set row_security = off
as $$
declare
  parent_return public.correction_returns%rowtype;
  round_item public.correction_round_items%rowtype;
begin
  if tg_op <> 'INSERT' then
    raise exception 'Correction return item history is append-only' using errcode = '23514';
  end if;
  select r.* into parent_return from public.correction_returns r
  where r.id = new.return_id and r.round_id = new.round_id
    and r.document_id = new.document_id and r.workspace_id = new.workspace_id;
  select i.* into round_item from public.correction_round_items i
  where i.id = new.round_item_id and i.round_id = new.round_id
    and i.document_id = new.document_id and i.workspace_id = new.workspace_id;
  if not found or not private.review_profile_has_role(new.recipient_id, new.workspace_id, array['Member'])
     or round_item.assignee_id is distinct from new.recipient_id
     or not exists (
       select 1 from public.correction_submission_items si
       where si.submission_id = new.previous_submission_id and si.round_item_id = new.round_item_id
         and si.round_id = new.round_id and si.document_id = new.document_id and si.workspace_id = new.workspace_id
     ) then
    raise exception 'Returned item must identify its current Member recipient and prior contribution' using errcode = '23514';
  end if;
  if parent_return.candidate_id is not null and not exists (
    select 1 from public.correction_candidate_items ci
    where ci.candidate_id = parent_return.candidate_id and ci.round_item_id = new.round_item_id
      and ci.submission_id = new.previous_submission_id and ci.round_id = new.round_id
      and ci.document_id = new.document_id and ci.workspace_id = new.workspace_id
  ) then
    raise exception 'Returned contribution does not belong to the selected candidate' using errcode = '23514';
  end if;
  return new;
end;
$$;

create function private.guard_correction_candidate_decision() returns trigger
language plpgsql security definer
set search_path = '' set row_security = off
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'Correction candidate decisions are append-only' using errcode = '23514';
  end if;
  if not private.review_profile_has_role(new.actor_id, new.workspace_id, array['Admin', 'QA Lead']) then
    raise exception 'Only a workspace reviewer can decide a candidate' using errcode = '23514';
  end if;
  return new;
end;
$$;

create function private.guard_correction_approval_contribution() returns trigger
language plpgsql security definer
set search_path = '' set row_security = off
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'Approval contribution history is append-only' using errcode = '23514';
  end if;
  if not private.review_profile_has_role(new.contributor_id, new.workspace_id, array['Member']) then
    raise exception 'Approval contributor must be a Member in the workspace' using errcode = '23514';
  end if;
  return new;
end;
$$;

create function private.guard_review_finding_revision() returns trigger
language plpgsql security definer
set search_path = '' set row_security = off
as $$
begin
  if new.id is distinct from old.id or new.workspace_id is distinct from old.workspace_id
     or new.analysis_id is distinct from old.analysis_id
     or new.severity_original is distinct from old.severity_original
     or new.confidence is distinct from old.confidence or new.explanation is distinct from old.explanation
     or new.fingerprint is distinct from old.fingerprint or new.created_at is distinct from old.created_at then
    raise exception 'Finding identity and original evidence metadata are immutable' using errcode = '23514';
  end if;
  if new.status is distinct from old.status or new.severity_current is distinct from old.severity_current
     or new.assignee_id is distinct from old.assignee_id then
    if new.review_revision = old.review_revision then
      new.review_revision := old.review_revision + 1;
    elsif new.review_revision <> old.review_revision + 1 then
      raise exception 'Finding review changes must advance the revision' using errcode = '23514';
    end if;
  elsif new.review_revision is distinct from old.review_revision then
    raise exception 'Finding review revision changes only with a review mutation' using errcode = '23514';
  end if;
  return new;
end;
$$;

create function private.guard_review_workflow_version() returns trigger
language plpgsql security definer
set search_path = '' set row_security = off
as $$
declare
  candidate_state public.correction_candidate_status;
begin
  if tg_op = 'UPDATE' and new.workflow_kind is distinct from old.workflow_kind then
    if old.workflow_kind <> 'initial' or new.workflow_kind not in ('correction_submission', 'correction_candidate')
       or old.processing_status <> 'uploaded' or old.version_status is not null
       or old.upload_state not in ('pending', 'verifying', 'recovering')
       or exists (select 1 from public.document_chunks c where c.version_id = old.id and c.workspace_id = old.workspace_id)
       or exists (select 1 from public.analysis_documents a where a.version_id = old.id and a.workspace_id = old.workspace_id) then
      raise exception 'Version provenance can only be assigned to an unused reserved upload' using errcode = '23514';
    end if;
  end if;

  if new.workflow_kind = 'initial' then
    if tg_op = 'INSERT' then return new; end if;
    return new;
  end if;
  if new.processing_status <> 'ready' and new.version_status is not null then
    raise exception 'Unready correction versions cannot have a functional status' using errcode = '23514';
  end if;
  if new.processing_status in ('processing', 'ready', 'processing_failed') then
    select c.status into candidate_state
    from public.correction_candidates c
    where c.version_id = new.id and c.workspace_id = new.workspace_id;
    if not found then
      raise exception 'A correction version can be processed only after candidate selection' using errcode = '23514';
    end if;
    if new.processing_status = 'processing' and candidate_state not in ('selected', 'processing') then
      raise exception 'Only a selected candidate may enter processing' using errcode = '23514';
    end if;
  end if;
  if new.processing_status in ('processing', 'ready')
     and (new.upload_state <> 'confirmed' or new.upload_confirmed_at is null) then
    raise exception 'Correction processing requires a confirmed upload' using errcode = '23514';
  end if;
  return new;
end;
$$;

create function private.guard_review_workflow_chunk() returns trigger
language plpgsql security definer
set search_path = '' set row_security = off
as $$
declare
  v public.document_versions%rowtype;
begin
  select x.* into v from public.document_versions x
  where x.id = new.version_id and x.workspace_id = new.workspace_id;
  if found and v.workflow_kind <> 'initial' and not exists (
    select 1 from public.correction_candidates c
    where c.version_id = v.id and c.workspace_id = v.workspace_id
      and c.status in ('selected', 'processing')
      and v.upload_state = 'confirmed'
  ) then
    raise exception 'A correction file cannot produce chunks before candidate selection' using errcode = '23514';
  end if;
  return new;
end;
$$;

create function private.assert_review_round(p_round_id uuid) returns void
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

create function private.assert_review_round_item(p_item_id uuid) returns void
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
      and si.expected_revision = i.revision and si.assignee_at_submit_id = i.assignee_id
  ) then
    raise exception 'Current round item coverage must be its confirmed assignment at this revision' using errcode = '23514';
  end if;
end;
$$;

create function private.assert_review_submission(p_submission_id uuid) returns void
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
        and si.expected_revision = i.revision and si.assignee_at_submit_id = i.assignee_id
    )
  ) then
    raise exception 'Current submission pointer must agree with its item snapshot' using errcode = '23514';
  end if;
end;
$$;

create function private.assert_review_candidate(p_candidate_id uuid) returns void
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
          or i.revision is distinct from ci.item_revision or s.state <> 'confirmed'
          or si.expected_revision is distinct from ci.item_revision)
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

create function private.assert_review_return(p_return_id uuid) returns void
language plpgsql security definer
set search_path = '' set row_security = off
as $$
declare
  x public.correction_returns%rowtype;
  r public.correction_rounds%rowtype;
  item_count bigint;
begin
  select y.* into x from public.correction_returns y where y.id = p_return_id;
  if not found then return; end if;
  select y.* into r from public.correction_rounds y where y.id = x.round_id;
  select count(*) into item_count from public.correction_return_items i where i.return_id = x.id;
  if r.mode = 'administrative' then
    if item_count <> 0 or x.candidate_id is null or not exists (
      select 1 from public.correction_candidate_decisions d
      where d.candidate_id = x.candidate_id and d.outcome in ('rejected', 'invalidated')
        and char_length(btrim(coalesce(d.private_reason, ''))) between 1 and 2000
    ) then
      raise exception 'Administrative proposal decisions retain a private reason without Member return items' using errcode = '23514';
    end if;
  elsif item_count = 0 then
    raise exception 'Member correction return requires at least one affected item' using errcode = '23514';
  end if;
end;
$$;

create function private.assert_review_round_trigger() returns trigger
language plpgsql security definer set search_path = '' set row_security = off as $$
begin
  perform private.assert_review_round(coalesce(new.id, old.id));
  return null;
end;
$$;
create function private.assert_review_round_item_trigger() returns trigger
language plpgsql security definer set search_path = '' set row_security = off as $$
declare item_id uuid; round_key uuid;
begin
  if tg_op = 'DELETE' then item_id := old.id; round_key := old.round_id;
  else item_id := new.id; round_key := new.round_id; end if;
  perform private.assert_review_round_item(item_id);
  perform private.assert_review_round(round_key);
  return null;
end;
$$;
create function private.assert_review_submission_trigger() returns trigger
language plpgsql security definer set search_path = '' set row_security = off as $$
declare submission_key uuid; round_key uuid;
begin
  if tg_table_name = 'correction_submission_items' then
    if tg_op = 'DELETE' then submission_key := old.submission_id; round_key := old.round_id;
    else submission_key := new.submission_id; round_key := new.round_id; end if;
  elsif tg_op = 'DELETE' then submission_key := old.id; round_key := old.round_id;
  else submission_key := new.id; round_key := new.round_id; end if;
  perform private.assert_review_submission(submission_key);
  perform private.assert_review_round(round_key);
  return null;
end;
$$;
create function private.assert_review_candidate_trigger() returns trigger
language plpgsql security definer set search_path = '' set row_security = off as $$
declare candidate_key uuid; round_key uuid;
begin
  if tg_table_name = 'correction_candidate_items' then
    if tg_op = 'DELETE' then candidate_key := old.candidate_id; round_key := old.round_id;
    else candidate_key := new.candidate_id; round_key := new.round_id; end if;
  elsif tg_table_name = 'correction_candidate_decisions' then
    if tg_op = 'DELETE' then candidate_key := old.candidate_id; round_key := old.round_id;
    else candidate_key := new.candidate_id; round_key := new.round_id; end if;
  elsif tg_op = 'DELETE' then candidate_key := old.id; round_key := old.round_id;
  else candidate_key := new.id; round_key := new.round_id; end if;
  perform private.assert_review_candidate(candidate_key);
  perform private.assert_review_round(round_key);
  return null;
end;
$$;
create function private.assert_review_return_trigger() returns trigger
language plpgsql security definer set search_path = '' set row_security = off as $$
declare return_key uuid; round_key uuid;
begin
  if tg_table_name = 'correction_return_items' then
    if tg_op = 'DELETE' then return_key := old.return_id; round_key := old.round_id;
    else return_key := new.return_id; round_key := new.round_id; end if;
  elsif tg_op = 'DELETE' then return_key := old.id; round_key := old.round_id;
  else return_key := new.id; round_key := new.round_id; end if;
  perform private.assert_review_return(return_key);
  perform private.assert_review_round(round_key);
  return null;
end;
$$;
create function private.assert_review_version_trigger() returns trigger
language plpgsql security definer set search_path = '' set row_security = off as $$
declare version_key uuid; workspace_key uuid; v public.document_versions%rowtype; c public.correction_candidates%rowtype;
begin
  if tg_op = 'DELETE' then version_key := old.id; workspace_key := old.workspace_id;
  else version_key := new.id; workspace_key := new.workspace_id; end if;
  select x.* into v from public.document_versions x where x.id = version_key and x.workspace_id = workspace_key;
  if not found or v.workflow_kind = 'initial' then return null; end if;
  select x.* into c from public.correction_candidates x where x.version_id = v.id and x.workspace_id = v.workspace_id;
  if not found then
    if v.processing_status <> 'uploaded' or v.version_status is not null then
      raise exception 'Unselected correction upload cannot be processed or activated' using errcode = '23514';
    end if;
    return null;
  end if;
  if v.processing_status = 'processing' and c.status not in ('selected', 'processing') then
    raise exception 'Correction version processing requires a selected candidate' using errcode = '23514';
  elsif v.processing_status = 'processing_failed' and c.status not in ('failed', 'invalidated') then
    raise exception 'Failed correction version requires a failed or invalidated candidate' using errcode = '23514';
  elsif v.processing_status = 'ready' and v.version_status = 'pending_approval'
     and c.status <> 'pending_approval' then
    raise exception 'Ready correction candidate must be pending approval' using errcode = '23514';
  elsif v.version_status = 'active' and c.status <> 'approved' then
    raise exception 'Only an approved correction candidate can become active' using errcode = '23514';
  elsif v.version_status = 'rejected' and c.status <> 'rejected' then
    raise exception 'Only a rejected ready candidate can become rejected' using errcode = '23514';
  end if;
  return null;
end;
$$;

create trigger correction_rounds_integrity_guard
  before insert or update on public.correction_rounds
  for each row execute function private.guard_correction_round();
create trigger correction_round_items_integrity_guard
  before insert or update or delete on public.correction_round_items
  for each row execute function private.guard_correction_round_item();
create trigger correction_submissions_integrity_guard
  before insert or update on public.correction_submissions
  for each row execute function private.guard_correction_submission();
create trigger correction_submission_items_integrity_guard
  before insert or update or delete on public.correction_submission_items
  for each row execute function private.guard_correction_submission_item();
create trigger correction_candidates_integrity_guard
  before insert or update or delete on public.correction_candidates
  for each row execute function private.guard_correction_candidate();
create trigger correction_candidate_items_integrity_guard
  before insert or update or delete on public.correction_candidate_items
  for each row execute function private.guard_correction_candidate_item();
create trigger correction_returns_integrity_guard
  before insert or update or delete on public.correction_returns
  for each row execute function private.guard_correction_return();
create trigger correction_return_items_integrity_guard
  before insert or update or delete on public.correction_return_items
  for each row execute function private.guard_correction_return_item();
create trigger correction_candidate_decisions_integrity_guard
  before insert or update or delete on public.correction_candidate_decisions
  for each row execute function private.guard_correction_candidate_decision();
create trigger correction_approval_contributions_integrity_guard
  before insert or update or delete on public.correction_approval_contributions
  for each row execute function private.guard_correction_approval_contribution();
create trigger findings_review_revision_guard
  before update on public.findings
  for each row execute function private.guard_review_finding_revision();
create trigger document_versions_review_workflow_guard
  before insert or update on public.document_versions
  for each row execute function private.guard_review_workflow_version();
create trigger document_chunks_review_workflow_guard
  before insert on public.document_chunks
  for each row execute function private.guard_review_workflow_chunk();

create constraint trigger correction_rounds_integrity_check
  after insert or update on public.correction_rounds deferrable initially deferred
  for each row execute function private.assert_review_round_trigger();
create constraint trigger correction_round_items_integrity_check
  after insert or update or delete on public.correction_round_items deferrable initially deferred
  for each row execute function private.assert_review_round_item_trigger();
create constraint trigger correction_submissions_integrity_check
  after insert or update on public.correction_submissions deferrable initially deferred
  for each row execute function private.assert_review_submission_trigger();
create constraint trigger correction_submission_items_integrity_check
  after insert or update or delete on public.correction_submission_items deferrable initially deferred
  for each row execute function private.assert_review_submission_trigger();
create constraint trigger correction_candidates_integrity_check
  after insert or update on public.correction_candidates deferrable initially deferred
  for each row execute function private.assert_review_candidate_trigger();
create constraint trigger correction_candidate_items_integrity_check
  after insert or update or delete on public.correction_candidate_items deferrable initially deferred
  for each row execute function private.assert_review_candidate_trigger();
create constraint trigger correction_returns_integrity_check
  after insert on public.correction_returns deferrable initially deferred
  for each row execute function private.assert_review_return_trigger();
create constraint trigger correction_return_items_integrity_check
  after insert on public.correction_return_items deferrable initially deferred
  for each row execute function private.assert_review_return_trigger();
create constraint trigger correction_candidate_decisions_integrity_check
  after insert on public.correction_candidate_decisions deferrable initially deferred
  for each row execute function private.assert_review_candidate_trigger();
create constraint trigger correction_approval_contributions_integrity_check
  after insert on public.correction_approval_contributions deferrable initially deferred
  for each row execute function private.assert_review_candidate_trigger();
create constraint trigger document_versions_review_workflow_check
  after insert or update on public.document_versions deferrable initially deferred
  for each row execute function private.assert_review_version_trigger();

revoke all on function private.review_profile_has_role(uuid,uuid,text[]),
  private.guard_correction_round(), private.guard_correction_round_item(),
  private.guard_correction_submission(), private.guard_correction_submission_item(),
  private.guard_correction_candidate(), private.guard_correction_candidate_item(),
  private.guard_correction_return(), private.guard_correction_return_item(),
  private.guard_correction_candidate_decision(), private.guard_correction_approval_contribution(),
  private.guard_review_finding_revision(), private.guard_review_workflow_version(),
  private.guard_review_workflow_chunk(), private.assert_review_round(uuid),
  private.assert_review_round_item(uuid), private.assert_review_submission(uuid),
  private.assert_review_candidate(uuid), private.assert_review_return(uuid),
  private.assert_review_round_trigger(), private.assert_review_round_item_trigger(),
  private.assert_review_submission_trigger(), private.assert_review_candidate_trigger(),
  private.assert_review_return_trigger(), private.assert_review_version_trigger()
  from public, anon, authenticated, service_role;
