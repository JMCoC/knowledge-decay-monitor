-- S2-05 retrieval snapshot: full-scope counts, canonical fingerprints,
-- bounded keyset pages, and version locks that serialize chunk changes.

create or replace function public.retrieve_candidate_pairs(
  p_workspace_id uuid,
  p_source_version_ids uuid[],
  p_comparison_version_ids uuid[],
  p_top_k integer,
  p_threshold double precision
) returns table (
  source_chunk_id uuid,
  source_version_id uuid,
  source_document_id uuid,
  source_text text,
  comparison_chunk_id uuid,
  comparison_version_id uuid,
  comparison_document_id uuid,
  comparison_text text,
  similarity double precision
)
language sql stable security invoker set search_path = ''
as $$
  with source_chunks as (
    select c.id as chunk_id, c.version_id, v.document_id,
      c.text_content, c.embedding
    from public.document_chunks c
    join public.document_versions v
      on v.id = c.version_id and v.workspace_id = c.workspace_id
    where c.workspace_id = p_workspace_id
      and c.version_id = any (p_source_version_ids)
  ),
  comparison_chunks as (
    select c.id as chunk_id, c.version_id, v.document_id,
      c.text_content, c.embedding
    from public.document_chunks c
    join public.document_versions v
      on v.id = c.version_id and v.workspace_id = c.workspace_id
    where c.workspace_id = p_workspace_id
      and (c.version_id = any (p_source_version_ids)
        or c.version_id = any (p_comparison_version_ids))
  ),
  ranked as (
    select s.chunk_id as s_chunk, s.version_id as s_ver,
      s.document_id as s_doc, s.text_content as s_text,
      u.o_chunk as o_chunk, u.o_ver as o_ver,
      u.o_doc as o_doc, u.o_text as o_text, u.sim as sim
    from source_chunks s
    cross join lateral (
      (select o.chunk_id as o_chunk, o.version_id as o_ver,
        o.document_id as o_doc, o.text_content as o_text,
        1 - (s.embedding operator(extensions.<=>) o.embedding) as sim
      from comparison_chunks o
      where o.version_id = s.version_id
        and o.chunk_id <> s.chunk_id
        and 1 - (s.embedding operator(extensions.<=>) o.embedding) >= p_threshold)
      union
      (select o.chunk_id as o_chunk, o.version_id as o_ver,
        o.document_id as o_doc, o.text_content as o_text,
        1 - (s.embedding operator(extensions.<=>) o.embedding) as sim
      from comparison_chunks o
      where o.version_id = any (p_comparison_version_ids)
        and o.chunk_id <> s.chunk_id
        and 1 - (s.embedding operator(extensions.<=>) o.embedding) >= p_threshold)
      order by sim desc, o_chunk asc
      limit p_top_k
    ) u
  )
  select distinct on (
      least(r.s_chunk, r.o_chunk),
      greatest(r.s_chunk, r.o_chunk))
    r.s_chunk as source_chunk_id,
    r.s_ver as source_version_id,
    r.s_doc as source_document_id,
    r.s_text as source_text,
    r.o_chunk as comparison_chunk_id,
    r.o_ver as comparison_version_id,
    r.o_doc as comparison_document_id,
    r.o_text as comparison_text,
    r.sim as similarity
  from ranked r
  order by least(r.s_chunk, r.o_chunk),
    greatest(r.s_chunk, r.o_chunk),
    r.sim desc,
    r.s_ver,
    r.o_ver,
    r.s_chunk,
    r.o_chunk;
$$;

create function private.canonical_jsonb(p_value jsonb)
returns text
language plpgsql immutable security definer set search_path = ''
as $$
declare
  v_type text := pg_catalog.jsonb_typeof(p_value);
  v_items text;
