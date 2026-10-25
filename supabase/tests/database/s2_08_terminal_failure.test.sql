begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
\ir analysis-fixtures.psql
select no_plan();

-- Direct coverage for private.finalize_failed_analysis (S2-08b, 8b-6) and
-- claim_analysis terminal wiring (8b-7). fail_analysis remains 8b-8.
create function pg_temp.terminal_fixture(
  p_name text,
  p_status public.analysis_job_status,
  p_operation_id uuid
) returns uuid
language plpgsql
set search_path = pg_temp, public
as $fn$
declare
  v_analysis uuid;
begin
  v_analysis := pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '10000000-0000-4000-8000-000000000001',
    p_status,
    1
  );

  update public.analyses
     set operation_id = p_operation_id,
         lease_expires_at = case
           when p_status = 'processing' then clock_timestamp() + interval '60 seconds'
           else null
         end,
         attempt_deadline_at = case
           when p_status = 'processing' then clock_timestamp() + interval '30 minutes'
           else null
         end,
         analysis_deadline_at = case
           when p_status in ('processing', 'queued') then clock_timestamp() + interval '90 minutes'
           else null
         end,
         next_attempt_at = null,
         continuation_pending = false,
         finished_at = case
           when p_status in ('completed', 'failed') then clock_timestamp()
           else null
         end,
         error_code = case
           when p_status = 'failed' then 'INTERNAL_ERROR'::public.analysis_failure_code
           else null
         end
   where id = v_analysis;

  insert into pg_temp.analysis_fixture_ids(name, analysis_id)
  values (p_name, v_analysis);

  return v_analysis;
end;
$fn$;

create function pg_temp.terminal_cleanup(p_analysis_id uuid)
returns void
language plpgsql
set search_path = pg_temp, public
as $fn$
begin
  delete from public.notification_events where analysis_id = p_analysis_id;
  delete from public.credit_ledger where analysis_id = p_analysis_id;
  delete from private.analysis_finding_evidence_staging where analysis_id = p_analysis_id;
  delete from private.analysis_finding_staging where analysis_id = p_analysis_id;
  delete from public.finding_evidence where analysis_id = p_analysis_id;
  delete from public.findings where analysis_id = p_analysis_id;
  delete from public.analysis_documents where analysis_id = p_analysis_id;
  delete from public.analyses where id = p_analysis_id;
  delete from pg_temp.analysis_fixture_ids where analysis_id = p_analysis_id;
end;
$fn$;

create function pg_temp.terminal_reserved(p_analysis_id uuid)
returns void
language plpgsql
set search_path = pg_temp, public
as $fn$
declare
  v_workspace_id uuid;
begin
  select workspace_id into v_workspace_id
  from public.analyses
  where id = p_analysis_id;

  insert into public.credit_ledger(workspace_id, event_type, amount, analysis_id)
  values (v_workspace_id, 'Reserved', 3, p_analysis_id);
end;
$fn$;

create function pg_temp.terminal_event(p_analysis_id uuid)
returns void
language plpgsql
set search_path = pg_temp, public
as $fn$
declare
  v_workspace_id uuid;
  v_initiator_id uuid;
begin
  select workspace_id, initiator_id into v_workspace_id, v_initiator_id
  from public.analyses
  where id = p_analysis_id;

  insert into public.notification_events(workspace_id, analysis_id, type, recipient_id)
  values (v_workspace_id, p_analysis_id, 'analysis_failed', v_initiator_id);
end;
$fn$;

create function pg_temp.terminal_staging(p_analysis_id uuid, p_operation_id uuid)
returns void
language plpgsql
set search_path = pg_temp, public
as $fn$
declare
  v_workspace_id uuid;
  v_fingerprint text := p_analysis_id::text || '-fp';
begin
  select workspace_id into v_workspace_id
  from public.analyses
  where id = p_analysis_id;

  insert into private.analysis_finding_staging(
    analysis_id, workspace_id, operation_id, batch_index, finding_ordinal,
    type, severity, confidence, explanation, fingerprint
  ) values (
    p_analysis_id, v_workspace_id, p_operation_id, 0, 0,
    'contradiction', 'Medium', 0.8, 'Synthetic terminal finding', v_fingerprint
  );

  insert into private.analysis_finding_evidence_staging(
    analysis_id, workspace_id, operation_id, batch_index, finding_ordinal,
    fingerprint, evidence_ordinal, role, document_id, version_id, chunk_id, snapshot
  ) values (
    p_analysis_id, v_workspace_id, p_operation_id, 0, 0,
    v_fingerprint, 0, 'source',
    gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
    'Synthetic terminal evidence'
  );
end;
$fn$;

-- Case A: processing + matching token + live lease + Reserved + staged data.
select pg_temp.terminal_fixture(
  'terminal_a', 'processing', '00000000-0000-4000-8000-00000000000a');
