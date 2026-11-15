-- Reviewer-owned round drafts, explicit opening, and safe cancellation.

create or replace function private.assert_review_finding_selection(
  p_workspace_id uuid,
  p_document_id uuid,
  p_finding_ids uuid[],
  p_opening boolean default false
) returns void
language plpgsql security definer
set search_path = '' set row_security = off
set lock_timeout = '1s' set statement_timeout = '5s'
as $$
declare
  v_finding_id uuid;
  v_finding public.findings%rowtype;
  v_assignee_id uuid;
begin
  if p_workspace_id is null or p_document_id is null or p_finding_ids is null
     or pg_catalog.cardinality(p_finding_ids) not between 1 and 100
     or exists (select 1 from pg_catalog.unnest(p_finding_ids) x where x is null)
     or pg_catalog.cardinality(p_finding_ids) <> (
       select pg_catalog.count(distinct x)::integer from pg_catalog.unnest(p_finding_ids) x
     ) then
    raise exception 'Invalid finding selection' using errcode = '22023';
  end if;

  for v_finding_id in
    select x from pg_catalog.unnest(p_finding_ids) x order by x
  loop
    select f.* into v_finding
    from public.findings f
    where f.id = v_finding_id and f.workspace_id = p_workspace_id
    for update;
    if not found then
      raise exception 'Finding selection is unavailable' using errcode = 'P0002';
    end if;

    select p.id into v_assignee_id
    from public.profiles p
    where p.id = v_finding.assignee_id and p.workspace_id = p_workspace_id and p.role = 'Member'
    for share;
    if v_finding.status not in ('confirmed', 'update_planned')
       or not exists (select 1 from public.analyses a
         where a.id = v_finding.analysis_id and a.workspace_id = p_workspace_id and a.status = 'completed')
       or v_assignee_id is null
       or not exists (select 1 from public.finding_evidence e
         where e.finding_id = v_finding.id and e.workspace_id = p_workspace_id and e.document_id = p_document_id) then
      if p_opening then
        raise exception 'Round selection changed and must be refreshed' using errcode = 'P0001';
      end if;
      raise exception 'Finding is not eligible for a correction round' using errcode = '22023';
    end if;
  end loop;
end;
$$;
revoke all on function private.assert_review_finding_selection(uuid, uuid, uuid[], boolean)
  from public, anon, authenticated, service_role;

create or replace function public.review_prepare_round(
  p_actor_id uuid,
  p_document_id uuid,
  p_mode text,
  p_finding_ids uuid[],
  p_idempotency_key text
) returns jsonb
language plpgsql security definer
set search_path = '' set row_security = off
set lock_timeout = '1s' set statement_timeout = '8s'
as $$
declare
  v_workspace_id uuid;
  v_base_version_id uuid;
  v_round_id uuid;
  v_round public.correction_rounds%rowtype;
  v_payload jsonb;
  v_replayed boolean;
  v_receipt_result_id uuid;
  v_event_id uuid;
