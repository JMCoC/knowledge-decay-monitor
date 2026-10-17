-- S2-05 worker handoff: bounded attempts, fixed analysis budget, fenced batches,
-- and operation-scoped retrieval readers. Settlement remains owned by S2-08.

alter table public.analyses
  add column continuation_pending boolean not null default false,
  add column attempt_started_at timestamptz,
  add column attempt_deadline_at timestamptz,
  add column analysis_deadline_at timestamptz;

-- Preserve already-running work without granting it a fresh budget. A retry
-- queued by the older worker keeps only the analysis-level deadline; its next
-- claim starts a new attempt deadline.
update public.analyses
   set analysis_deadline_at = coalesce(started_at, created_at) + interval '90 minutes',
       attempt_started_at = coalesce(attempt_started_at, started_at, updated_at, created_at),
       attempt_deadline_at = least(
         coalesce(attempt_started_at, started_at, updated_at, created_at) + interval '30 minutes',
         coalesce(started_at, created_at) + interval '90 minutes'
       )
 where status = 'processing';

update public.analyses
   set analysis_deadline_at = coalesce(started_at, created_at) + interval '90 minutes',
       attempt_deadline_at = null,
       attempt_started_at = null
 where status = 'queued' and attempt_count > 0;

create or replace function public.claim_analysis(p_analysis_id uuid default null)
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
  v_attempt_count integer;
  v_attempt_started_at timestamptz;
  v_attempt_deadline_at timestamptz;
  v_analysis_deadline_at timestamptz;
  v_lease_expires_at timestamptz;
  v_continuation boolean;
begin
  perform pg_catalog.pg_advisory_xact_lock(26061501);
  ts := clock_timestamp();

  -- Total-budget expiry is terminal. An expired queued continuation cannot
  -- silently turn into a new attempt; only a crashed processing lease can.
  update public.analyses as a
     set status = 'failed', error_code = case
           when a.attempt_count >= 3 then 'ATTEMPTS_EXHAUSTED'::public.analysis_failure_code
           else 'TIMEOUT'::public.analysis_failure_code end,
         finished_at = ts, continuation_pending = false, updated_at = ts
   where a.status = 'processing'
     and (a.analysis_deadline_at is null or a.analysis_deadline_at <= ts
       or ((a.attempt_deadline_at is null or a.attempt_deadline_at <= ts
         or a.lease_expires_at is null or a.lease_expires_at <= ts) and a.attempt_count >= 3));

  update public.analyses as a
     set status = 'failed', error_code = 'TIMEOUT'::public.analysis_failure_code,
         finished_at = ts, continuation_pending = false,
         operation_id = null, lease_expires_at = null, next_attempt_at = null,
         updated_at = ts
   where a.status = 'queued'
     and (a.analysis_deadline_at <= ts
       or (a.continuation_pending and
         (a.attempt_deadline_at is null or a.analysis_deadline_at is null
           or a.attempt_deadline_at <= ts)));

  -- A live continuation is the same attempt, even when it is attempt 3.
  if p_analysis_id is not null then
    select a.* into v from public.analyses as a
     where a.id = p_analysis_id
       and ((a.status = 'queued' and a.continuation_pending
             and a.attempt_deadline_at > ts and a.analysis_deadline_at > ts)
         or (a.status = 'queued' and not a.continuation_pending
             and a.attempt_count < 3
             and (a.next_attempt_at is null or a.next_attempt_at <= ts)
             and (a.analysis_deadline_at is null or a.analysis_deadline_at > ts))
         or (a.status = 'processing' and a.attempt_count < 3
             and (a.lease_expires_at <= ts or a.attempt_deadline_at <= ts)
             and (a.analysis_deadline_at is null or a.analysis_deadline_at > ts)))
     for update;
    claimed := found;
  end if;

  -- Sweep FIFO and leave rows already locked by another database session alone.
  if not claimed then
    select a.* into v from public.analyses as a
     where ((a.status = 'queued' and a.continuation_pending
             and a.attempt_deadline_at > ts and a.analysis_deadline_at > ts)
         or (a.status = 'queued' and not a.continuation_pending
             and a.attempt_count < 3
             and (a.next_attempt_at is null or a.next_attempt_at <= ts)
             and (a.analysis_deadline_at is null or a.analysis_deadline_at > ts))
         or (a.status = 'processing' and a.attempt_count < 3
             and (a.lease_expires_at <= ts or a.attempt_deadline_at <= ts)
             and (a.analysis_deadline_at is null or a.analysis_deadline_at > ts))
       )
     order by a.created_at, a.id for update of a skip locked limit 1;
    claimed := found;
  end if;
  if not claimed then return; end if;

  v_continuation := v.status = 'queued' and v.continuation_pending;
  op := gen_random_uuid();
  v_analysis_deadline_at := coalesce(v.analysis_deadline_at, ts + interval '90 minutes');
  if v_continuation then
    v_attempt_count := v.attempt_count;
    v_attempt_started_at := v.attempt_started_at;
    v_attempt_deadline_at := v.attempt_deadline_at;
  else
    v_attempt_count := v.attempt_count + 1;
    v_attempt_started_at := ts;
    v_attempt_deadline_at := least(ts + interval '30 minutes', v_analysis_deadline_at);
  end if;
  v_lease_expires_at := least(
    ts + interval '180 seconds', v_attempt_deadline_at, v_analysis_deadline_at
  );

  if v_attempt_count > 3 or v_attempt_deadline_at <= ts or v_lease_expires_at <= ts then
    update public.analyses as a
       set status = 'failed', error_code = case
             when v.attempt_count >= 3 then 'ATTEMPTS_EXHAUSTED'::public.analysis_failure_code
             else 'TIMEOUT'::public.analysis_failure_code end,
           finished_at = ts, continuation_pending = false, updated_at = ts
     where a.id = v.id;
    return;
  end if;

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
  return query select v.id, v.workspace_id, v.initiator_id, op,
    v_attempt_count, v_lease_expires_at, null::timestamptz;
