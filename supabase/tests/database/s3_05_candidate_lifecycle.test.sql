begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
\ir review-fixtures.psql
select no_plan();

select pg_temp.create_review_fixture_case();
select pg_temp.create_review_fixture_case();
select pg_temp.create_review_fixture_case();
select pg_temp.create_review_fixture_case();
select pg_temp.create_review_fixture_case();

create temporary table lifecycle_cases on commit drop as
select row_number() over (order by workspace_id)::integer as seq, x.*
from pg_temp.review_fixture_case x;

create function pg_temp.make_lifecycle_candidate(
  p_workspace_id uuid,
  p_finding_id uuid,
  p_admin_id uuid
) returns table(round_id uuid, candidate_id uuid, version_id uuid, submission_id uuid)
language plpgsql
set search_path = pg_temp, public
as $$
declare
  v_round_id uuid;
  v_item_id uuid;
  v_member_id uuid;
  v_submission_id uuid;
  v_candidate_id uuid;
  v_version_id uuid;
begin
  v_round_id := pg_temp.create_review_round(
    p_workspace_id, 'assigned_findings', array[p_finding_id]
  );
  select i.id, i.assignee_id into v_item_id, v_member_id
  from public.correction_round_items i
  where i.round_id = v_round_id and i.finding_id = p_finding_id;
  v_submission_id := pg_temp.create_review_submission(
    v_round_id, v_member_id, array[v_item_id]
  );
  v_candidate_id := pg_temp.select_direct_review_candidate(
    v_round_id, p_admin_id, v_submission_id
  );
  select c.version_id into v_version_id
  from public.correction_candidates c where c.id = v_candidate_id;
  return query select v_round_id, v_candidate_id, v_version_id, v_submission_id;
end;
$$;

create function pg_temp.start_lifecycle_candidate(p_candidate_id uuid) returns uuid
language plpgsql
set search_path = pg_temp, public
as $$
declare
  c public.correction_candidates%rowtype;
  v_operation_id uuid := gen_random_uuid();
  v_started_at timestamptz := clock_timestamp();
begin
  select x.* into strict c from public.correction_candidates x where x.id = p_candidate_id;
  update public.correction_candidates
  set status = 'processing', revision = revision + 1, updated_at = clock_timestamp()
  where id = c.id;
  update private.ingestion_jobs
  set status = 'running', attempt_count = 1, operation_id = v_operation_id,
      started_at = v_started_at,
      lease_expires_at = v_started_at + interval '180 seconds',
      updated_at = clock_timestamp()
  where version_id = c.version_id and workspace_id = c.workspace_id;
  update public.document_versions
  set processing_status = 'processing', processing_queued = false,
      processing_operation_id = v_operation_id,
      processing_started_at = v_started_at,
      processing_lease_expires_at = v_started_at + interval '180 seconds',
      updated_at = clock_timestamp()
  where id = c.version_id and workspace_id = c.workspace_id;
  return v_operation_id;
end;
$$;

create function pg_temp.fail_lifecycle_candidate(p_candidate_id uuid) returns void
language plpgsql
set search_path = pg_temp, public
as $$
declare
  c public.correction_candidates%rowtype;
begin
  select x.* into strict c from public.correction_candidates x where x.id = p_candidate_id;
  perform pg_temp.start_lifecycle_candidate(c.id);
  update public.document_versions
  set processing_status = 'processing_failed', version_status = null,
      processing_queued = false, processing_operation_id = null,
      processing_started_at = null, processing_lease_expires_at = null,
      updated_at = clock_timestamp()
  where id = c.version_id and workspace_id = c.workspace_id;
  update private.ingestion_jobs
  set status = 'failed', operation_id = null, started_at = null,
      lease_expires_at = null, updated_at = clock_timestamp()
  where version_id = c.version_id and workspace_id = c.workspace_id;
  update public.correction_candidates
  set status = 'failed', revision = revision + 1, updated_at = clock_timestamp()
  where id = c.id;
  update public.correction_rounds
  set status = 'candidate_failed', revision = revision + 1, updated_at = clock_timestamp()
  where id = c.round_id;
end;
$$;

create function pg_temp.promote_lifecycle_candidate(p_candidate_id uuid) returns void
language plpgsql
set search_path = pg_temp, public
as $$
declare
  c public.correction_candidates%rowtype;