begin
  if p_document_id is null or p_mode is null or p_mode not in ('assigned_findings', 'administrative') then
    raise exception 'Invalid correction round request' using errcode = '22023';
  end if;
  if p_mode = 'assigned_findings' then
    if p_finding_ids is null or pg_catalog.cardinality(p_finding_ids) not between 1 and 100
       or exists (select 1 from pg_catalog.unnest(p_finding_ids) x where x is null)
       or pg_catalog.cardinality(p_finding_ids) <> (
         select pg_catalog.count(distinct x)::integer from pg_catalog.unnest(p_finding_ids) x
       ) then
      raise exception 'Invalid assigned finding list' using errcode = '22023';
    end if;
  elsif p_finding_ids is not null and pg_catalog.cardinality(p_finding_ids) <> 0 then
    raise exception 'Administrative rounds cannot include finding IDs' using errcode = '22023';
  end if;

  v_workspace_id := private.lock_review_actor(p_actor_id);
  v_payload := pg_catalog.jsonb_build_object(
    'documentId', p_document_id,
    'mode', p_mode,
    'findingIds', coalesce(pg_catalog.to_jsonb(p_finding_ids), '[]'::jsonb)
  );
  select r.replayed, r.result_id into v_replayed, v_receipt_result_id
  from private.check_review_receipt(v_workspace_id, p_actor_id, 'prepareRound', p_idempotency_key, v_payload) r;
  if v_replayed then
    return private.review_round_snapshot(v_workspace_id, v_receipt_result_id);
  end if;

  perform private.lock_review_documents(v_workspace_id, array[p_document_id]);
  select d.active_version_id into v_base_version_id
  from public.documents d
  join public.document_versions v on v.id = d.active_version_id
    and v.document_id = d.id and v.workspace_id = d.workspace_id
  where d.id = p_document_id and d.workspace_id = v_workspace_id
    and v.processing_status = 'ready' and v.version_status = 'active'
  for update of d;
  if not found or v_base_version_id is null then
    raise exception 'Document has no active ready version' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.correction_rounds r
    where r.document_id = p_document_id and r.workspace_id = v_workspace_id
      and r.status not in ('approved', 'cancelled')) then
    raise exception 'Document already has an open correction round' using errcode = 'P0001';
  end if;

  if p_mode = 'assigned_findings' then
    perform private.assert_review_finding_selection(v_workspace_id, p_document_id, p_finding_ids, false);
  end if;

  insert into public.correction_rounds(workspace_id, document_id, mode, base_version_id, created_by)
  values (v_workspace_id, p_document_id, p_mode::public.correction_round_mode, v_base_version_id, p_actor_id)
  returning id into v_round_id;
  if p_mode = 'assigned_findings' then
    insert into public.correction_round_items(
      workspace_id, round_id, document_id, finding_id, initial_assignee_id, assignee_id
    )
    select v_workspace_id, v_round_id, p_document_id, f.id, f.assignee_id, f.assignee_id
    from public.findings f
    where f.id = any(p_finding_ids) and f.workspace_id = v_workspace_id
    order by f.id;
  end if;

  v_event_id := pg_catalog.gen_random_uuid();
  perform private.append_review_audit(
    p_actor_id, 'correction_round_prepared', 'correction_round', v_round_id,
    pg_catalog.jsonb_build_object('roundId', v_round_id), v_event_id
  );
  select r.* into strict v_round from public.correction_rounds r where r.id = v_round_id;
  perform private.finish_review_receipt(
    v_workspace_id, p_actor_id, 'prepareRound', p_idempotency_key, v_payload,
    v_round_id, v_round.revision, v_round.status::text
  );
  return private.review_round_snapshot(v_workspace_id, v_round_id);
end;
$$;
revoke all on function public.review_prepare_round(uuid, uuid, text, uuid[], text)
  from public, anon, authenticated, service_role;
grant execute on function public.review_prepare_round(uuid, uuid, text, uuid[], text) to service_role;

create or replace function public.review_update_round_draft(
  p_actor_id uuid,
  p_round_id uuid,
  p_revision bigint,
  p_finding_ids uuid[],
  p_idempotency_key text
) returns jsonb
language plpgsql security definer
set search_path = '' set row_security = off
set lock_timeout = '1s' set statement_timeout = '8s'
as $$
declare
  v_workspace_id uuid;
  v_round public.correction_rounds%rowtype;
  v_existing_ids uuid[];
  v_payload jsonb;
  v_replayed boolean;
  v_receipt_result_id uuid;
  v_round_id uuid;
  v_changed boolean := false;
  v_item_id uuid;
  v_event_id uuid;