end;
$$;

create or replace function public.renew_analysis_lease(
  p_analysis_id uuid, p_operation_id uuid, p_checkpoint jsonb
)
returns table(lease_expires_at timestamptz)
language plpgsql security definer set search_path = ''
set lock_timeout = '1s' set statement_timeout = '2s' as $$
declare
  v public.analyses%rowtype;
  ts timestamptz;
  v_attempt_started_at timestamptz;
  v_attempt_deadline_at timestamptz;
  v_analysis_deadline_at timestamptz;
  v_new_processed numeric;
  v_old_processed numeric;
  v_expires timestamptz;
begin
  perform pg_catalog.pg_advisory_xact_lock(26061501);
  ts := clock_timestamp();
  if p_checkpoint is not null and pg_catalog.jsonb_typeof(p_checkpoint) <> 'object' then
    raise exception 'Invalid checkpoint shape' using errcode = '22023';
  end if;

  select * into v from public.analyses
   where id = p_analysis_id and status = 'processing'
     and operation_id = p_operation_id
   for update;
  if not found or v.lease_expires_at is null or v.lease_expires_at <= ts then
    raise exception 'Analysis lease expired' using errcode = '22023';
  end if;

  v_attempt_started_at := coalesce(v.attempt_started_at, v.started_at, ts);
  v_analysis_deadline_at := coalesce(
    v.analysis_deadline_at, coalesce(v.started_at, v.created_at) + interval '90 minutes'
  );
  v_attempt_deadline_at := coalesce(
    v.attempt_deadline_at, least(v_attempt_started_at + interval '30 minutes', v_analysis_deadline_at)
  );
  if v_attempt_deadline_at <= ts or v_analysis_deadline_at <= ts then
    raise exception 'Analysis deadline expired' using errcode = '22023';
  end if;

  if p_checkpoint is not null and p_checkpoint ? 'processedPairs' then
    if coalesce(p_checkpoint ->> 'processedPairs', '') !~ '^(0|[1-9][0-9]*)$'
       or (p_checkpoint ->> 'processedPairs')::numeric > 2147483647 then
      raise exception 'Invalid checkpoint cursor' using errcode = '22023';
    end if;
    v_new_processed := (p_checkpoint ->> 'processedPairs')::numeric;
    if v.checkpoint ? 'processedPairs'
       and (v.checkpoint ->> 'processedPairs') ~ '^(0|[1-9][0-9]*)$' then
      v_old_processed := (v.checkpoint ->> 'processedPairs')::numeric;
      if v_new_processed < v_old_processed then
        raise exception 'Checkpoint cursor cannot move backwards' using errcode = '22023';
      end if;
    end if;
  end if;

  v_expires := least(ts + interval '180 seconds', v_attempt_deadline_at, v_analysis_deadline_at);
  update public.analyses
     set lease_expires_at = v_expires,
         checkpoint = coalesce(p_checkpoint, checkpoint),
         attempt_started_at = v_attempt_started_at,
         attempt_deadline_at = v_attempt_deadline_at,
         analysis_deadline_at = v_analysis_deadline_at,
         updated_at = ts
   where id = p_analysis_id;
  return query select v_expires;
