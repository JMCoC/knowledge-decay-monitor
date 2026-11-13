-- Internal append-only review history and typed workflow notification references.
-- The existing notification_type enum remains limited to S2 terminal events.

create type public.review_audit_action as enum (
  'finding_status_changed',
  'finding_severity_changed',
  'finding_assigned',
  'correction_round_prepared',
  'correction_round_opened',
  'correction_round_cancelled',
  'correction_submission_confirmed',
  'correction_candidate_selected',
  'correction_items_returned',
  'correction_candidate_approved',
  'correction_candidate_rejected',
  'correction_candidate_invalidated'
);

create type public.review_audit_entity_type as enum (
  'finding', 'correction_round', 'correction_submission', 'correction_candidate'
);

create type public.workflow_notification_type as enum (
  'assignment', 'version_approved', 'version_rejected'
);

create table public.audit_events (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  actor_id uuid not null,
  action public.review_audit_action not null,
  entity_type public.review_audit_entity_type not null,
  entity_id uuid not null,
  occurred_at timestamptz not null default pg_catalog.now(),
  metadata jsonb not null default '{}'::jsonb,
  unique (id, workspace_id),
  foreign key (actor_id, workspace_id)
    references public.profiles(id, workspace_id) on delete restrict,
  check (pg_catalog.jsonb_typeof(metadata) = 'object'),
  check (pg_catalog.octet_length(metadata::text) <= 2048)
);
alter table public.audit_events enable row level security;
revoke all on public.audit_events from public, anon, authenticated, service_role;

create function private.reject_audit_event_mutation() returns trigger
language plpgsql security definer
set search_path = '' set row_security = off
as $$
begin
  raise exception 'Audit events are append-only' using errcode = '42501';
end;
$$;
revoke all on function private.reject_audit_event_mutation()
  from public, anon, authenticated, service_role;

create trigger audit_events_append_only
before update or delete or truncate on public.audit_events
for each statement execute function private.reject_audit_event_mutation();

create function private.review_audit_metadata_key_count(p_metadata jsonb) returns integer
language sql immutable strict
set search_path = ''
as $$
  select pg_catalog.count(*)::integer from pg_catalog.jsonb_object_keys(p_metadata)
$$;
revoke all on function private.review_audit_metadata_key_count(jsonb)
  from public, anon, authenticated, service_role;