begin
  select x.* into strict c from public.correction_candidates x where x.id = p_candidate_id;
  perform pg_temp.start_lifecycle_candidate(c.id);
  update public.document_versions
  set processing_status = 'ready', version_status = 'pending_approval',
      processing_queued = false, processing_operation_id = null,
      processing_started_at = null, processing_lease_expires_at = null,
      updated_at = clock_timestamp()
  where id = c.version_id and workspace_id = c.workspace_id;
  update private.ingestion_jobs
  set status = 'completed', started_at = null, lease_expires_at = null,
      updated_at = clock_timestamp()
  where version_id = c.version_id and workspace_id = c.workspace_id;
  update public.correction_candidates
  set status = 'pending_approval', revision = revision + 1, updated_at = clock_timestamp()
  where id = c.id;
  update public.correction_rounds
  set status = 'pending_approval', revision = revision + 1, updated_at = clock_timestamp()
  where id = c.round_id;
end;
$$;

create temporary table lc_a on commit drop as
select c.seq, c.workspace_id, c.admin_id, c.member_a_id, c.member_b_id, c.finding_a_id,
  x.round_id, x.candidate_id, x.version_id, x.submission_id
from lifecycle_cases c
cross join lateral pg_temp.make_lifecycle_candidate(
  c.workspace_id, c.finding_a_id, c.admin_id
) x
where c.seq = 1;

create temporary table lc_b on commit drop as
select c.seq, c.workspace_id, c.admin_id, c.member_a_id, c.member_b_id, c.finding_a_id,
  x.round_id, x.candidate_id, x.version_id, x.submission_id
from lifecycle_cases c
cross join lateral pg_temp.make_lifecycle_candidate(
  c.workspace_id, c.finding_a_id, c.admin_id
) x
where c.seq = 2;

create temporary table lc_c on commit drop as
select c.seq, c.workspace_id, c.admin_id,
  pg_temp.create_review_round(
    c.workspace_id, 'administrative', array[]::uuid[]
  ) as round_id
from lifecycle_cases c
where c.seq = 3;

create temporary table lc_d on commit drop as
select c.seq, c.workspace_id, c.admin_id, c.member_a_id, c.finding_a_id,
  x.round_id, x.candidate_id, x.version_id, x.submission_id
from lifecycle_cases c
cross join lateral pg_temp.make_lifecycle_candidate(
  c.workspace_id, c.finding_a_id, c.admin_id
) x
where c.seq = 4;

create temporary table lc_e on commit drop as
select c.seq, c.workspace_id, c.admin_id, c.member_a_id, c.finding_a_id,
  x.round_id, x.candidate_id, x.version_id, x.submission_id
from lifecycle_cases c
cross join lateral pg_temp.make_lifecycle_candidate(
  c.workspace_id, c.finding_a_id, c.admin_id
) x
where c.seq = 5;

-- 1. A round transition to candidate_processing enqueues the selected candidate.
select is((
  select c.status::text from public.correction_candidates c
  where c.id = (select candidate_id from lc_a)
), 'selected', 'The trigger leaves a selected candidate selected');
select is((
  select r.status::text from public.correction_rounds r
  where r.id = (select round_id from lc_a)
), 'candidate_processing', 'The fixture round reaches candidate processing');
select is((
  select j.status::text from private.ingestion_jobs j
  where j.version_id = (select version_id from lc_a)
), 'queued', 'The round trigger enqueues the selected candidate');
select is((
  select v.processing_queued from public.document_versions v
  where v.id = (select version_id from lc_a)
), true, 'The selected candidate version projects a queued job');

-- 2. A retry from candidate_failed revives the candidate and queues the job.
select pg_temp.fail_lifecycle_candidate((select candidate_id from lc_b));
select is((
  select c.status::text from public.correction_candidates c
  where c.id = (select candidate_id from lc_b)
), 'failed', 'The fixture failed candidate is ready for retry');

update public.correction_rounds
set status = 'candidate_processing', active_candidate_id = (select candidate_id from lc_b),
    revision = revision + 1, updated_at = clock_timestamp()
where id = (select round_id from lc_b);