end;
$$;

create function public.renew_analysis_lease(
  p_analysis_id uuid,
  p_operation_id uuid,
  p_expected_processed_pairs integer,
  p_checkpoint jsonb
)
returns table(lease_expires_at timestamptz)
language plpgsql security definer set search_path = ''
set lock_timeout = '1s' set statement_timeout = '2s' as $$
declare
  v public.analyses%rowtype;
  ts timestamptz;
  v_current_processed integer := 0;
  v_new_processed integer;
  v_total_pairs integer;
  v_findings_count integer;
  v_old_total integer := null;
  v_old_findings integer := 0;
  v_attempt_started_at timestamptz;
  v_attempt_deadline_at timestamptz;
  v_analysis_deadline_at timestamptz;
  v_expires timestamptz;
begin
  perform pg_catalog.pg_advisory_xact_lock(26061501);
  ts := clock_timestamp();
  if p_expected_processed_pairs is null or p_expected_processed_pairs < 0
     or pg_catalog.jsonb_typeof(p_checkpoint) is distinct from 'object'
     or coalesce(p_checkpoint ->> 'processedPairs', '') !~ '^(0|[1-9][0-9]*)$'
     or coalesce(p_checkpoint ->> 'totalPairs', '') !~ '^(0|[1-9][0-9]*)$'
     or coalesce(p_checkpoint ->> 'findingsCount', '0') !~ '^(0|[1-9][0-9]*)$' then
    raise exception 'Invalid checkpoint cursor' using errcode = '22023';
  end if;
  if (p_checkpoint ->> 'processedPairs')::numeric > 2147483647
     or (p_checkpoint ->> 'totalPairs')::numeric > 2147483647
     or coalesce((p_checkpoint ->> 'findingsCount')::numeric, 0) > 2147483647 then
    raise exception 'Invalid checkpoint cursor' using errcode = '22023';
  end if;
  v_new_processed := (p_checkpoint ->> 'processedPairs')::integer;
  v_total_pairs := (p_checkpoint ->> 'totalPairs')::integer;
  v_findings_count := coalesce((p_checkpoint ->> 'findingsCount')::integer, 0);
  if v_new_processed < p_expected_processed_pairs or v_new_processed > v_total_pairs then
    raise exception 'Invalid checkpoint progress' using errcode = '22023';
  end if;

  select * into v from public.analyses
   where id = p_analysis_id and status = 'processing'
     and operation_id = p_operation_id
   for update;
  if not found or v.lease_expires_at is null or v.lease_expires_at <= ts then
    raise exception 'Analysis lease expired' using errcode = '22023';
  end if;
  if v.checkpoint ? 'processedPairs'
     and (v.checkpoint ->> 'processedPairs') ~ '^(0|[1-9][0-9]*)$' then
    v_current_processed := (v.checkpoint ->> 'processedPairs')::integer;
  end if;
  if v_current_processed <> p_expected_processed_pairs then
    raise exception 'Checkpoint cursor changed' using errcode = '22023';
  end if;
  if v.checkpoint ? 'totalPairs'
     and (v.checkpoint ->> 'totalPairs') ~ '^(0|[1-9][0-9]*)$' then
    v_old_total := (v.checkpoint ->> 'totalPairs')::integer;
  end if;
  if v.checkpoint ? 'findingsCount'
     and (v.checkpoint ->> 'findingsCount') ~ '^(0|[1-9][0-9]*)$' then
    v_old_findings := (v.checkpoint ->> 'findingsCount')::integer;
  end if;
  if (v_old_total is not null and v_old_total <> v_total_pairs)
     or v_findings_count < v_old_findings then
    raise exception 'Checkpoint state cannot regress' using errcode = '22023';
  end if;

  v_attempt_started_at := coalesce(v.attempt_started_at, v.started_at, ts);
  v_analysis_deadline_at := coalesce(
    v.analysis_deadline_at, coalesce(v.started_at, v.created_at) + interval '90 minutes'
  );
  v_attempt_deadline_at := coalesce(
    v.attempt_deadline_at, least(v_attempt_started_at + interval '30 minutes', v_analysis_deadline_at)
  );
  if v_attempt_deadline_at <= ts or v_analysis_deadline_at <= ts then
    raise exception 'Analysis deadline expired' using errcode = '22023';
  end if;
  v_expires := least(ts + interval '180 seconds', v_attempt_deadline_at, v_analysis_deadline_at);

  update public.analyses
     set lease_expires_at = v_expires, checkpoint = p_checkpoint,
         attempt_started_at = v_attempt_started_at,
         attempt_deadline_at = v_attempt_deadline_at,
         analysis_deadline_at = v_analysis_deadline_at,
         updated_at = ts
   where id = p_analysis_id;
  return query select v_expires;
