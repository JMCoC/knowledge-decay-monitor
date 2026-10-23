-- S2-08b part 1 of 5 (8b-6). Terminal failure helper.
-- Spec: docs/superpowers/specs/2026-10-21-s2-08-analysis-finalization-spec.md
-- §13.1, §13.2, §13.4.

create function private.finalize_failed_analysis(
  p_analysis_id uuid,
  p_operation_id uuid,
  p_error_code public.analysis_failure_code,
  p_enforce_operation boolean
) returns text
language plpgsql security definer set search_path = ''
set lock_timeout = '1s' as $$
declare
  v public.analyses%rowtype;
  v_workspace_id uuid;
  ts timestamptz;
  v_settlement public.credit_event_type;
  v_event_count integer;
  v_staging_count integer;
begin
  if p_analysis_id is null or p_error_code is null then
    raise exception 'Analysis and failure code are required' using errcode = '22023';
  end if;
  if p_enforce_operation and p_operation_id is null then
    raise exception 'Operation required for fenced failure' using errcode = '22023';
  end if;

  select a.workspace_id into v_workspace_id
  from public.analyses a
  where a.id = p_analysis_id;
  if v_workspace_id is null then
    return 'superseded';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_workspace_id::text, 0)
  );

  perform 1
  from public.workspaces w
  where w.id = v_workspace_id
  for update;
  if not found then
    return 'superseded';
  end if;

  select * into v
  from public.analyses a
  where a.id = p_analysis_id
  for update;
  if not found then
    return 'superseded';
  end if;

  ts := pg_catalog.clock_timestamp();

  if v.status = 'completed' then
    return 'superseded';
  end if;

  -- Terminal failures are idempotent, but the acknowledgement token must match.
  if v.status = 'failed' then
    if v.operation_id is distinct from p_operation_id then
      return 'superseded';
    end if;

    select l.event_type into v_settlement
    from public.credit_ledger l
    where l.analysis_id = p_analysis_id
      and l.event_type in ('Consumed', 'Released');

    if v_settlement = 'Consumed' then
      raise exception 'Ledger inconsistency: Consumed in failed analysis'
        using errcode = 'P0001';
    end if;

    select count(*) into v_event_count
    from public.notification_events e
    where e.analysis_id = p_analysis_id
      and e.type = 'analysis_failed'
      and e.recipient_id = v.initiator_id;

    select
      (select count(*) from private.analysis_finding_staging s
       where s.analysis_id = p_analysis_id)
      + (select count(*) from private.analysis_finding_evidence_staging e
         where e.analysis_id = p_analysis_id)
    into v_staging_count;

    if v_settlement = 'Released'
       and v_event_count >= 1
       and v_staging_count = 0 then
      return 'failed';
    end if;

    if v_settlement is null then
      perform private.settle_analysis_credits(
        p_analysis_id, v.fixed_cost, 'Released'
      );
    end if;

    insert into public.notification_events(
      workspace_id, analysis_id, type, recipient_id
    ) values (
      v.workspace_id, p_analysis_id, 'analysis_failed', v.initiator_id
    )
    on conflict (analysis_id, type, recipient_id) do nothing;

    delete from private.analysis_finding_evidence_staging e
    where e.analysis_id = p_analysis_id;
    delete from private.analysis_finding_staging s
    where s.analysis_id = p_analysis_id;

    return 'failed';
  end if;

  if p_enforce_operation then
    if v.status <> 'processing'
       or v.operation_id is distinct from p_operation_id
       or v.lease_expires_at is null or v.lease_expires_at <= ts
       or v.attempt_deadline_at is null or v.attempt_deadline_at <= ts
       or v.analysis_deadline_at is null or v.analysis_deadline_at <= ts then
      return 'superseded';
    end if;
  else
    if v.status not in ('processing', 'queued') then
      return 'superseded';
    end if;
  end if;

  update public.analyses
     set status = 'failed',
         error_code = p_error_code,
         finished_at = ts,
         updated_at = ts,
         lease_expires_at = null,
         next_attempt_at = null,
         continuation_pending = false
   where id = p_analysis_id;

  perform private.settle_analysis_credits(
    p_analysis_id, v.fixed_cost, 'Released'
  );

  insert into public.notification_events(
    workspace_id, analysis_id, type, recipient_id
  ) values (
    v.workspace_id, p_analysis_id, 'analysis_failed', v.initiator_id
  )
  on conflict (analysis_id, type, recipient_id) do nothing;

  delete from private.analysis_finding_evidence_staging e
  where e.analysis_id = p_analysis_id;
  delete from private.analysis_finding_staging s
  where s.analysis_id = p_analysis_id;

  return 'failed';
end;
$$;

revoke all on function private.finalize_failed_analysis(
  uuid, uuid, public.analysis_failure_code, boolean
) from public, anon, authenticated;
grant execute on function private.finalize_failed_analysis(
  uuid, uuid, public.analysis_failure_code, boolean
) to service_role;