select pg_temp.terminal_reserved(pg_temp.analysis_fixture_id('terminal_a'));
select pg_temp.terminal_staging(
  pg_temp.analysis_fixture_id('terminal_a'),
  '00000000-0000-4000-8000-00000000000a');

select is(
  private.finalize_failed_analysis(
    pg_temp.analysis_fixture_id('terminal_a'),
    '00000000-0000-4000-8000-00000000000a',
    'PROVIDER_UNAVAILABLE'::public.analysis_failure_code,
    true
  ),
  'failed',
  'A: a live matching failure closes the analysis'
);
select is(
  (select status::text from public.analyses where id = pg_temp.analysis_fixture_id('terminal_a')),
  'failed',
  'A: status becomes failed'
);
select is(
  (select error_code::text from public.analyses where id = pg_temp.analysis_fixture_id('terminal_a')),
  'PROVIDER_UNAVAILABLE',
  'A: the reported failure code is preserved'
);
select is(
  (select operation_id from public.analyses where id = pg_temp.analysis_fixture_id('terminal_a')),
  '00000000-0000-4000-8000-00000000000a'::uuid,
  'A: operation_id is preserved as the terminal acknowledgement token'
);
select ok(
  (select finished_at is not null
     and lease_expires_at is null
     and next_attempt_at is null
     and continuation_pending = false
   from public.analyses where id = pg_temp.analysis_fixture_id('terminal_a')),
  'A: finished_at is stamped and lease/backoff/continuation are cleared'
);
select is(
  (select count(*)::integer from public.credit_ledger
   where analysis_id = pg_temp.analysis_fixture_id('terminal_a') and event_type = 'Reserved'),
  1,
  'A: the reservation remains in the ledger'
);
select is(
  (select count(*)::integer from public.credit_ledger
   where analysis_id = pg_temp.analysis_fixture_id('terminal_a') and event_type = 'Released'),
  1,
  'A: the reservation is released exactly once'
);
select is(
  (select count(*)::integer from public.notification_events
   where analysis_id = pg_temp.analysis_fixture_id('terminal_a')
     and type = 'analysis_failed'
     and recipient_id = '10000000-0000-4000-8000-000000000001'),
  1,
  'A: the initiator receives one analysis_failed event'
);
select is(
  (select count(*)::integer from private.analysis_finding_staging
   where analysis_id = pg_temp.analysis_fixture_id('terminal_a')),
  0,
  'A: staged findings are cleaned'
);
select is(
  (select count(*)::integer from private.analysis_finding_evidence_staging
   where analysis_id = pg_temp.analysis_fixture_id('terminal_a')),
  0,
  'A: staged evidence is cleaned'
);
select is(
  (select count(*)::integer from public.findings
   where analysis_id = pg_temp.analysis_fixture_id('terminal_a')),
  0,
  'A: no findings are published for a failed analysis'
);
select is(
  (select dv.analysis_status::text
   from public.document_versions dv
   join pg_temp.analysis_case c on c.version_id = dv.id
   where c.analysis_id = pg_temp.analysis_fixture_id('terminal_a') and c.ordinal = 1),
  'pending_reanalysis',
  'A: document version analysis_status is unchanged'
);
select pg_temp.terminal_cleanup(pg_temp.analysis_fixture_id('terminal_a'));

-- Case B: processing + mismatched token.
select pg_temp.terminal_fixture(
  'terminal_b', 'processing', '00000000-0000-4000-8000-00000000000b');
select is(
  private.finalize_failed_analysis(
    pg_temp.analysis_fixture_id('terminal_b'),
    '00000000-0000-4000-8000-0000000000bb',
    'INTERNAL_ERROR'::public.analysis_failure_code,
    true
  ),
  'superseded',
  'B: a mismatched operation token is superseded'
);
select is(
  (select status::text from public.analyses where id = pg_temp.analysis_fixture_id('terminal_b')),
  'processing',
  'B: status is unchanged'
);
select is(
  (select operation_id from public.analyses where id = pg_temp.analysis_fixture_id('terminal_b')),
  '00000000-0000-4000-8000-00000000000b'::uuid,
  'B: operation_id is unchanged'
);
select is(
  (select count(*)::integer from public.credit_ledger
   where analysis_id = pg_temp.analysis_fixture_id('terminal_b')),
  0,
  'B: no ledger writes'
);
select is(
  (select count(*)::integer from public.notification_events
   where analysis_id = pg_temp.analysis_fixture_id('terminal_b')),
  0,
  'B: no event writes'
);
select pg_temp.terminal_cleanup(pg_temp.analysis_fixture_id('terminal_b'));

-- Case C1: processing + matching token, only the lease expired.
select pg_temp.terminal_fixture(
  'terminal_c1', 'processing', '00000000-0000-4000-8000-0000000000c1');