select is((
  select c.status::text from public.correction_candidates c
  where c.id = (select candidate_id from lc_b)
), 'selected', 'A retry revives failed to selected');
select is((
  select v.processing_status::text from public.document_versions v
  where v.id = (select version_id from lc_b)
), 'uploaded', 'A retry resets the candidate version to uploaded');
select is((
  select j.status::text from private.ingestion_jobs j
  where j.version_id = (select version_id from lc_b)
), 'queued', 'A retry queues the candidate job');
select is((
  select j.attempt_count from private.ingestion_jobs j
  where j.version_id = (select version_id from lc_b)
), 0, 'A retry starts a fresh attempt budget');

-- 2b. A direct enqueue retry also advances the round without recursing.
select pg_temp.fail_lifecycle_candidate((select candidate_id from lc_b));
select is(
  public.enqueue_ingestion_job(
    (select workspace_id from lc_b),
    (select version_id from lc_b),
    true
  ),
  'queued', 'A direct retry queues a failed candidate'
);
select is((
  select c.status::text from public.correction_candidates c
  where c.id = (select candidate_id from lc_b)
), 'selected', 'A direct retry revives the failed candidate once');
select is((
  select r.status::text from public.correction_rounds r
  where r.id = (select round_id from lc_b)
), 'candidate_processing', 'A direct retry advances the round exactly once');

-- 3. A processing round without a processable candidate is rejected.
select throws_ok(format(
  'update public.correction_rounds set status = %L, active_candidate_id = null, revision = revision + 1 where id = %L',
  'candidate_processing',
  (select round_id from lc_c)
), '23514', 'candidate_processing requires processable candidate',
  'A candidate-processing round without a candidate is rejected by the trigger');

-- 4. Invalidation atomically clears a processing candidate.
select pg_temp.start_lifecycle_candidate((select candidate_id from lc_d));
select is(
  public.invalidate_review_candidate(
    (select workspace_id from lc_d),
    (select round_id from lc_d),
    (select admin_id from lc_d),
    'Processing must be abandoned'
  ),
  'invalidated', 'A processing candidate can be invalidated'
);
select is((
  select c.status::text from public.correction_candidates c
  where c.id = (select candidate_id from lc_d)
), 'invalidated', 'Invalidation marks the candidate invalidated');
select is((
  select v.processing_status::text from public.document_versions v
  where v.id = (select version_id from lc_d)
), 'processing_failed', 'Invalidation preserves a failed processing state');
select is((
  select v.version_status from public.document_versions v
  where v.id = (select version_id from lc_d)
), null, 'Invalidation never assigns a functional version status');
select is((
  select v.processing_operation_id from public.document_versions v
  where v.id = (select version_id from lc_d)
), null, 'Invalidation clears the processing operation');
select is((
  select v.processing_lease_expires_at from public.document_versions v
  where v.id = (select version_id from lc_d)
), null, 'Invalidation clears the processing lease');
select is((
  select r.status::text from public.correction_rounds r
  where r.id = (select round_id from lc_d)
), 'collecting', 'Invalidation returns the assigned round to collecting');
select is((
  select r.active_candidate_id from public.correction_rounds r
  where r.id = (select round_id from lc_d)
), null, 'Invalidation clears the active candidate pointer');
select is((
  select d.outcome::text from public.correction_candidate_decisions d
  where d.candidate_id = (select candidate_id from lc_d)
), 'invalidated', 'Invalidation persists an append-only decision');
select is((
  select j.status::text from private.ingestion_jobs j
  where j.version_id = (select version_id from lc_d)
), 'failed', 'Invalidation retires the in-flight job');

-- 5. Approval-stage candidates are outside the invalidation contract.
select pg_temp.promote_lifecycle_candidate((select candidate_id from lc_e));
select is(
  public.invalidate_review_candidate(
    (select workspace_id from lc_e),
    (select round_id from lc_e),
    (select admin_id from lc_e),
    'Too late to invalidate'
  ),
  'conflict', 'A pending-approval candidate cannot be invalidated'
);
select is((
  select c.status::text from public.correction_candidates c
  where c.id = (select candidate_id from lc_e)
), 'pending_approval', 'A rejected invalidation leaves the candidate untouched');

