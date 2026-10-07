alter table public.document_versions
  add column processing_operation_id uuid,
  add column processing_started_at timestamptz;

-- Style follows S1-03 §6: qualified references, search_path = '',
-- explicit errcodes, service_role only.
create function public.finish_processing(
  p_version_id uuid,
  p_operation_id uuid,
  p_chunks jsonb
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version public.document_versions%ROWTYPE;
begin
  select * into v_version
    from public.document_versions
   where id = p_version_id;

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

  update public.document_versions
     set processing_status = 'ready',
         version_status = 'active',
         processing_operation_id = null,
         processing_started_at = null
   where id = p_version_id;

  update public.documents
     set active_version_id = p_version_id
   where id = v_version.document_id;
-- The deferrable check_active_version trigger validates
-- ready + active + pointer coherence at commit.
end;
$$;

revoke all on function public.finish_processing(uuid,uuid,jsonb)
  from public, anon, authenticated;
grant execute on function public.finish_processing(uuid,uuid,jsonb)
  to service_role;
