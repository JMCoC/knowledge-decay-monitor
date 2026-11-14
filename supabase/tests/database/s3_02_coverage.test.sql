begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
\ir review-fixtures.psql
select no_plan();

create temporary table coverage_cases on commit drop as
select f.*, null::uuid as round_id, null::uuid as item_a, null::uuid as item_c,
       null::uuid as submission_id, null::uuid as candidate_id,
       null::uuid as candidate_version_id, null::bigint as item_coverage_revision,
       null::bigint as round_coverage_revision
from pg_temp.review_fixture_case f where false;
select pg_temp.create_review_fixture_case();
insert into pg_temp.coverage_cases select f.*, null, null, null, null, null, null, null, null
from pg_temp.review_fixture_case f;

update pg_temp.coverage_cases c
set round_id = pg_temp.create_review_round(c.workspace_id, 'assigned_findings', ARRAY[c.finding_a_id, c.finding_c_id]);
update pg_temp.coverage_cases c set
  item_a = (select i.id from public.correction_round_items i where i.round_id = c.round_id and i.finding_id = c.finding_a_id),
  item_c = (select i.id from public.correction_round_items i where i.round_id = c.round_id and i.finding_id = c.finding_c_id);
create temporary table stale_coverage_reservation(submission_id uuid not null) on commit drop;
insert into pg_temp.stale_coverage_reservation
select pg_temp.create_review_reservation(c.round_id, c.member_a_id, ARRAY[c.item_a])
from pg_temp.coverage_cases c;
update pg_temp.coverage_cases c
set submission_id = pg_temp.create_review_submission(c.round_id, c.member_a_id, ARRAY[c.item_a, c.item_c]);
update pg_temp.coverage_cases c
set round_coverage_revision = (select r.coverage_revision from public.correction_rounds r where r.id = c.round_id);
update pg_temp.coverage_cases c
set candidate_id = pg_temp.select_direct_review_candidate(c.round_id, c.admin_id, c.submission_id);
update pg_temp.coverage_cases c
set candidate_version_id = (select v.id from public.correction_candidates x join public.document_versions v on v.id = x.version_id where x.id = c.candidate_id),
    item_coverage_revision = (select i.coverage_revision from public.correction_round_items i where i.id = c.item_a)
where true;
select pg_temp.start_review_candidate((select candidate_id from pg_temp.coverage_cases));
create temporary table coverage_operation(operation_id uuid not null) on commit drop;
insert into pg_temp.coverage_operation
select v.processing_operation_id
from public.document_versions v, pg_temp.coverage_cases c
where v.id = c.candidate_version_id;
select is((select i.opened_assignee_id from public.correction_round_items i, pg_temp.coverage_cases c where i.id = c.item_a),
  (select member_a_id from pg_temp.coverage_cases), 'Opening snapshots the assignee independently of preparation history');

select lives_ok(format(
  'update public.findings set assignee_id = %L where id = %L',
  (select member_b_id from pg_temp.coverage_cases), (select finding_a_id from pg_temp.coverage_cases)
), 'Finding assignment can change during candidate processing');
select lives_ok(format(
  'update public.correction_round_items set assignee_id = %L, revision = revision + 1 where id = %L',
  (select member_b_id from pg_temp.coverage_cases), (select item_a from pg_temp.coverage_cases)
), 'Reassignment during candidate processing preserves a confirmed contribution');
select is((select i.current_submission_id from public.correction_round_items i, pg_temp.coverage_cases c where i.id = c.item_a),
  (select submission_id from pg_temp.coverage_cases), 'Processing candidate keeps the original item coverage pointer');
select is((select i.coverage_revision from public.correction_round_items i, pg_temp.coverage_cases c where i.id = c.item_a),
  (select item_coverage_revision from pg_temp.coverage_cases), 'Reassignment does not advance item coverage revision');
select is((select ci.item_revision from public.correction_candidate_items ci, pg_temp.coverage_cases c where ci.candidate_id = c.candidate_id and ci.round_item_id = c.item_a),
  (select item_coverage_revision from pg_temp.coverage_cases), 'Selected candidate is fenced by item coverage, not current assignee revision');
select is((select r.coverage_revision from public.correction_rounds r, pg_temp.coverage_cases c where r.id = c.round_id),
  (select round_coverage_revision from pg_temp.coverage_cases), 'Reassignment does not advance round coverage revision');
select is((select s.state::text from public.correction_submissions s, pg_temp.coverage_cases c where s.id = c.submission_id),
  'confirmed', 'The original Member delivery remains confirmed');