end;
$$;

create function public.yield_analysis_batch(
  p_analysis_id uuid,
  p_operation_id uuid,
  p_expected_processed_pairs integer,
  p_checkpoint jsonb
) returns boolean
language plpgsql security definer set search_path = ''
set lock_timeout = '1s' set statement_timeout = '2s' as $$
declare
  v public.analyses%rowtype;
  ts timestamptz;
  v_current_processed integer := 0;
  v_new_processed integer;
  v_total_pairs integer;
  v_findings_count integer;
  v_old_total integer := null;
  v_old_findings integer := 0;
begin
  if p_expected_processed_pairs is null or p_expected_processed_pairs < 0
     or pg_catalog.jsonb_typeof(p_checkpoint) is distinct from 'object'
     or coalesce(p_checkpoint ->> 'processedPairs', '') !~ '^(0|[1-9][0-9]*)$'
     or coalesce(p_checkpoint ->> 'totalPairs', '') !~ '^(0|[1-9][0-9]*)$'
     or coalesce(p_checkpoint ->> 'findingsCount', '0') !~ '^(0|[1-9][0-9]*)$' then
    raise exception 'Invalid checkpoint cursor' using errcode = '22023';
  end if;
  if (p_checkpoint ->> 'processedPairs')::numeric > 2147483647
     or (p_checkpoint ->> 'totalPairs')::numeric > 2147483647
     or coalesce((p_checkpoint ->> 'findingsCount')::numeric, 0) > 2147483647 then
    raise exception 'Invalid checkpoint cursor' using errcode = '22023';
  end if;
  v_new_processed := (p_checkpoint ->> 'processedPairs')::integer;
  v_total_pairs := (p_checkpoint ->> 'totalPairs')::integer;
  v_findings_count := coalesce((p_checkpoint ->> 'findingsCount')::integer, 0);
  if v_new_processed <= p_expected_processed_pairs or v_new_processed > v_total_pairs then
    raise exception 'A yielded batch must advance the cursor' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(26061501);
  ts := clock_timestamp();
  select * into v from public.analyses where id = p_analysis_id for update;
  if not found or v.status <> 'processing'
     or v.operation_id is distinct from p_operation_id
     or v.lease_expires_at is null or v.lease_expires_at <= ts
     or v.attempt_deadline_at is null or v.attempt_deadline_at <= ts
     or v.analysis_deadline_at is null or v.analysis_deadline_at <= ts then
    return false;
  end if;
  if v.checkpoint ? 'processedPairs'
     and (v.checkpoint ->> 'processedPairs') ~ '^(0|[1-9][0-9]*)$' then
    v_current_processed := (v.checkpoint ->> 'processedPairs')::integer;
  end if;
  if v_current_processed <> p_expected_processed_pairs then return false; end if;
  if v.checkpoint ? 'totalPairs'
     and (v.checkpoint ->> 'totalPairs') ~ '^(0|[1-9][0-9]*)$' then
    v_old_total := (v.checkpoint ->> 'totalPairs')::integer;
  end if;
  if v.checkpoint ? 'findingsCount'
     and (v.checkpoint ->> 'findingsCount') ~ '^(0|[1-9][0-9]*)$' then
    v_old_findings := (v.checkpoint ->> 'findingsCount')::integer;
  end if;
  if (v_old_total is not null and v_old_total <> v_total_pairs)
     or v_findings_count < v_old_findings then
    raise exception 'Checkpoint state cannot regress' using errcode = '22023';
  end if;

  update public.analyses
     set status = 'queued', continuation_pending = true,
         checkpoint = p_checkpoint, operation_id = null, lease_expires_at = null,
         next_attempt_at = null, updated_at = ts
   where id = p_analysis_id;
  return true;
