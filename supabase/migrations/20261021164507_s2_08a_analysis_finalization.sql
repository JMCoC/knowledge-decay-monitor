-- S2-08a analysis finalization — part 1 of 3 (8a-1).
-- Durable staging for findings/evidence plus the terminal cleanup safety trigger.
-- Spec: docs/superpowers/specs/2026-10-21-s2-08-analysis-finalization-spec.md §5.1, §5.4.

-- Staging por análisis (no por intento): la unicidad es por fingerprint, de modo
-- que un reintento que repita el hallazgo no lo reescribe (first-wins entre intentos).
create table private.analysis_finding_staging (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null,
  workspace_id uuid not null,
  operation_id uuid not null,
  batch_index integer not null check (batch_index >= 0),
  finding_ordinal integer not null check (finding_ordinal >= 0),
  type public.finding_type not null,
  severity public.finding_severity not null,
  confidence double precision not null check (confidence >= 0 and confidence <= 1),
  explanation text not null check (char_length(btrim(explanation)) > 0),
  fingerprint text not null check (char_length(btrim(fingerprint)) > 0),
  created_at timestamptz not null default now(),
  unique (analysis_id, fingerprint)
);

-- Evidencia asociada por ordinal de finding; snapshot máximo 2.000 caracteres.
create table private.analysis_finding_evidence_staging (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null,
  workspace_id uuid not null,
  operation_id uuid not null,
  batch_index integer not null,
  finding_ordinal integer not null,
  fingerprint text not null check (char_length(btrim(fingerprint)) > 0),
  evidence_ordinal integer not null check (evidence_ordinal >= 0),
  role public.analysis_scope_role not null,
  document_id uuid not null,
  version_id uuid not null,
  chunk_id uuid not null,
  page_number integer check (page_number > 0),
  section text,
  section_heading text,
  snapshot text not null check (
    char_length(snapshot) between 1 and 2000 and char_length(btrim(snapshot)) > 0
  ),
  created_at timestamptz not null default now(),
  unique (analysis_id, fingerprint, evidence_ordinal)
);

alter table private.analysis_finding_staging enable row level security;
alter table private.analysis_finding_evidence_staging enable row level security;
revoke all on table private.analysis_finding_staging,
  private.analysis_finding_evidence_staging
  from public, anon, authenticated, service_role;

