-- S2-05 creates or replays a Run/Retry atomically with its scope and credit reservation.

alter table public.analysis_estimates
  add constraint analysis_estimates_run_reference_unique
    unique (id, workspace_id, initiator_id);

alter table public.analyses
  add column estimate_id uuid,
  add column command_fingerprint text,
  add constraint analyses_estimate_command_pair
    check ((estimate_id is null) = (command_fingerprint is null)),
  add constraint analyses_command_fingerprint_sha256
    check (command_fingerprint is null or command_fingerprint ~ '^[0-9a-f]{64}$'),
  add constraint analyses_estimate_owner_fkey
    foreign key (estimate_id, workspace_id, initiator_id)
    references public.analysis_estimates (id, workspace_id, initiator_id)
    on delete restrict;

create index analyses_estimate_id_idx
  on public.analyses (estimate_id)
  where estimate_id is not null;

create function private.create_analysis_run(
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

create function public.run_analysis(
  p_actor_id uuid,
  p_estimate_ref uuid,
  p_idempotency_key text,
  p_current_manifest jsonb
) returns table (
  analysis_id uuid,
  status public.analysis_job_status
)
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '3s'
set statement_timeout = '30s'
as $$
begin
  return query
  select command.analysis_id, command.status
  from private.create_analysis_run(
    p_actor_id, p_estimate_ref, p_idempotency_key, null, p_current_manifest
  ) command;
end;
$$;

create function public.retry_analysis(
  p_actor_id uuid,
  p_failed_analysis_id uuid,
  p_estimate_ref uuid,
  p_idempotency_key text,
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
begin
  if p_failed_analysis_id is null then
    raise exception using errcode = '22023', message = 'A failed analysis is required.';
  end if;
  return query
  select command.analysis_id, command.status, command.retry_of_analysis_id
  from private.create_analysis_run(
    p_actor_id, p_estimate_ref, p_idempotency_key, p_failed_analysis_id, p_current_manifest
  ) command;
end;
$$;

revoke all on function private.create_analysis_run(uuid,uuid,text,uuid,jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.run_analysis(uuid,uuid,text,jsonb)
  from public, anon, authenticated;
revoke all on function public.retry_analysis(uuid,uuid,uuid,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.run_analysis(uuid,uuid,text,jsonb),
  public.retry_analysis(uuid,uuid,uuid,text,jsonb) to service_role;
