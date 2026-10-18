-- array_agg over an empty comparison list yields NULL; preserve the public
-- empty-array contract through normalization, persistence, and the RPC result.

create or replace function private.create_analysis_estimate_impl(
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
    or not private.analysis_jsonb_has_exact_keys(
      p_manifest,
      array['fingerprintVersion', 'pricingVersion', 'promptVersion',
        'outputSchemaVersion', 'providers']::text[]
    )
    or p_manifest ->> 'fingerprintVersion' is distinct from 's2-05-v2'
    or p_manifest ->> 'pricingVersion' is distinct from 's2-04-v1'
    or pg_catalog.char_length(pg_catalog.btrim(p_manifest ->> 'promptVersion')) not between 1 and 120
    or pg_catalog.char_length(pg_catalog.btrim(p_manifest ->> 'outputSchemaVersion')) not between 1 and 120
    or not private.analysis_jsonb_has_exact_keys(
      p_manifest -> 'providers', array['primary', 'fallback']::text[]
    )
    or not private.analysis_jsonb_has_exact_keys(
      p_manifest #> '{providers,primary}', array['provider', 'model']::text[]
    )
    or not private.analysis_jsonb_has_exact_keys(
      p_manifest #> '{providers,fallback}', array['provider', 'model']::text[]
    )
    or pg_catalog.char_length(pg_catalog.btrim(p_manifest #>> '{providers,primary,provider}')) not between 1 and 120
    or pg_catalog.char_length(pg_catalog.btrim(p_manifest #>> '{providers,primary,model}')) not between 1 and 120
    or pg_catalog.char_length(pg_catalog.btrim(p_manifest #>> '{providers,fallback,provider}')) not between 1 and 120
    or pg_catalog.char_length(pg_catalog.btrim(p_manifest #>> '{providers,fallback,model}')) not between 1 and 120
  then
    raise exception using errcode = '22023', message = 'Invalid analysis execution manifest.';
  end if;

  select coalesce(pg_catalog.array_agg(x order by x), '{}'::uuid[])
  into v_source_ids
  from pg_catalog.unnest(p_source_version_ids) as u(x);
  select coalesce(pg_catalog.array_agg(x order by x), '{}'::uuid[])
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