end;
$$;

create function public.read_analysis_retrieval_summary(
  p_analysis_id uuid, p_operation_id uuid
) returns table (
  chunk_count integer,
  candidate_pair_count integer,
  chunks_revision text,
  request_fingerprint text,
  fixed_cost integer
)
language plpgsql security definer set search_path = ''
set lock_timeout = '3s' set statement_timeout = '35s' as $$
declare
  v public.analyses%rowtype;
  e public.analysis_estimates%rowtype;
  v_source_ids uuid[];
  v_comparison_ids uuid[];
  v_summary record;
  ts timestamptz;
begin
  ts := clock_timestamp();
  select * into v from public.analyses
   where id = p_analysis_id and status = 'processing'
     and operation_id = p_operation_id
   for share;
  if not found or v.lease_expires_at <= ts
     or v.lease_expires_at is null
     or v.attempt_deadline_at is null or v.attempt_deadline_at <= ts
     or v.analysis_deadline_at is null or v.analysis_deadline_at <= ts then
    raise exception 'Stale analysis operation' using errcode = '22023';
  end if;
  if v.estimate_id is null then
    raise exception 'Analysis snapshot is unavailable' using errcode = 'P2102';
  end if;

  select * into e from public.analysis_estimates where id = v.estimate_id
    and workspace_id = v.workspace_id and initiator_id = v.initiator_id;
  if not found then
    raise exception 'Analysis snapshot is unavailable' using errcode = 'P2102';
  end if;
  select coalesce(pg_catalog.array_agg(scope.version_id order by scope.version_id), '{}'::uuid[])
    into v_source_ids
  from (
    select distinct ad.version_id from public.analysis_documents ad
     where ad.analysis_id = v.id and ad.workspace_id = v.workspace_id and ad.role = 'source'
  ) scope;
  select coalesce(pg_catalog.array_agg(scope.version_id order by scope.version_id), '{}'::uuid[])
    into v_comparison_ids
  from (
    select distinct ad.version_id from public.analysis_documents ad
     where ad.analysis_id = v.id and ad.workspace_id = v.workspace_id and ad.role = 'comparison'
  ) scope;
  if v_source_ids is distinct from e.source_version_ids
     or v_comparison_ids is distinct from e.comparison_version_ids
     or e.execution_manifest is null
     or e.fingerprint_version is distinct from 's2-05-v2'
     or v.request_fingerprint is distinct from e.request_fingerprint
     or v.fixed_cost is distinct from e.fixed_cost
     or v.pricing_version is distinct from e.pricing_version
     or v.prompt_version is distinct from e.execution_manifest ->> 'promptVersion'
     or v.output_schema_version is distinct from e.execution_manifest ->> 'outputSchemaVersion'
     or v.provider_config is distinct from e.execution_manifest -> 'providers'
     or v.retrieval_config is distinct from e.retrieval_config then
    raise exception 'Analysis snapshot is stale' using errcode = 'P2102';
  end if;

  begin
    select * into v_summary
    from private.analysis_retrieval_summary(
      v.workspace_id, v_source_ids, v_comparison_ids, e.execution_manifest
    );
  exception when sqlstate '22023' then
    raise exception 'Analysis snapshot is stale' using errcode = 'P2102';
  end;
  if v_summary.request_fingerprint is distinct from v.request_fingerprint
     or v_summary.fixed_cost is distinct from v.fixed_cost
     or v_summary.chunks_revision is distinct from e.retrieval_config ->> 'chunksRevision'
     or v_summary.request_fingerprint is distinct from e.retrieval_config ->> 'fingerprint'
     or e.retrieval_config ->> 'embeddingRevision' is distinct from 'gte-small-384-v1'
     or e.retrieval_config ->> 'topK' is distinct from '5'
     or e.retrieval_config ->> 'similarityThreshold' is distinct from '0.75' then
    raise exception 'Analysis snapshot is stale' using errcode = 'P2102';
  end if;
  if v.lease_expires_at <= clock_timestamp()
     or v.attempt_deadline_at <= clock_timestamp()
     or v.analysis_deadline_at <= clock_timestamp() then
    raise exception 'Stale analysis operation' using errcode = '22023';
  end if;
  return query select v_summary.chunk_count, v_summary.candidate_pair_count,
    v_summary.chunks_revision, v_summary.request_fingerprint, v_summary.fixed_cost;
