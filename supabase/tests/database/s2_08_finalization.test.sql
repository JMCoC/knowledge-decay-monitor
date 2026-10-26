begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
\ir analysis-fixtures.psql
select no_plan();

-- Finalization fixtures: 4 versions. Versions 1, 2 and 4 are sources; version 3
-- is comparison-only so a source-status update cannot accidentally touch it.
create temporary table finalize_ops(
  name text primary key,
  analysis_id uuid not null,
  operation_id uuid not null,
  workspace_id uuid not null,
  initiator_id uuid not null
) on commit drop;

create function pg_temp.finalize_fixture(
  p_name text,
  p_version_count integer default 4,
  p_comparison_ordinal integer default 3
) returns uuid
language plpgsql
set search_path = pg_temp, public
as $$
declare
  v_analysis uuid;
  v_op uuid;
  v_workspace uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  v_initiator uuid := '10000000-0000-4000-8000-000000000001';
  v_case pg_temp.analysis_case%rowtype;
begin
  v_analysis := pg_temp.create_analysis_fixture(
    v_workspace, v_initiator, 'queued', p_version_count);

  select * into v_case
  from pg_temp.analysis_case
  where analysis_id = v_analysis and ordinal = p_comparison_ordinal;
  if v_case.analysis_id is null then
    raise exception 'comparison ordinal out of range';
  end if;

  delete from public.analysis_documents
  where analysis_id = v_analysis
    and version_id = v_case.version_id
    and role = 'source';
  insert into public.analysis_documents(
    analysis_id, workspace_id, document_id, version_id, role)
  values (
    v_analysis, v_workspace, v_case.document_id, v_case.version_id, 'comparison');
  perform pg_temp.force_analysis_checks();

  insert into public.credit_ledger(workspace_id, event_type, amount, analysis_id)
  values (v_workspace, 'Reserved', 3, v_analysis);

  select c.operation_id into v_op
  from public.claim_analysis(v_analysis) c;
  if v_op is null then
    raise exception 'finalize fixture claim failed';
  end if;

  update public.analyses
     set checkpoint = '{"processedPairs":0,"totalPairs":10,"findingsCount":0}'::jsonb
   where id = v_analysis;

  insert into pg_temp.finalize_ops(
    name, analysis_id, operation_id, workspace_id, initiator_id)
  values (p_name, v_analysis, v_op, v_workspace, v_initiator);
  insert into pg_temp.analysis_fixture_ids(name, analysis_id)
  values (p_name, v_analysis);

  return v_analysis;
end;
$$;

create function pg_temp.finalize_finding(
  p_analysis_name text,
  p_type text,
  p_severity text,
  p_source_snapshot text,
  p_comparison_snapshot text,
  p_explanation text default 'Synthetic finalization finding',
  p_confidence double precision default 0.8,
  p_source_scope text default null,
  p_source_ordinal integer default 1,
  p_comparison_scope text default null,
  p_comparison_ordinal integer default 3
) returns jsonb
language sql stable
set search_path = pg_temp, public
as $$
  select jsonb_build_object(
    'type', p_type,
    'severity', p_severity,
    'confidence', p_confidence,
    'explanation', p_explanation,
    'evidence', jsonb_build_array(
      (select jsonb_build_object(
        'documentId', c.document_id,
        'versionId', c.version_id,
        'chunkId', c.chunk_id,
        'role', 'source',
        'snapshot', p_source_snapshot,
        'pageNumber', null,
        'section', null,
        'sectionHeading', null)
       from pg_temp.analysis_case c
       where c.analysis_id = pg_temp.analysis_fixture_id(coalesce(p_source_scope, p_analysis_name))
         and c.ordinal = p_source_ordinal),
      (select jsonb_build_object(
        'documentId', c.document_id,
        'versionId', c.version_id,
        'chunkId', c.chunk_id,
        'role', 'comparison',
        'snapshot', p_comparison_snapshot,
        'pageNumber', null,
        'section', null,
        'sectionHeading', null)
       from pg_temp.analysis_case c
       where c.analysis_id = pg_temp.analysis_fixture_id(coalesce(p_comparison_scope, p_analysis_name))
         and c.ordinal = p_comparison_ordinal)
    )
  )
$$;

