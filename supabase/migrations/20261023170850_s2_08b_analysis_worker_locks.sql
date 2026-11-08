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

-- S2-08b part 3 of 5 (8b-8). fail_analysis takes the workspace advisory
-- before row locks and delegates terminal paths to the helper.
-- Spec: docs/superpowers/specs/2026-10-21-s2-08-analysis-finalization-spec.md
-- §7.2, §13.1, §13.2.
--
-- The helper runs with p_enforce_operation=false. fail_analysis already
-- checked the status, token and lease, and it preserves the legacy coalesced
-- deadlines. Re-enforcing them in the helper would reject legacy NULL or
-- expired deadlines before the coalesced deadline check can terminalize them.
-- §13.1 y plan 283-286 prescriben p_enforce_operation=true; false es
-- intencional aquí porque fail_analysis ya hizo fencing (status, token,
-- lease) y los deadlines legacy pueden ser NULL o estar vencidos, casos
-- que el helper true rechazaría como superseded.

create or replace function public.fail_analysis(
  p_analysis_id uuid,
  p_operation_id uuid,
  p_retryable boolean,
  p_error_code public.analysis_failure_code
)
returns text
language plpgsql security definer set search_path = ''
set lock_timeout = '1s' set statement_timeout = '2s' as $$
declare
  j public.analyses%rowtype;
  v_workspace_id uuid;
  ts timestamptz;
  v_attempt_deadline_at timestamptz;
  v_analysis_deadline_at timestamptz;
begin
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

  select * into j
  from public.analyses a
  where a.id = p_analysis_id
  for update;
  if not found
     or j.status <> 'processing'
     or j.operation_id is distinct from p_operation_id then
    return 'superseded';
  end if;

  ts := pg_catalog.clock_timestamp();
  if j.lease_expires_at is null or j.lease_expires_at <= ts then
    return 'superseded';
  end if;

  v_analysis_deadline_at := coalesce(
    j.analysis_deadline_at,
    coalesce(j.started_at, j.created_at) + interval '90 minutes'
  );
  v_attempt_deadline_at := coalesce(
    j.attempt_deadline_at,
    least(
      coalesce(j.attempt_started_at, j.started_at, ts) + interval '30 minutes',
      v_analysis_deadline_at
    )
  );

  if v_analysis_deadline_at <= ts or v_attempt_deadline_at <= ts then
    return private.finalize_failed_analysis(
      p_analysis_id, p_operation_id, 'TIMEOUT', false
    );
  end if;

  if p_retryable and j.attempt_count < 3 then
    update public.analyses
       set status = 'queued',
           operation_id = null,
           lease_expires_at = null,
           continuation_pending = false,
           next_attempt_at = ts + case
             when j.attempt_count = 1 then interval '30 seconds'
             else interval '2 minutes' end,
           error_code = p_error_code,
           updated_at = ts
     where id = j.id;
    return 'queued';
  end if;

  return private.finalize_failed_analysis(
    p_analysis_id, p_operation_id, p_error_code, false
  );
end;
$$;

revoke all on function public.fail_analysis(
  uuid, uuid, boolean, public.analysis_failure_code
) from public, anon, authenticated;
grant execute on function public.fail_analysis(
  uuid, uuid, boolean, public.analysis_failure_code
) to service_role;

-- S2-08b part 4 of 5 (8b-9). create_analysis_run takes the workspace advisory
-- before its existing workspace row lock.
-- Spec: docs/superpowers/specs/2026-10-21-s2-08-analysis-finalization-spec.md
-- §8.1, §8.2, §13.2.

