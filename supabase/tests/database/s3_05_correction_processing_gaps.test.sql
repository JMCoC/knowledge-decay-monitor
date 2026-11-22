begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
\ir review-fixtures.psql
select no_plan();

create temporary table gap_workspaces (
  case_name text primary key,
  workspace_id uuid not null
) on commit drop;
insert into gap_workspaces(case_name, workspace_id) values
  ('g1', pg_temp.create_review_fixture_case()),
  ('g2a', pg_temp.create_review_fixture_case()),
  ('g2b', pg_temp.create_review_fixture_case()),
  ('g3', pg_temp.create_review_fixture_case()),
  ('g4', pg_temp.create_review_fixture_case()),
  ('g6', pg_temp.create_review_fixture_case());

create temporary table gap_cases on commit drop as
select w.case_name, f.*
from gap_workspaces w
join pg_temp.review_fixture_case f on f.workspace_id = w.workspace_id;

create function pg_temp.make_gap_candidate(
  p_workspace_id uuid,
  p_finding_id uuid,
  p_admin_id uuid,
  p_member_id uuid
) returns table(round_id uuid, candidate_id uuid, version_id uuid, submission_id uuid)
language plpgsql
set search_path = pg_temp, public
as $$
declare
  v_round_id uuid;
  v_item_id uuid;
  v_submission_id uuid;
  v_candidate_id uuid;
  v_version_id uuid;
begin
  v_round_id := pg_temp.create_review_round(
    p_workspace_id, 'assigned_findings', array[p_finding_id]
  );
  select i.id into v_item_id
  from public.correction_round_items i
  where i.round_id = v_round_id and i.finding_id = p_finding_id;
  v_submission_id := pg_temp.create_review_submission(
    v_round_id, p_member_id, array[v_item_id]
  );
  v_candidate_id := pg_temp.select_direct_review_candidate(
    v_round_id, p_admin_id, v_submission_id
  );
  select c.version_id into v_version_id
  from public.correction_candidates c where c.id = v_candidate_id;
  return query select v_round_id, v_candidate_id, v_version_id, v_submission_id;
end;
$$;

-- G4. The complete candidate flow never mutates the credit ledger.
create temporary table g4 on commit drop as
select c.workspace_id, x.*
from gap_cases c
cross join lateral pg_temp.make_gap_candidate(
  c.workspace_id, c.finding_a_id, c.admin_id, c.member_a_id
) x
where c.case_name = 'g4';

create temporary table g4_credit_before on commit drop as
select count(*)::bigint as ledger_count, coalesce(sum(l.amount), 0)::bigint as ledger_sum
from public.credit_ledger l
where l.workspace_id = (select workspace_id from g4);

select is(
  public.enqueue_ingestion_job(
    (select workspace_id from g4), (select version_id from g4)
  ),
  'queued', 'G4: the selected candidate can be enqueued'
);
create temporary table g4_claim on commit drop as
select * from public.claim_ingestion_job();
select is(
  (select count(*)::integer from g4_claim), 1, 'G4: the candidate flow claims one job'
);
select is(
  (select version_id from g4_claim), (select version_id from g4),
  'G4: the claim picks the candidate version'
);
select public.finish_processing(
  (select version_id from g4), (select operation_id from g4_claim),
  jsonb_build_array(jsonb_build_object(
    'chunk_index', 0, 'text_content', 'Gap credit flow chunk',
    'page_number', 1, 'section_heading', 'Gap',
    'embedding', '[1,' || repeat('0,', 382) || '0]'
  ))
);
select is(
  (select v.processing_status::text from public.document_versions v
    where v.id = (select version_id from g4)),
  'ready', 'G4: the candidate finishes processing'
);
select is(
  (select c.status::text from public.correction_candidates c
    where c.id = (select candidate_id from g4)),
  'pending_approval', 'G4: the candidate waits for approval'
);
select is(
  (select count(*)::bigint from public.credit_ledger l
    where l.workspace_id = (select workspace_id from g4)),
  (select ledger_count from g4_credit_before),
  'G4: the flow does not append credit ledger rows'
);
select is(
  (select coalesce(sum(l.amount), 0)::bigint from public.credit_ledger l
    where l.workspace_id = (select workspace_id from g4)),
  (select ledger_sum from g4_credit_before),
  'G4: the flow does not change the credit ledger balance'
);

-- G1. An invalid chunk payload rolls back completion completely.
create temporary table g1 on commit drop as
select c.workspace_id, x.*
from gap_cases c
cross join lateral pg_temp.make_gap_candidate(
  c.workspace_id, c.finding_a_id, c.admin_id, c.member_a_id
) x
where c.case_name = 'g1';
select pg_temp.start_review_candidate((select candidate_id from g1));
create temporary table g1_state on commit drop as
select v.processing_operation_id as operation_id
from public.document_versions v where v.id = (select version_id from g1);