create function private.append_review_audit(
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
  elsif v_action in ('correction_round_prepared', 'correction_round_opened', 'correction_round_cancelled', 'correction_items_returned') then
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
    if private.review_audit_metadata_key_count(p_metadata) <> 1 or not (p_metadata ? 'assigneeId') then
      raise exception 'Invalid finding assignment audit metadata' using errcode = '22023';
    end if;
    if pg_catalog.jsonb_typeof(p_metadata->'assigneeId') = 'string' then
      if p_metadata->>'assigneeId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'Invalid finding assignee id' using errcode = '22023';
      end if;
      v_reference_id := (p_metadata->>'assigneeId')::uuid;
      if not exists (
        select 1 from public.profiles p
        where p.id = v_reference_id and p.workspace_id = v_workspace_id and p.role = 'Member'
      ) then
        raise exception 'Finding assignee must be a workspace Member' using errcode = '23514';
      end if;
    elsif pg_catalog.jsonb_typeof(p_metadata->'assigneeId') <> 'null' then
      raise exception 'Invalid finding assignee id' using errcode = '22023';
    end if;
  elsif v_action in ('correction_round_prepared', 'correction_round_opened', 'correction_round_cancelled') then
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
revoke all on function private.append_review_audit(uuid, text, text, uuid, jsonb, uuid)
  from public, anon, authenticated, service_role;

alter table public.notification_events alter column analysis_id drop not null;
alter table public.notification_events alter column type drop not null;
alter table public.notification_events
  add column workflow_event_id uuid,
  add column workflow_type public.workflow_notification_type,
  add constraint notification_events_workflow_event_workspace_fkey
    foreign key (workflow_event_id, workspace_id)
    references public.audit_events(id, workspace_id) on delete restrict,
  add constraint notification_events_workflow_type_shape_check check (
    (analysis_id is not null and workflow_event_id is null and type is not null
      and type in ('analysis_completed', 'analysis_failed') and workflow_type is null)
    or
    (analysis_id is null and workflow_event_id is not null and type is null and workflow_type is not null)
  ),
  add constraint notification_events_workflow_event_type_recipient_key
    unique (workflow_event_id, workflow_type, recipient_id);

create function private.guard_workflow_notification_event() returns trigger
language plpgsql security definer
set search_path = '' set row_security = off
as $$
declare
  v_audit_action public.review_audit_action;
begin
  if tg_op = 'UPDATE' and (
       new.id is distinct from old.id
    or new.workspace_id is distinct from old.workspace_id
    or new.analysis_id is distinct from old.analysis_id
    or new.type is distinct from old.type
    or new.workflow_event_id is distinct from old.workflow_event_id
    or new.workflow_type is distinct from old.workflow_type
    or new.recipient_id is distinct from old.recipient_id
  ) then
    raise exception 'Notification event identity is immutable' using errcode = '23514';
  end if;

  if new.workflow_event_id is null then
    return new;
  end if;

  select a.action into v_audit_action
  from public.audit_events a
  where a.id = new.workflow_event_id and a.workspace_id = new.workspace_id;
  if not found then
    raise exception 'Workflow notification must reference a tenant-matched audit event' using errcode = '23503';
  end if;

  if (new.workflow_type = 'assignment' and v_audit_action <> 'finding_assigned')
     or (new.workflow_type = 'version_approved' and v_audit_action <> 'correction_candidate_approved')
     or (new.workflow_type = 'version_rejected' and v_audit_action <> 'correction_candidate_rejected') then
    raise exception 'Workflow notification type does not match its audit action' using errcode = '23514';
  end if;
  if not exists (
    select 1 from public.profiles p
    where p.id = new.recipient_id and p.workspace_id = new.workspace_id and p.role = 'Member'
  ) then
    raise exception 'Workflow notification recipient must be a workspace Member' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.guard_workflow_notification_event()
  from public, anon, authenticated, service_role;
create trigger notification_events_workflow_guard
before insert or update on public.notification_events
for each row execute function private.guard_workflow_notification_event();

create function private.is_s2_terminal_notification(p_event_id uuid) returns boolean
language sql stable security definer
set search_path = '' set row_security = off
as $$
  select exists (
    select 1 from public.notification_events e
    where e.id = p_event_id
      and e.analysis_id is not null
      and e.workflow_event_id is null
      and e.workflow_type is null
      and e.type in ('analysis_completed', 'analysis_failed')
  )
$$;
revoke all on function private.is_s2_terminal_notification(uuid)
  from public, anon, authenticated, service_role;

alter function public.list_notification_candidates(integer) set schema private;
alter function public.list_notification_alerts(integer) set schema private;
alter function public.claim_notification_event(uuid) set schema private;
alter function public.get_notification_context(uuid, uuid) set schema private;
alter function public.prepare_notification_delivery(uuid, uuid, text) set schema private;
alter function public.confirm_notification_sent(uuid, uuid, text) set schema private;
alter function public.record_notification_failure(uuid, uuid, text, integer) set schema private;
alter function public.recover_notification_event(uuid) set schema private;
alter function public.claim_notification_alert(uuid) set schema private;
alter function public.confirm_notification_alert(uuid, uuid) set schema private;
alter function public.retry_notification_alert(uuid, uuid) set schema private;

revoke all on function private.list_notification_candidates(integer),
  private.list_notification_alerts(integer),
  private.claim_notification_event(uuid),
  private.get_notification_context(uuid, uuid),
  private.prepare_notification_delivery(uuid, uuid, text),
  private.confirm_notification_sent(uuid, uuid, text),
  private.record_notification_failure(uuid, uuid, text, integer),
  private.recover_notification_event(uuid),
  private.claim_notification_alert(uuid),
  private.confirm_notification_alert(uuid, uuid),
  private.retry_notification_alert(uuid, uuid)
  from public, anon, authenticated, service_role;

create function public.list_notification_candidates(p_limit integer default 5)
returns table(event_id uuid, recover_expired boolean)
language sql security definer set search_path = '' set row_security = off
set lock_timeout = '1s' set statement_timeout = '3s' as $$
  with db_time as (select pg_catalog.clock_timestamp() as now)
  select e.id, e.operation_id is not null
  from public.notification_events e
  cross join db_time t
  where e.analysis_id is not null and e.workflow_event_id is null
    and e.type in ('analysis_completed', 'analysis_failed')
    and e.status = 'pending' and e.attempt_count < 3
    and (e.next_attempt_at is null or e.next_attempt_at <= t.now)
    and (e.operation_id is null or e.lease_expires_at <= t.now)
    and exists (select 1 from private.notification_dispatch_settings s where s.id and s.enabled)
  order by e.created_at, e.id
  limit least(greatest(coalesce(p_limit, 1), 1), 5);
$$;

create function public.list_notification_alerts(p_limit integer default 5)
returns table(event_id uuid)
language sql security definer set search_path = '' set row_security = off
set lock_timeout = '1s' set statement_timeout = '3s' as $$
  with db_time as (select pg_catalog.clock_timestamp() as now)
  select e.id
  from public.notification_events e
  join private.notification_deliveries d on d.event_id = e.id
  cross join db_time t
  where e.analysis_id is not null and e.workflow_event_id is null
    and e.type in ('analysis_completed', 'analysis_failed')
    and e.status = 'failed' and e.error_code is not null
    and d.failure_reported_at is null
    and (d.alert_operation_id is null or d.alert_lease_expires_at <= t.now)
    and (d.alert_next_attempt_at is null or d.alert_next_attempt_at <= t.now)
  order by e.created_at, e.id
  limit least(greatest(coalesce(p_limit, 1), 1), 50);
$$;

create function public.claim_notification_event(p_event_id uuid)
returns setof public.notification_events
language plpgsql security definer set search_path = '' set row_security = off
set lock_timeout = '1s' set statement_timeout = '3s' as $$
begin
  if not private.is_s2_terminal_notification(p_event_id) then return; end if;
  return query select * from private.claim_notification_event(p_event_id);
end;
$$;

create function public.get_notification_context(p_event_id uuid, p_operation_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' set row_security = off
set lock_timeout = '1s' set statement_timeout = '3s' as $$
begin
  if not private.is_s2_terminal_notification(p_event_id) then
    return pg_catalog.jsonb_build_object('ok', false, 'code', 'LEASE_LOST');
  end if;
  return private.get_notification_context(p_event_id, p_operation_id);
end;
$$;

create function public.prepare_notification_delivery(p_event_id uuid, p_operation_id uuid, p_request_json text)
returns jsonb
language plpgsql security definer set search_path = '' set row_security = off
set lock_timeout = '1s' set statement_timeout = '3s' as $$
begin
  if not private.is_s2_terminal_notification(p_event_id) then
    return pg_catalog.jsonb_build_object('ok', false, 'code', 'LEASE_LOST');
  end if;
  return private.prepare_notification_delivery(p_event_id, p_operation_id, p_request_json);
end;
$$;

create function public.confirm_notification_sent(p_event_id uuid, p_operation_id uuid, p_provider_message_id text)
returns boolean
language plpgsql security definer set search_path = '' set row_security = off
set lock_timeout = '1s' set statement_timeout = '3s' as $$
begin
  if not private.is_s2_terminal_notification(p_event_id) then return false; end if;
  return private.confirm_notification_sent(p_event_id, p_operation_id, p_provider_message_id);
end;
$$;

create function public.record_notification_failure(
  p_event_id uuid, p_operation_id uuid, p_error_code text, p_retry_after_seconds integer default null
) returns text
language plpgsql security definer set search_path = '' set row_security = off
set lock_timeout = '1s' set statement_timeout = '3s' as $$
begin
  if not private.is_s2_terminal_notification(p_event_id) then return 'lost'; end if;
  return private.record_notification_failure(p_event_id, p_operation_id, p_error_code, p_retry_after_seconds);
end;
$$;

create function public.recover_notification_event(p_event_id uuid)
returns text
language plpgsql security definer set search_path = '' set row_security = off
set lock_timeout = '1s' set statement_timeout = '3s' as $$
begin
  if not private.is_s2_terminal_notification(p_event_id) then return 'unchanged'; end if;
  return private.recover_notification_event(p_event_id);
end;
$$;

create function public.claim_notification_alert(p_event_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' set row_security = off
set lock_timeout = '1s' set statement_timeout = '3s' as $$
begin
  if not private.is_s2_terminal_notification(p_event_id) then return null; end if;
  perform 1 from private.notification_dispatch_settings s where s.id and s.enabled for share;
  if not found then return null; end if;
  return private.claim_notification_alert(p_event_id);
end;
$$;

create function public.confirm_notification_alert(p_event_id uuid, p_operation_id uuid)
returns boolean
language plpgsql security definer set search_path = '' set row_security = off
set lock_timeout = '1s' set statement_timeout = '3s' as $$
begin
  if not private.is_s2_terminal_notification(p_event_id) then return false; end if;
  return private.confirm_notification_alert(p_event_id, p_operation_id);
end;
$$;

create function public.retry_notification_alert(p_event_id uuid, p_operation_id uuid)
returns boolean
language plpgsql security definer set search_path = '' set row_security = off
set lock_timeout = '1s' set statement_timeout = '3s' as $$
begin
  if not private.is_s2_terminal_notification(p_event_id) then return false; end if;
  return private.retry_notification_alert(p_event_id, p_operation_id);
end;
$$;

revoke all on function public.list_notification_candidates(integer),
  public.list_notification_alerts(integer),
  public.claim_notification_event(uuid),
  public.get_notification_context(uuid, uuid),
  public.prepare_notification_delivery(uuid, uuid, text),
  public.confirm_notification_sent(uuid, uuid, text),
  public.record_notification_failure(uuid, uuid, text, integer),
  public.recover_notification_event(uuid),
  public.claim_notification_alert(uuid),
  public.confirm_notification_alert(uuid, uuid),
  public.retry_notification_alert(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.list_notification_candidates(integer),
  public.list_notification_alerts(integer),
  public.claim_notification_event(uuid),
  public.get_notification_context(uuid, uuid),
  public.prepare_notification_delivery(uuid, uuid, text),
  public.confirm_notification_sent(uuid, uuid, text),
  public.record_notification_failure(uuid, uuid, text, integer),
  public.recover_notification_event(uuid),
  public.claim_notification_alert(uuid),
  public.confirm_notification_alert(uuid, uuid),
  public.retry_notification_alert(uuid, uuid)
  to service_role;
