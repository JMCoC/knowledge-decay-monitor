-- S2-04 retrieval + estimation: analysis_estimates, HNSW, retrieve_candidate_pairs.
-- Contract (source of truth): docs/contracts/S2-04-retrieval-estimation.md §§4-5.
-- Table + indexes verbatim §4.1-4.2; RLS + GRANTs verbatim §4.3;
-- RPC verbatim §5.1-5.2 (security invoker, session RLS, no service_role).

create table public.analysis_estimates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  initiator_id uuid not null,
  -- coalesce porque array_length('{}', 1) devuelve NULL y NULL >= 1
  -- no es falso: sin coalesce, '{}' pasaría el CHECK.
  source_version_ids uuid[] not null check (coalesce(array_length(source_version_ids, 1), 0) >= 1),
  comparison_version_ids uuid[] not null,
  request_fingerprint text not null check (char_length(btrim(request_fingerprint)) > 0),
  retrieval_config jsonb not null check (jsonb_typeof(retrieval_config) = 'object'),
  chunk_count integer not null check (chunk_count >= 0),
  candidate_pair_count integer not null check (candidate_pair_count >= 0),
  fixed_cost integer not null check (fixed_cost >= 1),
  pricing_version text not null check (char_length(btrim(pricing_version)) > 0),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (initiator_id, workspace_id) references public.profiles(id, workspace_id)
);

create index analysis_estimates_workspace_created_idx
  on public.analysis_estimates (workspace_id, created_at desc);

create index analysis_estimates_expires_idx
  on public.analysis_estimates (expires_at);

create index document_chunks_embedding_hnsw
  on public.document_chunks
  using hnsw (embedding extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 64);

alter table public.analysis_estimates enable row level security;

create policy estimates_select on public.analysis_estimates for select to authenticated
using (
  workspace_id = (select private.current_workspace_id())
  and (select private.current_workspace_role()) in ('Admin', 'QA Lead')
);

create policy estimates_insert on public.analysis_estimates for insert to authenticated
with check (
  workspace_id = (select private.current_workspace_id())
  and (select private.current_workspace_role()) in ('Admin', 'QA Lead')
  and initiator_id = (select auth.uid())
);

revoke all on public.analysis_estimates from public, anon, authenticated, service_role;
grant select, insert on public.analysis_estimates to authenticated;

-- Bounded semantic retrieval: per source chunk, same-version (internal) plus
-- comparison-version (external) candidates above threshold, Top-K each,
-- canonicalized to one row per unordered pair. Read-only; never writes.
create function public.retrieve_candidate_pairs(
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
    r.sim desc;
$$;

revoke all on function public.retrieve_candidate_pairs(uuid,uuid[],uuid[],integer,double precision)
  from public, anon, authenticated, service_role;
-- Derived grant (spec §6, team confirms in review): with security invoker and
-- a session client, authenticated needs EXECUTE or the call fails with 42501.
grant execute on function public.retrieve_candidate_pairs(uuid,uuid[],uuid[],integer,double precision)
  to authenticated;