begin
  if p_round_id is null or p_revision is null or p_revision < 1 or p_revision > 9007199254740991
     or p_finding_ids is null or pg_catalog.cardinality(p_finding_ids) not between 1 and 100
     or exists (select 1 from pg_catalog.unnest(p_finding_ids) x where x is null)
     or pg_catalog.cardinality(p_finding_ids) <> (
       select pg_catalog.count(distinct x)::integer from pg_catalog.unnest(p_finding_ids) x
     ) then
    raise exception 'Invalid draft finding selection' using errcode = '22023';
  end if;
  v_workspace_id := private.lock_review_actor(p_actor_id);
  v_payload := pg_catalog.jsonb_build_object('roundId', p_round_id, 'revision', p_revision, 'findingIds', p_finding_ids);
  select r.replayed, r.result_id into v_replayed, v_receipt_result_id
  from private.check_review_receipt(v_workspace_id, p_actor_id, 'updateRoundDraft', p_idempotency_key, v_payload) r;
  if v_replayed then
    return private.review_round_snapshot(v_workspace_id, v_receipt_result_id);
  end if;

  select r.document_id into v_round.document_id
  from public.correction_rounds r where r.id = p_round_id and r.workspace_id = v_workspace_id;
  if not found then raise exception 'Correction round is unavailable' using errcode = 'P0002'; end if;
  perform private.lock_review_documents(v_workspace_id, array[v_round.document_id]);
  select r.* into v_round from public.correction_rounds r
  where r.id = p_round_id and r.workspace_id = v_workspace_id for update;
  if not found then raise exception 'Correction round is unavailable' using errcode = 'P0002'; end if;
  if v_round.revision <> p_revision then
    raise exception 'Correction round revision is stale' using errcode = 'P0001';
  end if;
  if v_round.mode <> 'assigned_findings' or v_round.status <> 'draft' then
    raise exception 'Only an assigned finding draft can be edited' using errcode = 'P0001';
  end if;
  perform private.assert_review_finding_selection(v_workspace_id, v_round.document_id, p_finding_ids, false);

  for v_item_id in
    select i.id from public.correction_round_items i
    where i.round_id = p_round_id and i.workspace_id = v_workspace_id order by i.id
  loop
    perform 1 from public.correction_round_items i where i.id = v_item_id for update;
  end loop;
  select coalesce(pg_catalog.array_agg(i.finding_id order by i.finding_id), '{}'::uuid[])
  into v_existing_ids from public.correction_round_items i
  where i.round_id = p_round_id and i.workspace_id = v_workspace_id;
  select coalesce(pg_catalog.array_agg(x order by x), '{}'::uuid[])
  into v_existing_ids from (
    select unnest(v_existing_ids) as x
  ) q;
  if v_existing_ids is distinct from (
    select pg_catalog.array_agg(x order by x) from pg_catalog.unnest(p_finding_ids) x
  ) then
    v_changed := true;
    delete from public.correction_round_items i
    where i.round_id = p_round_id and i.workspace_id = v_workspace_id
      and not (i.finding_id = any(p_finding_ids));
    insert into public.correction_round_items(
      workspace_id, round_id, document_id, finding_id, initial_assignee_id, assignee_id
    )
    select v_workspace_id, p_round_id, v_round.document_id, f.id, f.assignee_id, f.assignee_id
    from public.findings f
    where f.id = any(p_finding_ids) and f.workspace_id = v_workspace_id
      and not exists (select 1 from public.correction_round_items i
        where i.round_id = p_round_id and i.finding_id = f.id)
    order by f.id;
    update public.correction_rounds r
    set revision = r.revision + 1, coverage_revision = r.coverage_revision + 1,
        updated_at = pg_catalog.clock_timestamp()
    where r.id = p_round_id and r.workspace_id = v_workspace_id;
    v_event_id := pg_catalog.gen_random_uuid();
    perform private.append_review_audit(
      p_actor_id, 'correction_round_draft_updated', 'correction_round', p_round_id,
      pg_catalog.jsonb_build_object('roundId', p_round_id), v_event_id
    );
  end if;

  select r.* into strict v_round from public.correction_rounds r where r.id = p_round_id;
  perform private.finish_review_receipt(
    v_workspace_id, p_actor_id, 'updateRoundDraft', p_idempotency_key, v_payload,
    p_round_id, v_round.revision, v_round.status::text
  );
  return private.review_round_snapshot(v_workspace_id, p_round_id);
