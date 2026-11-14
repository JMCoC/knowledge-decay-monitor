-- Shared transaction support and actor-scoped reviewer projections.
-- Privileged RPC entry points are callable only by the server service role.

create function private.review_canonical_payload(p_value jsonb, p_key text default null)
returns jsonb
language plpgsql immutable
set search_path = ''
as $$
declare
  v_result jsonb;
  v_text text;
begin
  if p_value is null then
    raise exception 'Review payload is required' using errcode = '22023';
  end if;

  case pg_catalog.jsonb_typeof(p_value)
    when 'object' then
      select coalesce(pg_catalog.jsonb_object_agg(e.key,
        private.review_canonical_payload(e.value, e.key)), '{}'::jsonb)
      into v_result
      from pg_catalog.jsonb_each(p_value) e;
      return v_result;
    when 'array' then
      if p_key in ('findingIds', 'itemIds', 'documentIds', 'versionIds') then
        if exists (
          select 1 from pg_catalog.jsonb_array_elements(p_value) e(value)
          where pg_catalog.jsonb_typeof(e.value) <> 'string'
             or e.value #>> '{}' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        ) then
          raise exception 'Review payload contains an invalid UUID set' using errcode = '22023';
        end if;
        select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(pg_catalog.lower(e.value #>> '{}'))
          order by pg_catalog.lower(e.value #>> '{}')), '[]'::jsonb)
        into v_result
        from pg_catalog.jsonb_array_elements(p_value) e(value);
        return v_result;
      end if;
      select coalesce(pg_catalog.jsonb_agg(
        private.review_canonical_payload(e.value, null) order by e.ordinality), '[]'::jsonb)
      into v_result
      from pg_catalog.jsonb_array_elements(p_value) with ordinality e(value, ordinality);
      return v_result;
    when 'string' then
      v_text := p_value #>> '{}';
      if v_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        return pg_catalog.to_jsonb(pg_catalog.lower(v_text));
      end if;
      if p_key in ('reason', 'privateReason') then
        return pg_catalog.to_jsonb(pg_catalog.btrim(v_text));
      end if;
      return p_value;
    else
      return p_value;
  end case;
end;
$$;
revoke all on function private.review_canonical_payload(jsonb, text)
  from public, anon, authenticated, service_role;

create function private.review_command_fingerprint(p_operation text, p_payload jsonb)
returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  v_allowed_operations constant text[] := array[
    'changeFinding', 'assignFinding', 'prepareRound', 'updateRoundDraft', 'openRound', 'cancelRound',
    'reserveCorrection', 'finalizeCorrection', 'resumeCorrection', 'selectFinalCandidate',
    'reserveConsolidatedFile', 'finalizeConsolidatedFile', 'retryCorrectionCandidate',
    'returnRoundItems', 'rejectAdministrativeCandidate', 'approveCorrection'
  ];
  v_normalized jsonb;
begin
  if p_operation is null or not (p_operation = any(v_allowed_operations))
     or p_payload is null or pg_catalog.jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Invalid review command fingerprint input' using errcode = '22023';
  end if;
  v_normalized := private.review_canonical_payload(p_payload, null);
  return pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(p_operation || ':' || v_normalized::text, 'UTF8'), 'sha256'), 'hex');
end;
$$;
revoke all on function private.review_command_fingerprint(text, jsonb)
  from public, anon, authenticated, service_role;

create function private.review_reader_workspace(p_actor_id uuid) returns uuid
language plpgsql stable security definer
set search_path = '' set row_security = off
as $$
declare
  v_workspace_id uuid;
  v_role text;
begin
  select p.workspace_id, p.role::text into v_workspace_id, v_role
  from public.profiles p where p.id = p_actor_id;
  if not found or v_role not in ('Admin', 'QA Lead') then
    raise exception 'A reviewer profile is required' using errcode = '42501';
  end if;
  return v_workspace_id;
end;
$$;
revoke all on function private.review_reader_workspace(uuid)
  from public, anon, authenticated, service_role;

create function private.lock_review_actor(p_actor_id uuid) returns uuid
language plpgsql security definer
set search_path = '' set row_security = off
set lock_timeout = '1s' set statement_timeout = '3s'
as $$
declare
  v_workspace_id uuid;
  v_locked_workspace_id uuid;
  v_role text;
begin
  select p.workspace_id, p.role::text into v_workspace_id, v_role
  from public.profiles p where p.id = p_actor_id;
  if not found or p_actor_id is null or v_role not in ('Admin', 'QA Lead') then
    raise exception 'A reviewer profile is required' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('review:' || v_workspace_id::text, 0));

  select p.workspace_id, p.role::text into v_locked_workspace_id, v_role
  from public.profiles p where p.id = p_actor_id for share;
  if not found or v_locked_workspace_id <> v_workspace_id or v_role not in ('Admin', 'QA Lead') then
    raise exception 'Reviewer authorization changed' using errcode = '42501';
  end if;
  return v_locked_workspace_id;
end;
$$;
revoke all on function private.lock_review_actor(uuid)
  from public, anon, authenticated, service_role;

create function private.lock_review_documents(p_workspace_id uuid, p_document_ids uuid[]) returns void
language plpgsql security definer
set search_path = '' set row_security = off
set lock_timeout = '1s' set statement_timeout = '3s'
as $$
declare
  v_document_id uuid;
begin
  if p_workspace_id is null or p_document_ids is null
     or pg_catalog.cardinality(p_document_ids) < 1
     or pg_catalog.cardinality(p_document_ids) > 100
     or pg_catalog.cardinality(p_document_ids) <> (
       select pg_catalog.count(distinct x)::integer from pg_catalog.unnest(p_document_ids) x
     ) then
    raise exception 'Invalid review document lock set' using errcode = '22023';
  end if;

  for v_document_id in
    select x from pg_catalog.unnest(p_document_ids) x order by x
  loop
    perform 1 from public.documents d
    where d.id = v_document_id and d.workspace_id = p_workspace_id
    for update;
    if not found then
      raise exception 'Review document is unavailable' using errcode = 'P0002';
    end if;
  end loop;
end;
$$;
revoke all on function private.lock_review_documents(uuid, uuid[])
  from public, anon, authenticated, service_role;

create function private.check_review_receipt(
  p_workspace_id uuid,
  p_actor_id uuid,
  p_operation text,
  p_key text,
  p_payload jsonb
) returns table(replayed boolean, result_id uuid)
language plpgsql security definer
set search_path = '' set row_security = off
set lock_timeout = '1s' set statement_timeout = '3s'
as $$
declare
  v_fingerprint text;
  v_saved_fingerprint text;
  v_saved_result_id uuid;
begin
  if p_workspace_id is null or p_actor_id is null or p_key is null
     or p_key <> pg_catalog.btrim(p_key)
     or pg_catalog.char_length(p_key) not between 1 and 128 then
    raise exception 'Invalid review receipt key' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.profiles p
    where p.id = p_actor_id and p.workspace_id = p_workspace_id
      and p.role in ('Admin', 'QA Lead')
  ) then
    raise exception 'A reviewer profile is required' using errcode = '42501';
  end if;

  v_fingerprint := private.review_command_fingerprint(p_operation, p_payload);
  select c.fingerprint, c.result_id into v_saved_fingerprint, v_saved_result_id
  from private.review_commands c
  where c.workspace_id = p_workspace_id and c.actor_id = p_actor_id
    and c.operation = p_operation and c.idempotency_key = p_key
  for share;
  if found then
    if v_saved_fingerprint <> v_fingerprint then
      raise exception 'Idempotency key was used with a different request' using errcode = 'P0001';
    end if;
    return query select true, v_saved_result_id;
  else
    return query select false, null::uuid;
  end if;
