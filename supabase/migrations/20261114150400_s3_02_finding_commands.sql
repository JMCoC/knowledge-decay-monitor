-- Human finding decisions and assignment changes are tenant-serialized,
-- optimistic, replayable commands. No command mutates evidence or analysis state.

create or replace function private.guard_review_finding_revision() returns trigger
language plpgsql security definer
set search_path = '' set row_security = off
as $$
declare
  v_transition_allowed boolean;
begin
  if new.id is distinct from old.id or new.workspace_id is distinct from old.workspace_id
     or new.analysis_id is distinct from old.analysis_id
     or new.severity_original is distinct from old.severity_original
     or new.confidence is distinct from old.confidence or new.explanation is distinct from old.explanation
     or new.fingerprint is distinct from old.fingerprint or new.created_at is distinct from old.created_at then
    raise exception 'Finding identity and original evidence metadata are immutable' using errcode = '23514';
  end if;

  if new.status is distinct from old.status then
    v_transition_allowed :=
      (old.status = 'pending_review' and new.status in ('confirmed', 'false_positive'))
      or (old.status = 'confirmed' and new.status in ('update_planned', 'resolved'))
      or (old.status = 'update_planned' and new.status = 'resolved')
      or (old.status = 'false_positive' and new.status = 'resolved');
    if not v_transition_allowed then
      raise exception 'Invalid finding status transition' using errcode = '23514';
    end if;
  end if;

  if new.assignee_id is distinct from old.assignee_id then
    if new.assignee_id is not null and not exists (
      select 1 from public.profiles p where p.id = new.assignee_id and p.workspace_id = new.workspace_id
    ) then
      raise exception 'Finding assignee must belong to the analysis workspace' using errcode = '23503';
    end if;
    if new.assignee_id is not null
       and not private.review_profile_has_role(new.assignee_id, new.workspace_id, array['Member']) then
      raise exception 'Finding assignee must be a workspace Member' using errcode = '23514';
    end if;
    if new.status not in ('confirmed', 'update_planned') then
      raise exception 'Findings can only be assigned while confirmed or update planned' using errcode = '23514';
    end if;
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

create or replace function private.lock_review_finding_relations(p_workspace_id uuid, p_finding_id uuid)
returns uuid[]
language plpgsql security definer
set search_path = '' set row_security = off
set lock_timeout = '1s' set statement_timeout = '5s'
as $$
declare
  v_round_ids uuid[];
  v_round_id uuid;
  v_submission_id uuid;
  v_item_id uuid;
begin
  select coalesce(pg_catalog.array_agg(distinct r.id order by r.id), '{}'::uuid[])
    into v_round_ids
  from public.correction_rounds r
  join public.correction_round_items i on i.round_id = r.id and i.workspace_id = r.workspace_id
  where r.workspace_id = p_workspace_id and i.finding_id = p_finding_id
    and r.status in ('draft', 'collecting', 'consolidating', 'candidate_processing', 'candidate_failed', 'pending_approval');

  for v_round_id in
    select x from pg_catalog.unnest(v_round_ids) x order by x
  loop
    perform 1 from public.correction_rounds r where r.id = v_round_id and r.workspace_id = p_workspace_id for update;
  end loop;

  -- Match the submission-before-item ordering used by reservation finalization.
  for v_submission_id in
    select s.id
    from public.correction_submissions s
    where s.workspace_id = p_workspace_id and s.state = 'reserved'
      and s.round_id = any(v_round_ids)
      and exists (
        select 1
        from public.correction_submission_items si
        join public.correction_round_items i on i.id = si.round_item_id
          and i.round_id = si.round_id and i.document_id = si.document_id and i.workspace_id = si.workspace_id
        where si.submission_id = s.id and i.finding_id = p_finding_id
      )
    order by s.id
  loop
    perform 1 from public.correction_submissions s
    where s.id = v_submission_id and s.workspace_id = p_workspace_id for update;
  end loop;

  for v_item_id in
    select i.id
    from public.correction_round_items i
    join public.correction_rounds r on r.id = i.round_id and r.workspace_id = i.workspace_id
    where i.workspace_id = p_workspace_id and i.finding_id = p_finding_id
      and r.id = any(v_round_ids)
    order by i.id
  loop
    perform 1 from public.correction_round_items i
    where i.id = v_item_id and i.workspace_id = p_workspace_id for update;
  end loop;

  return v_round_ids;