end;
$$;
revoke all on function public.review_update_round_draft(uuid, uuid, bigint, uuid[], text)
  from public, anon, authenticated, service_role;
grant execute on function public.review_update_round_draft(uuid, uuid, bigint, uuid[], text) to service_role;

create or replace function public.review_open_round(
  p_actor_id uuid,
  p_round_id uuid,
  p_revision bigint,
  p_idempotency_key text
) returns jsonb
language plpgsql security definer
set search_path = '' set row_security = off
set lock_timeout = '1s' set statement_timeout = '8s'
as $$
declare
  v_workspace_id uuid;
  v_round public.correction_rounds%rowtype;
  v_finding_ids uuid[];
  v_new_status public.correction_round_status;
  v_payload jsonb;
  v_replayed boolean;
  v_receipt_result_id uuid;
  v_event_id uuid;
begin
  if p_round_id is null or p_revision is null or p_revision < 1 or p_revision > 9007199254740991 then
    raise exception 'Invalid correction round opening request' using errcode = '22023';
  end if;
  v_workspace_id := private.lock_review_actor(p_actor_id);
  v_payload := pg_catalog.jsonb_build_object('roundId', p_round_id, 'revision', p_revision);
  select r.replayed, r.result_id into v_replayed, v_receipt_result_id
  from private.check_review_receipt(v_workspace_id, p_actor_id, 'openRound', p_idempotency_key, v_payload) r;
  if v_replayed then
    return private.review_open_round_snapshot(v_workspace_id, v_receipt_result_id);
  end if;

  select r.document_id into v_round.document_id
  from public.correction_rounds r where r.id = p_round_id and r.workspace_id = v_workspace_id;
  if not found then raise exception 'Correction round is unavailable' using errcode = 'P0002'; end if;
  perform private.lock_review_documents(v_workspace_id, array[v_round.document_id]);
  select r.* into v_round from public.correction_rounds r
  where r.id = p_round_id and r.workspace_id = v_workspace_id for update;
  if not found then raise exception 'Correction round is unavailable' using errcode = 'P0002'; end if;
  if v_round.revision <> p_revision then
    raise exception 'Correction round revision is stale' using errcode = 'P0001';
  end if;
  if v_round.status <> 'draft' then
    raise exception 'Only a draft correction round can be opened' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.documents d
    join public.document_versions v on v.id = v_round.base_version_id
      and v.document_id = d.id and v.workspace_id = d.workspace_id
    where d.id = v_round.document_id and d.workspace_id = v_workspace_id
      and d.active_version_id = v_round.base_version_id
      and v.processing_status = 'ready' and v.version_status = 'active'
  ) then
    raise exception 'Correction round base is no longer active and ready' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.correction_rounds r
    where r.document_id = v_round.document_id and r.workspace_id = v_workspace_id
      and r.id <> p_round_id and r.status not in ('approved', 'cancelled')) then
    raise exception 'Document has another open correction round' using errcode = 'P0001';
  end if;

  if v_round.mode = 'assigned_findings' then
    select coalesce(pg_catalog.array_agg(i.finding_id order by i.finding_id), '{}'::uuid[])
    into v_finding_ids from public.correction_round_items i
    where i.round_id = p_round_id and i.workspace_id = v_workspace_id;
    perform private.assert_review_finding_selection(v_workspace_id, v_round.document_id, v_finding_ids, true);
    if exists (
      select 1 from public.correction_round_items i
      join public.findings f on f.id = i.finding_id and f.workspace_id = i.workspace_id
      where i.round_id = p_round_id and i.workspace_id = v_workspace_id
        and (i.assignee_id is distinct from f.assignee_id or i.assignee_id is null
          or not private.review_profile_has_role(i.assignee_id, v_workspace_id, array['Member']))
    ) then
      raise exception 'Round assignment changed and must be refreshed' using errcode = 'P0001';
    end if;
    for v_event_id in
      select i.id from public.correction_round_items i
      where i.round_id = p_round_id and i.workspace_id = v_workspace_id order by i.id
    loop
      perform 1 from public.correction_round_items i where i.id = v_event_id for update;
    end loop;
    v_new_status := 'collecting';
  else
    if exists (select 1 from public.correction_round_items i where i.round_id = p_round_id) then
      raise exception 'Administrative rounds cannot contain finding items' using errcode = 'P0001';
    end if;
    v_new_status := 'consolidating';
  end if;

  update public.correction_rounds r
  set status = v_new_status, opened_at = pg_catalog.clock_timestamp(),
      revision = r.revision + 1, updated_at = pg_catalog.clock_timestamp()
  where r.id = p_round_id and r.workspace_id = v_workspace_id;
  v_event_id := pg_catalog.gen_random_uuid();
  perform private.append_review_audit(
    p_actor_id, 'correction_round_opened', 'correction_round', p_round_id,
    pg_catalog.jsonb_build_object('roundId', p_round_id), v_event_id
  );
  select r.* into strict v_round from public.correction_rounds r where r.id = p_round_id;
  perform private.finish_review_receipt(
    v_workspace_id, p_actor_id, 'openRound', p_idempotency_key, v_payload,
    p_round_id, v_round.revision, v_round.status::text
  );
  return private.review_open_round_snapshot(v_workspace_id, p_round_id);