end;
$$;
revoke all on function private.check_review_receipt(uuid, uuid, text, text, jsonb)
  from public, anon, authenticated, service_role;

create function private.finish_review_receipt(
  p_workspace_id uuid,
  p_actor_id uuid,
  p_operation text,
  p_key text,
  p_payload jsonb,
  p_result_id uuid,
  p_result_revision bigint,
  p_result_status text
) returns void
language plpgsql security definer
set search_path = '' set row_security = off
set lock_timeout = '1s' set statement_timeout = '3s'
as $$
declare
  v_fingerprint text;
begin
  if p_workspace_id is null or p_actor_id is null or p_key is null
     or p_key <> pg_catalog.btrim(p_key)
     or pg_catalog.char_length(p_key) not between 1 and 128
     or p_result_id is null or p_result_revision is null
     or p_result_revision < 1 or p_result_revision > 9007199254740991
     or p_result_status is null or pg_catalog.char_length(p_result_status) > 60 then
    raise exception 'Invalid review receipt result' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.profiles p
    where p.id = p_actor_id and p.workspace_id = p_workspace_id
      and p.role in ('Admin', 'QA Lead')
  ) then
    raise exception 'A reviewer profile is required' using errcode = '42501';
  end if;

  v_fingerprint := private.review_command_fingerprint(p_operation, p_payload);
  insert into private.review_commands(
    workspace_id, actor_id, operation, idempotency_key, fingerprint,
    result_id, result_revision, result_status
  ) values (
    p_workspace_id, p_actor_id, p_operation, p_key, v_fingerprint,
    p_result_id, p_result_revision, p_result_status
  );