create function pg_temp.finalize_completed_fixture(
  p_name text,
  p_version_count integer default 4
) returns uuid
language plpgsql
set search_path = pg_temp, public
as $$
declare
  v_analysis uuid;
begin
  v_analysis := pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '10000000-0000-4000-8000-000000000001',
    'completed', p_version_count);
  insert into pg_temp.analysis_fixture_ids(name, analysis_id)
  values (p_name, v_analysis);
  return v_analysis;
end;
$$;

create function pg_temp.finalize_op(p_name text)
returns uuid
language sql stable
set search_path = pg_temp, public
as $$
  select operation_id from pg_temp.finalize_ops where name = p_name
$$;

create function pg_temp.stage_finalize(
  p_name text,
  p_expected_processed integer,
  p_processed integer,
  p_total integer,
  p_findings_count integer,
  p_findings jsonb,
  p_has_more boolean default false
) returns boolean
language sql
set search_path = pg_temp, public
as $$
  select public.persist_analysis_batch(
    pg_temp.analysis_fixture_id(p_name),
    pg_temp.finalize_op(p_name),
    p_expected_processed,
    jsonb_build_object(
      'processedPairs', p_processed,
      'totalPairs', p_total,
      'findingsCount', p_findings_count),
    p_findings,
    p_has_more)
$$;

create function pg_temp.rotate_finalize_operation(p_name text)
returns uuid
language plpgsql
set search_path = pg_temp, public
as $$
declare
  v_op uuid := gen_random_uuid();
begin
  update public.analyses
     set operation_id = v_op
   where id = pg_temp.analysis_fixture_id(p_name);
  update pg_temp.finalize_ops set operation_id = v_op where name = p_name;
  return v_op;
end;
$$;

create function pg_temp.close_finalize_fixture(p_name text)
returns void
language sql
set search_path = pg_temp, public
as $$
  update public.analyses
     set status = 'failed', error_code = 'INTERNAL_ERROR'
   where id = pg_temp.analysis_fixture_id(p_name)
$$;

create function pg_temp.fixture_version_status(
  p_name text,
  p_ordinal integer
) returns text
language sql stable
set search_path = pg_temp, public
as $$
  select dv.analysis_status::text
  from public.document_versions dv
  join pg_temp.analysis_case c
    on c.analysis_id = pg_temp.analysis_fixture_id(p_name)
   and c.ordinal = p_ordinal
   and c.version_id = dv.id
$$;

-- RED GATE: this first close must fail with "function ... does not exist"
-- before finalize_analysis_success is implemented.
select pg_temp.finalize_fixture('fin_success', 4, 3);
update public.document_versions
   set analysis_status = 'analyzed'
 where id = (
   select version_id
   from pg_temp.analysis_case
   where analysis_id = pg_temp.analysis_fixture_id('fin_success')
     and ordinal = 4
 );
select is(pg_temp.stage_finalize('fin_success', 0, 5, 10, 2,
    jsonb_build_array(
      pg_temp.finalize_finding('fin_success', 'contradiction', 'High',
        'source one', 'comparison one', 'explanation one', 0.9, null, 1, null, 3),
      pg_temp.finalize_finding('fin_success', 'obsolescence', 'Low',
        'source two', 'comparison two', 'explanation two', 0.4, null, 1, null, 3)
    )),
  true, 'Two findings stage atomically');
select public.finalize_analysis_success(
  pg_temp.analysis_fixture_id('fin_success'),
  pg_temp.finalize_op('fin_success'),
  2);

-- Success: completed with findings, evidence, Consumed, event and source status.
select is((select status::text from public.analyses
    where id = pg_temp.analysis_fixture_id('fin_success')),
  'completed', 'A successful close marks the analysis completed');
select is((select operation_id from public.analyses
    where id = pg_temp.analysis_fixture_id('fin_success')),
  pg_temp.finalize_op('fin_success'),
  'The completed analysis preserves its operation_id for idempotent replay');
select is((select finished_at is not null from public.analyses
    where id = pg_temp.analysis_fixture_id('fin_success')),
  true, 'A successful close sets finished_at');
select is((select count(*)::int from private.analysis_finding_staging
    where analysis_id = pg_temp.analysis_fixture_id('fin_success')),
  0, 'All finding staging is deleted');
select is((select count(*)::int from private.analysis_finding_evidence_staging
    where analysis_id = pg_temp.analysis_fixture_id('fin_success')),
  0, 'All evidence staging is deleted');