end;
$$;
revoke all on function public.review_open_round(uuid, uuid, bigint, text)
  from public, anon, authenticated, service_role;
grant execute on function public.review_open_round(uuid, uuid, bigint, text) to service_role;

create or replace function public.review_cancel_round(
  p_actor_id uuid,
  p_round_id uuid,
  p_revision bigint,
  p_reason text,
  p_idempotency_key text
) returns jsonb
language plpgsql security definer
set search_path = '' set row_security = off
set lock_timeout = '1s' set statement_timeout = '8s'
as $$
declare
  v_workspace_id uuid;
  v_round public.correction_rounds%rowtype;
  v_payload jsonb;
  v_reason text;
  v_replayed boolean;
  v_receipt_result_id uuid;
  v_submission_id uuid;
  v_item_id uuid;
  v_candidate public.correction_candidates%rowtype;
  v_event_id uuid;
begin
  v_reason := pg_catalog.btrim(p_reason);
  if p_round_id is null or p_revision is null or p_revision < 1 or p_revision > 9007199254740991
     or v_reason is null or pg_catalog.char_length(v_reason) not between 1 and 2000 then
    raise exception 'Invalid correction round cancellation request' using errcode = '22023';
  end if;
  v_workspace_id := private.lock_review_actor(p_actor_id);
  v_payload := pg_catalog.jsonb_build_object('roundId', p_round_id, 'revision', p_revision, 'reason', v_reason);
  select r.replayed, r.result_id into v_replayed, v_receipt_result_id
  from private.check_review_receipt(v_workspace_id, p_actor_id, 'cancelRound', p_idempotency_key, v_payload) r;
  if v_replayed then
    return private.review_round_snapshot(v_workspace_id, v_receipt_result_id);
  end if;

  select r.document_id into v_round.document_id
  from public.correction_rounds r where r.id = p_round_id and r.workspace_id = v_workspace_id;
  if not found then raise exception 'Correction round is unavailable' using errcode = 'P0002'; end if;
  perform private.lock_review_documents(v_workspace_id, array[v_round.document_id]);
  select r.* into v_round from public.correction_rounds r
  where r.id = p_round_id and r.workspace_id = v_workspace_id for update;
  if not found then raise exception 'Correction round is unavailable' using errcode = 'P0002'; end if;
  if v_round.revision <> p_revision then
    raise exception 'Correction round revision is stale' using errcode = 'P0001';
  end if;
  if v_round.status = 'cancelled' then
    perform private.finish_review_receipt(
      v_workspace_id, p_actor_id, 'cancelRound', p_idempotency_key, v_payload,
      p_round_id, v_round.revision, v_round.status::text
    );
    return private.review_round_snapshot(v_workspace_id, p_round_id);
  end if;
  if v_round.status not in ('draft', 'collecting', 'consolidating', 'candidate_failed') then
    raise exception 'Correction round cannot be cancelled in its current phase' using errcode = 'P0001';
  end if;

  for v_submission_id in
    select s.id from public.correction_submissions s
    where s.round_id = p_round_id and s.workspace_id = v_workspace_id and s.state = 'reserved'
    order by s.id
  loop
    perform 1 from public.correction_submissions s
    where s.id = v_submission_id and s.workspace_id = v_workspace_id for update;
  end loop;
  for v_item_id in
    select i.id from public.correction_round_items i
    where i.round_id = p_round_id and i.workspace_id = v_workspace_id order by i.id
  loop
    perform 1 from public.correction_round_items i
    where i.id = v_item_id and i.workspace_id = v_workspace_id for update;
  end loop;
  for v_candidate in
    select c.* from public.correction_candidates c
    where c.round_id = p_round_id and c.workspace_id = v_workspace_id and c.status in ('reserved', 'failed')
    order by c.id
    for update
  loop
    perform 1 from public.document_versions v
    where v.id = v_candidate.version_id and v.workspace_id = v_workspace_id for update;
  end loop;

  update public.correction_submissions s set state = 'invalidated'
  where s.round_id = p_round_id and s.workspace_id = v_workspace_id and s.state = 'reserved';

  for v_candidate in
    select c.* from public.correction_candidates c
    where c.round_id = p_round_id and c.workspace_id = v_workspace_id and c.status in ('reserved', 'failed')
    order by c.id
  loop
    insert into public.correction_candidate_decisions(
      workspace_id, round_id, document_id, candidate_id, actor_id, outcome, private_reason
    ) values (
      v_workspace_id, p_round_id, v_round.document_id, v_candidate.id, p_actor_id, 'invalidated', v_reason
    );
    update public.correction_candidates c set status = 'invalidated', revision = c.revision + 1
    where c.id = v_candidate.id and c.workspace_id = v_workspace_id;
    update public.document_versions v set version_status = null
    where v.id = v_candidate.version_id and v.workspace_id = v_workspace_id;
  end loop;

  insert into private.review_round_cancellations(round_id, workspace_id, actor_id, reason)
  values (p_round_id, v_workspace_id, p_actor_id, v_reason);
  update public.correction_rounds r
  set status = 'cancelled', active_candidate_id = null,
      revision = r.revision + 1, updated_at = pg_catalog.clock_timestamp()
  where r.id = p_round_id and r.workspace_id = v_workspace_id;
  v_event_id := pg_catalog.gen_random_uuid();
  perform private.append_review_audit(
    p_actor_id, 'correction_round_cancelled', 'correction_round', p_round_id,
    pg_catalog.jsonb_build_object('roundId', p_round_id), v_event_id
  );
  select r.* into strict v_round from public.correction_rounds r where r.id = p_round_id;
  perform private.finish_review_receipt(
    v_workspace_id, p_actor_id, 'cancelRound', p_idempotency_key, v_payload,
    p_round_id, v_round.revision, v_round.status::text
  );
  return private.review_round_snapshot(v_workspace_id, p_round_id);
end;
$$;
revoke all on function public.review_cancel_round(uuid, uuid, bigint, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.review_cancel_round(uuid, uuid, bigint, text, text) to service_role;

comment on function public.review_prepare_round(uuid, uuid, text, uuid[], text) is
  'Creates one tenant-scoped reviewer draft from the active ready base and an eligible evidence selection.';
comment on function public.review_update_round_draft(uuid, uuid, bigint, uuid[], text) is
  'Replaces an assigned draft selection additively while preserving retained item history.';
comment on function public.review_open_round(uuid, uuid, bigint, text) is
  'Revalidates an active draft, snapshots its opening assignees, then enters collection or consolidation.';
comment on function public.review_cancel_round(uuid, uuid, bigint, text, text) is
  'Atomically cancels an eligible round, invalidates pending reservations and reserved/failed candidates, and keeps private reason out of audit receipts.';
