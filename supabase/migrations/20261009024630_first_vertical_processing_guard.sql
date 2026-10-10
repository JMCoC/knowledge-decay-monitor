-- Preserve the processing RPC contract while fencing stale and late workers.
create or replace function public.finish_processing(
  p_version_id uuid,
  p_operation_id uuid,
  p_chunks jsonb
) returns void
language plpgsql
security definer
set search_path = ''
set statement_timeout = '2s'
set lock_timeout = '1s'
as $$
declare
  v_version public.document_versions%ROWTYPE;
begin
  select * into v_version
    from public.document_versions
   where id = p_version_id
   for update;

  if not found then
    raise exception 'Version not found' using errcode = '22023';
  end if;
  if v_version.processing_status <> 'processing' then
    raise exception 'Version is not processing' using errcode = '22023';
  end if;
  if v_version.upload_state is distinct from 'confirmed' then
    raise exception 'Upload is not confirmed' using errcode = '22023';
  end if;
  if v_version.processing_operation_id is distinct from p_operation_id then
    raise exception 'Stale processing operation' using errcode = '22023';
  end if;
  if v_version.processing_started_at is null
     or clock_timestamp() >= v_version.processing_started_at + interval '50 seconds' then
    raise exception 'Processing deadline exceeded' using errcode = '22023';
  end if;
  if v_version.version_number <> 1 then
    raise exception 'Only v1 auto-activates' using errcode = '22023';
  end if;
  if v_version.version_status is not null then
    raise exception 'Version already decided' using errcode = '22023';
  end if;
  if p_chunks is null or jsonb_typeof(p_chunks) <> 'array'
     or jsonb_array_length(p_chunks) = 0 then
    raise exception 'Empty chunk set' using errcode = '22023';
  end if;
  if jsonb_array_length(p_chunks) > 500 then
    raise exception 'Chunk limit exceeded' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_chunks) as c(text_content text)
     where nullif(btrim(c.text_content), '') is null
  ) then
    raise exception 'Empty chunk text' using errcode = '22023';
  end if;

  insert into public.document_chunks
    (workspace_id, version_id, chunk_index, text_content,
     page_number, section_heading, embedding)
  select v_version.workspace_id,
         v_version.id,
         (c.chunk_index)::integer,
         nullif(btrim(c.text_content), ''),
         (c.page_number)::integer,
         nullif(btrim(c.section_heading), ''),
         (c.embedding)::extensions.vector(384)
    from jsonb_to_recordset(p_chunks) as c(
      chunk_index integer,
      text_content text,
      page_number integer,
      section_heading text,
      embedding text
    );

  if clock_timestamp() >= v_version.processing_started_at + interval '50 seconds' then
    raise exception 'Processing deadline exceeded' using errcode = '22023';
  end if;

  update public.document_versions
     set processing_status = 'ready',
         version_status = 'active',
         processing_operation_id = null,
         processing_started_at = null
   where id = p_version_id;

  update public.documents
     set active_version_id = p_version_id
   where id = v_version.document_id;

  if clock_timestamp() >= v_version.processing_started_at + interval '50 seconds' then
    raise exception 'Processing deadline exceeded' using errcode = '22023';
  end if;
-- The deferrable check_active_version trigger validates
-- ready + active + pointer coherence at commit.
end;
$$;

revoke all on function public.finish_processing(uuid,uuid,jsonb)
  from public, anon, authenticated;
grant execute on function public.finish_processing(uuid,uuid,jsonb)
  to service_role;

create or replace view public.repository_documents
with (security_invoker = true)
as
select
  d.id,
  d.workspace_id,
  d.name,
  d.category,
  d.owner_id,
  p.id as owner_profile_id,
  p.full_name as owner_full_name,
  d.active_version_id,
  d.created_at,
  latest.id as latest_version_id,
  latest.version_number as latest_version_number,
  latest.processing_status as latest_processing_status,
  latest.version_status as latest_version_status,
  latest.analysis_status as latest_analysis_status,
  latest.upload_state as latest_upload_state,
  latest.processing_started_at as latest_processing_started_at
from public.documents d
left join public.profiles p
  on p.id = d.owner_id and p.workspace_id = d.workspace_id
left join lateral (
  select v.id, v.version_number, v.processing_status,
    v.version_status, v.analysis_status, v.upload_state,
    v.processing_started_at
  from public.document_versions v
  where v.document_id = d.id and v.workspace_id = d.workspace_id
  order by v.version_number desc, v.id desc
  limit 1
) latest on true;

revoke all on public.repository_documents from public, anon, authenticated;
grant select on public.repository_documents to authenticated;
comment on view public.repository_documents is
  'Tenant-scoped Repository projection; lateral query selects latest version before application filters.';

notify pgrst, 'reload schema';