select is((select count(*)::int from public.findings
    where analysis_id = pg_temp.analysis_fixture_id('fin_success')),
  2, 'Both findings are published');
select is((select count(*)::int from public.finding_evidence
    where analysis_id = pg_temp.analysis_fixture_id('fin_success')),
  4, 'Both evidence rows per finding are published');
select is((select count(*)::int from public.findings
    where analysis_id = pg_temp.analysis_fixture_id('fin_success')
      and status = 'pending_review'
      and assignee_id is null
      and severity_original = severity_current),
  2, 'Published findings keep their initial state and severity snapshot');
select is((select string_agg(event_type::text, ',' order by event_type)
    from public.credit_ledger
    where analysis_id = pg_temp.analysis_fixture_id('fin_success')),
  'Reserved,Consumed', 'The ledger is Reserved followed by Consumed');
select is((select count(*)::int from public.credit_ledger
    where analysis_id = pg_temp.analysis_fixture_id('fin_success')),
  2, 'The ledger has exactly two rows');
select is((select amount from public.credit_ledger
    where analysis_id = pg_temp.analysis_fixture_id('fin_success')
      and event_type = 'Consumed'),
  3, 'The Consumed row consumes the fixed cost');
select is((select count(*)::int from public.notification_events
    where analysis_id = pg_temp.analysis_fixture_id('fin_success')
      and type = 'analysis_completed'),
  1, 'Exactly one analysis_completed event is emitted');
select is((select recipient_id from public.notification_events
    where analysis_id = pg_temp.analysis_fixture_id('fin_success')
      and type = 'analysis_completed'),
  (select initiator_id from pg_temp.finalize_ops where name = 'fin_success'),
  'The event is addressed to the analysis initiator');
select is(pg_temp.fixture_version_status('fin_success', 1), 'analyzed',
  'Source version 1 moves pending_reanalysis -> analyzed');
select is(pg_temp.fixture_version_status('fin_success', 2), 'analyzed',
  'A source version without evidence also moves to analyzed');
select is(pg_temp.fixture_version_status('fin_success', 3), 'pending_reanalysis',
  'The comparison version is untouched');
select is(pg_temp.fixture_version_status('fin_success', 4), 'analyzed',
  'An already analyzed source stays analyzed');

-- Idempotency: repeating the same operation is a silent no-op.
select lives_ok(
  format('select public.finalize_analysis_success(%L, %L, %s)',
    pg_temp.analysis_fixture_id('fin_success'),
    pg_temp.finalize_op('fin_success'), 2),
  'Replaying the same operation succeeds silently');
select is((select count(*)::int from public.findings
    where analysis_id = pg_temp.analysis_fixture_id('fin_success')),
  2, 'Replay does not duplicate findings');
select is((select count(*)::int from public.finding_evidence
    where analysis_id = pg_temp.analysis_fixture_id('fin_success')),
  4, 'Replay does not duplicate evidence');
select is((select count(*)::int from public.credit_ledger
    where analysis_id = pg_temp.analysis_fixture_id('fin_success')),
  2, 'Replay does not consume credits again');
select is((select string_agg(event_type::text, ',' order by event_type)
    from public.credit_ledger
    where analysis_id = pg_temp.analysis_fixture_id('fin_success')),
  'Reserved,Consumed', 'Replay leaves the ledger unchanged');
select is((select count(*)::int from public.notification_events
    where analysis_id = pg_temp.analysis_fixture_id('fin_success')
      and type = 'analysis_completed'),
  1, 'Replay does not duplicate the event');
select is((select count(*)::int from private.analysis_finding_staging
    where analysis_id = pg_temp.analysis_fixture_id('fin_success')),
  0, 'Replay leaves staging empty');
select is(pg_temp.fixture_version_status('fin_success', 1), 'analyzed',
  'Replay leaves source status idempotent');
select is(pg_temp.fixture_version_status('fin_success', 3), 'pending_reanalysis',
  'Replay leaves comparison status idempotent');

-- Zero findings, reported zero, empty staging: still completed, consumed and notified.
select pg_temp.finalize_fixture('fin_zero', 4, 3);
select is(pg_temp.stage_finalize('fin_zero', 0, 10, 10, 0, '[]'::jsonb),
  true, 'An empty final batch stages nothing');