end;
$$;

-- The private page helper is also service_role-executable for the existing
-- retrieval contract. Reject NULL explicitly: `NULL NOT BETWEEN ...` is NULL,
-- and PostgreSQL interprets LIMIT NULL as an unbounded page.
create or replace function private.analysis_candidate_pair_page(
  p_workspace_id uuid,
  p_source_version_ids uuid[],
  p_comparison_version_ids uuid[],
  p_after_low uuid,
  p_after_high uuid,
  p_limit integer
) returns table (
  source_chunk_id uuid,
  source_version_id uuid,
  source_document_id uuid,
  source_text text,
  comparison_chunk_id uuid,
  comparison_version_id uuid,
  comparison_document_id uuid,
  comparison_text text,
  similarity double precision,
  pair_low_id uuid,
  pair_high_id uuid
)
language plpgsql volatile security definer set search_path = ''
set statement_timeout = '30s'
as $$
declare
  v_scope_count integer;
begin
  if p_workspace_id is null
    or p_source_version_ids is null
    or pg_catalog.cardinality(p_source_version_ids) = 0
    or p_comparison_version_ids is null
    or p_limit is null
    or p_limit not between 1 and 10
    or ((p_after_low is null) is distinct from (p_after_high is null))
    or pg_catalog.cardinality(p_source_version_ids) <> (
      select pg_catalog.count(distinct x)::integer from pg_catalog.unnest(p_source_version_ids) as u(x))
    or pg_catalog.cardinality(p_comparison_version_ids) <> (
      select pg_catalog.count(distinct x)::integer from pg_catalog.unnest(p_comparison_version_ids) as u(x))
  then
    raise exception using errcode = '22023', message = 'Invalid candidate pair page request.';
  end if;

  select pg_catalog.count(distinct x)::integer into v_scope_count
  from pg_catalog.unnest(p_source_version_ids || p_comparison_version_ids) as u(x);
  if v_scope_count > 20 then
    raise exception using errcode = '22023', message = 'Analysis scope exceeds 20 versions.';
  end if;

  return query
  select
    r.source_chunk_id,
    r.source_version_id,
    r.source_document_id,
    r.source_text,
    r.comparison_chunk_id,
    r.comparison_version_id,
    r.comparison_document_id,
    r.comparison_text,
    r.similarity,
    least(r.source_chunk_id, r.comparison_chunk_id),
    greatest(r.source_chunk_id, r.comparison_chunk_id)
  from public.retrieve_candidate_pairs(
    p_workspace_id,
    p_source_version_ids,
    p_comparison_version_ids,
    5,
    0.75
  ) r
  where p_after_low is null
    or (least(r.source_chunk_id, r.comparison_chunk_id),
        greatest(r.source_chunk_id, r.comparison_chunk_id)) > (p_after_low, p_after_high)
  order by
    least(r.source_chunk_id, r.comparison_chunk_id),
    greatest(r.source_chunk_id, r.comparison_chunk_id)
  limit p_limit;
end;
$$;