end;
$$;
revoke all on function private.finish_review_receipt(uuid, uuid, text, text, jsonb, uuid, bigint, text)
  from public, anon, authenticated, service_role;

create function private.review_finding_snapshot(p_workspace_id uuid, p_finding_id uuid) returns jsonb
language plpgsql stable security definer
set search_path = '' set row_security = off
as $$
declare
  v_snapshot jsonb;
begin
  select pg_catalog.jsonb_build_object(
    'id', f.id,
    'analysisId', f.analysis_id,
    'type', f.type,
    'explanation', f.explanation,
    'severityOriginal', f.severity_original,
    'severityCurrent', f.severity_current,
    'status', f.status,
    'assignee', case when assignee.id is null then null
      else pg_catalog.jsonb_build_object('id', assignee.id, 'fullName', assignee.full_name) end,
    'createdAt', f.created_at,
    'revision', f.review_revision,
    'canChangeStatus', case f.status
      when 'pending_review' then true
      when 'confirmed' then true
      when 'false_positive' then true
      when 'update_planned' then true
      else false end,
    'canChangeSeverity', true,
    'canAssign', f.status in ('confirmed', 'update_planned'),
    'canPrepareRound', f.status in ('confirmed', 'update_planned') and assignee.id is not null
      and exists (
        select 1
        from public.finding_evidence e
        join public.documents d on d.id = e.document_id and d.workspace_id = e.workspace_id
        join public.document_versions v on v.id = d.active_version_id
          and v.document_id = d.id and v.workspace_id = d.workspace_id
        where e.finding_id = f.id and e.workspace_id = f.workspace_id
          and d.active_version_id is not null
          and v.processing_status = 'ready' and v.version_status = 'active'
      )
  ) into v_snapshot
  from public.findings f
  left join public.profiles assignee on assignee.id = f.assignee_id
    and assignee.workspace_id = f.workspace_id and assignee.role = 'Member'
  where f.id = p_finding_id and f.workspace_id = p_workspace_id;

  if v_snapshot is null then
    raise exception 'Finding is unavailable' using errcode = 'P0002';
  end if;
  return v_snapshot;
end;
$$;
revoke all on function private.review_finding_snapshot(uuid, uuid)
  from public, anon, authenticated, service_role;

create function private.review_round_snapshot(p_workspace_id uuid, p_round_id uuid) returns jsonb
language plpgsql stable security definer
set search_path = '' set row_security = off
as $$
declare
  v_snapshot jsonb;
begin
  select pg_catalog.jsonb_build_object(
    'roundId', r.id,
    'documentId', r.document_id,
    'mode', r.mode,
    'baseActiveVersionId', r.base_version_id,
    'status', r.status,
    'revision', r.revision,
    'createdAt', r.created_at,
    'openedAt', r.opened_at
  ) into v_snapshot
  from public.correction_rounds r
  where r.id = p_round_id and r.workspace_id = p_workspace_id;

  if v_snapshot is null then
    raise exception 'Correction round is unavailable' using errcode = 'P0002';
  end if;
  return v_snapshot;
end;
$$;
revoke all on function private.review_round_snapshot(uuid, uuid)
  from public, anon, authenticated, service_role;

create function private.review_open_round_snapshot(p_workspace_id uuid, p_round_id uuid) returns jsonb
language plpgsql stable security definer
set search_path = '' set row_security = off
as $$
declare
  v_round public.correction_rounds%rowtype;
  v_items jsonb;
  v_submissions jsonb;
  v_candidate jsonb;
  v_coverage jsonb;