update public.analyses
   set lease_expires_at = clock_timestamp() - interval '1 second'
 where id = pg_temp.analysis_fixture_id('terminal_c1');
select is(
  private.finalize_failed_analysis(
    pg_temp.analysis_fixture_id('terminal_c1'),
    '00000000-0000-4000-8000-0000000000c1',
    'TIMEOUT'::public.analysis_failure_code,
    true
  ),
  'superseded',
  'C1: only the lease expired → superseded'
);
select is(
  (select status::text from public.analyses where id = pg_temp.analysis_fixture_id('terminal_c1')),
  'processing',
  'C1: status is unchanged'
);
select is(
  (select count(*)::integer from public.credit_ledger
   where analysis_id = pg_temp.analysis_fixture_id('terminal_c1')),
  0,
  'C1: no ledger writes'
);
select is(
  (select count(*)::integer from public.notification_events
   where analysis_id = pg_temp.analysis_fixture_id('terminal_c1')),
  0,
  'C1: no event writes'
);
select pg_temp.terminal_cleanup(pg_temp.analysis_fixture_id('terminal_c1'));

-- Case C2: processing + matching token, only the attempt deadline expired.
select pg_temp.terminal_fixture(
  'terminal_c2', 'processing', '00000000-0000-4000-8000-0000000000c2');
update public.analyses
   set attempt_deadline_at = clock_timestamp() - interval '1 second'
 where id = pg_temp.analysis_fixture_id('terminal_c2');
select is(
  private.finalize_failed_analysis(
    pg_temp.analysis_fixture_id('terminal_c2'),
    '00000000-0000-4000-8000-0000000000c2',
    'TIMEOUT'::public.analysis_failure_code,
    true
  ),
  'superseded',
  'C2: only the attempt deadline expired → superseded'
);
select is(
  (select status::text from public.analyses where id = pg_temp.analysis_fixture_id('terminal_c2')),
  'processing',
  'C2: status is unchanged'
);
select is(
  (select count(*)::integer from public.credit_ledger
   where analysis_id = pg_temp.analysis_fixture_id('terminal_c2')),
  0,
  'C2: no ledger writes'
);
select is(
  (select count(*)::integer from public.notification_events
   where analysis_id = pg_temp.analysis_fixture_id('terminal_c2')),
  0,
  'C2: no event writes'
);
select pg_temp.terminal_cleanup(pg_temp.analysis_fixture_id('terminal_c2'));

-- Case C3: processing + matching token, only the analysis deadline expired.
select pg_temp.terminal_fixture(
  'terminal_c3', 'processing', '00000000-0000-4000-8000-0000000000c3');
update public.analyses
   set analysis_deadline_at = clock_timestamp() - interval '1 second'
 where id = pg_temp.analysis_fixture_id('terminal_c3');
select is(
  private.finalize_failed_analysis(
    pg_temp.analysis_fixture_id('terminal_c3'),
    '00000000-0000-4000-8000-0000000000c3',
    'TIMEOUT'::public.analysis_failure_code,
    true
  ),
  'superseded',
  'C3: only the analysis deadline expired → superseded'
);
select is(
  (select status::text from public.analyses where id = pg_temp.analysis_fixture_id('terminal_c3')),
  'processing',
  'C3: status is unchanged'
);
select is(
  (select count(*)::integer from public.credit_ledger
   where analysis_id = pg_temp.analysis_fixture_id('terminal_c3')),
  0,
  'C3: no ledger writes'
);
select is(
  (select count(*)::integer from public.notification_events
   where analysis_id = pg_temp.analysis_fixture_id('terminal_c3')),
  0,
  'C3: no event writes'
);
select pg_temp.terminal_cleanup(pg_temp.analysis_fixture_id('terminal_c3'));

-- Case D: failed + matching token + Released + event + no staging.
select pg_temp.terminal_fixture(
  'terminal_d', 'failed', '00000000-0000-4000-8000-00000000000d');
select pg_temp.terminal_reserved(pg_temp.analysis_fixture_id('terminal_d'));
insert into public.credit_ledger(workspace_id, event_type, amount, analysis_id)
select workspace_id, 'Released', 3, id
from public.analyses where id = pg_temp.analysis_fixture_id('terminal_d');
select pg_temp.terminal_event(pg_temp.analysis_fixture_id('terminal_d'));
select is(
  private.finalize_failed_analysis(
    pg_temp.analysis_fixture_id('terminal_d'),
    '00000000-0000-4000-8000-00000000000d',
    'INTERNAL_ERROR'::public.analysis_failure_code,
    true
  ),
  'failed',
  'D: a fully settled failed row is an idempotent no-op'
);
select is(
  (select count(*)::integer from public.credit_ledger
   where analysis_id = pg_temp.analysis_fixture_id('terminal_d')),
  2,
  'D: no duplicate ledger rows'
);
select is(
  (select count(*)::integer from public.notification_events
   where analysis_id = pg_temp.analysis_fixture_id('terminal_d')),
  1,
  'D: no duplicate event'
);
select pg_temp.terminal_cleanup(pg_temp.analysis_fixture_id('terminal_d'));