create function public.read_analysis_pair_batch(
  p_analysis_id uuid,
  p_operation_id uuid,
  p_after_low uuid,
  p_after_high uuid,
  p_limit integer
) returns table (
  source_chunk_id uuid,
  source_version_id uuid,
  source_document_id uuid,
  source_text text,
  comparison_chunk_id uuid,
  comparison_version_id uuid,
  comparison_document_id uuid,
  comparison_text text,
  similarity double precision,
  pair_low_id uuid,
  pair_high_id uuid
)
language plpgsql security definer set search_path = ''
set lock_timeout = '3s' set statement_timeout = '35s' as $$
declare
  v public.analyses%rowtype;
  e public.analysis_estimates%rowtype;
  v_source_ids uuid[];
  v_comparison_ids uuid[];
  v_scope_count integer;
  v_eligible_count integer;
  v_chunk_ids uuid[];
  v_chunks_revision text;
  ts timestamptz;
begin
  if p_limit is null or p_limit not between 1 and 10
     or ((p_after_low is null) is distinct from (p_after_high is null)) then
    raise exception 'Invalid candidate pair page request' using errcode = '22023';
  end if;
  ts := clock_timestamp();
  select * into v from public.analyses
   where id = p_analysis_id and status = 'processing'
     and operation_id = p_operation_id
   for share;
  if not found or v.lease_expires_at is null or v.lease_expires_at <= ts
     or v.attempt_deadline_at is null or v.attempt_deadline_at <= ts
     or v.analysis_deadline_at is null or v.analysis_deadline_at <= ts then
    raise exception 'Stale analysis operation' using errcode = '22023';
  end if;
  if v.estimate_id is null then
    raise exception 'Analysis snapshot is unavailable' using errcode = 'P2102';
  end if;
  select * into e from public.analysis_estimates where id = v.estimate_id
    and workspace_id = v.workspace_id and initiator_id = v.initiator_id;
  if not found or e.execution_manifest is null
     or v.request_fingerprint is distinct from e.request_fingerprint
     or v.fixed_cost is distinct from e.fixed_cost
     or v.retrieval_config is distinct from e.retrieval_config then
    raise exception 'Analysis snapshot is stale' using errcode = 'P2102';
  end if;
  select coalesce(pg_catalog.array_agg(scope.version_id order by scope.version_id), '{}'::uuid[])
    into v_source_ids
  from (
    select distinct ad.version_id from public.analysis_documents ad
     where ad.analysis_id = v.id and ad.workspace_id = v.workspace_id and ad.role = 'source'
  ) scope;
  select coalesce(pg_catalog.array_agg(scope.version_id order by scope.version_id), '{}'::uuid[])
    into v_comparison_ids
  from (
    select distinct ad.version_id from public.analysis_documents ad
     where ad.analysis_id = v.id and ad.workspace_id = v.workspace_id and ad.role = 'comparison'
  ) scope;
  if v_source_ids is distinct from e.source_version_ids
     or v_comparison_ids is distinct from e.comparison_version_ids then
    raise exception 'Analysis scope is stale' using errcode = 'P2102';
  end if;

  select pg_catalog.count(distinct scope.version_id)::integer
    into v_scope_count
  from pg_catalog.unnest(v_source_ids || v_comparison_ids) as scope(version_id);
  perform dv.id
  from public.document_versions as dv
  join public.documents as d
    on d.id = dv.document_id and d.workspace_id = dv.workspace_id
  where dv.workspace_id = v.workspace_id and dv.id = any(v_source_ids || v_comparison_ids)
  order by dv.id
  for share of dv, d;
  select pg_catalog.count(distinct dv.id)::integer
    into v_eligible_count
  from public.document_versions as dv
  join public.documents as d
    on d.id = dv.document_id and d.workspace_id = dv.workspace_id
  where dv.workspace_id = v.workspace_id
    and dv.id = any(v_source_ids || v_comparison_ids)
    and dv.processing_status = 'ready'
    and dv.version_status = 'active'
    and d.active_version_id = dv.id;
  if v_eligible_count is distinct from v_scope_count then
    raise exception 'Analysis scope is stale' using errcode = 'P2102';
  end if;

  select coalesce(pg_catalog.array_agg(c.id order by c.id), '{}'::uuid[])
    into v_chunk_ids
  from public.document_chunks as c
  where c.workspace_id = v.workspace_id
    and c.version_id = any(v_source_ids || v_comparison_ids);
  v_chunks_revision := pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.array_to_string(v_chunk_ids, ','), 'UTF8'),
    'sha256'
  ), 'hex');
  if v_chunks_revision is distinct from e.retrieval_config ->> 'chunksRevision' then
    raise exception 'Analysis chunks are stale' using errcode = 'P2102';
  end if;

  return query select page.source_chunk_id, page.source_version_id,
    page.source_document_id, page.source_text, page.comparison_chunk_id,
    page.comparison_version_id, page.comparison_document_id, page.comparison_text,
    page.similarity, page.pair_low_id, page.pair_high_id
  from private.analysis_candidate_pair_page(
    v.workspace_id, v_source_ids, v_comparison_ids,
    p_after_low, p_after_high, p_limit
  ) page;
  if v.lease_expires_at <= clock_timestamp()
     or v.attempt_deadline_at <= clock_timestamp()
     or v.analysis_deadline_at <= clock_timestamp() then
    raise exception 'Stale analysis operation' using errcode = '22023';
  end if;