begin
  select r.* into v_round from public.correction_rounds r
  where r.id = p_round_id and r.workspace_id = p_workspace_id;
  if not found then
    raise exception 'Correction round is unavailable' using errcode = 'P0002';
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'itemId', i.id,
    'finding', private.review_finding_snapshot(p_workspace_id, i.finding_id),
    'initialAssignee', case when initial_owner.id is null then null
      else pg_catalog.jsonb_build_object('id', initial_owner.id, 'fullName', initial_owner.full_name) end,
    'assignee', case when current_owner.id is null then null
      else pg_catalog.jsonb_build_object('id', current_owner.id, 'fullName', current_owner.full_name) end,
    'revision', i.revision,
    'currentSubmissionId', i.current_submission_id
  ) order by i.created_at, i.id), '[]'::jsonb)
  into v_items
  from public.correction_round_items i
  left join public.profiles initial_owner on initial_owner.id = i.initial_assignee_id
    and initial_owner.workspace_id = i.workspace_id and initial_owner.role = 'Member'
  left join public.profiles current_owner on current_owner.id = i.assignee_id
    and current_owner.workspace_id = i.workspace_id and current_owner.role = 'Member'
  where i.round_id = v_round.id and i.workspace_id = p_workspace_id;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'submissionId', s.id,
    'versionId', s.version_id,
    'state', s.state,
    'submitter', pg_catalog.jsonb_build_object('id', submitter.id, 'fullName', submitter.full_name),
    'itemIds', coalesce((
      select pg_catalog.jsonb_agg(si.round_item_id order by si.round_item_id)
      from public.correction_submission_items si
      where si.submission_id = s.id and si.workspace_id = p_workspace_id
    ), '[]'::jsonb),
    'upload', pg_catalog.jsonb_build_object(
      'versionId', v.id,
      'uploadState', v.upload_state,
      'attemptId', v.current_upload_attempt_id,
      'canOpen', v.upload_state = 'confirmed',
      'canResume', false,
      'canRecover', false
    ),
    'confirmedAt', s.confirmed_at
  ) order by s.created_at, s.id), '[]'::jsonb)
  into v_submissions
  from public.correction_submissions s
  join public.profiles submitter on submitter.id = s.submitter_id
    and submitter.workspace_id = s.workspace_id
  join public.document_versions v on v.id = s.version_id
    and v.document_id = s.document_id and v.workspace_id = s.workspace_id
  where s.round_id = v_round.id and s.workspace_id = p_workspace_id;

  select pg_catalog.jsonb_build_object(
    'revision', v_round.coverage_revision,
    'complete', pg_catalog.count(*) filter (where i.current_submission_id is not null)
      = pg_catalog.count(*),
    'coveredItemCount', pg_catalog.count(*) filter (where i.current_submission_id is not null),
    'requiredItemCount', pg_catalog.count(*)
  ) into v_coverage
  from public.correction_round_items i
  where i.round_id = v_round.id and i.workspace_id = p_workspace_id;

  if v_round.active_candidate_id is not null then
    select pg_catalog.jsonb_build_object(
      'candidateId', c.id,
      'versionId', c.version_id,
      'selectionKind', c.selection_kind,
      'status', c.status,
      'processingStatus', v.processing_status,
      'versionStatus', v.version_status,
      'revision', c.revision,
      'coverageRevision', c.coverage_revision,
      'itemIds', coalesce((
        select pg_catalog.jsonb_agg(ci.round_item_id order by ci.round_item_id)
        from public.correction_candidate_items ci
        where ci.candidate_id = c.id and ci.workspace_id = p_workspace_id
      ), '[]'::jsonb)
    ) into v_candidate
    from public.correction_candidates c
    join public.document_versions v on v.id = c.version_id
      and v.document_id = c.document_id and v.workspace_id = c.workspace_id
    where c.id = v_round.active_candidate_id and c.round_id = v_round.id
      and c.workspace_id = p_workspace_id;
  end if;

  return private.review_round_snapshot(p_workspace_id, p_round_id)
    || pg_catalog.jsonb_build_object(
      'items', v_items,
      'submissions', v_submissions,
      'coverage', v_coverage,
      'candidate', v_candidate
    );
end;
$$;
revoke all on function private.review_open_round_snapshot(uuid, uuid)
  from public, anon, authenticated, service_role;

create function public.review_list_assignees(
  p_actor_id uuid, p_page bigint default 1, p_page_size integer default 25
) returns jsonb
language plpgsql security definer
set search_path = '' set row_security = off
set lock_timeout = '1s' set statement_timeout = '3s'
as $$
declare
  v_workspace_id uuid;
  v_total bigint;
  v_items jsonb;
