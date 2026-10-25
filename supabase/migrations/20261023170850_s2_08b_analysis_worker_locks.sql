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

-- S2-08b part 2 of 5 (8b-7). Claim with a 45 second ceiling, a two-phase
-- sweep, and terminal delegation to the failure helper.
-- Spec: docs/superpowers/specs/2026-10-21-s2-08-analysis-finalization-spec.md
-- §8.4, §13.2.

create or replace function public.claim_analysis(p_analysis_id uuid default null)
returns table(
  id uuid, workspace_id uuid, initiator_id uuid, operation_id uuid,
  attempt_count integer, lease_expires_at timestamptz, next_attempt_at timestamptz
)
language plpgsql security definer set search_path = ''
set lock_timeout = '1s' set statement_timeout = '45s' as $$
declare
  v public.analyses%rowtype;
  v_candidate record;
  v_terminal boolean;
  v_reclaimable boolean;
  v_error_code public.analysis_failure_code;
  v_skip boolean;
  v_claimed boolean;
  op uuid;
  ts timestamptz;
  v_attempt_count integer;
  v_attempt_started_at timestamptz;
  v_attempt_deadline_at timestamptz;
  v_analysis_deadline_at timestamptz;
  v_lease_expires_at timestamptz;
  v_continuation boolean;