select throws_ok(format(
  'select public.finish_processing(%L, %L, %L::jsonb)',
  (select version_id from g1),
  (select operation_id from g1_state),
  jsonb_build_array(jsonb_build_object(
    'chunk_index', 0, 'text_content', 'Invalid embedding',
    'page_number', 1, 'section_heading', 'Gap',
    'embedding', '[1,2,3]'
  ))::text
), '22000', null, 'G1: an invalid embedding dimension rejects completion');
select is((
  select count(*)::integer from public.document_chunks
  where version_id = (select version_id from g1)
), 0, 'G1: no chunk survives the failed completion');
select is((
  select v.processing_status::text from public.document_versions v
  where v.id = (select version_id from g1)
), 'processing', 'G1: the version remains processing after rollback');
select is((
  select v.version_status from public.document_versions v
  where v.id = (select version_id from g1)
), null, 'G1: the version keeps a null functional status');
select is((
  select j.status::text from private.ingestion_jobs j
  where j.version_id = (select version_id from g1)
), 'running', 'G1: the failed completion leaves the job running for the worker');
select is(
  public.fail_ingestion_job(
    (select version_id from g1), (select operation_id from g1_state), true
  ),
  'queued', 'G1: the worker retry path queues the failed job'
);
select is((
  select j.status::text from private.ingestion_jobs j
  where j.version_id = (select version_id from g1)
), 'queued', 'G1: the retry leaves the job queued');
select is((
  select v.processing_status::text from public.document_versions v
  where v.id = (select version_id from g1)
), 'processing', 'G1: a retryable candidate failure keeps the version processing');
update private.ingestion_jobs
set available_at = clock_timestamp() + interval '1 day'
where version_id = (select version_id from g1);

-- G2a. A terminal worker failure retires the whole candidate flow.
create temporary table g2a on commit drop as
select c.workspace_id, x.*
from gap_cases c
cross join lateral pg_temp.make_gap_candidate(
  c.workspace_id, c.finding_a_id, c.admin_id, c.member_a_id
) x
where c.case_name = 'g2a';
select pg_temp.start_review_candidate((select candidate_id from g2a));
create temporary table g2a_state on commit drop as
select v.processing_operation_id as operation_id,
  c.revision as candidate_revision, r.revision as round_revision
from public.document_versions v
join public.correction_candidates c on c.version_id = v.id
join public.correction_rounds r on r.id = c.round_id
where v.id = (select version_id from g2a);

select is(
  public.fail_ingestion_job(
    (select version_id from g2a), (select operation_id from g2a_state), false
  ),
  'failed', 'G2a: a non-retryable failure is terminal'
);
select is((
  select v.processing_status::text from public.document_versions v
  where v.id = (select version_id from g2a)
), 'processing_failed', 'G2a: the terminal failure marks the version failed');
select is((
  select v.version_status from public.document_versions v
  where v.id = (select version_id from g2a)
), null, 'G2a: the terminal failure never assigns a functional version status');
select is((
  select c.status::text from public.correction_candidates c
  where c.id = (select candidate_id from g2a)
), 'failed', 'G2a: the candidate becomes failed');
select is((
  select c.revision from public.correction_candidates c
  where c.id = (select candidate_id from g2a)
), (select candidate_revision + 1 from g2a_state), 'G2a: the candidate revision advances once');
select is((
  select r.status::text from public.correction_rounds r
  where r.id = (select round_id from g2a)
), 'candidate_failed', 'G2a: the round becomes candidate_failed');
select is((
  select r.revision from public.correction_rounds r
  where r.id = (select round_id from g2a)
), (select round_revision + 1 from g2a_state), 'G2a: the round revision advances once');
select is((
  select j.status::text from private.ingestion_jobs j
  where j.version_id = (select version_id from g2a)
), 'failed', 'G2a: the job is retired');

-- G2b. The third attempt is terminal even when the worker asks to retry.
create temporary table g2b on commit drop as
select c.workspace_id, x.*
from gap_cases c
cross join lateral pg_temp.make_gap_candidate(
  c.workspace_id, c.finding_a_id, c.admin_id, c.member_a_id
) x
where c.case_name = 'g2b';
select pg_temp.start_review_candidate((select candidate_id from g2b));
update private.ingestion_jobs
set attempt_count = 3
where version_id = (select version_id from g2b);
select public.fail_ingestion_job(
  (select version_id from g2b),
  (select v.processing_operation_id from public.document_versions v
    where v.id = (select version_id from g2b)),
  true
);
select is((
  select c.status::text from public.correction_candidates c
  where c.id = (select candidate_id from g2b)
), 'failed', 'G2b: the exhausted retry budget fails the candidate');
select is((
  select j.status::text from private.ingestion_jobs j
  where j.version_id = (select version_id from g2b)
), 'failed', 'G2b: the exhausted retry budget retires the job');

-- G3. A stale worker cannot finish or fail a job claimed by a newer operation.
create temporary table g3 on commit drop as
select c.workspace_id, x.*
from gap_cases c
cross join lateral pg_temp.make_gap_candidate(
  c.workspace_id, c.finding_a_id, c.admin_id, c.member_a_id
) x
where c.case_name = 'g3';
select pg_temp.start_review_candidate((select candidate_id from g3));
create temporary table g3_before on commit drop as
select v.processing_operation_id as operation_id,
  c.revision as candidate_revision, r.revision as round_revision