end;
$$;
revoke all on function private.lock_review_finding_relations(uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.review_change_finding(
  p_actor_id uuid,
  p_finding_id uuid,
  p_revision bigint,
  p_change jsonb,
  p_idempotency_key text
) returns jsonb
language plpgsql security definer
set search_path = '' set row_security = off
set lock_timeout = '1s' set statement_timeout = '8s'
as $$
declare
  v_workspace_id uuid;
  v_finding public.findings%rowtype;
  v_document_ids uuid[];
  v_offset integer;
  v_round_ids uuid[];
  v_replayed boolean;
  v_receipt_result_id uuid;
  v_field text;
  v_value text;
  v_next_status public.finding_status;
  v_next_severity public.finding_severity;
  v_event_id uuid;
  v_changed_item_count bigint;
  v_changed_round_ids uuid[];
  v_changed_item_ids uuid[];
  v_submission_id uuid;
begin
  if p_finding_id is null or p_revision is null or p_revision < 1 or p_revision > 9007199254740991
     or p_change is null or pg_catalog.jsonb_typeof(p_change) <> 'object' then
    raise exception 'Invalid finding change request' using errcode = '22023';
  end if;
  if (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(p_change)) <> 2
     or not (p_change ?& array['field', 'value'])
     or pg_catalog.jsonb_typeof(p_change->'field') <> 'string'
     or pg_catalog.jsonb_typeof(p_change->'value') <> 'string' then
    raise exception 'Invalid finding change request' using errcode = '22023';
  end if;
  v_field := p_change->>'field';
  v_value := p_change->>'value';
  if v_field = 'status' then
    if v_value not in ('pending_review', 'confirmed', 'false_positive', 'update_planned', 'resolved') then
      raise exception 'Invalid finding status' using errcode = '22023';
    end if;
    v_next_status := v_value::public.finding_status;
  elsif v_field = 'severity' then
    if v_value not in ('High', 'Medium', 'Low') then
      raise exception 'Invalid finding severity' using errcode = '22023';
    end if;
    v_next_severity := v_value::public.finding_severity;
  else
    raise exception 'Invalid finding change field' using errcode = '22023';
  end if;

  v_workspace_id := private.lock_review_actor(p_actor_id);
  select receipt.replayed, receipt.result_id into v_replayed, v_receipt_result_id
  from private.check_review_receipt(
    v_workspace_id, p_actor_id, 'changeFinding', p_idempotency_key,
    pg_catalog.jsonb_build_object('findingId', p_finding_id, 'revision', p_revision, 'change', p_change)
  ) receipt;
  if v_replayed then
    return private.review_finding_snapshot(v_workspace_id, p_finding_id);
  end if;

  if not exists (select 1 from public.findings f where f.id = p_finding_id and f.workspace_id = v_workspace_id) then
    raise exception 'Finding is unavailable' using errcode = 'P0002';
  end if;
  select pg_catalog.array_agg(distinct e.document_id order by e.document_id) into v_document_ids
  from public.finding_evidence e where e.finding_id = p_finding_id and e.workspace_id = v_workspace_id;
  for v_offset in 1..coalesce(pg_catalog.cardinality(v_document_ids), 0) by 100 loop
    perform private.lock_review_documents(
      v_workspace_id, v_document_ids[v_offset:least(v_offset + 99, pg_catalog.cardinality(v_document_ids))]
    );
  end loop;

  select f.* into v_finding from public.findings f
  where f.id = p_finding_id and f.workspace_id = v_workspace_id for update;
  if not found then
    raise exception 'Finding is unavailable' using errcode = 'P0002';
  end if;
  if v_finding.review_revision <> p_revision then
    raise exception 'Finding revision is stale' using errcode = 'P0001';
  end if;

  if v_field = 'status' then
    if v_finding.status is distinct from v_next_status then
      if not (
        (v_finding.status = 'pending_review' and v_next_status in ('confirmed', 'false_positive'))
        or (v_finding.status = 'confirmed' and v_next_status in ('update_planned', 'resolved'))
        or (v_finding.status = 'update_planned' and v_next_status = 'resolved')
        or (v_finding.status = 'false_positive' and v_next_status = 'resolved')
      ) then
        raise exception 'Finding cannot transition from its current status' using errcode = 'P0001';
      end if;

      if v_next_status = 'resolved' then
        v_round_ids := private.lock_review_finding_relations(v_workspace_id, p_finding_id);
      end if;
      update public.findings f
      set status = v_next_status, review_revision = f.review_revision + 1
      where f.id = p_finding_id and f.workspace_id = v_workspace_id;

      if v_next_status = 'resolved' then
        with changed_items as (
          update public.correction_round_items i
          set revision = i.revision + 1
          from public.correction_rounds r
          where i.round_id = r.id and i.workspace_id = r.workspace_id
            and i.finding_id = p_finding_id and i.workspace_id = v_workspace_id
            and r.id = any(v_round_ids)
            and r.status in ('draft', 'collecting', 'consolidating', 'candidate_processing', 'candidate_failed', 'pending_approval')
          returning i.id, i.round_id
        )
        select count(*), coalesce(pg_catalog.array_agg(distinct c.round_id order by c.round_id), '{}'::uuid[]),
          coalesce(pg_catalog.array_agg(c.id order by c.id), '{}'::uuid[])
        into v_changed_item_count, v_changed_round_ids, v_changed_item_ids
        from changed_items c;
        if v_changed_item_count > 0 then
          update public.correction_rounds r
          set revision = r.revision + 1
          where r.id = any(v_changed_round_ids);

          for v_submission_id in
            select s.id from public.correction_submissions s
            where s.workspace_id = v_workspace_id and s.state = 'reserved'
              and exists (
                select 1 from public.correction_submission_items si
                where si.submission_id = s.id and si.round_item_id = any(v_changed_item_ids)
              )
            order by s.id
          loop
            update public.correction_submissions s set state = 'invalidated'
            where s.id = v_submission_id and s.workspace_id = v_workspace_id and s.state = 'reserved';
          end loop;
        end if;
      end if;

      v_event_id := pg_catalog.gen_random_uuid();
      perform private.append_review_audit(
        p_actor_id, 'finding_status_changed', 'finding', p_finding_id,
        pg_catalog.jsonb_build_object('previousStatus', v_finding.status::text, 'status', v_next_status::text), v_event_id
      );
    end if;
  elsif v_finding.severity_current is distinct from v_next_severity then
    update public.findings f
    set severity_current = v_next_severity, review_revision = f.review_revision + 1
    where f.id = p_finding_id and f.workspace_id = v_workspace_id;
    v_event_id := pg_catalog.gen_random_uuid();
    perform private.append_review_audit(
      p_actor_id, 'finding_severity_changed', 'finding', p_finding_id,
      pg_catalog.jsonb_build_object('previousSeverity', v_finding.severity_current::text, 'severity', v_next_severity::text), v_event_id
    );
  end if;

  select f.* into strict v_finding from public.findings f
  where f.id = p_finding_id and f.workspace_id = v_workspace_id;
  perform private.finish_review_receipt(
    v_workspace_id, p_actor_id, 'changeFinding', p_idempotency_key,
    pg_catalog.jsonb_build_object('findingId', p_finding_id, 'revision', p_revision, 'change', p_change),
    p_finding_id, v_finding.review_revision, v_finding.status::text
  );
  return private.review_finding_snapshot(v_workspace_id, p_finding_id);
end;
$$;
revoke all on function public.review_change_finding(uuid, uuid, bigint, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.review_change_finding(uuid, uuid, bigint, jsonb, text) to service_role;

create or replace function public.review_assign_finding(
  p_actor_id uuid,
  p_finding_id uuid,
  p_revision bigint,
  p_assignee_id uuid,
  p_idempotency_key text
) returns jsonb
language plpgsql security definer
set search_path = '' set row_security = off
set lock_timeout = '1s' set statement_timeout = '8s'
as $$
declare
  v_workspace_id uuid;
  v_finding public.findings%rowtype;
  v_document_ids uuid[];
  v_offset integer;
  v_round_ids uuid[];
  v_replayed boolean;
  v_receipt_result_id uuid;
  v_recipient_id uuid;
  v_event_id uuid;
  v_changed_item_count bigint;
  v_changed_round_ids uuid[];
  v_changed_item_ids uuid[];
begin
  if p_finding_id is null or p_revision is null or p_revision < 1 or p_revision > 9007199254740991 then
    raise exception 'Invalid finding assignment request' using errcode = '22023';
  end if;

  v_workspace_id := private.lock_review_actor(p_actor_id);
  select receipt.replayed, receipt.result_id into v_replayed, v_receipt_result_id
  from private.check_review_receipt(
    v_workspace_id, p_actor_id, 'assignFinding', p_idempotency_key,
    pg_catalog.jsonb_build_object('findingId', p_finding_id, 'revision', p_revision, 'assigneeId', p_assignee_id)
  ) receipt;
  if v_replayed then
    return private.review_finding_snapshot(v_workspace_id, p_finding_id);
  end if;

  if p_assignee_id is not null then
    select p.id into v_recipient_id
    from public.profiles p
    where p.id = p_assignee_id and p.workspace_id = v_workspace_id and p.role = 'Member'
    for share;
    if not found then
      raise exception 'Assignment recipient is not eligible' using errcode = '22023';
    end if;
  end if;

  if not exists (select 1 from public.findings f where f.id = p_finding_id and f.workspace_id = v_workspace_id) then
    raise exception 'Finding is unavailable' using errcode = 'P0002';
  end if;
  select pg_catalog.array_agg(distinct e.document_id order by e.document_id) into v_document_ids
  from public.finding_evidence e where e.finding_id = p_finding_id and e.workspace_id = v_workspace_id;
  for v_offset in 1..coalesce(pg_catalog.cardinality(v_document_ids), 0) by 100 loop
    perform private.lock_review_documents(
      v_workspace_id, v_document_ids[v_offset:least(v_offset + 99, pg_catalog.cardinality(v_document_ids))]
    );
  end loop;

  select f.* into v_finding from public.findings f
  where f.id = p_finding_id and f.workspace_id = v_workspace_id for update;
  if not found then
    raise exception 'Finding is unavailable' using errcode = 'P0002';
  end if;
  if v_finding.review_revision <> p_revision then
    raise exception 'Finding revision is stale' using errcode = 'P0001';
  end if;
  if v_finding.status not in ('confirmed', 'update_planned') then
    raise exception 'Finding cannot be assigned in its current status' using errcode = 'P0001';
  end if;

  if v_finding.assignee_id is distinct from p_assignee_id then
    v_round_ids := private.lock_review_finding_relations(v_workspace_id, p_finding_id);
    update public.findings f
    set assignee_id = p_assignee_id, review_revision = f.review_revision + 1
    where f.id = p_finding_id and f.workspace_id = v_workspace_id;

    with changed_items as (
      update public.correction_round_items i
      set assignee_id = p_assignee_id, revision = i.revision + 1
      from public.correction_rounds r
      where i.round_id = r.id and i.workspace_id = r.workspace_id
        and i.finding_id = p_finding_id and i.workspace_id = v_workspace_id
        and r.id = any(v_round_ids)
        and r.status in ('draft', 'collecting', 'consolidating', 'candidate_processing', 'candidate_failed', 'pending_approval')
        and i.assignee_id is distinct from p_assignee_id
      returning i.id, i.round_id
    )
    select count(*), coalesce(pg_catalog.array_agg(distinct c.round_id order by c.round_id), '{}'::uuid[]),
      coalesce(pg_catalog.array_agg(c.id order by c.id), '{}'::uuid[])
    into v_changed_item_count, v_changed_round_ids, v_changed_item_ids
    from changed_items c;
    if v_changed_item_count > 0 then
      update public.correction_rounds r
      set revision = r.revision + 1
      where r.id = any(v_changed_round_ids);

      update public.correction_submissions s set state = 'invalidated'
      where s.workspace_id = v_workspace_id and s.state = 'reserved'
        and exists (
          select 1 from public.correction_submission_items si
          where si.submission_id = s.id and si.round_item_id = any(v_changed_item_ids)
        );
    end if;

    v_event_id := pg_catalog.gen_random_uuid();
    perform private.append_review_audit(
      p_actor_id, 'finding_assigned', 'finding', p_finding_id,
      pg_catalog.jsonb_build_object('previousAssigneeId', v_finding.assignee_id, 'assigneeId', p_assignee_id), v_event_id
    );
    if p_assignee_id is not null then
      perform private.append_assignment_outbox(v_workspace_id, v_event_id, p_assignee_id);
    end if;
  end if;

  select f.* into strict v_finding from public.findings f
  where f.id = p_finding_id and f.workspace_id = v_workspace_id;
  perform private.finish_review_receipt(
    v_workspace_id, p_actor_id, 'assignFinding', p_idempotency_key,
    pg_catalog.jsonb_build_object('findingId', p_finding_id, 'revision', p_revision, 'assigneeId', p_assignee_id),
    p_finding_id, v_finding.review_revision, v_finding.status::text
  );
  return private.review_finding_snapshot(v_workspace_id, p_finding_id);
end;
$$;
revoke all on function public.review_assign_finding(uuid, uuid, bigint, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.review_assign_finding(uuid, uuid, bigint, uuid, text) to service_role;

comment on function public.review_change_finding(uuid, uuid, bigint, jsonb, text) is
  'Admin/QA human status and severity decision with tenant guard, CAS, atomic audit and minimal replay receipt.';
comment on function public.review_assign_finding(uuid, uuid, bigint, uuid, text) is
  'Admin/QA assignment command; synchronizes nonterminal authorization while preserving confirmed coverage and candidate fences.';