begin
  v_workspace_id := private.review_reader_workspace(p_actor_id);
  if p_page is null or p_page < 1 or p_page > 9007199254740991
     or p_page_size is null or p_page_size < 1 or p_page_size > 100 then
    raise exception 'Invalid reviewer directory page' using errcode = '22023';
  end if;

  select pg_catalog.count(*) into v_total from public.profiles p
  where p.workspace_id = v_workspace_id and p.role = 'Member';

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', page_rows.id, 'fullName', page_rows.full_name
  ) order by page_rows.full_name, page_rows.id), '[]'::jsonb)
  into v_items
  from (
    select p.id, p.full_name from public.profiles p
    where p.workspace_id = v_workspace_id and p.role = 'Member'
    order by p.full_name, p.id
    limit p_page_size offset ((p_page - 1) * p_page_size)
  ) page_rows;

  return pg_catalog.jsonb_build_object(
    'items', v_items, 'total', v_total, 'page', p_page, 'pageSize', p_page_size
  );
end;
$$;
revoke all on function public.review_list_assignees(uuid, bigint, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.review_list_assignees(uuid, bigint, integer) to service_role;

create function public.review_get_finding(p_actor_id uuid, p_finding_id uuid) returns jsonb
language plpgsql security definer
set search_path = '' set row_security = off
set lock_timeout = '1s' set statement_timeout = '3s'
as $$
declare
  v_workspace_id uuid;
begin
  v_workspace_id := private.review_reader_workspace(p_actor_id);
  if p_finding_id is null then
    raise exception 'Finding is unavailable' using errcode = 'P0002';
  end if;
  return private.review_finding_snapshot(v_workspace_id, p_finding_id);
end;
$$;
revoke all on function public.review_get_finding(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.review_get_finding(uuid, uuid) to service_role;

create function public.review_get_round_draft(p_actor_id uuid, p_round_id uuid) returns jsonb
language plpgsql security definer
set search_path = '' set row_security = off
set lock_timeout = '1s' set statement_timeout = '3s'
as $$
declare
  v_workspace_id uuid;
  v_round public.correction_rounds%rowtype;
  v_finding_ids jsonb;
begin
  v_workspace_id := private.review_reader_workspace(p_actor_id);
  select r.* into v_round from public.correction_rounds r
  where r.id = p_round_id and r.workspace_id = v_workspace_id and r.created_by = p_actor_id;
  if not found then
    raise exception 'Correction draft is unavailable' using errcode = 'P0002';
  end if;
  if v_round.status <> 'draft' then
    raise exception 'Correction draft is no longer editable' using errcode = 'P0001';
  end if;

  select coalesce(pg_catalog.jsonb_agg(i.finding_id order by i.finding_id), '[]'::jsonb)
  into v_finding_ids from public.correction_round_items i
  where i.round_id = v_round.id and i.workspace_id = v_workspace_id;
  return private.review_round_snapshot(v_workspace_id, v_round.id)
    || pg_catalog.jsonb_build_object('findingIds', v_finding_ids);
end;
$$;
revoke all on function public.review_get_round_draft(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.review_get_round_draft(uuid, uuid) to service_role;

comment on function private.lock_review_actor(uuid) is
  'Acquires the tenant review command guard before row locks and revalidates the persisted Admin/QA profile FOR SHARE.';
comment on function private.check_review_receipt(uuid, uuid, text, text, jsonb) is
  'Checks a SHA-256 receipt after actor authorization and before entity CAS; stores no request payload.';
comment on function private.finish_review_receipt(uuid, uuid, text, text, jsonb, uuid, bigint, text) is
  'Inserts a minimal idempotency receipt in the command transaction without replacing an existing key.';
comment on function private.review_open_round_snapshot(uuid, uuid) is
  'Builds an allowlisted Admin/QA round projection without confidence, fingerprints, storage paths, or private cancellation reasons.';

create or replace function private.append_review_audit(
  p_actor_id uuid,
  p_action text,
  p_entity_type text,
  p_entity_id uuid,
  p_metadata jsonb,
  p_event_id uuid
) returns uuid
language plpgsql security definer
set search_path = '' set row_security = off
set lock_timeout = '1s' set statement_timeout = '3s'
as $$
declare
  v_workspace_id uuid;
  v_actor_role text;
  v_action public.review_audit_action;
  v_entity_type public.review_audit_entity_type;
  v_expected_entity_type public.review_audit_entity_type;
  v_reference_id uuid;
  v_existing public.audit_events%rowtype;
  v_inserted integer;
  v_assignment_key text;
begin
  if p_actor_id is null or p_action is null or p_entity_type is null
     or p_entity_id is null or p_event_id is null
     or p_metadata is null or pg_catalog.jsonb_typeof(p_metadata) <> 'object'
     or pg_catalog.octet_length(p_metadata::text) > 2048 then
    raise exception 'Invalid review audit input' using errcode = '22023';
  end if;

  begin
    v_action := p_action::public.review_audit_action;
    v_entity_type := p_entity_type::public.review_audit_entity_type;
  exception when invalid_text_representation then
    raise exception 'Unsupported review audit action or entity type' using errcode = '22023';
  end;

  select p.workspace_id, p.role::text
    into v_workspace_id, v_actor_role
  from public.profiles p
  where p.id = p_actor_id;
  if not found then
    raise exception 'A persisted review actor is required' using errcode = '42501';
  end if;

  if v_action in ('finding_status_changed', 'finding_severity_changed', 'finding_assigned') then
    v_expected_entity_type := 'finding';
  elsif v_action in ('correction_round_prepared', 'correction_round_draft_updated', 'correction_round_opened', 'correction_round_cancelled', 'correction_items_returned') then
    v_expected_entity_type := 'correction_round';
  elsif v_action = 'correction_submission_confirmed' then
    v_expected_entity_type := 'correction_submission';
  else
    v_expected_entity_type := 'correction_candidate';
  end if;
  if v_entity_type <> v_expected_entity_type then
    raise exception 'Review audit action does not match its entity type' using errcode = '22023';
  end if;

  if v_action = 'finding_status_changed' then
    if private.review_audit_metadata_key_count(p_metadata) <> 2
       or not (p_metadata ?& array['previousStatus', 'status'])
       or pg_catalog.jsonb_typeof(p_metadata->'previousStatus') <> 'string'
       or pg_catalog.jsonb_typeof(p_metadata->'status') <> 'string'
       or p_metadata->>'previousStatus' not in ('pending_review', 'confirmed', 'false_positive', 'update_planned', 'resolved')
       or p_metadata->>'status' not in ('pending_review', 'confirmed', 'false_positive', 'update_planned', 'resolved')
       or p_metadata->>'previousStatus' = p_metadata->>'status' then
      raise exception 'Invalid finding status audit metadata' using errcode = '22023';
    end if;
  elsif v_action = 'finding_severity_changed' then
    if private.review_audit_metadata_key_count(p_metadata) <> 2
       or not (p_metadata ?& array['previousSeverity', 'severity'])
       or pg_catalog.jsonb_typeof(p_metadata->'previousSeverity') <> 'string'
       or pg_catalog.jsonb_typeof(p_metadata->'severity') <> 'string'
       or p_metadata->>'previousSeverity' not in ('High', 'Medium', 'Low')
       or p_metadata->>'severity' not in ('High', 'Medium', 'Low')
       or p_metadata->>'previousSeverity' = p_metadata->>'severity' then
      raise exception 'Invalid finding severity audit metadata' using errcode = '22023';
    end if;
  elsif v_action = 'finding_assigned' then
    if private.review_audit_metadata_key_count(p_metadata) <> 2
       or not (p_metadata ?& array['previousAssigneeId', 'assigneeId'])
       or p_metadata->'previousAssigneeId' is not distinct from p_metadata->'assigneeId' then
      raise exception 'Invalid finding assignment audit metadata' using errcode = '22023';
    end if;
    foreach v_assignment_key in array array['previousAssigneeId', 'assigneeId'] loop
      if pg_catalog.jsonb_typeof(p_metadata->v_assignment_key) = 'string' then
        if p_metadata->>v_assignment_key !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
          raise exception 'Invalid finding assignee id' using errcode = '22023';
        end if;
        v_reference_id := (p_metadata->>v_assignment_key)::uuid;
        if not exists (
          select 1 from public.profiles p
          where p.id = v_reference_id and p.workspace_id = v_workspace_id and p.role = 'Member'
        ) then
          raise exception 'Finding assignee must be a workspace Member' using errcode = '23514';
        end if;
      elsif pg_catalog.jsonb_typeof(p_metadata->v_assignment_key) <> 'null' then
        raise exception 'Invalid finding assignee id' using errcode = '22023';
      end if;
    end loop;
  elsif v_action in ('correction_round_prepared', 'correction_round_draft_updated', 'correction_round_opened', 'correction_round_cancelled') then
    if private.review_audit_metadata_key_count(p_metadata) <> 1 or not (p_metadata ? 'roundId')
       or pg_catalog.jsonb_typeof(p_metadata->'roundId') <> 'string'
       or p_metadata->>'roundId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or (p_metadata->>'roundId')::uuid <> p_entity_id
       or not exists (select 1 from public.correction_rounds r
         where r.id = p_entity_id and r.workspace_id = v_workspace_id) then
      raise exception 'Invalid correction round audit metadata' using errcode = '22023';
    end if;
  elsif v_action = 'correction_submission_confirmed' then
    if private.review_audit_metadata_key_count(p_metadata) <> 2
       or not (p_metadata ?& array['roundId', 'submissionId'])
       or pg_catalog.jsonb_typeof(p_metadata->'roundId') <> 'string'
       or pg_catalog.jsonb_typeof(p_metadata->'submissionId') <> 'string'
       or p_metadata->>'roundId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or p_metadata->>'submissionId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or (p_metadata->>'submissionId')::uuid <> p_entity_id
       or not exists (select 1 from public.correction_submissions s
         where s.id = p_entity_id and s.workspace_id = v_workspace_id
           and s.round_id = (p_metadata->>'roundId')::uuid) then
      raise exception 'Invalid correction submission audit metadata' using errcode = '22023';
    end if;
  elsif v_action = 'correction_items_returned' then
    if private.review_audit_metadata_key_count(p_metadata) <> 2
       or not (p_metadata ?& array['roundId', 'outcome'])
       or pg_catalog.jsonb_typeof(p_metadata->'roundId') <> 'string'
       or p_metadata->>'roundId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or (p_metadata->>'roundId')::uuid <> p_entity_id
       or pg_catalog.jsonb_typeof(p_metadata->'outcome') <> 'string'
       or p_metadata->>'outcome' not in ('rejected', 'invalidated')
       or not exists (select 1 from public.correction_rounds r
         where r.id = p_entity_id and r.workspace_id = v_workspace_id) then
      raise exception 'Invalid returned-items audit metadata' using errcode = '22023';
    end if;
  elsif v_action = 'correction_candidate_selected' then
    if private.review_audit_metadata_key_count(p_metadata) <> 2
       or not (p_metadata ?& array['candidateId', 'roundId'])
       or pg_catalog.jsonb_typeof(p_metadata->'candidateId') <> 'string'
       or pg_catalog.jsonb_typeof(p_metadata->'roundId') <> 'string'
       or p_metadata->>'candidateId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or p_metadata->>'roundId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or (p_metadata->>'candidateId')::uuid <> p_entity_id
       or not exists (select 1 from public.correction_candidates c
         where c.id = p_entity_id and c.workspace_id = v_workspace_id
           and c.round_id = (p_metadata->>'roundId')::uuid) then
      raise exception 'Invalid correction candidate audit metadata' using errcode = '22023';
    end if;
  elsif v_action in ('correction_candidate_approved', 'correction_candidate_rejected', 'correction_candidate_invalidated') then
    if pg_catalog.jsonb_typeof(p_metadata->'candidateId') <> 'string'
       or p_metadata->>'candidateId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or (p_metadata->>'candidateId')::uuid <> p_entity_id
       or not exists (select 1 from public.correction_candidates c
         where c.id = p_entity_id and c.workspace_id = v_workspace_id) then
      raise exception 'Invalid correction candidate decision metadata' using errcode = '22023';
    end if;
    if v_action = 'correction_candidate_approved' then
      if private.review_audit_metadata_key_count(p_metadata) <> 3
         or not (p_metadata ?& array['candidateId', 'outcome', 'retention'])
         or pg_catalog.jsonb_typeof(p_metadata->'outcome') <> 'string'
         or pg_catalog.jsonb_typeof(p_metadata->'retention') <> 'string'
         or p_metadata->>'outcome' <> 'approved'
         or p_metadata->>'retention' not in ('retain', 'delete') then
        raise exception 'Invalid approval audit metadata' using errcode = '22023';
      end if;
    else
      if private.review_audit_metadata_key_count(p_metadata) <> 2
         or not (p_metadata ?& array['candidateId', 'outcome'])
         or pg_catalog.jsonb_typeof(p_metadata->'outcome') <> 'string'
         or p_metadata->>'outcome' <> (case v_action
           when 'correction_candidate_rejected' then 'rejected' else 'invalidated' end) then
        raise exception 'Invalid candidate decision audit metadata' using errcode = '22023';
      end if;
    end if;
  end if;

  if v_action = 'correction_submission_confirmed' then
    if v_actor_role <> 'Member' then
      raise exception 'A Member must confirm a correction submission' using errcode = '42501';
    end if;
  elsif v_actor_role not in ('Admin', 'QA Lead') then
    raise exception 'A reviewer profile is required for this audit action' using errcode = '42501';
  end if;

  if v_entity_type = 'finding' then
    if not exists (select 1 from public.findings f where f.id = p_entity_id and f.workspace_id = v_workspace_id) then
      raise exception 'Finding audit entity does not belong to the actor workspace' using errcode = '23514';
    end if;
  elsif v_entity_type = 'correction_round' then
    if not exists (select 1 from public.correction_rounds r where r.id = p_entity_id and r.workspace_id = v_workspace_id) then
      raise exception 'Correction round audit entity does not belong to the actor workspace' using errcode = '23514';
    end if;
  elsif v_entity_type = 'correction_submission' then
    if not exists (select 1 from public.correction_submissions s where s.id = p_entity_id and s.workspace_id = v_workspace_id) then
      raise exception 'Correction submission audit entity does not belong to the actor workspace' using errcode = '23514';
    end if;
  elsif not exists (select 1 from public.correction_candidates c where c.id = p_entity_id and c.workspace_id = v_workspace_id) then
    raise exception 'Correction candidate audit entity does not belong to the actor workspace' using errcode = '23514';
  end if;

  insert into public.audit_events(id, workspace_id, actor_id, action, entity_type, entity_id, metadata)
  values (p_event_id, v_workspace_id, p_actor_id, v_action, v_entity_type, p_entity_id, p_metadata)
  on conflict (id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 1 then
    return p_event_id;
  end if;

  select e.* into v_existing from public.audit_events e where e.id = p_event_id;
  if found and v_existing.workspace_id = v_workspace_id
     and v_existing.actor_id = p_actor_id and v_existing.action = v_action
     and v_existing.entity_type = v_entity_type and v_existing.entity_id = p_entity_id
     and v_existing.metadata = p_metadata then
    return p_event_id;
  end if;
  raise exception 'Audit event id was already used with a different payload' using errcode = '23505';
end;
$$;

create function private.append_assignment_outbox(
  p_workspace_id uuid,
  p_event_id uuid,
  p_recipient_id uuid
) returns void
language plpgsql security definer
set search_path = '' set row_security = off
set lock_timeout = '1s' set statement_timeout = '3s'
as $$
declare
  v_inserted integer;
begin
  if p_workspace_id is null or p_event_id is null or p_recipient_id is null then
    raise exception 'Invalid assignment outbox input' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.audit_events e
    where e.id = p_event_id and e.workspace_id = p_workspace_id
      and e.action = 'finding_assigned' and e.entity_type = 'finding'
      and e.metadata ?& array['previousAssigneeId', 'assigneeId']
      and e.metadata->>'assigneeId' = p_recipient_id::text
  ) then
    raise exception 'Assignment notification must reference its matching audit event' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.profiles p
    where p.id = p_recipient_id and p.workspace_id = p_workspace_id and p.role = 'Member'
  ) then
    raise exception 'Assignment recipient must be a workspace Member' using errcode = '22023';
  end if;

  insert into public.notification_events(
    workspace_id, analysis_id, type, recipient_id, workflow_event_id, workflow_type
  ) values (
    p_workspace_id, null, null, p_recipient_id, p_event_id, 'assignment'
  ) on conflict (workflow_event_id, workflow_type, recipient_id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 and not exists (
    select 1 from public.notification_events e
    where e.workspace_id = p_workspace_id and e.analysis_id is null and e.type is null
      and e.workflow_event_id = p_event_id and e.workflow_type = 'assignment'
      and e.recipient_id = p_recipient_id
  ) then
    raise exception 'Assignment outbox key was reused with a different event' using errcode = '23505';
  end if;
end;
$$;
revoke all on function private.append_assignment_outbox(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