from public.document_versions v
join public.correction_candidates c on c.version_id = v.id
join public.correction_rounds r on r.id = c.round_id
where v.id = (select version_id from g3);
update private.ingestion_jobs
set started_at = clock_timestamp() - interval '1 hour',
    lease_expires_at = clock_timestamp() - interval '1 second'
where version_id = (select version_id from g3);
create temporary table g3_claim on commit drop as
select * from public.claim_ingestion_job();
select is(
  (select count(*)::integer from g3_claim), 1, 'G3: the expired candidate is reclaimed'
);
select is(
  (select version_id from g3_claim), (select version_id from g3),
  'G3: the new claim picks the same version'
);
select ok(
  (select operation_id from g3_claim) <> (select operation_id from g3_before),
  'G3: the new claim replaces the worker operation'
);
select throws_ok(format(
  'select public.finish_processing(%L, %L, %L::jsonb)',
  (select version_id from g3),
  (select operation_id from g3_before),
  jsonb_build_array(jsonb_build_object(
    'chunk_index', 0, 'text_content', 'Stale completion',
    'page_number', 1, 'section_heading', 'Gap',
    'embedding', '[1,' || repeat('0,', 382) || '0]'
  ))::text
), '22023', null, 'G3: the stale worker cannot finish the new operation');
select is((
  select count(*)::integer from public.document_chunks
  where version_id = (select version_id from g3)
), 0, 'G3: the stale completion inserts no chunks');
select is(
  public.fail_ingestion_job(
    (select version_id from g3), (select operation_id from g3_before), false
  ),
  'superseded', 'G3: the stale worker cannot fail the new operation'
);
select is((
  select v.processing_operation_id from public.document_versions v
  where v.id = (select version_id from g3)
), (select operation_id from g3_claim), 'G3: the version keeps the new operation');
select is((
  select j.operation_id from private.ingestion_jobs j
  where j.version_id = (select version_id from g3)
), (select operation_id from g3_claim), 'G3: the job keeps the new operation');
select is((
  select j.status::text from private.ingestion_jobs j
  where j.version_id = (select version_id from g3)
), 'running', 'G3: the new operation remains running');
select is((
  select j.attempt_count from private.ingestion_jobs j
  where j.version_id = (select version_id from g3)
), 2, 'G3: the new operation is the second attempt');
select is((
  select c.status::text from public.correction_candidates c
  where c.id = (select candidate_id from g3)
), 'processing', 'G3: the candidate reflects the new worker');
select is((
  select r.status::text from public.correction_rounds r
  where r.id = (select round_id from g3)
), 'candidate_processing', 'G3: the round reflects the new worker');
select is(
  public.fail_ingestion_job(
    (select version_id from g3), (select operation_id from g3_claim), false
  ),
  'failed', 'G3: the new worker can retire its own operation'
);

-- G6. Completing coverage alone does not start candidate processing or jobs.
create temporary table g6_round on commit drop as
select c.workspace_id, c.member_a_id, c.admin_id,
  pg_temp.create_review_round(
    c.workspace_id, 'assigned_findings', array[c.finding_a_id]
  ) as round_id,
  null::uuid as item_id,
  null::uuid as submission_id
from gap_cases c where c.case_name = 'g6';
update g6_round g
set item_id = (select i.id from public.correction_round_items i
  where i.round_id = g.round_id and i.finding_id = (
    select c.finding_a_id from gap_cases c where c.case_name = 'g6'
  ));
select throws_ok(format(
  'update public.correction_rounds set status = %L, revision = revision + 1 where id = %L',
  'consolidating', (select round_id from g6_round)
), '23514', null, 'G6: incomplete confirmed coverage cannot consolidate');
select throws_ok(format(
  'update public.correction_rounds set status = %L, revision = revision + 1 where id = %L',
  'candidate_processing', (select round_id from g6_round)
), '23514', null, 'G6: incomplete coverage cannot start candidate processing');
update g6_round g
set submission_id = pg_temp.create_review_submission(
  g.round_id, g.member_a_id, array[g.item_id]
);
select is((
  select r.status::text from public.correction_rounds r
  where r.id = (select round_id from g6_round)
), 'collecting', 'G6: a complete submission leaves the round collecting');
select ok(not exists (
  select 1 from private.ingestion_jobs j
  join public.correction_submissions s on s.version_id = j.version_id
  where s.id = (select submission_id from g6_round)
), 'G6: completing coverage alone does not enqueue a job');
update public.correction_rounds
set status = 'consolidating', revision = revision + 1
where id = (select round_id from g6_round);
select is((
  select r.status::text from public.correction_rounds r
  where r.id = (select round_id from g6_round)
), 'consolidating', 'G6: complete coverage can consolidate');
select ok(not exists (
  select 1 from private.ingestion_jobs j
  join public.correction_submissions s on s.version_id = j.version_id
  where s.id = (select submission_id from g6_round)
), 'G6: consolidation alone does not enqueue a job');

select * from finish();
rollback;
