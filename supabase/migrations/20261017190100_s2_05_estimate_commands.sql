-- S2-05 trusted estimate creation. Historical S2-04 estimates stay readable
-- with a NULL execution snapshot; new estimates can only be made by the RPC.

alter table public.analysis_estimates
  add column execution_manifest jsonb,
  add column fingerprint_version text,
  add constraint analysis_estimates_execution_manifest_object
    check (execution_manifest is null or jsonb_typeof(execution_manifest) = 'object'),
  add constraint analysis_estimates_fingerprint_version_supported
    check (fingerprint_version is null or fingerprint_version = 's2-05-v2'),
  add constraint analysis_estimates_snapshot_pair
    check ((execution_manifest is null) = (fingerprint_version is null));

drop policy estimates_insert on public.analysis_estimates;
revoke all on public.analysis_estimates from public, anon, authenticated, service_role;
grant select (
  id, workspace_id, initiator_id, source_version_ids, comparison_version_ids,
  fixed_cost, expires_at, created_at
) on public.analysis_estimates to authenticated;

create function private.guard_analysis_estimate_snapshot()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.execution_manifest is distinct from old.execution_manifest
      or new.fingerprint_version is distinct from old.fingerprint_version
    then
      raise exception using errcode = '42501', message = 'Estimate execution snapshots are immutable.';
    end if;
    return new;
  end if;

  if exists (
    select 1
    from public.analyses a
    where a.workspace_id = old.workspace_id
      and a.request_fingerprint = old.request_fingerprint
  ) then
    raise exception using errcode = '23503', message = 'Estimate snapshot is referenced by an analysis.';
  end if;
  return old;
end;
$$;

create trigger analysis_estimates_snapshot_immutable
before update or delete on public.analysis_estimates
for each row execute function private.guard_analysis_estimate_snapshot();

create function public.create_analysis_estimate(
  p_actor_id uuid,
  p_source_version_ids uuid[],
  p_comparison_version_ids uuid[],
  p_manifest jsonb
) returns table (
  estimate_ref uuid,
  fixed_cost integer,
  expires_at timestamptz,
  source_version_ids uuid[],
  comparison_version_ids uuid[]
)
language plpgsql volatile security definer set search_path = ''
set lock_timeout = '3s' set statement_timeout = '30s'
as $$
declare
  v_workspace_id uuid;
  v_role public.workspace_role;
  v_source_ids uuid[];
  v_comparison_ids uuid[];
  v_scope_count integer;
  v_summary record;
  v_estimate_id uuid;
  v_created_at timestamptz;
  v_expires_at timestamptz;