-- Case E: failed + matching token + Released + event + staging.
select pg_temp.terminal_fixture(
  'terminal_e', 'failed', '00000000-0000-4000-8000-00000000000e');
select pg_temp.terminal_reserved(pg_temp.analysis_fixture_id('terminal_e'));
insert into public.credit_ledger(workspace_id, event_type, amount, analysis_id)
select workspace_id, 'Released', 3, id
from public.analyses where id = pg_temp.analysis_fixture_id('terminal_e');
select pg_temp.terminal_event(pg_temp.analysis_fixture_id('terminal_e'));
select pg_temp.terminal_staging(
  pg_temp.analysis_fixture_id('terminal_e'),
  '00000000-0000-4000-8000-00000000000e');
select is(
  private.finalize_failed_analysis(
    pg_temp.analysis_fixture_id('terminal_e'),
    '00000000-0000-4000-8000-00000000000e',
    'INTERNAL_ERROR'::public.analysis_failure_code,
    true
  ),
  'failed',
  'E: a settled failed row with staging is cleaned idempotently'
);
select is(
  (select count(*)::integer from private.analysis_finding_staging
   where analysis_id = pg_temp.analysis_fixture_id('terminal_e')),
  0,
  'E: staged findings are cleaned'
);
select is(
  (select count(*)::integer from private.analysis_finding_evidence_staging
   where analysis_id = pg_temp.analysis_fixture_id('terminal_e')),
  0,
  'E: staged evidence is cleaned'
);
select is(
  (select count(*)::integer from public.credit_ledger
   where analysis_id = pg_temp.analysis_fixture_id('terminal_e')),
  2,
  'E: no duplicate ledger rows'
);
select is(
  (select count(*)::integer from public.notification_events
   where analysis_id = pg_temp.analysis_fixture_id('terminal_e')),
  1,
  'E: no duplicate event'
);
select pg_temp.terminal_cleanup(pg_temp.analysis_fixture_id('terminal_e'));

-- Case F: failed + matching token + Consumed is corrupt and must raise P0001.
select pg_temp.terminal_fixture(
  'terminal_f', 'failed', '00000000-0000-4000-8000-00000000000f');
select pg_temp.terminal_reserved(pg_temp.analysis_fixture_id('terminal_f'));
insert into public.credit_ledger(workspace_id, event_type, amount, analysis_id)
select workspace_id, 'Consumed', 3, id
from public.analyses where id = pg_temp.analysis_fixture_id('terminal_f');
select pg_temp.terminal_staging(
  pg_temp.analysis_fixture_id('terminal_f'),
  '00000000-0000-4000-8000-00000000000f');
select throws_ok(
  format(
    'select private.finalize_failed_analysis(%L, %L, %L, true)',
    pg_temp.analysis_fixture_id('terminal_f'),
    '00000000-0000-4000-8000-00000000000f',
    'INTERNAL_ERROR'
  ),
  'P0001',
  null,
  'F: Consumed on a failed row raises P0001'
);
select is(
  (select status::text from public.analyses where id = pg_temp.analysis_fixture_id('terminal_f')),
  'failed',
  'F: the failed status is unchanged'
);
select is(
  (select count(*)::integer from private.analysis_finding_staging
   where analysis_id = pg_temp.analysis_fixture_id('terminal_f')),
  1,
  'F: staging survives the raised exception'
);
select is(
  (select count(*)::integer from public.notification_events
   where analysis_id = pg_temp.analysis_fixture_id('terminal_f')),
  0,
  'F: no event is written'
);
select pg_temp.terminal_cleanup(pg_temp.analysis_fixture_id('terminal_f'));

-- Case G: failed + matching token + Reserved without Released.
select pg_temp.terminal_fixture(
  'terminal_g', 'failed', '00000000-0000-4000-8000-00000000001a');
select pg_temp.terminal_reserved(pg_temp.analysis_fixture_id('terminal_g'));
select pg_temp.terminal_staging(
  pg_temp.analysis_fixture_id('terminal_g'),
  '00000000-0000-4000-8000-00000000001a');