begin
  perform pg_catalog.pg_advisory_xact_lock(26061501);
  ts := clock_timestamp();

  -- Phase 1: unlocked candidate discovery. The directed id is preferred, then
  -- FIFO across workspaces. Terminal rows are included so phase 2 can settle
  -- them through the helper instead of bulk-updating past the ledger.
  for v_candidate in
    select c.id, c.workspace_id
    from (
      select a.id, a.workspace_id, a.created_at,
             case when a.id = p_analysis_id then 0 else 1 end as directed_rank
      from public.analyses as a
      where (a.status = 'processing' and (
               a.analysis_deadline_at is null or a.analysis_deadline_at <= ts
               or ((a.attempt_deadline_at is null or a.attempt_deadline_at <= ts
                    or a.lease_expires_at is null or a.lease_expires_at <= ts)
                   and a.attempt_count >= 3)))
         or (a.status = 'queued' and (
               a.analysis_deadline_at <= ts
               or (a.continuation_pending and (
                    a.attempt_deadline_at is null or a.analysis_deadline_at is null
                    or a.attempt_deadline_at <= ts))))
         or (a.status = 'queued' and a.continuation_pending
             and a.attempt_deadline_at > ts and a.analysis_deadline_at > ts)
         or (a.status = 'queued' and not a.continuation_pending
             and a.attempt_count < 3
             and (a.next_attempt_at is null or a.next_attempt_at <= ts)
             and (a.analysis_deadline_at is null or a.analysis_deadline_at > ts))
         or (a.status = 'processing' and a.attempt_count < 3
             and (a.lease_expires_at <= ts or a.attempt_deadline_at <= ts)
             and (a.analysis_deadline_at is null or a.analysis_deadline_at > ts))
    ) as c
    order by c.directed_rank, c.created_at, c.id
    limit 25
  loop
    v_skip := false;
    v_claimed := false;
    v_terminal := false;
    v_reclaimable := false;
    v_error_code := null;

    begin
      -- Phase 2: canonical order advisory -> workspace -> analysis. The
      -- analysis is read unlocked first; only the helper or the reclaim
      -- branch takes its row lock.
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(v_candidate.workspace_id::text, 0)
      );

      perform 1
      from public.workspaces as w
      where w.id = v_candidate.workspace_id
      for update;
      if not found then
        v_skip := true;
      end if;

      if not v_skip then
        select a.* into v
        from public.analyses as a
        where a.id = v_candidate.id;
        if not found then
          v_skip := true;
        end if;
      end if;

      if not v_skip then
        if v.status = 'processing' and (
             v.analysis_deadline_at is null or v.analysis_deadline_at <= ts
             or ((v.attempt_deadline_at is null or v.attempt_deadline_at <= ts
                  or v.lease_expires_at is null or v.lease_expires_at <= ts)
                 and v.attempt_count >= 3)
           ) then
          v_terminal := true;
          v_error_code := case
            when v.attempt_count >= 3 then 'ATTEMPTS_EXHAUSTED'::public.analysis_failure_code
            else 'TIMEOUT'::public.analysis_failure_code
          end;
        elsif v.status = 'queued' and (
             v.analysis_deadline_at <= ts
             or (v.continuation_pending and (
                  v.attempt_deadline_at is null or v.analysis_deadline_at is null
                  or v.attempt_deadline_at <= ts))
           ) then
          v_terminal := true;
          v_error_code := 'TIMEOUT'::public.analysis_failure_code;
        elsif (v.status = 'queued' and v.continuation_pending
               and v.attempt_deadline_at > ts and v.analysis_deadline_at > ts)
           or (v.status = 'queued' and not v.continuation_pending
               and v.attempt_count < 3
               and (v.next_attempt_at is null or v.next_attempt_at <= ts)
               and (v.analysis_deadline_at is null or v.analysis_deadline_at > ts))
           or (v.status = 'processing' and v.attempt_count < 3
               and (v.lease_expires_at <= ts or v.attempt_deadline_at <= ts)
               and (v.analysis_deadline_at is null or v.analysis_deadline_at > ts)) then
          v_reclaimable := true;
        else
          v_skip := true;
        end if;
      end if;

      if v_terminal then
        perform private.finalize_failed_analysis(
          v.id, null::uuid, v_error_code, false
        );
        v_skip := true;
      end if;

      if v_reclaimable then
        select a.* into v
        from public.analyses as a
        where a.id = v_candidate.id
          and ((a.status = 'queued' and a.continuation_pending
                and a.attempt_deadline_at > ts and a.analysis_deadline_at > ts)
            or (a.status = 'queued' and not a.continuation_pending
                and a.attempt_count < 3
                and (a.next_attempt_at is null or a.next_attempt_at <= ts)
                and (a.analysis_deadline_at is null or a.analysis_deadline_at > ts))
            or (a.status = 'processing' and a.attempt_count < 3
                and (a.lease_expires_at <= ts or a.attempt_deadline_at <= ts)
                and (a.analysis_deadline_at is null or a.analysis_deadline_at > ts)))
        for update of a skip locked;
        if not found then
          v_skip := true;
        else
          v_continuation := v.status = 'queued' and v.continuation_pending;
          op := gen_random_uuid();
          v_analysis_deadline_at := coalesce(
            v.analysis_deadline_at, ts + interval '90 minutes'
          );
          if v_continuation then
            v_attempt_count := v.attempt_count;
            v_attempt_started_at := v.attempt_started_at;
            v_attempt_deadline_at := v.attempt_deadline_at;
          else
            v_attempt_count := v.attempt_count + 1;
            v_attempt_started_at := ts;
            v_attempt_deadline_at := least(
              ts + interval '30 minutes', v_analysis_deadline_at
            );
          end if;
          v_lease_expires_at := least(
            ts + interval '180 seconds', v_attempt_deadline_at,
            v_analysis_deadline_at
          );

          if v_attempt_count > 3
             or v_attempt_deadline_at <= ts
             or v_lease_expires_at <= ts then
            v_error_code := case
              when v_attempt_count >= 3 then 'ATTEMPTS_EXHAUSTED'::public.analysis_failure_code
              else 'TIMEOUT'::public.analysis_failure_code
            end;
            perform private.finalize_failed_analysis(
              v.id, null::uuid, v_error_code, false
            );
            v_skip := true;
          else
            update public.analyses as a
               set status = 'processing', operation_id = op,
                   lease_expires_at = v_lease_expires_at,
                   attempt_count = v_attempt_count,
                   attempt_started_at = v_attempt_started_at,
                   attempt_deadline_at = v_attempt_deadline_at,
                   analysis_deadline_at = v_analysis_deadline_at,
                   continuation_pending = false,
                   started_at = coalesce(v.started_at, ts),
                   next_attempt_at = null, updated_at = ts
             where a.id = v.id;
            v_claimed := true;
          end if;
        end if;
      end if;
    exception
      when lock_not_available then
        -- A candidate held by another session is skipped; the sweep must not
        -- fail because one row is busy.
        v_skip := true;
    end;

    if v_claimed then
      return query select v.id, v.workspace_id, v.initiator_id, op,
        v_attempt_count, v_lease_expires_at, null::timestamptz;
      return;
    end if;
  end loop;
end;
$$;
