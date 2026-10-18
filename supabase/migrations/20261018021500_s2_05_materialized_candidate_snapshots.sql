-- S2-05: materialize each run's candidate pair IDs once, then page those IDs.
-- Chunk text remains in document_chunks and is read only for the requested page.

create table private.analysis_candidate_pair_snapshots (
  analysis_id uuid not null,
  workspace_id uuid not null,
  source_version_ids uuid[] not null,
  comparison_version_ids uuid[] not null,
  execution_manifest jsonb not null,
  chunk_count integer,
  candidate_pair_count integer,
  chunks_revision text,
  request_fingerprint text,
  fixed_cost integer,
  is_complete boolean not null default false,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (analysis_id, workspace_id),
  foreign key (analysis_id, workspace_id)
    references public.analyses (id, workspace_id) on delete cascade,
  check (
    not is_complete
    or (
      chunk_count is not null and chunk_count >= 0
      and candidate_pair_count is not null and candidate_pair_count >= 0
      and chunks_revision is not null
      and chunks_revision ~ '^[0-9a-f]{64}$'
      and request_fingerprint is not null
      and request_fingerprint ~ '^[0-9a-f]{64}$'
      and fixed_cost is not null and fixed_cost >= 0
    )
  ),
  check (
    is_complete
    or (
      chunk_count is null
      and candidate_pair_count is null
      and chunks_revision is null
      and request_fingerprint is null
      and fixed_cost is null
    )
  )
);

create table private.analysis_candidate_pair_rows (
  analysis_id uuid not null,
  workspace_id uuid not null,
  pair_low_id uuid not null,
  pair_high_id uuid not null,
  source_chunk_id uuid not null,
  comparison_chunk_id uuid not null,
  similarity double precision not null,
  primary key (analysis_id, workspace_id, pair_low_id, pair_high_id),
  foreign key (analysis_id, workspace_id)
    references private.analysis_candidate_pair_snapshots (analysis_id, workspace_id)
    on delete cascade,
  check (pair_low_id < pair_high_id),
  check (pair_low_id = least(source_chunk_id, comparison_chunk_id)),
  check (pair_high_id = greatest(source_chunk_id, comparison_chunk_id))
);

comment on table private.analysis_candidate_pair_snapshots is
  'Worker-only candidate ID snapshot and retrieval summary for one analysis attempt family.';
comment on table private.analysis_candidate_pair_rows is
  'Worker-only candidate chunk IDs; document text is joined from document_chunks per bounded page.';

