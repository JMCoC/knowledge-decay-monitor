-- S2-06 analysis worker leases, Task 1: worker columns + claim_analysis.
-- renew_analysis_lease, complete_analysis and fail_analysis arrive in Task 2
-- in this same file. SQL verbatim from the S2-06 spec §5.1.

alter table public.analyses
  add column checkpoint jsonb,
  add column next_attempt_at timestamptz;

-- The new columns stay outside the authenticated column-list grant
-- (20261010194238_s2_01_analysis_security.sql:47-50); service_role keeps
-- table-level access. No additional REVOKE needed.

create function public.claim_analysis(p_analysis_id uuid default null)
returns table(
  id uuid, workspace_id uuid, initiator_id uuid, operation_id uuid,
  attempt_count integer, lease_expires_at timestamptz, next_attempt_at timestamptz
)
language plpgsql security definer set search_path = ''
set lock_timeout = '1s' set statement_timeout = '2s' as $$
declare
  v public.analyses%rowtype;
  claimed boolean := false;
  op uuid;
  ts timestamptz;
begin
  perform pg_catalog.pg_advisory_xact_lock(26061501);
  ts := clock_timestamp();
  -- Marcado terminal (C1): TODO(S2-08) liberar créditos + emitir evento.
  -- operation_id/lease_expires_at se preservan como token de acuse terminal (mismo patrón que complete_analysis §5.3).
  update public.analyses
     set status = 'failed', error_code = 'ATTEMPTS_EXHAUSTED',
         finished_at = ts, updated_at = ts
   where status = 'processing' and analyses.lease_expires_at < ts and analyses.attempt_count >= 3;
  -- Claim dirigido (B1/B2): frescos (NULL) o vencidos, siempre con margen de intento.
  if p_analysis_id is not null then
    select * into v from public.analyses
     where analyses.id = p_analysis_id and analyses.attempt_count < 3
       and ((status = 'queued' and (analyses.next_attempt_at is null or analyses.next_attempt_at <= ts))
         or (status = 'processing' and analyses.lease_expires_at < ts))
     for update;
    claimed := found;
  end if;
  -- Sweep FIFO (B2): NULL primero por created_at, sin bloquearse en filas tomadas.
  if not claimed then
    select * into v from public.analyses
     where analyses.attempt_count < 3
       and ((status = 'queued' and (analyses.next_attempt_at is null or analyses.next_attempt_at <= ts))
         or (status = 'processing' and analyses.lease_expires_at < ts))
     order by created_at, analyses.id for update skip locked limit 1;
    claimed := found;
  end if;
  if not claimed then return; end if;
  op := gen_random_uuid();
  update public.analyses
     set status = 'processing', operation_id = op,
         lease_expires_at = ts + interval '180 seconds',
         attempt_count = v.attempt_count + 1,
         started_at = coalesce(v.started_at, ts),
         next_attempt_at = null, updated_at = ts
   where analyses.id = v.id;
  return query select v.id, v.workspace_id, v.initiator_id, op,
    v.attempt_count + 1, ts + interval '180 seconds', null::timestamptz;
end;
$$;

revoke all on function public.claim_analysis(uuid)
  from public, anon, authenticated;
grant execute on function public.claim_analysis(uuid)
  to service_role;

-- Task 0 Option A: the worker runs retrieval as service_role.
-- retrieve_candidate_pairs is security invoker filtering by p_workspace_id,
-- and service_role has BYPASSRLS, so no wrapper is needed.
grant execute on function public.retrieve_candidate_pairs(uuid,uuid[],uuid[],integer,double precision)
  to service_role;

-- Task 2: renew/complete/fail. SQL verbatim from the S2-06 spec §5.2-§5.4.

create function public.renew_analysis_lease(
  p_analysis_id uuid, p_operation_id uuid, p_checkpoint jsonb
)
returns table(lease_expires_at timestamptz)
language plpgsql security definer set search_path = ''
set lock_timeout = '1s' set statement_timeout = '2s' as $$
declare expires timestamptz;
begin
  perform pg_catalog.pg_advisory_xact_lock(26061501);
  if p_checkpoint is not null and jsonb_typeof(p_checkpoint) <> 'object' then
    raise exception 'Invalid checkpoint shape' using errcode = '22023';
  end if;
  update public.analyses
     set lease_expires_at = least(
           clock_timestamp() + interval '180 seconds',
           started_at + interval '30 minutes'),
         checkpoint = p_checkpoint, updated_at = clock_timestamp()
   where id = p_analysis_id and status = 'processing'
     and operation_id = p_operation_id
     and analyses.lease_expires_at > clock_timestamp()
     and started_at + interval '30 minutes' > clock_timestamp()
  returning analyses.lease_expires_at into expires;
  if not found then
    raise exception 'Analysis lease expired' using errcode = '22023';
  end if;
  return query select expires;
end;
$$;

create function public.complete_analysis(p_analysis_id uuid, p_operation_id uuid)
returns void
language plpgsql security definer set search_path = ''
set lock_timeout = '1s' set statement_timeout = '2s' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(26061501);
  update public.analyses set updated_at = clock_timestamp()
   where id = p_analysis_id and status = 'completed' and operation_id = p_operation_id;
  if found then return; end if;
  update public.analyses
     set status = 'completed', finished_at = clock_timestamp(),
         updated_at = clock_timestamp()
   where id = p_analysis_id and status = 'processing'
     and operation_id = p_operation_id
     and lease_expires_at > clock_timestamp();
  if not found then
    raise exception 'Stale analysis operation' using errcode = '22023';
  end if;
  -- TODO(S2-08): findings + evidence + consumir reserva + evento analysis_completed.
end;
$$;

create function public.fail_analysis(
  p_analysis_id uuid, p_operation_id uuid,
  p_retryable boolean, p_error_code public.analysis_failure_code
)
returns text
language plpgsql security definer set search_path = ''
set lock_timeout = '1s' set statement_timeout = '2s' as $$
declare j public.analyses%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(26061501);
  select * into j from public.analyses where id = p_analysis_id for update;
  if not found or j.status <> 'processing'
      or j.operation_id is distinct from p_operation_id then
    return 'superseded';
  end if;
  if j.lease_expires_at <= clock_timestamp() then return 'superseded'; end if;
  -- C5: no incrementa attempt_count; solo evalúa si queda margen.
  if p_retryable and j.attempt_count < 3 then
    update public.analyses
       set status = 'queued', operation_id = null, lease_expires_at = null,
           next_attempt_at = clock_timestamp() + case
             when j.attempt_count = 1 then interval '30 seconds'
             else interval '2 minutes' end,
           error_code = p_error_code, updated_at = clock_timestamp()
     where id = j.id;
    return 'queued';
  end if;
  update public.analyses
     set status = 'failed', lease_expires_at = null, next_attempt_at = null,
         error_code = p_error_code, finished_at = clock_timestamp(),
         updated_at = clock_timestamp()
   where id = j.id;
  -- TODO(S2-08): liberar reserva + evento analysis_failed.
  return 'failed';
end;
$$;

revoke all on function public.renew_analysis_lease(uuid, uuid, jsonb),
  public.complete_analysis(uuid, uuid),
  public.fail_analysis(uuid, uuid, boolean, public.analysis_failure_code)
  from public, anon, authenticated;
grant execute on function public.renew_analysis_lease(uuid, uuid, jsonb),
  public.complete_analysis(uuid, uuid),
  public.fail_analysis(uuid, uuid, boolean, public.analysis_failure_code)
  to service_role;