-- 6. A late retry cannot revive an invalidated candidate.
select is(
  public.enqueue_ingestion_job(
    (select workspace_id from lc_d),
    (select version_id from lc_d)
  ),
  'conflict', 'A late retry after invalidation is a conflict'
);

-- Move case A to approval too, so the queue view has two tenant rows.
select pg_temp.promote_lifecycle_candidate((select candidate_id from lc_a));

grant select on lifecycle_cases, lc_a, lc_e to authenticated;

-- 7. The queue view is tenant-scoped under RLS.
set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', (select admin_id::text from lc_a),
  'role', 'authenticated',
  'app_metadata', jsonb_build_object(
    'role', 'Admin', 'workspace_id', (select workspace_id::text from lc_a)
  )
)::text, true);
select is((
  select count(*)::integer from public.correction_candidate_queue
), 1, 'An Admin sees only their workspace candidate queue row');
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', (select admin_id::text from lc_e),
  'role', 'authenticated',
  'app_metadata', jsonb_build_object(
    'role', 'Admin', 'workspace_id', (select workspace_id::text from lc_e)
  )
)::text, true);
select is((
  select count(*)::integer from public.correction_candidate_queue
), 1, 'A second Admin sees only their own workspace candidate queue row');
reset role;

-- 8. Ready for approval is never projected as approved.
select is((
  select q.candidate_status::text from public.correction_candidate_queue q
  where q.round_id = (select round_id from lc_e)
), 'pending_approval', 'The queue projects pending approval as pending approval');
select is((
  select q.version_version_status::text from public.correction_candidate_queue q
  where q.round_id = (select round_id from lc_e)
), 'pending_approval', 'The queue keeps version and candidate statuses separate');
select is((
  select count(*)::integer from public.correction_candidate_queue q
  where q.round_id = (select round_id from lc_e) and q.candidate_status = 'approved'
), 0, 'The queue never infers approval from readiness');

-- 9. The read RPC authorizes the reviewer and filters the same tenant scope.
select is((
  select count(*)::integer from public.review_get_round_processing_status(
    (select admin_id from lc_e), (select round_id from lc_e)
  )
), 1, 'An authorized reviewer reads the round processing status');
select is((
  select p.round_status::text from public.review_get_round_processing_status(
    (select admin_id from lc_e), (select round_id from lc_e)
  ) p
), 'pending_approval', 'The read RPC projects the round phase');
select is((
  select p.candidate_status::text from public.review_get_round_processing_status(
    (select admin_id from lc_e), (select round_id from lc_e)
  ) p
), 'pending_approval', 'The read RPC projects the candidate phase');
select is((
  select p.version_processing_status::text from public.review_get_round_processing_status(
    (select admin_id from lc_e), (select round_id from lc_e)
  ) p
), 'ready', 'The read RPC projects the version processing state');
select is((
  select p.version_version_status::text from public.review_get_round_processing_status(
    (select admin_id from lc_e), (select round_id from lc_e)
  ) p
), 'pending_approval', 'The read RPC projects the version functional state');
select is((
  select count(*)::integer from public.review_get_round_processing_status(
    (select admin_id from lc_a), (select round_id from lc_e)
  )
), 0, 'A reviewer from another workspace cannot read the round');
-- 10. A Member who submitted in the round can read the same projection.
select is((
  select count(*)::integer from public.review_get_round_processing_status(
    (select member_a_id from lc_e), (select round_id from lc_e)
  )
), 1, 'A Member with a submission in the round reads its processing status');
select is((
  select p.candidate_status::text from public.review_get_round_processing_status(
    (select member_a_id from lc_e), (select round_id from lc_e)
  ) p
), 'pending_approval', 'The Member projection matches the reviewer projection');

-- 11. A Member without a submission in the round reads no status.
select is((
  select count(*)::integer from public.review_get_round_processing_status(
    (select member_b_id from lc_a), (select round_id from lc_a)
  )
), 0, 'A Member without a submission in the round reads no status');

-- 12. The Member read branch does not grant write access.
select throws_ok(format(
  'select public.invalidate_review_candidate(%L, %L, %L, %L)',
  (select workspace_id from lc_e),
  (select round_id from lc_e),
  (select member_a_id from lc_e),
  'synthetic member attempt'
), '42501', null, 'A Member cannot invalidate a candidate');

select * from finish();
rollback;