select is((select c.status::text from public.correction_candidates c, pg_temp.coverage_cases x where c.id = x.candidate_id),
  'processing', 'Assignment changes do not invalidate the active candidate');
select is((select v.processing_status::text from public.document_versions v, pg_temp.coverage_cases c where v.id = c.candidate_version_id),
  'processing', 'Assignment changes do not stop document processing');
select is((select v.processing_operation_id from public.document_versions v, pg_temp.coverage_cases c where v.id = c.candidate_version_id),
  (select operation_id from pg_temp.coverage_operation), 'Assignment changes preserve the in-flight processing operation');
select throws_ok(format(
  'update public.correction_round_items set current_submission_id = %L, coverage_revision = coverage_revision + 1 where id = %L',
  (select s.id from public.correction_submissions s where s.id = (select submission_id from pg_temp.stale_coverage_reservation)),
  (select item_a from pg_temp.coverage_cases)
), '23514', 'Current candidate must be invalidated before replacing item coverage',
  'A live candidate prevents a coverage pointer from changing');

select pg_temp.confirm_review_upload(s.version_id)
from public.correction_submissions s
where s.id = (select submission_id from pg_temp.stale_coverage_reservation);
select throws_ok(format(
  'update public.correction_submissions set state = %L, confirmed_at = (select upload_confirmed_at from public.document_versions where id = %L) where id = %L',
  'confirmed',
  (select s.version_id from public.correction_submissions s where s.id = (select submission_id from pg_temp.stale_coverage_reservation)),
  (select submission_id from pg_temp.stale_coverage_reservation)
), '23514', 'Correction submission assignment or revision is stale',
  'An old reservation cannot be confirmed after reassignment');

select lives_ok(format(
  'select pg_temp.complete_review_candidate(%L)', (select candidate_id from pg_temp.coverage_cases)
), 'The unchanged contribution can finish processing after reassignment');
select lives_ok(format(
  'update public.findings set assignee_id = %L where id = %L',
  (select member_b_id from pg_temp.coverage_cases), (select finding_c_id from pg_temp.coverage_cases)
), 'Pending approval finding assignment can change');
select lives_ok(format(
  'update public.correction_round_items set assignee_id = %L, revision = revision + 1 where id = %L',
  (select member_b_id from pg_temp.coverage_cases), (select item_c from pg_temp.coverage_cases)
), 'Reassignment while pending approval preserves confirmed coverage');
select is((select c.status::text from public.correction_candidates c, pg_temp.coverage_cases x where c.id = x.candidate_id),
  'pending_approval', 'The completed candidate remains pending approval');
select is((select v.version_status::text from public.document_versions v, pg_temp.coverage_cases c where v.id = c.candidate_version_id),
  'pending_approval', 'The candidate version remains ready for approval');
select lives_ok(format(
  'update public.findings set assignee_id = %L where id = %L',
  (select member_a_id from pg_temp.coverage_cases), (select finding_c_id from pg_temp.coverage_cases)
), 'The still-covered item can be reassigned back to its original reviewer');
select lives_ok(format(
  'update public.correction_round_items set assignee_id = %L, revision = revision + 1 where id = %L',
  (select member_a_id from pg_temp.coverage_cases), (select item_c from pg_temp.coverage_cases)
), 'Restoring assignment leaves the pending candidate coverage intact');

grant select on pg_temp.coverage_cases to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub', (select member_a_id::text from pg_temp.coverage_cases), true);
select is((select count(*)::integer from public.correction_submissions s, pg_temp.coverage_cases c where s.id = c.submission_id),
  0, 'A grouped file becomes private to its former submitter when any included assignment is revoked');
select is((select count(*)::integer from public.correction_round_items i, pg_temp.coverage_cases c where i.id = c.item_c),
  1, 'The former submitter can still read another finding that remains assigned');
select ok(not private.current_review_version_allowed((select candidate_version_id from pg_temp.coverage_cases)),
  'The revoked submitter cannot read the grouped correction file version');
select set_config('request.jwt.claim.sub', (select member_b_id::text from pg_temp.coverage_cases), true);
select is((select count(*)::integer from public.correction_submissions s, pg_temp.coverage_cases c where s.id = c.submission_id),
  0, 'The new assignee cannot read a correction file submitted by a previous Member');
select ok(not private.current_review_version_allowed((select candidate_version_id from pg_temp.coverage_cases)),
  'The new assignee cannot read the previous Member file through version capability');
reset role;

select finish();
rollback;