begin
  if p_actor_id is null then
    raise exception using errcode = '42501', message = 'A permitted analysis actor is required.';
  end if;

  -- Lock the persisted identity row so role/workspace changes cannot race
  -- the privileged command.
  select p.workspace_id, p.role
  into v_workspace_id, v_role
  from public.profiles p
  where p.id = p_actor_id
  for share;

  if not found or v_role not in ('Admin', 'QA Lead') then
    raise exception using errcode = '42501', message = 'The analysis actor is not permitted.';
  end if;

  if p_source_version_ids is null
    or pg_catalog.cardinality(p_source_version_ids) < 1
    or pg_catalog.cardinality(p_source_version_ids) > 20
    or p_comparison_version_ids is null
    or pg_catalog.cardinality(p_comparison_version_ids) > 20
    or pg_catalog.array_position(p_source_version_ids, null) is not null
    or pg_catalog.array_position(p_comparison_version_ids, null) is not null
    or pg_catalog.cardinality(p_source_version_ids) <> (
      select pg_catalog.count(distinct x)::integer
      from pg_catalog.unnest(p_source_version_ids) as u(x))
    or pg_catalog.cardinality(p_comparison_version_ids) <> (
      select pg_catalog.count(distinct x)::integer
      from pg_catalog.unnest(p_comparison_version_ids) as u(x))
  then
    raise exception using errcode = '22023', message = 'Invalid analysis scope.';
  end if;

  select pg_catalog.count(distinct x)::integer
  into v_scope_count
  from pg_catalog.unnest(p_source_version_ids || p_comparison_version_ids) as u(x);
  if v_scope_count > 20 then
    raise exception using errcode = '22023', message = 'Analysis scope exceeds 20 versions.';
  end if;

  if pg_catalog.jsonb_typeof(p_manifest) is distinct from 'object'
    or pg_catalog.jsonb_object_length(p_manifest) <> 5
    or not (p_manifest ?& array[
      'fingerprintVersion', 'pricingVersion', 'promptVersion',
      'outputSchemaVersion', 'providers'
    ])
    or p_manifest ->> 'fingerprintVersion' is distinct from 's2-05-v2'
    or p_manifest ->> 'pricingVersion' is distinct from 's2-04-v1'
    or pg_catalog.char_length(pg_catalog.btrim(p_manifest ->> 'promptVersion')) not between 1 and 120
    or pg_catalog.char_length(pg_catalog.btrim(p_manifest ->> 'outputSchemaVersion')) not between 1 and 120
    or pg_catalog.jsonb_typeof(p_manifest -> 'providers') is distinct from 'object'
    or pg_catalog.jsonb_object_length(p_manifest -> 'providers') <> 2
    or not ((p_manifest -> 'providers') ?& array['primary', 'fallback'])
    or pg_catalog.jsonb_typeof(p_manifest #> '{providers,primary}') is distinct from 'object'
    or pg_catalog.jsonb_object_length(p_manifest #> '{providers,primary}') <> 2
    or not ((p_manifest #> '{providers,primary}') ?& array['provider', 'model'])
    or pg_catalog.jsonb_typeof(p_manifest #> '{providers,fallback}') is distinct from 'object'
    or pg_catalog.jsonb_object_length(p_manifest #> '{providers,fallback}') <> 2
    or not ((p_manifest #> '{providers,fallback}') ?& array['provider', 'model'])
    or pg_catalog.char_length(pg_catalog.btrim(p_manifest #>> '{providers,primary,provider}')) not between 1 and 120
    or pg_catalog.char_length(pg_catalog.btrim(p_manifest #>> '{providers,primary,model}')) not between 1 and 120
    or pg_catalog.char_length(pg_catalog.btrim(p_manifest #>> '{providers,fallback,provider}')) not between 1 and 120
    or pg_catalog.char_length(pg_catalog.btrim(p_manifest #>> '{providers,fallback,model}')) not between 1 and 120
  then
    raise exception using errcode = '22023', message = 'Invalid analysis execution manifest.';
  end if;

  select pg_catalog.array_agg(x order by x)
  into v_source_ids
  from pg_catalog.unnest(p_source_version_ids) as u(x);
  select pg_catalog.array_agg(x order by x)
  into v_comparison_ids
  from pg_catalog.unnest(p_comparison_version_ids) as u(x);

  select *
  into v_summary
  from private.analysis_retrieval_summary(
    v_workspace_id, v_source_ids, v_comparison_ids, p_manifest
  );

  v_created_at := pg_catalog.clock_timestamp();
  v_expires_at := v_created_at + interval '30 minutes';

  insert into public.analysis_estimates(
    workspace_id, initiator_id, source_version_ids, comparison_version_ids,
    request_fingerprint, retrieval_config, chunk_count, candidate_pair_count,
    fixed_cost, pricing_version, execution_manifest, fingerprint_version,
    created_at, expires_at
  ) values (
    v_workspace_id, p_actor_id, v_source_ids, v_comparison_ids,
    v_summary.request_fingerprint,
    pg_catalog.jsonb_build_object(
      'topK', 5,
      'similarityThreshold', 0.75,
      'chunksRevision', v_summary.chunks_revision,
      'embeddingRevision', 'gte-small-384-v1',
      'fingerprint', v_summary.request_fingerprint
    ),
    v_summary.chunk_count, v_summary.candidate_pair_count,
    v_summary.fixed_cost, p_manifest ->> 'pricingVersion',
    p_manifest, p_manifest ->> 'fingerprintVersion',
    v_created_at, v_expires_at
  )
  returning id into v_estimate_id;

  return query select
    v_estimate_id, v_summary.fixed_cost, v_expires_at,
    v_source_ids, v_comparison_ids;
end;
$$;

revoke all on function private.guard_analysis_estimate_snapshot()
  from public, anon, authenticated, service_role;
revoke all on function public.create_analysis_estimate(uuid,uuid[],uuid[],jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.create_analysis_estimate(uuid,uuid[],uuid[],jsonb)
  to service_role;

notify pgrst, 'reload schema';