select public.finalize_analysis_success(
  pg_temp.analysis_fixture_id('fin_zero'),
  pg_temp.finalize_op('fin_zero'),
  0);
select is((select status::text from public.analyses
    where id = pg_temp.analysis_fixture_id('fin_zero')),
  'completed', 'Zero findings still completes the analysis');
select is((select count(*)::int from public.findings
    where analysis_id = pg_temp.analysis_fixture_id('fin_zero')),
  0, 'Zero findings publishes no findings');
select is((select count(*)::int from public.finding_evidence
    where analysis_id = pg_temp.analysis_fixture_id('fin_zero')),
  0, 'Zero findings publishes no evidence');
select is((select string_agg(event_type::text, ',' order by event_type)
    from public.credit_ledger
    where analysis_id = pg_temp.analysis_fixture_id('fin_zero')),
  'Reserved,Consumed', 'Zero findings still consumes the reservation');
select is((select count(*)::int from public.notification_events
    where analysis_id = pg_temp.analysis_fixture_id('fin_zero')
      and type = 'analysis_completed'),
  1, 'Zero findings still emits analysis_completed');
select is(pg_temp.fixture_version_status('fin_zero', 1), 'analyzed',
  'Zero findings still marks source version 1 analyzed');
select is(pg_temp.fixture_version_status('fin_zero', 2), 'analyzed',
  'Zero findings still marks source version 2 analyzed');
select is(pg_temp.fixture_version_status('fin_zero', 3), 'pending_reanalysis',
  'Zero findings leaves the comparison version untouched');
select is(pg_temp.fixture_version_status('fin_zero', 4), 'analyzed',
  'Zero findings marks every source version analyzed');
select is((select count(*)::int from private.analysis_finding_staging
    where analysis_id = pg_temp.analysis_fixture_id('fin_zero')),
  0, 'Zero findings leaves no staging');

-- P3: the worker reported findings but staging is empty -> P0001, nothing committed.
select pg_temp.finalize_fixture('fin_p0001', 4, 3);
select throws_ok(
  format('select public.finalize_analysis_success(%L, %L, %s)',
    pg_temp.analysis_fixture_id('fin_p0001'),
    pg_temp.finalize_op('fin_p0001'), 1),
  'P0001', null,
  'Reported findings with empty staging fail with P0001');
select is((select status::text from public.analyses
    where id = pg_temp.analysis_fixture_id('fin_p0001')),
  'processing', 'P0001 leaves the analysis processing');
select is((select count(*)::int from public.findings
    where analysis_id = pg_temp.analysis_fixture_id('fin_p0001')),
  0, 'P0001 publishes no findings');
select is((select count(*)::int from public.credit_ledger
    where analysis_id = pg_temp.analysis_fixture_id('fin_p0001')),
  1, 'P0001 leaves only the Reserved ledger row');
select is((select count(*)::int from public.notification_events
    where analysis_id = pg_temp.analysis_fixture_id('fin_p0001')),
  0, 'P0001 emits no event');
select pg_temp.close_finalize_fixture('fin_p0001');

-- P3: staging_count < reported is legitimate dedup, not an error.
select pg_temp.finalize_fixture('fin_dedup', 4, 3);
select is(pg_temp.stage_finalize('fin_dedup', 0, 5, 10, 1,
    jsonb_build_array(
      pg_temp.finalize_finding('fin_dedup', 'contradiction', 'Medium',
        'source one', 'comparison one')
    )),
  true, 'One finding stages while the worker reports two');
select lives_ok(
  format('select public.finalize_analysis_success(%L, %L, %s)',
    pg_temp.analysis_fixture_id('fin_dedup'),
    pg_temp.finalize_op('fin_dedup'), 2),
  'staging_count < reported is legitimate dedup');
select is((select status::text from public.analyses
    where id = pg_temp.analysis_fixture_id('fin_dedup')),
  'completed', 'Dedup still completes the analysis');
select is((select count(*)::int from public.findings
    where analysis_id = pg_temp.analysis_fixture_id('fin_dedup')),
  1, 'Dedup publishes the single staged finding');
select is((select count(*)::int from public.finding_evidence
    where analysis_id = pg_temp.analysis_fixture_id('fin_dedup')),
  2, 'Dedup publishes its two evidence rows');