select is(
  private.finalize_failed_analysis(
    pg_temp.analysis_fixture_id('terminal_g'),
    '00000000-0000-4000-8000-00000000001a',
    'INTERNAL_ERROR'::public.analysis_failure_code,
    true
  ),
  'failed',
  'G: a partially settled failed row is completed'
);
select is(
  (select count(*)::integer from public.credit_ledger
   where analysis_id = pg_temp.analysis_fixture_id('terminal_g') and event_type = 'Released'),
  1,
  'G: the missing release is settled'
);
select is(
  (select count(*)::integer from public.notification_events
   where analysis_id = pg_temp.analysis_fixture_id('terminal_g')),
  1,
  'G: the missing event is inserted'
);
select is(
  (select count(*)::integer from private.analysis_finding_staging
   where analysis_id = pg_temp.analysis_fixture_id('terminal_g')),
  0,
  'G: staging is cleaned'
);
select pg_temp.terminal_cleanup(pg_temp.analysis_fixture_id('terminal_g'));

-- Case H: failed + mismatched token.
select pg_temp.terminal_fixture(
  'terminal_h', 'failed', '00000000-0000-4000-8000-00000000001b');
select pg_temp.terminal_reserved(pg_temp.analysis_fixture_id('terminal_h'));
select is(
  private.finalize_failed_analysis(
    pg_temp.analysis_fixture_id('terminal_h'),
    '00000000-0000-4000-8000-0000000000bb',
    'INTERNAL_ERROR'::public.analysis_failure_code,
    true
  ),
  'superseded',
  'H: a failed row with a mismatched token is superseded'
);
select is(
  (select count(*)::integer from public.credit_ledger
   where analysis_id = pg_temp.analysis_fixture_id('terminal_h')),
  1,
  'H: no settlement is written'
);
select is(
  (select count(*)::integer from public.notification_events
   where analysis_id = pg_temp.analysis_fixture_id('terminal_h')),
  0,
  'H: no event is written'
);
select pg_temp.terminal_cleanup(pg_temp.analysis_fixture_id('terminal_h'));

-- Case I: completed + any token.
select pg_temp.terminal_fixture(
  'terminal_i', 'completed', '00000000-0000-4000-8000-00000000001c');
select is(
  private.finalize_failed_analysis(
    pg_temp.analysis_fixture_id('terminal_i'),
    '00000000-0000-4000-8000-00000000001c',
    'INTERNAL_ERROR'::public.analysis_failure_code,
    true
  ),
  'superseded',
  'I: a completed analysis is never failed'
);
select is(
  (select status::text from public.analyses where id = pg_temp.analysis_fixture_id('terminal_i')),
  'completed',
  'I: completed status is unchanged'
);
select is(
  (select count(*)::integer from public.credit_ledger
   where analysis_id = pg_temp.analysis_fixture_id('terminal_i')),
  0,
  'I: no ledger writes'
);
select is(
  (select count(*)::integer from public.notification_events
   where analysis_id = pg_temp.analysis_fixture_id('terminal_i')),
  0,
  'I: no event writes'
);
select pg_temp.terminal_cleanup(pg_temp.analysis_fixture_id('terminal_i'));

-- Case J: queued + p_enforce_operation=true.
select pg_temp.terminal_fixture(
  'terminal_j', 'queued', '00000000-0000-4000-8000-00000000001d');
select is(
  private.finalize_failed_analysis(
    pg_temp.analysis_fixture_id('terminal_j'),
    '00000000-0000-4000-8000-00000000001d',
    'TIMEOUT'::public.analysis_failure_code,
    true
  ),
  'superseded',
  'J: a queued row is superseded in fenced mode'
);
select is(
  (select status::text from public.analyses where id = pg_temp.analysis_fixture_id('terminal_j')),
  'queued',
  'J: queued status is unchanged'
);
select is(
  (select count(*)::integer from public.credit_ledger
   where analysis_id = pg_temp.analysis_fixture_id('terminal_j')),
  0,
  'J: no ledger writes'
);
select is(
  (select count(*)::integer from public.notification_events
   where analysis_id = pg_temp.analysis_fixture_id('terminal_j')),
  0,
  'J: no event writes'
);
select pg_temp.terminal_cleanup(pg_temp.analysis_fixture_id('terminal_j'));

-- Case K: queued + p_enforce_operation=false (caller confirmed terminal).
select pg_temp.terminal_fixture(
  'terminal_k', 'queued', null);
select pg_temp.terminal_reserved(pg_temp.analysis_fixture_id('terminal_k'));
select pg_temp.terminal_staging(
  pg_temp.analysis_fixture_id('terminal_k'),
  gen_random_uuid());