create or replace function private.create_analysis_run(
  p_actor_id uuid,
  p_estimate_ref uuid,
  p_idempotency_key text,
  p_retry_of_analysis_id uuid,
  p_current_manifest jsonb
) returns table (
  analysis_id uuid,
  status public.analysis_job_status,
  retry_of_analysis_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '3s'
set statement_timeout = '30s'
as $$
declare
  v_workspace_id uuid;
  v_actor_role public.workspace_role;
  v_command_kind text;
  v_command_fingerprint text;
  v_existing_id uuid;
  v_existing_status public.analysis_job_status;
  v_existing_retry_of uuid;
  v_existing_command_fingerprint text;
  v_estimate public.analysis_estimates%rowtype;
  v_scope_ids uuid[];
  v_summary record;
  v_parent public.analyses%rowtype;
  v_reserved_count integer;
  v_released_count integer;
  v_consumed_count integer;
  v_reserved_amount integer;
  v_released_amount integer;
  v_analysis_id uuid;
begin
  if p_actor_id is null or p_estimate_ref is null
     or p_idempotency_key is null
     or pg_catalog.char_length(p_idempotency_key) not between 1 and 128
     or p_idempotency_key <> pg_catalog.btrim(p_idempotency_key)
     or pg_catalog.char_length(pg_catalog.btrim(p_idempotency_key)) = 0 then
    raise exception using errcode = '22023', message = 'Invalid analysis command.';
  end if;

  select p.workspace_id, p.role
  into v_workspace_id, v_actor_role
  from public.profiles p
  where p.id = p_actor_id
  for share;
  if not found then
    raise exception using errcode = 'P0002', message = 'Analysis actor not found.';
  end if;
  if v_actor_role not in ('Admin', 'QA Lead') then
    raise exception using errcode = '42501', message = 'Analysis command is not permitted.';
  end if;

  -- S2-08 canonical order: workspace advisory before the existing row locks.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_workspace_id::text, 0)
  );

  -- S2-02 credit operations use this same per-workspace row lock. It serializes
  -- commands in one tenant without blocking work in another tenant.
  perform w.id
  from public.workspaces w
  where w.id = v_workspace_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Analysis workspace not found.';
  end if;

  v_command_kind := case when p_retry_of_analysis_id is null then 'run' else 'retry' end;
  v_command_fingerprint := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        private.canonical_jsonb(pg_catalog.jsonb_build_object(
          'estimateRef', p_estimate_ref,
          'failedAnalysisId', p_retry_of_analysis_id,
          'kind', v_command_kind
        )),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  -- A matching command is replayable even if the estimate, documents, or
  -- current execution configuration changed after its original commit.
  select a.id, a.status, a.retry_of_analysis_id, a.command_fingerprint
  into v_existing_id, v_existing_status, v_existing_retry_of, v_existing_command_fingerprint
  from public.analyses a
  where a.workspace_id = v_workspace_id
    and a.initiator_id = p_actor_id
    and a.idempotency_key = p_idempotency_key
  for update;
  if found then
    if v_existing_command_fingerprint is null
       or v_existing_command_fingerprint <> v_command_fingerprint then
      raise exception using errcode = 'P2002', message = 'Analysis command conflicts with an earlier key.';
    end if;
    return query select v_existing_id, v_existing_status, v_existing_retry_of;
    return;
  end if;

  select e.*
  into v_estimate
  from public.analysis_estimates e
  where e.id = p_estimate_ref
    and e.workspace_id = v_workspace_id
    and e.initiator_id = p_actor_id
  for share;
  if not found then
    raise exception using errcode = 'P0002', message = 'Analysis estimate not found.';
  end if;

  if v_estimate.expires_at <= pg_catalog.clock_timestamp() then
    raise exception using errcode = 'P2101', message = 'Analysis estimate has expired.';
  end if;
  if p_current_manifest is null
     or v_estimate.execution_manifest is null
     or v_estimate.fingerprint_version <> 's2-05-v2'
     or v_estimate.pricing_version <> 's2-04-v1'
     or p_current_manifest is distinct from v_estimate.execution_manifest then
    raise exception using errcode = 'P2102', message = 'Analysis estimate is stale.';
  end if;

  if v_estimate.source_version_ids is null
     or v_estimate.comparison_version_ids is null
     or pg_catalog.cardinality(v_estimate.source_version_ids) < 1
     or pg_catalog.cardinality(v_estimate.source_version_ids) <> (
       select pg_catalog.count(distinct x)::integer
       from pg_catalog.unnest(v_estimate.source_version_ids) as source(x)
     )
     or pg_catalog.cardinality(v_estimate.comparison_version_ids) <> (
       select pg_catalog.count(distinct x)::integer
       from pg_catalog.unnest(v_estimate.comparison_version_ids) as comparison(x)
     )
     or exists (
       select 1
       from pg_catalog.unnest(v_estimate.source_version_ids || v_estimate.comparison_version_ids) as scope(x)
       where x is null
     ) then
    raise exception using errcode = 'P2102', message = 'Analysis estimate scope is stale.';
  end if;

  select pg_catalog.array_agg(scope.version_id order by scope.version_id)
  into v_scope_ids
  from (
    select distinct x as version_id
    from pg_catalog.unnest(v_estimate.source_version_ids || v_estimate.comparison_version_ids) as ids(x)
  ) scope;
  if pg_catalog.cardinality(v_scope_ids) > 20 then
    raise exception using errcode = 'P2102', message = 'Analysis estimate scope exceeds its limit.';
  end if;

  begin
    select *
    into strict v_summary
    from private.analysis_retrieval_summary(
      v_workspace_id,
      v_estimate.source_version_ids,
      v_estimate.comparison_version_ids,
      v_estimate.execution_manifest
    );
  exception when sqlstate '22023' then
    raise exception using errcode = 'P2102', message = 'Analysis estimate snapshot is stale.';
  end;

  if v_summary.request_fingerprint is distinct from v_estimate.request_fingerprint
     or v_summary.fixed_cost is distinct from v_estimate.fixed_cost
     or v_summary.chunk_count is distinct from v_estimate.chunk_count
     or v_summary.candidate_pair_count is distinct from v_estimate.candidate_pair_count
     or v_estimate.retrieval_config ->> 'fingerprint' is distinct from v_summary.request_fingerprint
     or v_estimate.retrieval_config ->> 'chunksRevision' is distinct from v_summary.chunks_revision
     or v_estimate.retrieval_config ->> 'embeddingRevision' is distinct from 'gte-small-384-v1'
     or v_estimate.retrieval_config ->> 'topK' is distinct from '5'
     or v_estimate.retrieval_config ->> 'similarityThreshold' is distinct from '0.75' then
    raise exception using errcode = 'P2102', message = 'Analysis estimate snapshot is stale.';
  end if;

  if p_retry_of_analysis_id is not null then
    select a.*
    into v_parent
    from public.analyses a
    where a.id = p_retry_of_analysis_id
      and a.workspace_id = v_workspace_id
    for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'Failed analysis not found.';
    end if;
    if v_parent.status <> 'failed' then
      raise exception using errcode = 'P2002', message = 'Only a failed analysis can be retried.';
    end if;

    select
      pg_catalog.count(*) filter (where l.event_type = 'Reserved')::integer,
      pg_catalog.count(*) filter (where l.event_type = 'Released')::integer,
      pg_catalog.count(*) filter (where l.event_type = 'Consumed')::integer,
      pg_catalog.max(l.amount) filter (where l.event_type = 'Reserved'),
      pg_catalog.max(l.amount) filter (where l.event_type = 'Released')
    into v_reserved_count, v_released_count, v_consumed_count, v_reserved_amount, v_released_amount
    from public.credit_ledger l
    where l.analysis_id = v_parent.id
      and l.workspace_id = v_workspace_id;

    if v_parent.fixed_cost <> v_parent.reserved_credits
       or v_reserved_count <> 1
       or v_released_count <> 1
       or v_consumed_count <> 0
       or v_reserved_amount <> v_parent.fixed_cost
       or v_released_amount <> v_parent.fixed_cost then
      raise exception using errcode = 'P2002', message = 'Failed analysis credits are not fully released.';
    end if;
  end if;

  if exists (
    select 1 from public.analyses a
    where a.workspace_id = v_workspace_id
      and a.status in ('queued', 'processing')
  ) then
    raise exception using errcode = 'P2002', message = 'The workspace already has an active analysis.';
  end if;

  insert into public.analyses (
    workspace_id,
    initiator_id,
    status,
    fixed_cost,
    reserved_credits,
    idempotency_key,
    request_fingerprint,
    retry_of_analysis_id,
    retrieval_config,
    pricing_version,
    prompt_version,
    output_schema_version,
    provider_config,
    estimate_id,
    command_fingerprint
  ) values (
    v_workspace_id,
    p_actor_id,
    'queued',
    v_estimate.fixed_cost,
    v_estimate.fixed_cost,
    p_idempotency_key,
    v_estimate.request_fingerprint,
    p_retry_of_analysis_id,
    v_estimate.retrieval_config,
    v_estimate.pricing_version,
    v_estimate.execution_manifest ->> 'promptVersion',
    v_estimate.execution_manifest ->> 'outputSchemaVersion',
    v_estimate.execution_manifest -> 'providers',
    v_estimate.id,
    v_command_fingerprint
  )
  returning id into v_analysis_id;

  insert into public.analysis_documents (analysis_id, workspace_id, document_id, version_id, role)
  select v_analysis_id, v_workspace_id, v.document_id, v.id, 'source'::public.analysis_scope_role
  from pg_catalog.unnest(v_estimate.source_version_ids) as source(version_id)
  join public.document_versions v
    on v.id = source.version_id and v.workspace_id = v_workspace_id
  union all
  select v_analysis_id, v_workspace_id, v.document_id, v.id, 'comparison'::public.analysis_scope_role
  from pg_catalog.unnest(v_estimate.comparison_version_ids) as comparison(version_id)
  join public.document_versions v
    on v.id = comparison.version_id and v.workspace_id = v_workspace_id;

  perform private.reserve_analysis_credits(v_analysis_id, v_estimate.fixed_cost);

  return query select v_analysis_id, 'queued'::public.analysis_job_status, p_retry_of_analysis_id;
end;
$$;

create or replace function public.complete_analysis(
  p_analysis_id uuid,
  p_operation_id uuid
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'complete_analysis is deprecated, use finalize_analysis_success'
    using errcode = 'P0001';
end;
$$;

revoke all on function public.complete_analysis(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.complete_analysis(uuid, uuid)
  to service_role;