select is((select string_agg(event_type::text, ',' order by event_type)
    from public.credit_ledger
    where analysis_id = pg_temp.analysis_fixture_id('fin_dedup')),
  'Reserved,Consumed', 'Dedup consumes the reservation');
select is((select count(*)::int from public.notification_events
    where analysis_id = pg_temp.analysis_fixture_id('fin_dedup')
      and type = 'analysis_completed'),
  1, 'Dedup emits one analysis_completed event');

-- Settle precondition: a missing reservation rolls back the whole close.
select pg_temp.finalize_fixture('fin_settle_fail', 4, 3);
delete from public.credit_ledger
 where analysis_id = pg_temp.analysis_fixture_id('fin_settle_fail')
   and event_type = 'Reserved';
select is(pg_temp.stage_finalize('fin_settle_fail', 0, 5, 10, 1,
    jsonb_build_array(
      pg_temp.finalize_finding('fin_settle_fail', 'contradiction', 'Medium',
        'source one', 'comparison one')
    )),
  true, 'A finding stages before the failing settlement');
select throws_ok(
  format('select public.finalize_analysis_success(%L, %L, %s)',
    pg_temp.analysis_fixture_id('fin_settle_fail'),
    pg_temp.finalize_op('fin_settle_fail'), 1),
  'P2002', null,
  'A missing reservation fails the settlement and rolls back');
select is((select status::text from public.analyses
    where id = pg_temp.analysis_fixture_id('fin_settle_fail')),
  'processing', 'Settlement failure leaves the analysis processing');
select is((select count(*)::int from private.analysis_finding_staging
    where analysis_id = pg_temp.analysis_fixture_id('fin_settle_fail')),
  1, 'Settlement failure restores the staged finding');
select is((select count(*)::int from public.findings
    where analysis_id = pg_temp.analysis_fixture_id('fin_settle_fail')),
  0, 'Settlement failure publishes no findings');
select is((select count(*)::int from public.credit_ledger
    where analysis_id = pg_temp.analysis_fixture_id('fin_settle_fail')),
  0, 'Settlement failure leaves no ledger rows');
select is((select count(*)::int from public.notification_events
    where analysis_id = pg_temp.analysis_fixture_id('fin_settle_fail')),
  0, 'Settlement failure emits no event');
select is(pg_temp.fixture_version_status('fin_settle_fail', 1),
  'pending_reanalysis', 'Settlement failure rolls back source status');
select pg_temp.close_finalize_fixture('fin_settle_fail');

-- Fencing: operation mismatch -> 22023, no changes.
select pg_temp.finalize_fixture('fin_superseded_op', 4, 3);
select is(pg_temp.stage_finalize('fin_superseded_op', 0, 5, 10, 1,
    jsonb_build_array(
      pg_temp.finalize_finding('fin_superseded_op', 'contradiction', 'Medium',
        'source one', 'comparison one')
    )),
  true, 'A finding stages before the operation mismatch');
select throws_ok(
  format('select public.finalize_analysis_success(%L, %L, %s)',
    pg_temp.analysis_fixture_id('fin_superseded_op'),
    gen_random_uuid(), 1),
  '22023', null,
  'A different operation token is superseded');
select is((select status::text from public.analyses
    where id = pg_temp.analysis_fixture_id('fin_superseded_op')),
  'processing', 'Operation mismatch leaves the analysis processing');
select is((select count(*)::int from private.analysis_finding_staging
    where analysis_id = pg_temp.analysis_fixture_id('fin_superseded_op')),
  1, 'Operation mismatch leaves staging untouched');
select is((select count(*)::int from public.findings
    where analysis_id = pg_temp.analysis_fixture_id('fin_superseded_op')),
  0, 'Operation mismatch publishes no findings');
select is((select count(*)::int from public.credit_ledger
    where analysis_id = pg_temp.analysis_fixture_id('fin_superseded_op')),
  1, 'Operation mismatch leaves only Reserved');
select is((select count(*)::int from public.notification_events
    where analysis_id = pg_temp.analysis_fixture_id('fin_superseded_op')),
  0, 'Operation mismatch emits no event');
select pg_temp.close_finalize_fixture('fin_superseded_op');