select is(
  private.finalize_failed_analysis(
    pg_temp.analysis_fixture_id('terminal_k'),
    null,
    'TIMEOUT'::public.analysis_failure_code,
    false
  ),
  'failed',
  'K: an unfenced queued row can be failed by a sweep'
);
select is(
  (select status::text from public.analyses where id = pg_temp.analysis_fixture_id('terminal_k')),
  'failed',
  'K: status becomes failed'
);
select is(
  (select error_code::text from public.analyses where id = pg_temp.analysis_fixture_id('terminal_k')),
  'TIMEOUT',
  'K: the sweep failure code is preserved'
);
select ok(
  (select lease_expires_at is null
     and next_attempt_at is null
     and continuation_pending = false
   from public.analyses where id = pg_temp.analysis_fixture_id('terminal_k')),
  'K: lease/backoff/continuation are cleared'
);
select is(
  (select count(*)::integer from public.credit_ledger
   where analysis_id = pg_temp.analysis_fixture_id('terminal_k') and event_type = 'Released'),
  1,
  'K: the reservation is released'
);
select is(
  (select count(*)::integer from public.notification_events
   where analysis_id = pg_temp.analysis_fixture_id('terminal_k')),
  1,
  'K: the failure event is emitted'
);
select is(
  (select count(*)::integer from private.analysis_finding_staging
   where analysis_id = pg_temp.analysis_fixture_id('terminal_k')),
  0,
  'K: staging is cleaned'
);
select pg_temp.terminal_cleanup(pg_temp.analysis_fixture_id('terminal_k'));

-- Case L: unknown analysis id.
select is(
  private.finalize_failed_analysis(
    gen_random_uuid(),
    gen_random_uuid(),
    'INTERNAL_ERROR'::public.analysis_failure_code,
    false
  ),
  'superseded',
  'L: an unknown analysis id is superseded'
);

-- Rollback: the update must roll back when settle_analysis_credits raises.
select pg_temp.terminal_fixture(
  'terminal_rollback', 'processing', '00000000-0000-4000-8000-00000000001e');
select pg_temp.terminal_staging(
  pg_temp.analysis_fixture_id('terminal_rollback'),
  '00000000-0000-4000-8000-00000000001e');
select throws_ok(
  format(
    'select private.finalize_failed_analysis(%L, %L, %L, true)',
    pg_temp.analysis_fixture_id('terminal_rollback'),
    '00000000-0000-4000-8000-00000000001e',
    'TIMEOUT'
  ),
  'P2002',
  null,
  'Rollback: settling without a reservation raises'
);
select is(
  (select status::text from public.analyses
   where id = pg_temp.analysis_fixture_id('terminal_rollback')),
  'processing',
  'Rollback: the analysis remains processing'
);
select is(
  (select count(*)::integer from private.analysis_finding_staging
   where analysis_id = pg_temp.analysis_fixture_id('terminal_rollback')),
  1,
  'Rollback: staged findings survive'
);
select is(
  (select count(*)::integer from private.analysis_finding_evidence_staging
   where analysis_id = pg_temp.analysis_fixture_id('terminal_rollback')),
  1,
  'Rollback: staged evidence survives'
);
select is(
  (select count(*)::integer from public.notification_events
   where analysis_id = pg_temp.analysis_fixture_id('terminal_rollback')),
  0,
  'Rollback: no event is inserted'
);
select pg_temp.terminal_cleanup(pg_temp.analysis_fixture_id('terminal_rollback'));

-- Claim wiring (S2-08b, 8b-7): the sweep must delegate terminal rows to the
-- helper and keep the reclaim path on SKIP LOCKED.
select ok(
  exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    cross join lateral unnest(coalesce(p.proconfig, '{}'::text[])) as cfg
    where n.nspname = 'public'
      and p.proname = 'claim_analysis'
      and p.pronargs = 1
      and cfg = 'statement_timeout=45s'
  ),
  'Claim: statement_timeout is the 45 second ceiling'
);
select ok(
  exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    cross join lateral unnest(coalesce(p.proconfig, '{}'::text[])) as cfg
    where n.nspname = 'public'
      and p.proname = 'claim_analysis'
      and p.pronargs = 1
      and cfg = 'lock_timeout=1s'
  ),
  'Claim: lock_timeout remains one second'
);

-- Directed claim of an expired third attempt terminalizes through the helper.
select pg_temp.terminal_fixture(
  'claim_terminal_third', 'processing', '00000000-0000-4000-8000-000000000020');
update public.analyses
   set attempt_count = 3,
       lease_expires_at = clock_timestamp() - interval '1 second'
 where id = pg_temp.analysis_fixture_id('claim_terminal_third');
select pg_temp.terminal_reserved(pg_temp.analysis_fixture_id('claim_terminal_third'));
select pg_temp.terminal_staging(
  pg_temp.analysis_fixture_id('claim_terminal_third'),
  '00000000-0000-4000-8000-000000000020');