end;
$$;

create or replace function public.fail_analysis(
  p_analysis_id uuid, p_operation_id uuid,
  p_retryable boolean, p_error_code public.analysis_failure_code
)
returns text
language plpgsql security definer set search_path = ''
set lock_timeout = '1s' set statement_timeout = '2s' as $$
declare
  j public.analyses%rowtype;
  ts timestamptz;
  v_attempt_deadline_at timestamptz;
  v_analysis_deadline_at timestamptz;
begin
  perform pg_catalog.pg_advisory_xact_lock(26061501);
  ts := clock_timestamp();
  select * into j from public.analyses where id = p_analysis_id for update;
  if not found or j.status <> 'processing'
      or j.operation_id is distinct from p_operation_id then
    return 'superseded';
  end if;
  if j.lease_expires_at is null or j.lease_expires_at <= ts then return 'superseded'; end if;
  v_analysis_deadline_at := coalesce(
    j.analysis_deadline_at, coalesce(j.started_at, j.created_at) + interval '90 minutes'
  );
  v_attempt_deadline_at := coalesce(
    j.attempt_deadline_at,
    least(coalesce(j.attempt_started_at, j.started_at, ts) + interval '30 minutes', v_analysis_deadline_at)
  );
  if v_analysis_deadline_at <= ts or v_attempt_deadline_at <= ts then
    update public.analyses
       set status = 'failed', error_code = 'TIMEOUT', lease_expires_at = null,
           next_attempt_at = null, continuation_pending = false,
           finished_at = ts, updated_at = ts
     where id = j.id;
    return 'failed';
  end if;
  if p_retryable and j.attempt_count < 3 then
    update public.analyses
       set status = 'queued', operation_id = null, lease_expires_at = null,
           continuation_pending = false,
           next_attempt_at = ts + case
             when j.attempt_count = 1 then interval '30 seconds'
             else interval '2 minutes' end,
           error_code = p_error_code, updated_at = ts
     where id = j.id;
    return 'queued';
  end if;
  update public.analyses
     set status = 'failed', lease_expires_at = null, next_attempt_at = null,
         continuation_pending = false,
         error_code = p_error_code, finished_at = ts, updated_at = ts
   where id = j.id;
  -- TODO(S2-08): liberar reserva + evento analysis_failed.
  return 'failed';
end;
$$;

revoke all on function public.yield_analysis_batch(uuid,uuid,integer,jsonb),
  public.read_analysis_retrieval_summary(uuid,uuid),
  public.read_analysis_pair_batch(uuid,uuid,uuid,uuid,integer),
  public.renew_analysis_lease(uuid,uuid,integer,jsonb)
  from public, anon, authenticated;
grant execute on function public.yield_analysis_batch(uuid,uuid,integer,jsonb),
  public.read_analysis_retrieval_summary(uuid,uuid),
  public.read_analysis_pair_batch(uuid,uuid,uuid,uuid,integer),
  public.renew_analysis_lease(uuid,uuid,integer,jsonb)
  to service_role;

notify pgrst, 'reload schema';