-- Fencing: expired lease -> 22023, no changes.
select pg_temp.finalize_fixture('fin_superseded_lease', 4, 3);
select is(pg_temp.stage_finalize('fin_superseded_lease', 0, 5, 10, 1,
    jsonb_build_array(
      pg_temp.finalize_finding('fin_superseded_lease', 'contradiction', 'Medium',
        'source one', 'comparison one')
    )),
  true, 'A finding stages before the expired lease');
update public.analyses
   set lease_expires_at = clock_timestamp() - interval '1 second'
 where id = pg_temp.analysis_fixture_id('fin_superseded_lease');
select throws_ok(
  format('select public.finalize_analysis_success(%L, %L, %s)',
    pg_temp.analysis_fixture_id('fin_superseded_lease'),
    pg_temp.finalize_op('fin_superseded_lease'), 1),
  '22023', null,
  'An expired lease is superseded');
select is((select status::text from public.analyses
    where id = pg_temp.analysis_fixture_id('fin_superseded_lease')),
  'processing', 'Expired lease leaves the analysis processing');
select is((select count(*)::int from private.analysis_finding_staging
    where analysis_id = pg_temp.analysis_fixture_id('fin_superseded_lease')),
  1, 'Expired lease leaves staging untouched');
select is((select count(*)::int from public.findings
    where analysis_id = pg_temp.analysis_fixture_id('fin_superseded_lease')),
  0, 'Expired lease publishes no findings');
select is((select count(*)::int from public.credit_ledger
    where analysis_id = pg_temp.analysis_fixture_id('fin_superseded_lease')),
  1, 'Expired lease leaves only Reserved');
select is((select count(*)::int from public.notification_events
    where analysis_id = pg_temp.analysis_fixture_id('fin_superseded_lease')),
  0, 'Expired lease emits no event');
select pg_temp.close_finalize_fixture('fin_superseded_lease');

-- Fencing: a completed analysis with a different token -> 22023, no changes.
select pg_temp.finalize_completed_fixture('fin_superseded_status', 4);
select throws_ok(
  format('select public.finalize_analysis_success(%L, %L, %s)',
    pg_temp.analysis_fixture_id('fin_superseded_status'),
    gen_random_uuid(), 0),
  '22023', null,
  'A non-processing analysis is superseded');
select is((select status::text from public.analyses
    where id = pg_temp.analysis_fixture_id('fin_superseded_status')),
  'completed', 'Non-processing status is unchanged');
select is((select count(*)::int from public.credit_ledger
    where analysis_id = pg_temp.analysis_fixture_id('fin_superseded_status')),
  0, 'Non-processing status has no ledger rows');
select is((select count(*)::int from public.notification_events
    where analysis_id = pg_temp.analysis_fixture_id('fin_superseded_status')),
  0, 'Non-processing status emits no event');
select is((select count(*)::int from public.findings
    where analysis_id = pg_temp.analysis_fixture_id('fin_superseded_status')),
  0, 'Non-processing status publishes no findings');
select is(pg_temp.fixture_version_status('fin_superseded_status', 1),
  'pending_reanalysis', 'Non-processing status leaves source status untouched');

-- Cleanup is by analysis_id: staging from a previous operation_id is also removed.
select pg_temp.finalize_fixture('fin_cleanup_ops', 4, 3);
select is(pg_temp.stage_finalize('fin_cleanup_ops', 0, 5, 10, 1,
    jsonb_build_array(
      pg_temp.finalize_finding('fin_cleanup_ops', 'contradiction', 'High',
        'source one', 'comparison one')
    )),
  true, 'The first operation stages a finding');
select pg_temp.rotate_finalize_operation('fin_cleanup_ops');
select is(pg_temp.stage_finalize('fin_cleanup_ops', 5, 10, 10, 2,
    jsonb_build_array(
      pg_temp.finalize_finding('fin_cleanup_ops', 'obsolescence', 'Low',
        'source two', 'comparison two')
    )),
  true, 'A second operation stages another finding');
select public.finalize_analysis_success(
  pg_temp.analysis_fixture_id('fin_cleanup_ops'),
  pg_temp.finalize_op('fin_cleanup_ops'),
  2);
select is((select status::text from public.analyses
    where id = pg_temp.analysis_fixture_id('fin_cleanup_ops')),
  'completed', 'The second operation closes the shared analysis');