select is(
  (select count(*)::integer
   from public.claim_analysis(pg_temp.analysis_fixture_id('claim_terminal_third'))),
  0,
  'Claim: an expired third attempt returns no work'
);
select is(
  (select status::text from public.analyses
   where id = pg_temp.analysis_fixture_id('claim_terminal_third')),
  'failed',
  'Claim: an expired third attempt becomes failed'
);
select is(
  (select error_code::text from public.analyses
   where id = pg_temp.analysis_fixture_id('claim_terminal_third')),
  'ATTEMPTS_EXHAUSTED',
  'Claim: an expired third attempt uses ATTEMPTS_EXHAUSTED'
);
select is(
  (select count(*)::integer from public.credit_ledger
   where analysis_id = pg_temp.analysis_fixture_id('claim_terminal_third')),
  2,
  'Claim: the third-attempt reservation is released exactly once'
);
select is(
  (select count(*)::integer from public.credit_ledger
   where analysis_id = pg_temp.analysis_fixture_id('claim_terminal_third')
     and event_type = 'Released'),
  1,
  'Claim: the third-attempt release is persisted'
);
select is(
  (select count(*)::integer from public.notification_events
   where analysis_id = pg_temp.analysis_fixture_id('claim_terminal_third')
     and type = 'analysis_failed'),
  1,
  'Claim: the third-attempt failure event is emitted'
);
select is(
  (select count(*)::integer from private.analysis_finding_staging
   where analysis_id = pg_temp.analysis_fixture_id('claim_terminal_third')),
  0,
  'Claim: third-attempt staging is cleaned'
);
select is(
  (select operation_id from public.analyses
   where id = pg_temp.analysis_fixture_id('claim_terminal_third')),
  '00000000-0000-4000-8000-000000000020'::uuid,
  'Claim: the terminal acknowledgement token is preserved'
);
select pg_temp.terminal_cleanup(pg_temp.analysis_fixture_id('claim_terminal_third'));

-- Sweep of an expired queued continuation terminalizes through the helper.
select pg_temp.terminal_fixture(
  'claim_terminal_continuation', 'queued', null);
update public.analyses
   set attempt_count = 1,
       continuation_pending = true,
       attempt_deadline_at = clock_timestamp() - interval '1 second',
       analysis_deadline_at = clock_timestamp() + interval '90 minutes'
 where id = pg_temp.analysis_fixture_id('claim_terminal_continuation');
select pg_temp.terminal_reserved(pg_temp.analysis_fixture_id('claim_terminal_continuation'));
select pg_temp.terminal_staging(
  pg_temp.analysis_fixture_id('claim_terminal_continuation'),
  '00000000-0000-4000-8000-000000000021');
select is(
  (select count(*)::integer from public.claim_analysis(null)),
  0,
  'Claim: an expired continuation returns no work'
);
select is(
  (select status::text from public.analyses
   where id = pg_temp.analysis_fixture_id('claim_terminal_continuation')),
  'failed',
  'Claim: an expired continuation becomes failed'
);
select is(
  (select error_code::text from public.analyses
   where id = pg_temp.analysis_fixture_id('claim_terminal_continuation')),
  'TIMEOUT',
  'Claim: an expired continuation uses TIMEOUT'
);
select is(
  (select count(*)::integer from public.credit_ledger
   where analysis_id = pg_temp.analysis_fixture_id('claim_terminal_continuation')),
  2,
  'Claim: the continuation reservation is released exactly once'
);
select is(
  (select count(*)::integer from public.credit_ledger
   where analysis_id = pg_temp.analysis_fixture_id('claim_terminal_continuation')
     and event_type = 'Released'),
  1,
  'Claim: the continuation release is persisted'
);
select is(
  (select count(*)::integer from public.notification_events
   where analysis_id = pg_temp.analysis_fixture_id('claim_terminal_continuation')
     and type = 'analysis_failed'),
  1,
  'Claim: the continuation failure event is emitted'
);
select is(
  (select count(*)::integer from private.analysis_finding_staging
   where analysis_id = pg_temp.analysis_fixture_id('claim_terminal_continuation')),
  0,
  'Claim: continuation staging is cleaned'
);
select pg_temp.terminal_cleanup(pg_temp.analysis_fixture_id('claim_terminal_continuation'));

-- A queued retry with attempts left is reclaimed, not terminalized.
select pg_temp.terminal_fixture(
  'claim_retry_reclaim', 'queued', null);
update public.analyses
   set attempt_count = 1,
       next_attempt_at = clock_timestamp() - interval '1 second',
       analysis_deadline_at = clock_timestamp() + interval '90 minutes'
 where id = pg_temp.analysis_fixture_id('claim_retry_reclaim');