begin
  if p_value is null then return 'null'; end if;

  if v_type = 'object' then
    select coalesce(
      pg_catalog.string_agg(
        pg_catalog.to_jsonb(e.key)::text || ':' || private.canonical_jsonb(e.value),
        ',' order by e.key collate "C"
      ),
      ''
    ) into v_items
    from pg_catalog.jsonb_each(p_value) as e(key, value);
    return '{' || v_items || '}';
  elsif v_type = 'array' then
    select coalesce(
      pg_catalog.string_agg(private.canonical_jsonb(e.value), ',' order by e.ordinality),
      ''
    ) into v_items
    from pg_catalog.jsonb_array_elements(p_value) with ordinality as e(value, ordinality);
    return '[' || v_items || ']';
  elsif v_type = 'string' then
    return pg_catalog.to_jsonb(p_value #>> '{}')::text;
  end if;
  return p_value::text;
end;
$$;

create function private.analysis_retrieval_summary(
  p_workspace_id uuid,
  p_source_version_ids uuid[],
  p_comparison_version_ids uuid[],
  p_manifest jsonb
) returns table (
  chunk_count integer,
  candidate_pair_count integer,
  chunks_revision text,
  request_fingerprint text,
  fixed_cost integer
)
language plpgsql volatile security definer set search_path = ''
set lock_timeout = '3s' set statement_timeout = '30s'
as $$
declare
  v_scope_ids uuid[];
  v_source_ids uuid[];
  v_comparison_ids uuid[];
  v_eligible_count integer;
  v_chunk_ids uuid[];
  v_chunk_count integer;
  v_pair_count integer;
  v_pair_hashes text[];
  v_chunks_revision text;
  v_request_fingerprint text;
  v_fixed_cost integer;
  v_payload jsonb;
begin
  if p_workspace_id is null
    or p_source_version_ids is null
    or pg_catalog.cardinality(p_source_version_ids) = 0
    or p_comparison_version_ids is null
    or pg_catalog.cardinality(p_source_version_ids) > 20
    or pg_catalog.cardinality(p_comparison_version_ids) > 20
    or pg_catalog.cardinality(p_source_version_ids) <> (
      select pg_catalog.count(distinct x)::integer from pg_catalog.unnest(p_source_version_ids) as u(x))
    or pg_catalog.cardinality(p_comparison_version_ids) <> (
      select pg_catalog.count(distinct x)::integer from pg_catalog.unnest(p_comparison_version_ids) as u(x))
  then
    raise exception using errcode = '22023', message = 'Invalid analysis scope.';
  end if;

  if pg_catalog.jsonb_typeof(p_manifest) is distinct from 'object'
    or p_manifest ->> 'fingerprintVersion' is distinct from 's2-05-v2'
    or p_manifest ->> 'pricingVersion' is distinct from 's2-04-v1'
    or nullif(pg_catalog.btrim(p_manifest ->> 'promptVersion'), '') is null
    or nullif(pg_catalog.btrim(p_manifest ->> 'outputSchemaVersion'), '') is null
    or pg_catalog.jsonb_typeof(p_manifest -> 'providers') is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_manifest #> '{providers,primary}') is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_manifest #> '{providers,fallback}') is distinct from 'object'
    or nullif(pg_catalog.btrim(p_manifest #>> '{providers,primary,provider}'), '') is null
    or nullif(pg_catalog.btrim(p_manifest #>> '{providers,primary,model}'), '') is null
    or nullif(pg_catalog.btrim(p_manifest #>> '{providers,fallback,provider}'), '') is null
    or nullif(pg_catalog.btrim(p_manifest #>> '{providers,fallback,model}'), '') is null
  then
    raise exception using errcode = '22023', message = 'Invalid analysis execution manifest.';
  end if;

  select pg_catalog.array_agg(x order by x)
  into v_source_ids
  from pg_catalog.unnest(p_source_version_ids) as u(x);
  select pg_catalog.array_agg(x order by x)
  into v_comparison_ids
  from pg_catalog.unnest(p_comparison_version_ids) as u(x);
  select pg_catalog.array_agg(id order by id)
  into v_scope_ids
  from (
    select distinct x as id
    from pg_catalog.unnest(p_source_version_ids || p_comparison_version_ids) as u(x)
  ) scope;

  if pg_catalog.cardinality(v_scope_ids) > 20 then
    raise exception using errcode = '22023', message = 'Analysis scope exceeds 20 versions.';
  end if;

  -- finish_processing locks the version before it writes chunks or activates it.
  -- Acquiring the same rows in UUID order makes the snapshot a stable boundary.
  perform v.id
  from public.document_versions v
  where v.workspace_id = p_workspace_id and v.id = any (v_scope_ids)
  order by v.id
  for update;

  select pg_catalog.count(*)::integer
  into v_eligible_count
  from public.document_versions v
  join public.documents d
    on d.id = v.document_id and d.workspace_id = v.workspace_id
  where v.workspace_id = p_workspace_id
    and v.id = any (v_scope_ids)
    and v.processing_status = 'ready'
    and v.version_status = 'active'
    and d.active_version_id = v.id;

  if v_eligible_count <> pg_catalog.cardinality(v_scope_ids) then
    raise exception using errcode = '22023', message = 'Analysis scope is not eligible.';
  end if;

  select coalesce(pg_catalog.array_agg(c.id order by c.id), '{}'::uuid[])
  into v_chunk_ids
  from public.document_chunks c
  where c.workspace_id = p_workspace_id and c.version_id = any (v_scope_ids);
  v_chunk_count := pg_catalog.cardinality(v_chunk_ids);

  select
    pg_catalog.count(*)::integer,
    coalesce(
      pg_catalog.array_agg(
        pg_catalog.encode(
          extensions.digest(
            pg_catalog.convert_to(r.source_chunk_id::text || '|' || r.comparison_chunk_id::text, 'UTF8'),
            'sha256'
          ),
          'hex'
        ) order by r.source_chunk_id, r.comparison_chunk_id
      ),
      '{}'::text[]
    )
  into v_pair_count, v_pair_hashes
  from public.retrieve_candidate_pairs(
    p_workspace_id, v_source_ids, v_comparison_ids, 5, 0.75
  ) r;

  v_chunks_revision := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(pg_catalog.array_to_string(v_chunk_ids, ','), 'UTF8'),
      'sha256'
    ),
    'hex'
  );
  v_fixed_cost := (100 + 5 * v_chunk_count + 20 * v_pair_count + 99) / 100;

  v_payload := pg_catalog.jsonb_build_object(
    'candidatePairCount', v_pair_count,
    'chunkCount', v_chunk_count,
    'embeddingRevision', 'gte-small-384-v1',
    'outputSchemaVersion', p_manifest ->> 'outputSchemaVersion',
    'pairHashes', pg_catalog.to_jsonb(v_pair_hashes),
    'pricingVersion', p_manifest ->> 'pricingVersion',
    'promptVersion', p_manifest ->> 'promptVersion',
    'retrieval', pg_catalog.jsonb_build_object(
      'chunksRevision', v_chunks_revision,
      'similarityThreshold', 0.75,
      'topK', 5
    ),
    'sortedComparisonVersionIds', pg_catalog.to_jsonb(v_comparison_ids),
    'sortedSourceVersionIds', pg_catalog.to_jsonb(v_source_ids),
    'executionManifest', p_manifest
  );
  v_request_fingerprint := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(private.canonical_jsonb(v_payload), 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  return query select
    v_chunk_count, v_pair_count, v_chunks_revision,
    v_request_fingerprint, v_fixed_cost;
end;
$$;

create function private.analysis_candidate_pair_page(
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

create function private.lock_analysis_chunk_versions()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_version_ids uuid[];
begin
  if tg_op = 'INSERT' then
    v_version_ids := array[new.version_id];
  elsif tg_op = 'DELETE' then
    v_version_ids := array[old.version_id];
  else
    v_version_ids := array[old.version_id, new.version_id];
  end if;

  perform v.id
  from public.document_versions v
  where v.id = any (v_version_ids)
  order by v.id
  for update;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger document_chunks_analysis_snapshot_lock
before insert or update or delete on public.document_chunks
for each row execute function private.lock_analysis_chunk_versions();

revoke all on function private.canonical_jsonb(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.analysis_retrieval_summary(uuid,uuid[],uuid[],jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.analysis_candidate_pair_page(uuid,uuid[],uuid[],uuid,uuid,integer)
  from public, anon, authenticated, service_role;
revoke all on function private.lock_analysis_chunk_versions()
  from public, anon, authenticated, service_role;
grant execute on function private.analysis_retrieval_summary(uuid,uuid[],uuid[],jsonb)
  to service_role;
grant execute on function private.analysis_candidate_pair_page(uuid,uuid[],uuid[],uuid,uuid,integer)
  to service_role;

notify pgrst, 'reload schema';