select is((select count(*)::int from public.findings
    where analysis_id = pg_temp.analysis_fixture_id('fin_cleanup_ops')),
  2, 'Findings staged by both operations are published');
select is((select count(*)::int from public.finding_evidence
    where analysis_id = pg_temp.analysis_fixture_id('fin_cleanup_ops')),
  4, 'Evidence staged by both operations is published');
select is((select count(*)::int from private.analysis_finding_staging
    where analysis_id = pg_temp.analysis_fixture_id('fin_cleanup_ops')),
  0, 'Findings from both operation_ids are deleted');
select is((select count(*)::int from private.analysis_finding_evidence_staging
    where analysis_id = pg_temp.analysis_fixture_id('fin_cleanup_ops')),
  0, 'Evidence from both operation_ids is deleted');
select is((select count(*)::int from public.credit_ledger
    where analysis_id = pg_temp.analysis_fixture_id('fin_cleanup_ops')),
  2, 'The shared analysis is settled exactly once');
select is((select count(*)::int from public.notification_events
    where analysis_id = pg_temp.analysis_fixture_id('fin_cleanup_ops')
      and type = 'analysis_completed'),
  1, 'The shared analysis emits one event');

-- Trigger integration: a direct terminal transition wipes staging without
-- publishing, settling or notifying.
select pg_temp.finalize_fixture('fin_trigger', 4, 3);
select is(pg_temp.stage_finalize('fin_trigger', 0, 5, 10, 1,
    jsonb_build_array(
      pg_temp.finalize_finding('fin_trigger', 'contradiction', 'Medium',
        'source one', 'comparison one')
    )),
  true, 'A finding stages before the direct terminal update');
select is((select count(*)::int from private.analysis_finding_staging
    where analysis_id = pg_temp.analysis_fixture_id('fin_trigger')),
  1, 'Staging exists before the direct terminal update');
update public.analyses
   set status = 'completed'
 where id = pg_temp.analysis_fixture_id('fin_trigger');
select is((select count(*)::int from private.analysis_finding_staging
    where analysis_id = pg_temp.analysis_fixture_id('fin_trigger')),
  0, 'The safety trigger deletes finding staging on a direct completed update');
select is((select count(*)::int from private.analysis_finding_evidence_staging
    where analysis_id = pg_temp.analysis_fixture_id('fin_trigger')),
  0, 'The safety trigger deletes evidence staging on a direct completed update');
select is((select count(*)::int from public.findings
    where analysis_id = pg_temp.analysis_fixture_id('fin_trigger')),
  0, 'The safety trigger does not publish findings');
select is((select count(*)::int from public.credit_ledger
    where analysis_id = pg_temp.analysis_fixture_id('fin_trigger')),
  1, 'The safety trigger does not settle credits');
select is((select count(*)::int from public.notification_events
    where analysis_id = pg_temp.analysis_fixture_id('fin_trigger')),
  0, 'The safety trigger does not emit events');

-- Signature and grants. complete_analysis is intentionally untouched in 8a;
-- its revocation belongs to S2-08b (spec §1, plan §35).
select has_function('public', 'finalize_analysis_success',
  array['uuid', 'uuid', 'integer'],
  'finalize_analysis_success has the specified signature');
select ok(has_function_privilege('service_role',
    'public.finalize_analysis_success(uuid,uuid,integer)', 'EXECUTE'),
  'service_role can execute finalize_analysis_success');
select ok(not has_function_privilege('anon',
    'public.finalize_analysis_success(uuid,uuid,integer)', 'EXECUTE'),
  'anon cannot execute finalize_analysis_success');
select ok(not has_function_privilege('authenticated',
    'public.finalize_analysis_success(uuid,uuid,integer)', 'EXECUTE'),
  'authenticated cannot execute finalize_analysis_success');
select ok(not has_function_privilege('public',
    'public.finalize_analysis_success(uuid,uuid,integer)', 'EXECUTE'),
  'PUBLIC cannot execute finalize_analysis_success');
select has_function('public', 'complete_analysis',
  array['uuid', 'uuid'],
  'complete_analysis remains available; its revocation is S2-08b');
select ok(has_function_privilege('service_role',
    'public.complete_analysis(uuid,uuid)', 'EXECUTE'),
  'service_role retains execute on complete_analysis');

select * from finish();
rollback;
