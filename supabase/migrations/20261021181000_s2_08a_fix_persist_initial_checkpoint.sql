-- S2-08a fix: a fresh analysis starts with checkpoint = NULL.
-- persist_analysis_batch must treat that as processedPairs = 0, matching the
-- S2-06 yield_analysis_batch cursor semantics. Without this, the first batch
-- of every new analysis returns false and the worker aborts without staging.
-- This is a corrective migration; the original 8a-3 file stays immutable.
create or replace function public.persist_analysis_batch(
  p_analysis_id uuid,
  p_operation_id uuid,
  p_expected_processed_pairs integer,
  p_checkpoint jsonb,
  p_findings jsonb,
  p_has_more boolean
) returns boolean
language plpgsql security definer set search_path = ''
-- 5s ceiling: a persist takes ~100ms in normal load; a 5s timeout
-- is a bug signal, not normal contention. If the worker hits 55P03,
-- the S2-06 backoff (30s/2min) retries safely.
set lock_timeout = '5s' set statement_timeout = '5s' as $$
declare
  v_workspace_id uuid;
  v public.analyses%rowtype;
  ts timestamptz;
  v_finding jsonb;
  v_evidence jsonb;
  v_evidence_norm jsonb;
  v_version_ids jsonb;
  v_payload text;
  v_fingerprint text;
  v_type text;
  v_severity text;
  v_snapshot text;
  v_confidence numeric;
  v_page_number numeric;
  v_finding_ordinal integer;
  v_evidence_ordinal integer;
  v_source_count integer;
  v_comparison_count integer;
  v_new_processed numeric;
  v_total_pairs numeric;
  v_findings_count numeric;
  v_old_processed integer := 0;
  v_old_total integer := null;
  v_old_findings integer := 0;