-- Safety-net cleanup: whenever an analysis reaches a terminal status by any path
-- other than the finalize/fail helpers, drop all of its staging rows. The cleanup
-- is always by analysis_id (a retry shares the analysis' staging, P2).
create function private.cleanup_analysis_finding_staging()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  delete from private.analysis_finding_staging s
  where s.analysis_id = new.id;
  delete from private.analysis_finding_evidence_staging e
  where e.analysis_id = new.id;
  return new;
end;
$$;

create trigger analyses_finding_staging_terminal_cleanup
after update of status on public.analyses
for each row
when (
  old.status is distinct from new.status
  and new.status in ('completed'::public.analysis_job_status, 'failed'::public.analysis_job_status)
)
execute function private.cleanup_analysis_finding_staging();

revoke all on function private.cleanup_analysis_finding_staging()
  from public, anon, authenticated, service_role;

comment on column public.document_versions.analysis_status is
  'Owned by S2-08: only pending_reanalysis → analyzed for source versions of a completed analysis.';

-- S2-08a analysis finalization — part 2 of 3 (8a-3).
-- Atomic persist of one bounded worker batch: validate shape, fence the
-- operation, recompute the fingerprint in SQL, enforce evidence scope, stage
-- findings/evidence and advance the checkpoint in a single transaction.
-- The legacy yield/renew RPCs are intentionally not reused: both re-CAS the
-- expected cursor and would reject a batch this RPC already validated.
create function public.persist_analysis_batch(
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
  v_old_processed integer := null;
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

-- S2-08a analysis finalization — part 3 of 3 (8a-4).
-- Atomic success close: publish findings/evidence, settle the reservation,
-- emit analysis_completed, mark source versions analyzed and delete staging.
-- complete_analysis is intentionally untouched; its revocation is S2-08b.
-- Spec: docs/superpowers/specs/2026-10-21-s2-08-analysis-finalization-spec.md §6.1-§6.5.
create function public.finalize_analysis_success(
  p_analysis_id uuid,
  p_operation_id uuid,
  p_reported_findings_count integer
) returns void
language plpgsql security definer set search_path = ''
-- 5s ceiling: a close takes ~100ms in normal load; a 5s timeout
-- is a bug signal, not normal contention. If the worker hits 55P03,
-- the S2-06 backoff (30s/2min) retries safely.
set lock_timeout = '5s' set statement_timeout = '5s' as $$
declare
  v_workspace_id uuid;
  v public.analyses%rowtype;
  v_staging_count integer;
  ts timestamptz;
begin
  -- Step 1: argument validation.
  if p_analysis_id is null
     or p_operation_id is null
     or p_reported_findings_count is null
     or p_reported_findings_count < 0 then
    raise exception 'Invalid finalize arguments' using errcode = '22023';
  end if;

  -- Step 2: read the immutable workspace without a lock, then take the
  -- per-workspace advisory lock before any row lock (same order as persist).
  select a.workspace_id into v_workspace_id
  from public.analyses a
  where a.id = p_analysis_id;
  if v_workspace_id is null then
    raise exception 'Stale analysis operation' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_workspace_id::text, 0)
  );

  -- Step 3: lock workspace then analysis, in that order.
  perform 1
  from public.workspaces w
  where w.id = v_workspace_id
  for update;
  if not found then
    raise exception 'Stale analysis operation' using errcode = '22023';
  end if;

  select * into v
  from public.analyses a
  where a.id = p_analysis_id
  for update;
  if not found then
    raise exception 'Stale analysis operation' using errcode = '22023';
  end if;

  ts := pg_catalog.clock_timestamp();

  -- Step 4: idempotent replay of the same successful operation is a silent
  -- no-op. It must not re-consume credits or re-emit the event.
  if v.status = 'completed' and v.operation_id = p_operation_id then
    return;
  end if;

  -- Step 5: fencing. Any terminal-but-not-completed state, different token,
  -- or expired lease/deadline is superseded (22023, no retry).
  if v.status <> 'processing'
     or v.operation_id is distinct from p_operation_id
     or v.lease_expires_at is null or v.lease_expires_at <= ts
     or v.attempt_deadline_at is null or v.attempt_deadline_at <= ts
     or v.analysis_deadline_at is null or v.analysis_deadline_at <= ts then
    raise exception 'Stale analysis operation' using errcode = '22023';
  end if;

  -- Step 6: P3 invariant. The worker reported findings but nothing was
  -- staged, which means the evidence was not persisted. A smaller staging
  -- count is legitimate dedup (first-wins by fingerprint) and is allowed.
  select pg_catalog.count(*) into v_staging_count
  from private.analysis_finding_staging s
  where s.analysis_id = p_analysis_id;
  if v_staging_count = 0 and p_reported_findings_count > 0 then
    raise exception 'Reported findings without staged rows' using errcode = 'P0001';
  end if;

  -- Step 7: publish findings first-wins, then only the evidence that belongs
  -- to the findings actually inserted. The staging unique key already
  -- deduplicates by (analysis_id, fingerprint); the ON CONFLICT is defense
  -- in depth. Tenant/scope FKs are enforced by finding_evidence.
  with inserted as (
    insert into public.findings(
      workspace_id, analysis_id, type, severity_original, severity_current,
      confidence, explanation, status, assignee_id, fingerprint
    )
    select s.workspace_id, s.analysis_id, s.type, s.severity, s.severity,
           s.confidence, s.explanation, 'pending_review', null, s.fingerprint
    from private.analysis_finding_staging s
    where s.analysis_id = p_analysis_id
    order by s.batch_index, s.finding_ordinal
    on conflict (analysis_id, fingerprint) do nothing
    returning id, fingerprint
  )
  insert into public.finding_evidence(
    workspace_id, analysis_id, finding_id, document_id, version_id, chunk_id,
    page_number, section, section_heading, snapshot
  )
  select e.workspace_id, e.analysis_id, i.id, e.document_id, e.version_id,
         e.chunk_id, e.page_number, e.section, e.section_heading, e.snapshot
  from inserted i
  join private.analysis_finding_evidence_staging e
    on e.analysis_id = p_analysis_id
   and e.fingerprint = i.fingerprint
  order by e.fingerprint, e.evidence_ordinal;

  -- Step 8: mark completed, preserving operation_id for idempotent replay.
  -- The AFTER UPDATE OF status trigger from 8a-1 fires here and deletes all
  -- staging for this analysis. The DELETEs in step 11 are idempotent no-ops
  -- kept for defense in depth.
  update public.analyses
     set status = 'completed', finished_at = ts, updated_at = ts
   where id = p_analysis_id;

  -- Step 9: consume the reservation now that the analysis is completed.
  perform private.settle_analysis_credits(
    p_analysis_id, v.fixed_cost, 'Consumed'
  );

  -- Step 10: notify the initiator exactly once, including zero-finding closes.
  insert into public.notification_events(
    workspace_id, analysis_id, type, recipient_id
  ) values (
    v_workspace_id, p_analysis_id, 'analysis_completed', v.initiator_id
  )
  on conflict (analysis_id, type, recipient_id) do nothing;

  -- Step 11: only source versions of this analysis move pending -> analyzed.
  -- Comparison roles and already analyzed versions are untouched.
  update public.document_versions dv
     set analysis_status = 'analyzed', updated_at = ts
   where dv.workspace_id = v_workspace_id
     and dv.analysis_status = 'pending_reanalysis'
     and dv.id in (
       select ad.version_id
       from public.analysis_documents ad
       where ad.analysis_id = p_analysis_id
         and ad.workspace_id = v_workspace_id
         and ad.role = 'source'
     );

  -- The trigger already deleted both staging tables in step 8; these are
  -- intentional idempotent no-ops (cleanup is by analysis_id, not operation_id).
  delete from private.analysis_finding_evidence_staging e
  where e.analysis_id = p_analysis_id;
  delete from private.analysis_finding_staging s
  where s.analysis_id = p_analysis_id;
end;
$$;

comment on function public.finalize_analysis_success(uuid, uuid, integer) is
  'Atomic S2-08 success close: publish findings/evidence, settle Consumed, notify, mark source versions analyzed and delete staging.';

revoke all on function public.finalize_analysis_success(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.finalize_analysis_success(uuid, uuid, integer)
  to service_role;

notify pgrst, 'reload schema';