create function private.analysis_retrieval_summary_for_run(
  p_analysis_id uuid,
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
  v_snapshot private.analysis_candidate_pair_snapshots%rowtype;
  v_has_snapshot boolean := false;
begin
  if p_analysis_id is null or p_workspace_id is null
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

  -- Serialize first materialization and later cache reads for this analysis.
  perform pg_catalog.pg_advisory_xact_lock(
    26061502, pg_catalog.hashtext(p_analysis_id::text)
  );

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
  if not exists (
    select 1 from public.analyses a
    where a.id = p_analysis_id and a.workspace_id = p_workspace_id
  ) then
    raise exception using errcode = '22023', message = 'Analysis workspace is stale.';
  end if;

  -- finish_processing locks the version before it writes chunks or activates it.
  -- Acquiring the same rows in UUID order makes this summary a stable boundary.
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
  v_chunks_revision := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(pg_catalog.array_to_string(v_chunk_ids, ','), 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  select * into v_snapshot
  from private.analysis_candidate_pair_snapshots s
  where s.analysis_id = p_analysis_id and s.workspace_id = p_workspace_id
  for update;
  v_has_snapshot := found;

  if v_has_snapshot and v_snapshot.is_complete then
    if v_snapshot.source_version_ids is distinct from v_source_ids
      or v_snapshot.comparison_version_ids is distinct from v_comparison_ids
      or v_snapshot.execution_manifest is distinct from p_manifest
      or v_snapshot.chunk_count is distinct from v_chunk_count
      or v_snapshot.chunks_revision is distinct from v_chunks_revision
      or v_snapshot.request_fingerprint !~ '^[0-9a-f]{64}$'
      or v_snapshot.candidate_pair_count < 0
    then
      raise exception using errcode = '22023', message = 'Analysis snapshot is stale.';
    end if;
    v_fixed_cost := (100 + 5 * v_chunk_count + 20 * v_snapshot.candidate_pair_count + 99) / 100;
    if v_snapshot.fixed_cost is distinct from v_fixed_cost then
      raise exception using errcode = '22023', message = 'Analysis snapshot is stale.';
    end if;
    return query select v_snapshot.chunk_count, v_snapshot.candidate_pair_count,
      v_snapshot.chunks_revision, v_snapshot.request_fingerprint, v_snapshot.fixed_cost;
    return;
  end if;

  -- A committed incomplete header is never expected; remove it defensively so
  -- a retry can rebuild an atomic, complete snapshot.
  if v_has_snapshot then
    delete from private.analysis_candidate_pair_snapshots s
    where s.analysis_id = p_analysis_id and s.workspace_id = p_workspace_id;
  end if;
  insert into private.analysis_candidate_pair_snapshots (
    analysis_id, workspace_id, source_version_ids,
    comparison_version_ids, execution_manifest
  ) values (
    p_analysis_id, p_workspace_id, v_source_ids,
    v_comparison_ids, p_manifest
  );

  -- Retrieval runs once. Its IDs are inserted and its canonical pair hashes
  -- are aggregated from the same materialized CTE in this transaction.
  with candidate_pairs as materialized (
    select
      r.source_chunk_id,
      r.comparison_chunk_id,
      r.similarity,
      least(r.source_chunk_id, r.comparison_chunk_id) as pair_low_id,
      greatest(r.source_chunk_id, r.comparison_chunk_id) as pair_high_id
    from public.retrieve_candidate_pairs(
      p_workspace_id, v_source_ids, v_comparison_ids, 5, 0.75
    ) r
  ),
  inserted_pairs as (
    insert into private.analysis_candidate_pair_rows (
      analysis_id, workspace_id, pair_low_id, pair_high_id,
      source_chunk_id, comparison_chunk_id, similarity
    )
    select
      p_analysis_id, p_workspace_id, p.pair_low_id, p.pair_high_id,
      p.source_chunk_id, p.comparison_chunk_id, p.similarity
    from candidate_pairs p
    returning source_chunk_id, comparison_chunk_id
  )
  select
    pg_catalog.count(*)::integer,
    coalesce(
      pg_catalog.array_agg(
        pg_catalog.encode(
          extensions.digest(
            pg_catalog.convert_to(source_chunk_id::text || '|' || comparison_chunk_id::text, 'UTF8'),
            'sha256'
          ),
          'hex'
        ) order by source_chunk_id, comparison_chunk_id
      ),
      '{}'::text[]
    )
  into v_pair_count, v_pair_hashes
  from inserted_pairs;

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

  update private.analysis_candidate_pair_snapshots s
  set chunk_count = v_chunk_count,
      candidate_pair_count = v_pair_count,
      chunks_revision = v_chunks_revision,
      request_fingerprint = v_request_fingerprint,
      fixed_cost = v_fixed_cost,
      is_complete = true
  where s.analysis_id = p_analysis_id and s.workspace_id = p_workspace_id;

  return query select
    v_chunk_count, v_pair_count, v_chunks_revision,
    v_request_fingerprint, v_fixed_cost;
end;
$$;

create function private.analysis_candidate_pair_snapshot_page(
  p_analysis_id uuid,
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
  v_workspace_id uuid;
begin
  if p_analysis_id is null or p_limit is null or p_limit not between 1 and 10
    or ((p_after_low is null) is distinct from (p_after_high is null))
  then
    raise exception using errcode = '22023', message = 'Invalid candidate pair page request.';
  end if;

  select s.workspace_id into v_workspace_id
  from private.analysis_candidate_pair_snapshots s
  where s.analysis_id = p_analysis_id and s.is_complete;
  if not found then
    raise exception using errcode = 'P2102', message = 'Analysis candidate snapshot is unavailable.';
  end if;

  return query
  select
    source_chunk.id,
    source_version.id,
    source_version.document_id,
    source_chunk.text_content,
    comparison_chunk.id,
    comparison_version.id,
    comparison_version.document_id,
    comparison_chunk.text_content,
    pair.similarity,
    pair.pair_low_id,
    pair.pair_high_id
  from private.analysis_candidate_pair_rows pair
  join public.document_chunks source_chunk
    on source_chunk.id = pair.source_chunk_id
   and source_chunk.workspace_id = pair.workspace_id
  join public.document_versions source_version
    on source_version.id = source_chunk.version_id
   and source_version.workspace_id = source_chunk.workspace_id
  join public.document_chunks comparison_chunk
    on comparison_chunk.id = pair.comparison_chunk_id
   and comparison_chunk.workspace_id = pair.workspace_id
  join public.document_versions comparison_version
    on comparison_version.id = comparison_chunk.version_id
   and comparison_version.workspace_id = comparison_chunk.workspace_id
  where pair.analysis_id = p_analysis_id
    and pair.workspace_id = v_workspace_id
    and (
      p_after_low is null
      or (pair.pair_low_id, pair.pair_high_id) > (p_after_low, p_after_high)
    )
  order by pair.pair_low_id, pair.pair_high_id
  limit p_limit;
end;
$$;

create or replace function public.read_analysis_retrieval_summary(
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
    from private.analysis_retrieval_summary_for_run(
      v.id, v.workspace_id, v_source_ids, v_comparison_ids, e.execution_manifest
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

create or replace function public.read_analysis_pair_batch(
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
  from private.analysis_candidate_pair_snapshot_page(
    v.id, p_after_low, p_after_high, p_limit
  ) page;
  if v.lease_expires_at <= clock_timestamp()
     or v.attempt_deadline_at <= clock_timestamp()
     or v.analysis_deadline_at <= clock_timestamp() then
    raise exception 'Stale analysis operation' using errcode = '22023';
  end if;
end;
$$;

create function private.cleanup_analysis_candidate_pair_snapshot()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if old.status is distinct from new.status
    and new.status in ('completed'::public.analysis_job_status, 'failed'::public.analysis_job_status)
  then
    delete from private.analysis_candidate_pair_snapshots s
    where s.analysis_id = new.id and s.workspace_id = new.workspace_id;
  end if;
  return new;
end;
$$;

create trigger analyses_candidate_snapshot_terminal_cleanup
after update of status on public.analyses
for each row
when (
  old.status is distinct from new.status
  and new.status in ('completed'::public.analysis_job_status, 'failed'::public.analysis_job_status)
)
execute function private.cleanup_analysis_candidate_pair_snapshot();

revoke all on table private.analysis_candidate_pair_snapshots,
  private.analysis_candidate_pair_rows
  from public, anon, authenticated, service_role;
revoke all on function private.analysis_retrieval_summary_for_run(uuid,uuid,uuid[],uuid[],jsonb),
  private.analysis_candidate_pair_snapshot_page(uuid,uuid,uuid,integer),
  private.cleanup_analysis_candidate_pair_snapshot()
  from public, anon, authenticated, service_role;
grant execute on function private.analysis_retrieval_summary_for_run(uuid,uuid,uuid[],uuid[],jsonb),
  private.analysis_candidate_pair_snapshot_page(uuid,uuid,uuid,integer)
  to service_role;

notify pgrst, 'reload schema';