begin
  -- Step 1: arguments, checkpoint cursor and finding shape (22023).
  if p_analysis_id is null
     or p_operation_id is null
     or p_expected_processed_pairs is null
     or p_expected_processed_pairs < 0
     or p_has_more is null
     or pg_catalog.jsonb_typeof(p_checkpoint) is distinct from 'object'
     or pg_catalog.jsonb_typeof(p_findings) is distinct from 'array' then
    raise exception 'Invalid persist arguments' using errcode = '22023';
  end if;

  if coalesce(p_checkpoint ->> 'processedPairs', '') !~ '^(0|[1-9][0-9]*)$'
     or coalesce(p_checkpoint ->> 'totalPairs', '') !~ '^(0|[1-9][0-9]*)$'
     or coalesce(p_checkpoint ->> 'findingsCount', '0') !~ '^(0|[1-9][0-9]*)$' then
    raise exception 'Invalid checkpoint cursor' using errcode = '22023';
  end if;

  v_new_processed := (p_checkpoint ->> 'processedPairs')::numeric;
  v_total_pairs := (p_checkpoint ->> 'totalPairs')::numeric;
  v_findings_count := coalesce((p_checkpoint ->> 'findingsCount')::numeric, 0);
  if v_new_processed > 2147483647
     or v_total_pairs > 2147483647
     or v_findings_count > 2147483647 then
    raise exception 'Invalid checkpoint cursor' using errcode = '22023';
  end if;
  if v_new_processed <= p_expected_processed_pairs
     or v_new_processed > v_total_pairs then
    raise exception 'A persisted batch must advance the cursor' using errcode = '22023';
  end if;

  for v_finding_ordinal in 0 .. pg_catalog.jsonb_array_length(p_findings) - 1 loop
    v_finding := p_findings -> v_finding_ordinal;
    if pg_catalog.jsonb_typeof(v_finding) is distinct from 'object' then
      raise exception 'Invalid finding shape' using errcode = '22023';
    end if;

    v_type := v_finding ->> 'type';
    if v_type is null or v_type not in ('contradiction', 'obsolescence') then
      raise exception 'Invalid finding type' using errcode = '22023';
    end if;
    v_severity := v_finding ->> 'severity';
    if v_severity is null or v_severity not in ('High', 'Medium', 'Low') then
      raise exception 'Invalid finding severity' using errcode = '22023';
    end if;

    if pg_catalog.jsonb_typeof(v_finding -> 'confidence') is distinct from 'number' then
      raise exception 'Invalid finding confidence' using errcode = '22023';
    end if;
    v_confidence := (v_finding ->> 'confidence')::numeric;
    if v_confidence < 0 or v_confidence > 1 then
      raise exception 'Invalid finding confidence' using errcode = '22023';
    end if;

    if pg_catalog.jsonb_typeof(v_finding -> 'explanation') is distinct from 'string'
       or pg_catalog.char_length(pg_catalog.btrim(v_finding ->> 'explanation')) = 0 then
      raise exception 'Invalid finding explanation' using errcode = '22023';
    end if;

    if pg_catalog.jsonb_typeof(v_finding -> 'evidence') is distinct from 'array'
       or pg_catalog.jsonb_array_length(v_finding -> 'evidence') <> 2 then
      raise exception 'Invalid finding evidence' using errcode = '22023';
    end if;

    v_source_count := 0;
    v_comparison_count := 0;
    for v_evidence_ordinal in 0 .. 1 loop
      v_evidence := v_finding -> 'evidence' -> v_evidence_ordinal;
      if pg_catalog.jsonb_typeof(v_evidence) is distinct from 'object' then
        raise exception 'Invalid evidence shape' using errcode = '22023';
      end if;

      if v_evidence ->> 'role' = 'source' then
        v_source_count := v_source_count + 1;
      elsif v_evidence ->> 'role' = 'comparison' then
        v_comparison_count := v_comparison_count + 1;
      else
        raise exception 'Invalid evidence role' using errcode = '22023';
      end if;

      if pg_catalog.jsonb_typeof(v_evidence -> 'documentId') is distinct from 'string'
         or (v_evidence ->> 'documentId') !~*
           '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         or pg_catalog.jsonb_typeof(v_evidence -> 'versionId') is distinct from 'string'
         or (v_evidence ->> 'versionId') !~*
           '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         or pg_catalog.jsonb_typeof(v_evidence -> 'chunkId') is distinct from 'string'
         or (v_evidence ->> 'chunkId') !~*
           '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'Invalid evidence identifiers' using errcode = '22023';
      end if;

      if pg_catalog.jsonb_typeof(v_evidence -> 'snapshot') is distinct from 'string' then
        raise exception 'Invalid evidence snapshot' using errcode = '22023';
      end if;
      v_snapshot := v_evidence ->> 'snapshot';
      if pg_catalog.char_length(v_snapshot) < 1
         or pg_catalog.char_length(v_snapshot) > 2000
         or pg_catalog.char_length(pg_catalog.btrim(v_snapshot)) = 0 then
        raise exception 'Invalid evidence snapshot' using errcode = '22023';
      end if;

      if pg_catalog.jsonb_exists(v_evidence, 'pageNumber')
         and pg_catalog.jsonb_typeof(v_evidence -> 'pageNumber') <> 'null' then
        if pg_catalog.jsonb_typeof(v_evidence -> 'pageNumber') <> 'number' then
          raise exception 'Invalid evidence page number' using errcode = '22023';
        end if;
        v_page_number := (v_evidence ->> 'pageNumber')::numeric;
        if v_page_number <> pg_catalog.trunc(v_page_number)
           or v_page_number < 1
           or v_page_number > 2147483647 then
          raise exception 'Invalid evidence page number' using errcode = '22023';
        end if;
      end if;

      if pg_catalog.jsonb_exists(v_evidence, 'section')
         and pg_catalog.jsonb_typeof(v_evidence -> 'section') not in ('null', 'string') then
        raise exception 'Invalid evidence section' using errcode = '22023';
      end if;
      if pg_catalog.jsonb_exists(v_evidence, 'sectionHeading')
         and pg_catalog.jsonb_typeof(v_evidence -> 'sectionHeading') not in ('null', 'string') then
        raise exception 'Invalid evidence section heading' using errcode = '22023';
      end if;
    end loop;

    if v_source_count <> 1 or v_comparison_count <> 1 then
      raise exception 'Invalid evidence sides' using errcode = '22023';
    end if;
  end loop;

  -- Step 2: workspace advisory before the row lock. The workspace is immutable.
  select a.workspace_id into v_workspace_id
  from public.analyses a where a.id = p_analysis_id;
  if v_workspace_id is null then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_workspace_id::text, 0)
  );

  -- Step 3: lock the analysis and fence status/operation/lease/deadlines/cursor.
  ts := pg_catalog.clock_timestamp();
  select * into v from public.analyses a where a.id = p_analysis_id for update;
  if not found
     or v.status <> 'processing'
     or v.operation_id is distinct from p_operation_id
     or v.lease_expires_at is null or v.lease_expires_at <= ts
     or v.attempt_deadline_at is null or v.attempt_deadline_at <= ts
     or v.analysis_deadline_at is null or v.analysis_deadline_at <= ts then
    return false;
  end if;

  if v.checkpoint ? 'processedPairs'
     and (v.checkpoint ->> 'processedPairs') ~ '^(0|[1-9][0-9]*)$' then
    v_old_processed := (v.checkpoint ->> 'processedPairs')::integer;
  end if;
  if v_old_processed is distinct from p_expected_processed_pairs then
    return false;
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

  -- Steps 4-5: recompute each fingerprint, validate scope and stage first-wins.
  for v_finding_ordinal in 0 .. pg_catalog.jsonb_array_length(p_findings) - 1 loop
    v_finding := p_findings -> v_finding_ordinal;
    v_type := v_finding ->> 'type';

    select pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'versionId', s.version_id,
               'chunkId', s.chunk_id,
               'snapshot', s.snapshot
             )
             order by s.version_id collate "C",
                      s.chunk_id collate "C",
                      s.snapshot collate "C"
           )
    into v_evidence_norm
    from (
      select e.ord ->> 'versionId' as version_id,
             e.ord ->> 'chunkId' as chunk_id,
             pg_catalog.btrim(
               pg_catalog.regexp_replace(
                 pg_catalog.normalize(e.ord ->> 'snapshot', 'NFC'),
                 E'[ \t\n\r\f\v]+',
                 ' ',
                 'g'
               ),
               E' \t\n\r\f\v'
             ) as snapshot
      from pg_catalog.jsonb_array_elements(v_finding -> 'evidence') as e(ord)
    ) s;

    select pg_catalog.jsonb_agg(vid order by vid collate "C")
    into v_version_ids
    from (
      select distinct e.ord ->> 'versionId' as vid
      from pg_catalog.jsonb_array_elements(v_finding -> 'evidence') as e(ord)
    ) s;

    v_payload := private.canonical_jsonb(
      pg_catalog.jsonb_build_object(
        'type', v_type,
        'versionIds', v_version_ids,
        'evidence', v_evidence_norm
      )
    );
    v_fingerprint := pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(v_payload, 'UTF8')),
      'hex'
    );

    for v_evidence_ordinal in 0 .. 1 loop
      v_evidence := v_finding -> 'evidence' -> v_evidence_ordinal;
      if not exists (
        select 1 from public.analysis_documents ad
        where ad.analysis_id = p_analysis_id
          and ad.workspace_id = v.workspace_id
          and ad.document_id = (v_evidence ->> 'documentId')::uuid
          and ad.version_id = (v_evidence ->> 'versionId')::uuid
          and ad.role = (v_evidence ->> 'role')::public.analysis_scope_role
      ) or not exists (
        select 1 from public.document_chunks dc
        where dc.id = (v_evidence ->> 'chunkId')::uuid
          and dc.version_id = (v_evidence ->> 'versionId')::uuid
          and dc.workspace_id = v.workspace_id
      ) then
        raise exception 'Evidence is outside the analysis scope' using errcode = 'P0001';
      end if;
    end loop;

    insert into private.analysis_finding_staging(
      analysis_id, workspace_id, operation_id, batch_index, finding_ordinal,
      type, severity, confidence, explanation, fingerprint
    ) values (
      p_analysis_id, v.workspace_id, p_operation_id,
      p_expected_processed_pairs, v_finding_ordinal,
      v_type::public.finding_type,
      (v_finding ->> 'severity')::public.finding_severity,
      (v_finding ->> 'confidence')::double precision,
      v_finding ->> 'explanation',
      v_fingerprint
    )
    on conflict (analysis_id, fingerprint) do nothing;

    for v_evidence_ordinal in 0 .. 1 loop
      v_evidence := v_finding -> 'evidence' -> v_evidence_ordinal;
      insert into private.analysis_finding_evidence_staging(
        analysis_id, workspace_id, operation_id, batch_index, finding_ordinal,
        fingerprint, evidence_ordinal, role, document_id, version_id, chunk_id,
        page_number, section, section_heading, snapshot
      ) values (
        p_analysis_id, v.workspace_id, p_operation_id,
        p_expected_processed_pairs, v_finding_ordinal,
        v_fingerprint, v_evidence_ordinal,
        (v_evidence ->> 'role')::public.analysis_scope_role,
        (v_evidence ->> 'documentId')::uuid,
        (v_evidence ->> 'versionId')::uuid,
        (v_evidence ->> 'chunkId')::uuid,
        case when pg_catalog.jsonb_typeof(v_evidence -> 'pageNumber') = 'number'
             then pg_catalog.trunc(
                    (v_evidence ->> 'pageNumber')::numeric
                  )::integer
             else null end,
        v_evidence ->> 'section',
        v_evidence ->> 'sectionHeading',
        v_evidence ->> 'snapshot'
      )
      on conflict (analysis_id, fingerprint, evidence_ordinal) do nothing;
    end loop;
  end loop;

  -- Step 6: inline status/lease update. Never call yield/renew here.
  if p_has_more then
    update public.analyses
       set status = 'queued', continuation_pending = true,
           operation_id = null, lease_expires_at = null,
           next_attempt_at = null, checkpoint = p_checkpoint, updated_at = ts
     where id = p_analysis_id;
  else
    update public.analyses
       set lease_expires_at = least(
             pg_catalog.clock_timestamp() + interval '180 seconds',
             started_at + interval '30 minutes'
           ),
           checkpoint = p_checkpoint, updated_at = pg_catalog.clock_timestamp()
     where id = p_analysis_id;
  end if;

  return true;
end;
$$;

revoke all on function public.persist_analysis_batch(
  uuid, uuid, integer, jsonb, jsonb, boolean
) from public, anon, authenticated;
grant execute on function public.persist_analysis_batch(
  uuid, uuid, integer, jsonb, jsonb, boolean
) to service_role;