select pg_temp.terminal_reserved(pg_temp.analysis_fixture_id('claim_retry_reclaim'));
select is(
  (select id from public.claim_analysis(null)),
  pg_temp.analysis_fixture_id('claim_retry_reclaim'),
  'Claim: a retry with attempts left is reclaimed'
);
select is(
  (select status::text from public.analyses
   where id = pg_temp.analysis_fixture_id('claim_retry_reclaim')),
  'processing',
  'Claim: the retry moves to processing'
);
select is(
  (select attempt_count from public.analyses
   where id = pg_temp.analysis_fixture_id('claim_retry_reclaim')),
  2,
  'Claim: the retry consumes the next attempt'
);
select ok(
  (select operation_id is not null from public.analyses
   where id = pg_temp.analysis_fixture_id('claim_retry_reclaim')),
  'Claim: the retry mints a fresh operation token'
);
select is(
  (select count(*)::integer from public.credit_ledger
   where analysis_id = pg_temp.analysis_fixture_id('claim_retry_reclaim')),
  1,
  'Claim: the retry keeps its reservation'
);
select is(
  (select count(*)::integer from public.notification_events
   where analysis_id = pg_temp.analysis_fixture_id('claim_retry_reclaim')),
  0,
  'Claim: the retry emits no failure event'
);
select pg_temp.terminal_cleanup(pg_temp.analysis_fixture_id('claim_retry_reclaim'));

-- A live queued candidate is claimed normally.
select pg_temp.terminal_fixture(
  'claim_live_queued', 'queued', null);
select is(
  (select id from public.claim_analysis(null)),
  pg_temp.analysis_fixture_id('claim_live_queued'),
  'Claim: a live queued candidate is reclaimed'
);
select is(
  (select status::text from public.analyses
   where id = pg_temp.analysis_fixture_id('claim_live_queued')),
  'processing',
  'Claim: a live queued candidate moves to processing'
);
select is(
  (select attempt_count from public.analyses
   where id = pg_temp.analysis_fixture_id('claim_live_queued')),
  1,
  'Claim: a live queued candidate starts attempt 1'
);
select is(
  (select count(*)::integer from public.notification_events
   where analysis_id = pg_temp.analysis_fixture_id('claim_live_queued')),
  0,
  'Claim: a live claim emits no failure event'
);
select pg_temp.terminal_cleanup(pg_temp.analysis_fixture_id('claim_live_queued'));

-- A processing candidate with an expired lease is reclaimed normally.
select pg_temp.terminal_fixture(
  'claim_processing_reclaim', 'processing', '00000000-0000-4000-8000-000000000022');
update public.analyses
   set attempt_count = 1,
       lease_expires_at = clock_timestamp() - interval '1 second',
       attempt_deadline_at = clock_timestamp() + interval '30 minutes',
       analysis_deadline_at = clock_timestamp() + interval '90 minutes'
 where id = pg_temp.analysis_fixture_id('claim_processing_reclaim');
select is(
  (select id from public.claim_analysis(null)),
  pg_temp.analysis_fixture_id('claim_processing_reclaim'),
  'Claim: a processing lease expiry is reclaimed'
);
select is(
  (select attempt_count from public.analyses
   where id = pg_temp.analysis_fixture_id('claim_processing_reclaim')),
  2,
  'Claim: a processing lease expiry starts a new attempt'
);
select ok(
  (select operation_id is distinct from '00000000-0000-4000-8000-000000000022'::uuid
   from public.analyses where id = pg_temp.analysis_fixture_id('claim_processing_reclaim')),
  'Claim: a processing reclaim rotates the operation token'
);
select is(
  (select count(*)::integer from public.credit_ledger
   where analysis_id = pg_temp.analysis_fixture_id('claim_processing_reclaim')),
  0,
  'Claim: a processing reclaim does not touch the ledger'
);
select is(
  (select count(*)::integer from public.notification_events
   where analysis_id = pg_temp.analysis_fixture_id('claim_processing_reclaim')),
  0,
  'Claim: a processing reclaim emits no failure event'
);
select pg_temp.terminal_cleanup(pg_temp.analysis_fixture_id('claim_processing_reclaim'));

select skip('Second-session SKIP LOCKED claim needs dblink (no repo precedent); method: hold a directed claim open in session A, claim via dblink in session B, assert disjoint rows', 1);

-- Privileges: helper is callable only by service_role.
select ok(
  has_function_privilege(
    'service_role',
    'private.finalize_failed_analysis(uuid,uuid,public.analysis_failure_code,boolean)',
    'EXECUTE'
  ),
  'Privileges: service_role can execute the helper'
);
select ok(
  not has_function_privilege(
    'anon',
    'private.finalize_failed_analysis(uuid,uuid,public.analysis_failure_code,boolean)',
    'EXECUTE'
  ),
  'Privileges: anon cannot execute the helper'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'private.finalize_failed_analysis(uuid,uuid,public.analysis_failure_code,boolean)',
    'EXECUTE'
  ),
  'Privileges: authenticated cannot execute the helper'
);
select ok(
  not has_function_privilege(
    'public',
    'private.finalize_failed_analysis(uuid,uuid,public.analysis_failure_code,boolean)',
    'EXECUTE'
  ),
  'Privileges: public cannot execute the helper'
);

select * from finish();
rollback;
