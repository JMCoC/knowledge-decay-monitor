begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
\ir review-fixtures.psql
select no_plan();

create temporary table review_integrity_cases (
  case_name text primary key,
  workspace_id uuid not null
) on commit drop;
insert into pg_temp.review_integrity_cases values
  ('empty', pg_temp.create_review_fixture_case()),
  ('coverage', pg_temp.create_review_fixture_case()),
  ('direct', pg_temp.create_review_fixture_case()),
  ('stale', pg_temp.create_review_fixture_case());

create temporary table review_integrity_secondary_case (
  workspace_id uuid not null,
  analysis_id uuid not null,
  document_id uuid not null,
  version_id uuid not null,
  finding_id uuid not null
) on commit drop;
do $$
declare
  v_workspace uuid;
  v_admin uuid;
  v_member uuid;
  v_analysis uuid;
  v_document uuid;
  v_version uuid;
  v_chunk uuid;
  v_finding uuid;
begin
  select c.workspace_id, f.admin_id, f.member_a_id
  into strict v_workspace, v_admin, v_member
  from pg_temp.review_integrity_cases c
  join pg_temp.review_fixture_case f on f.workspace_id = c.workspace_id
  where c.case_name = 'empty';
  v_analysis := pg_temp.create_analysis_fixture(v_workspace, v_admin, 'completed', 1);
  select document_id, version_id, chunk_id
  into strict v_document, v_version, v_chunk
  from pg_temp.analysis_case where analysis_id = v_analysis and ordinal = 1;
  v_finding := pg_temp.insert_finding_row(v_analysis, v_workspace, 0.5);
  update public.findings set assignee_id = v_member where id = v_finding;
  perform pg_temp.insert_evidence_row(
    v_workspace, v_analysis, v_finding, v_document, v_version, v_chunk, 'Synthetic secondary evidence'
  );
  insert into pg_temp.review_integrity_secondary_case
  values (v_workspace, v_analysis, v_document, v_version, v_finding);
end;
$$;

create temporary table review_integrity_rounds (
  round_name text primary key,
  case_name text not null,
  round_id uuid not null
) on commit drop;
insert into public.correction_rounds(id, workspace_id, document_id, mode, base_version_id, created_by)
select gen_random_uuid(), f.workspace_id, f.document_id, 'assigned_findings', f.version_id, f.admin_id
from pg_temp.review_integrity_cases c
join pg_temp.review_fixture_case f on f.workspace_id = c.workspace_id
where c.case_name = 'empty';
insert into pg_temp.review_integrity_rounds
select 'empty_assigned', 'empty', r.id from public.correction_rounds r
join pg_temp.review_integrity_cases c on c.workspace_id = r.workspace_id
where c.case_name = 'empty' and r.mode = 'assigned_findings';

insert into public.correction_rounds(id, workspace_id, document_id, mode, base_version_id, created_by)
select gen_random_uuid(), f.workspace_id, s.document_id, 'administrative', s.version_id, f.admin_id
from pg_temp.review_integrity_cases c
join pg_temp.review_fixture_case f on f.workspace_id = c.workspace_id
join pg_temp.review_integrity_secondary_case s on s.workspace_id = f.workspace_id
where c.case_name = 'empty';
insert into pg_temp.review_integrity_rounds
select 'admin', 'empty', r.id from public.correction_rounds r
join pg_temp.review_integrity_secondary_case s on s.document_id = r.document_id
where r.mode = 'administrative';

insert into pg_temp.review_integrity_rounds
select 'coverage', 'coverage', pg_temp.create_review_round(
  f.workspace_id, 'assigned_findings', ARRAY[f.finding_a_id, f.finding_b_id, f.finding_c_id]
)
from pg_temp.review_integrity_cases c
join pg_temp.review_fixture_case f on f.workspace_id = c.workspace_id
where c.case_name = 'coverage';
insert into pg_temp.review_integrity_rounds
select 'direct', 'direct', pg_temp.create_review_round(
  f.workspace_id, 'assigned_findings', ARRAY[f.finding_a_id, f.finding_c_id]
)
from pg_temp.review_integrity_cases c
join pg_temp.review_fixture_case f on f.workspace_id = c.workspace_id
where c.case_name = 'direct';

create temporary table review_integrity_items (
  case_name text not null,
  finding_key text not null,
  item_id uuid not null,
  primary key (case_name, finding_key)
) on commit drop;
insert into pg_temp.review_integrity_items
select r.case_name,
  case when i.finding_id = f.finding_a_id then 'a'
       when i.finding_id = f.finding_b_id then 'b'
       when i.finding_id = f.finding_c_id then 'c' end,
  i.id
from pg_temp.review_integrity_rounds r
join pg_temp.review_integrity_cases c on c.case_name = r.case_name
join pg_temp.review_fixture_case f on f.workspace_id = c.workspace_id
join public.correction_round_items i on i.round_id = r.round_id
where r.case_name in ('coverage', 'direct');

create temporary table review_integrity_submissions (
  submission_name text primary key,
  submission_id uuid not null
) on commit drop;
create temporary table review_integrity_candidates (
  candidate_name text primary key,
  candidate_id uuid not null,
  version_id uuid
) on commit drop;

select throws_ok(format(
  'update public.correction_rounds set status = %L, opened_at = now(), revision = revision + 1 where id = %L',
  'collecting', (select round_id from pg_temp.review_integrity_rounds where round_name = 'empty_assigned')
), '23514', null, 'An assigned round cannot open without a fixed non-empty set');

select throws_ok(format(
  'insert into public.correction_round_items(workspace_id, round_id, document_id, finding_id, initial_assignee_id, assignee_id) '
  || 'select f.workspace_id, %L, f.document_id, s.finding_id, f.member_a_id, f.member_a_id '
  || 'from pg_temp.review_fixture_case f cross join pg_temp.review_integrity_secondary_case s '
  || 'where f.workspace_id = s.workspace_id and f.workspace_id = %L',
  (select round_id from pg_temp.review_integrity_rounds where round_name = 'empty_assigned'),
  (select workspace_id from pg_temp.review_integrity_cases where case_name = 'empty')
), '23514', null, 'A finding without evidence from the round document cannot be added');

select throws_ok(format(
  'insert into public.correction_round_items(workspace_id, round_id, document_id, finding_id, initial_assignee_id, assignee_id) '
  || 'select f.workspace_id, %L, s.document_id, s.finding_id, f.member_a_id, f.member_a_id '
  || 'from pg_temp.review_fixture_case f cross join pg_temp.review_integrity_secondary_case s '
  || 'where f.workspace_id = s.workspace_id and f.workspace_id = %L',
  (select round_id from pg_temp.review_integrity_rounds where round_name = 'admin'),
  (select workspace_id from pg_temp.review_integrity_cases where case_name = 'empty')
), '23514', null, 'An administrative proposal cannot acquire Member finding items');

insert into public.correction_round_items(
  workspace_id, round_id, document_id, finding_id, initial_assignee_id, assignee_id
)
select f.workspace_id, r.round_id, f.document_id, f.finding_a_id, f.member_a_id, f.member_a_id
from pg_temp.review_integrity_rounds r
join pg_temp.review_integrity_cases c on c.case_name = r.case_name
join pg_temp.review_fixture_case f on f.workspace_id = c.workspace_id
where r.round_name = 'empty_assigned';
select throws_ok(format(
  'update public.correction_rounds set status = %L, opened_at = now(), revision = revision + 1 where id = %L',
  'collecting', (select round_id from pg_temp.review_integrity_rounds where round_name = 'empty_assigned')
), '23514', null, 'A round cannot open while a selected finding is still pending review');
update public.findings set status = 'confirmed'
where id = (select f.finding_a_id from pg_temp.review_fixture_case f
  join pg_temp.review_integrity_cases c on c.workspace_id = f.workspace_id where c.case_name = 'empty');
select lives_ok(format(
  'update public.correction_rounds set status = %L, opened_at = now(), revision = revision + 1 where id = %L',
  'collecting', (select round_id from pg_temp.review_integrity_rounds where round_name = 'empty_assigned')
), 'An evidenced confirmed finding assigned to a Member can open');
select lives_ok(format(
  'update public.correction_rounds set status = %L, opened_at = now(), revision = revision + 1 where id = %L',
  'consolidating', (select round_id from pg_temp.review_integrity_rounds where round_name = 'admin')
), 'An administrative proposal opens directly to consolidation without Member items');
select throws_ok(format(
  'insert into public.correction_round_items(workspace_id, round_id, document_id, finding_id, initial_assignee_id, assignee_id) '
  || 'select f.workspace_id, %L, f.document_id, f.finding_c_id, f.member_a_id, f.member_a_id '
  || 'from pg_temp.review_fixture_case f where f.workspace_id = %L',
  (select round_id from pg_temp.review_integrity_rounds where round_name = 'empty_assigned'),
  (select workspace_id from pg_temp.review_integrity_cases where case_name = 'empty')
), '23514', null, 'The finding set is fixed after opening');

create temporary table review_integrity_historical_version(
  case_name text primary key,
  workspace_id uuid not null,
  document_id uuid not null,
  version_id uuid not null
) on commit drop;
do $$
declare
  f pg_temp.review_fixture_case%rowtype;
  v_case record;
  v_id uuid := gen_random_uuid();
begin
  for v_case in
    select c.case_name, c.workspace_id
    from pg_temp.review_integrity_cases c
    join pg_temp.review_fixture_case fixture_row on fixture_row.workspace_id = c.workspace_id
    where c.case_name in ('empty', 'stale')
  loop
    select x.* into strict f from pg_temp.review_fixture_case x where x.workspace_id = v_case.workspace_id;
    v_id := gen_random_uuid();
    insert into public.document_versions(id, workspace_id, document_id, version_number, storage_path,
      processing_status, version_status)
    values (v_id, f.workspace_id, f.document_id, 2,
      f.workspace_id::text || '/' || f.document_id::text || '/' || v_id::text || '/original.md',
      'ready', 'historical');
    insert into pg_temp.review_integrity_historical_version values
      (v_case.case_name, f.workspace_id, f.document_id, v_id);
  end loop;
end;
$$;
select throws_ok(format(
  'update public.correction_rounds set base_version_id = %L where id = %L',
  (select version_id from pg_temp.review_integrity_historical_version where case_name = 'empty'),
  (select round_id from pg_temp.review_integrity_rounds where round_name = 'empty_assigned')
), '23514', null, 'An opened round cannot change its base version');

create temporary table review_integrity_stale_round(round_id uuid not null) on commit drop;
do $$
declare
  f pg_temp.review_fixture_case%rowtype;
  v_round_id uuid := gen_random_uuid();
  v_finding_id uuid;
begin
  select x.* into strict f from pg_temp.review_fixture_case x
  join pg_temp.review_integrity_cases c on c.workspace_id = x.workspace_id
  where c.case_name = 'stale';
  update public.findings set status = 'confirmed' where id = f.finding_a_id;
  insert into public.correction_rounds(id, workspace_id, document_id, mode, base_version_id, created_by)
  values (v_round_id, f.workspace_id, f.document_id, 'assigned_findings',
    (select version_id from pg_temp.review_integrity_historical_version where case_name = 'stale'), f.admin_id);
  insert into public.correction_round_items(workspace_id, round_id, document_id, finding_id,
    initial_assignee_id, assignee_id)
  values (f.workspace_id, v_round_id, f.document_id, f.finding_a_id, f.member_a_id, f.member_a_id);
  insert into pg_temp.review_integrity_stale_round values (v_round_id);
end;
$$;
select throws_ok(format(
  'update public.correction_rounds set status = %L, opened_at = now(), revision = revision + 1 where id = %L',
  'collecting', (select round_id from pg_temp.review_integrity_stale_round)
), '23514', null, 'A correction round cannot open against a stale non-active version');

select is((select review_revision from public.findings where id =
  (select f.finding_a_id from pg_temp.review_fixture_case f
   join pg_temp.review_integrity_cases c on c.workspace_id = f.workspace_id where c.case_name = 'empty')),
  3::bigint, 'Human assignment and status mutations advance the finding review revision');
select throws_ok(format(
  'update public.findings set review_revision = review_revision + 1 where id = %L',
  (select f.finding_a_id from pg_temp.review_fixture_case f
   join pg_temp.review_integrity_cases c on c.workspace_id = f.workspace_id where c.case_name = 'empty')
), '23514', null, 'Review revision cannot change without a review mutation');

select throws_ok(format(
  'update public.correction_rounds set status = %L, revision = revision + 1 where id = %L',
  'consolidating', (select round_id from pg_temp.review_integrity_rounds where round_name = 'coverage')
), '23514', null, 'A Member round cannot consolidate before every item has confirmed coverage');
select throws_ok(format(
  'select pg_temp.create_review_submission(%L::uuid, %L::uuid, ARRAY[%L::uuid, %L::uuid])',
  (select round_id from pg_temp.review_integrity_rounds where round_name = 'coverage'),
  (select f.member_a_id from pg_temp.review_fixture_case f
   join pg_temp.review_integrity_cases c on c.workspace_id = f.workspace_id where c.case_name = 'coverage'),
  (select item_id from pg_temp.review_integrity_items where case_name = 'coverage' and finding_key = 'a'),
  (select item_id from pg_temp.review_integrity_items where case_name = 'coverage' and finding_key = 'b')
), '23514', null, 'One Member file cannot cover another Member finding');
select throws_ok(format(
  'select pg_temp.create_review_submission(%L::uuid, %L::uuid, ARRAY[%L::uuid])',
  (select round_id from pg_temp.review_integrity_rounds where round_name = 'coverage'),
  (select f.admin_id from pg_temp.review_fixture_case f
   join pg_temp.review_integrity_cases c on c.workspace_id = f.workspace_id where c.case_name = 'coverage'),
  (select item_id from pg_temp.review_integrity_items where case_name = 'coverage' and finding_key = 'a')
), '23514', null, 'Admin cannot submit a Member correction file');

insert into pg_temp.review_integrity_submissions
select 'member_a_group', pg_temp.create_review_submission(
  r.round_id, f.member_a_id, ARRAY[
    (select item_id from pg_temp.review_integrity_items where case_name = 'coverage' and finding_key = 'a'),
    (select item_id from pg_temp.review_integrity_items where case_name = 'coverage' and finding_key = 'c')
  ]
)
from pg_temp.review_integrity_rounds r
join pg_temp.review_integrity_cases c on c.case_name = r.case_name
join pg_temp.review_fixture_case f on f.workspace_id = c.workspace_id
where r.round_name = 'coverage';
select ok(not exists (
  select 1 from private.ingestion_jobs j
  join public.correction_submissions s on s.version_id = j.version_id
  where s.id = (select submission_id from pg_temp.review_integrity_submissions where submission_name = 'member_a_group')
), 'A confirmed intermediate Member submission does not create a processing job');
select throws_ok(format(
  'update public.correction_rounds set status = %L, revision = revision + 1 where id = %L',
  'consolidating', (select round_id from pg_temp.review_integrity_rounds where round_name = 'coverage')
), '23514', null, 'A partial group of files does not count as complete round coverage');
insert into pg_temp.review_integrity_submissions
select 'member_b_single', pg_temp.create_review_submission(
  r.round_id, f.member_b_id, ARRAY[
    (select item_id from pg_temp.review_integrity_items where case_name = 'coverage' and finding_key = 'b')
  ]
)
from pg_temp.review_integrity_rounds r
join pg_temp.review_integrity_cases c on c.case_name = r.case_name
join pg_temp.review_fixture_case f on f.workspace_id = c.workspace_id
where r.round_name = 'coverage';
select throws_ok(format(
  'select pg_temp.try_select_direct_review_candidate(%L::uuid, %L::uuid, %L::uuid)',
  (select round_id from pg_temp.review_integrity_rounds where round_name = 'coverage'),
  (select f.admin_id from pg_temp.review_fixture_case f
   join pg_temp.review_integrity_cases c on c.workspace_id = f.workspace_id where c.case_name = 'coverage'),
  (select submission_id from pg_temp.review_integrity_submissions where submission_name = 'member_a_group')
), '23514', null, 'A direct candidate cannot combine files from two Members');
select lives_ok(format(
  'update public.correction_rounds set status = %L, revision = revision + 1 where id = %L',
  'consolidating', (select round_id from pg_temp.review_integrity_rounds where round_name = 'coverage')
), 'Complete confirmed Member coverage can enter consolidation');

insert into pg_temp.review_integrity_candidates(candidate_name, candidate_id)
select 'coverage_failed', pg_temp.create_consolidated_candidate(r.round_id, f.admin_id)
from pg_temp.review_integrity_rounds r
join pg_temp.review_integrity_cases c on c.case_name = r.case_name
join pg_temp.review_fixture_case f on f.workspace_id = c.workspace_id
where r.round_name = 'coverage';
update pg_temp.review_integrity_candidates x
set version_id = c.version_id
from public.correction_candidates c where c.id = x.candidate_id;
select ok((select v.upload_state = 'confirmed' and c.status = 'reserved'
  from pg_temp.review_integrity_candidates x
  join public.correction_candidates c on c.id = x.candidate_id
  join public.document_versions v on v.id = x.version_id
  where x.candidate_name = 'coverage_failed'),
  'A reserved consolidated candidate can hold confirmed bytes without starting processing');
select ok(not exists (
  select 1 from private.ingestion_jobs j
  where j.version_id = (select version_id from pg_temp.review_integrity_candidates where candidate_name = 'coverage_failed')
), 'A reserved consolidated candidate does not create a processing job');
select throws_ok(format(
  'update public.document_versions set processing_status = %L where id = %L',
  'processing', (select version_id from pg_temp.review_integrity_candidates where candidate_name = 'coverage_failed')
), '23514', null, 'Reserved candidate cannot enqueue document processing');
select throws_ok(format(
  'insert into public.document_chunks(id, workspace_id, version_id, chunk_index, text_content, embedding) '
  || 'values (gen_random_uuid(), %L, %L, 0, %L, null::extensions.vector(384))',
  (select c.workspace_id from public.correction_candidates c
   join pg_temp.review_integrity_candidates x on x.candidate_id = c.id where x.candidate_name = 'coverage_failed'),
  (select version_id from pg_temp.review_integrity_candidates where candidate_name = 'coverage_failed'),
  'Synthetic pre-selection content'
), '23514', null, 'A correction upload cannot create chunks before candidate selection');
select throws_ok(format(
  'select pg_temp.create_consolidated_candidate(%L::uuid, %L::uuid)',
  (select round_id from pg_temp.review_integrity_rounds where round_name = 'coverage'),
  (select f.admin_id from pg_temp.review_fixture_case f
   join pg_temp.review_integrity_cases c on c.workspace_id = f.workspace_id where c.case_name = 'coverage')
), '23505', null, 'A round cannot reserve two live final candidates');
select throws_ok(format(
  'select pg_temp.try_select_candidate_without_items(%L::uuid)',
  (select candidate_id from pg_temp.review_integrity_candidates where candidate_name = 'coverage_failed')
), '23514', null, 'A selected candidate must snapshot complete coverage');
select pg_temp.select_review_candidate(
  (select candidate_id from pg_temp.review_integrity_candidates where candidate_name = 'coverage_failed')
);
select is((select count(*) from public.correction_candidate_items ci
  where ci.candidate_id = (select candidate_id from pg_temp.review_integrity_candidates where candidate_name = 'coverage_failed')),
  3::bigint, 'Consolidated candidate snapshots all three current item contributions');
select throws_ok(format(
  'update public.correction_candidate_items set item_revision = item_revision + 1 '
  || 'where candidate_id = %L and round_item_id = %L',
  (select candidate_id from pg_temp.review_integrity_candidates where candidate_name = 'coverage_failed'),
  (select item_id from pg_temp.review_integrity_items where case_name = 'coverage' and finding_key = 'a')
), '23514', null, 'Candidate coverage snapshot is immutable');
select throws_ok(format(
  'update public.correction_round_items set current_submission_id = null where id = %L',
  (select item_id from pg_temp.review_integrity_items where case_name = 'coverage' and finding_key = 'a')
), '23514', null, 'Live candidate coverage cannot be replaced before return or invalidation');

select pg_temp.fail_review_candidate(
  (select candidate_id from pg_temp.review_integrity_candidates where candidate_name = 'coverage_failed')
);
select is((select c.status::text from public.correction_candidates c
  where c.id = (select candidate_id from pg_temp.review_integrity_candidates where candidate_name = 'coverage_failed')),
  'failed', 'Worker failure leaves a failed candidate instead of human rejection');
select is((select v.version_status from public.document_versions v
  where v.id = (select version_id from pg_temp.review_integrity_candidates where candidate_name = 'coverage_failed')),
  null, 'Failed candidate version remains non-functional');
select ok((select v.processing_status = 'processing_failed'
  from public.document_versions v
  where v.id = (select version_id from pg_temp.review_integrity_candidates where candidate_name = 'coverage_failed')),
  'Failed candidate preserves its processing failure');
select ok((select count(*) = 0 from public.document_chunks c
  join public.correction_submissions s on s.version_id = c.version_id
  where s.id = (select submission_id from pg_temp.review_integrity_submissions where submission_name = 'member_a_group')),
  'Intermediate Member submissions never produce chunks');

create temporary table review_integrity_returns(return_id uuid not null) on commit drop;
insert into pg_temp.review_integrity_returns
select pg_temp.return_failed_review_item(
  (select candidate_id from pg_temp.review_integrity_candidates where candidate_name = 'coverage_failed'),
  (select item_id from pg_temp.review_integrity_items where case_name = 'coverage' and finding_key = 'b'),
  'Please update the section owned by this assignment.'
);
select is((select c.status::text from public.correction_candidates c
  where c.id = (select candidate_id from pg_temp.review_integrity_candidates where candidate_name = 'coverage_failed')),
  'invalidated', 'Returning one failed item invalidates that candidate attempt');
select is((select count(*) from public.correction_candidate_items ci
  where ci.candidate_id = (select candidate_id from pg_temp.review_integrity_candidates where candidate_name = 'coverage_failed')),
  3::bigint, 'The old candidate keeps its immutable full coverage snapshot');
select is((select count(*) from public.correction_round_items i
  where i.round_id = (select round_id from pg_temp.review_integrity_rounds where round_name = 'coverage')
    and i.finding_id in (
      select f.finding_a_id from pg_temp.review_fixture_case f
      join pg_temp.review_integrity_cases c on c.workspace_id = f.workspace_id where c.case_name = 'coverage'
      union all
      select f.finding_c_id from pg_temp.review_fixture_case f
      join pg_temp.review_integrity_cases c on c.workspace_id = f.workspace_id where c.case_name = 'coverage'
    ) and i.current_submission_id = (select submission_id from pg_temp.review_integrity_submissions where submission_name = 'member_a_group')),
  2::bigint, 'Returning one Member item preserves both unaffected contributions');
select is((select current_submission_id from public.correction_round_items i
  where i.id = (select item_id from pg_temp.review_integrity_items where case_name = 'coverage' and finding_key = 'b')),
  null, 'Only the returned item loses current coverage');
select ok((select v.processing_status = 'processing_failed' and v.version_status is null
  from public.document_versions v
  where v.id = (select version_id from pg_temp.review_integrity_candidates where candidate_name = 'coverage_failed')),
  'Invalidation does not mislabel a failed version as rejected');
select throws_ok(format(
  'delete from public.correction_candidates where id = %L',
  (select candidate_id from pg_temp.review_integrity_candidates where candidate_name = 'coverage_failed')
), '23514', null, 'Candidate attempt history is append-only');

insert into pg_temp.review_integrity_submissions
select 'member_b_resubmission', pg_temp.create_review_submission(
  r.round_id, f.member_b_id, ARRAY[
    (select item_id from pg_temp.review_integrity_items where case_name = 'coverage' and finding_key = 'b')
  ]
)
from pg_temp.review_integrity_rounds r
join pg_temp.review_integrity_cases c on c.case_name = r.case_name
join pg_temp.review_fixture_case f on f.workspace_id = c.workspace_id
where r.round_name = 'coverage';
update public.correction_rounds
set status = 'consolidating', revision = revision + 1
where id = (select round_id from pg_temp.review_integrity_rounds where round_name = 'coverage');
insert into pg_temp.review_integrity_candidates(candidate_name, candidate_id)
select 'coverage_replacement', pg_temp.create_consolidated_candidate(r.round_id, f.admin_id)
from pg_temp.review_integrity_rounds r
join pg_temp.review_integrity_cases c on c.case_name = r.case_name
join pg_temp.review_fixture_case f on f.workspace_id = c.workspace_id
where r.round_name = 'coverage';
update pg_temp.review_integrity_candidates x
set version_id = c.version_id from public.correction_candidates c where c.id = x.candidate_id;
select pg_temp.select_review_candidate(
  (select candidate_id from pg_temp.review_integrity_candidates where candidate_name = 'coverage_replacement')
);
select ok((select replacement.version_id <> failed.version_id
  from pg_temp.review_integrity_candidates replacement
  join pg_temp.review_integrity_candidates failed on failed.candidate_name = 'coverage_failed'
  where replacement.candidate_name = 'coverage_replacement'),
  'Replacement candidate uses a different immutable version');
select is((select ci.submission_id from public.correction_candidate_items ci
  where ci.candidate_id = (select candidate_id from pg_temp.review_integrity_candidates where candidate_name = 'coverage_replacement')
    and ci.round_item_id = (select item_id from pg_temp.review_integrity_items where case_name = 'coverage' and finding_key = 'b')),
  (select submission_id from pg_temp.review_integrity_submissions where submission_name = 'member_b_resubmission'),
  'Replacement candidate snapshots the new returned-item delivery');

insert into pg_temp.review_integrity_submissions
select 'direct_member_a_group', pg_temp.create_review_submission(
  r.round_id, f.member_a_id, ARRAY[
    (select item_id from pg_temp.review_integrity_items where case_name = 'direct' and finding_key = 'a'),
    (select item_id from pg_temp.review_integrity_items where case_name = 'direct' and finding_key = 'c')
  ]
)
from pg_temp.review_integrity_rounds r
join pg_temp.review_integrity_cases c on c.case_name = r.case_name
join pg_temp.review_fixture_case f on f.workspace_id = c.workspace_id
where r.round_name = 'direct';
insert into pg_temp.review_integrity_candidates(candidate_name, candidate_id)
select 'direct_valid', pg_temp.select_direct_review_candidate(
  r.round_id, f.admin_id,
  (select submission_id from pg_temp.review_integrity_submissions where submission_name = 'direct_member_a_group')
)
from pg_temp.review_integrity_rounds r
join pg_temp.review_integrity_cases c on c.case_name = r.case_name
join pg_temp.review_fixture_case f on f.workspace_id = c.workspace_id
where r.round_name = 'direct';
update pg_temp.review_integrity_candidates x
set version_id = c.version_id from public.correction_candidates c where c.id = x.candidate_id;
select is((select c.status::text from public.correction_candidates c
  where c.id = (select candidate_id from pg_temp.review_integrity_candidates where candidate_name = 'direct_valid')),
  'selected', 'One Member grouped submission can be selected directly');
select is((select c.version_id from public.correction_candidates c
  where c.id = (select candidate_id from pg_temp.review_integrity_candidates where candidate_name = 'direct_valid')),
  (select s.version_id from public.correction_submissions s
   where s.id = (select submission_id from pg_temp.review_integrity_submissions where submission_name = 'direct_member_a_group')),
  'Direct selection preserves the original submission version');

insert into pg_temp.review_integrity_candidates(candidate_name, candidate_id)
select 'admin_rejected', pg_temp.create_consolidated_candidate(r.round_id, f.admin_id, false)
from pg_temp.review_integrity_rounds r
join pg_temp.review_integrity_cases c on c.case_name = r.case_name
join pg_temp.review_fixture_case f on f.workspace_id = c.workspace_id
where r.round_name = 'admin';
update pg_temp.review_integrity_candidates x
set version_id = c.version_id from public.correction_candidates c where c.id = x.candidate_id;
select throws_ok(format(
  'update public.correction_candidates set status = %L, revision = revision + 1 where id = %L',
  'selected', (select candidate_id from pg_temp.review_integrity_candidates where candidate_name = 'admin_rejected')
), '23514', null, 'Consolidated candidate cannot be selected before upload confirmation');
select pg_temp.confirm_review_upload(
  (select version_id from pg_temp.review_integrity_candidates where candidate_name = 'admin_rejected')
);
select pg_temp.select_review_candidate(
  (select candidate_id from pg_temp.review_integrity_candidates where candidate_name = 'admin_rejected')
);
select pg_temp.complete_review_candidate(
  (select candidate_id from pg_temp.review_integrity_candidates where candidate_name = 'admin_rejected')
);
insert into public.correction_candidate_decisions(
  workspace_id, round_id, document_id, candidate_id, actor_id, outcome, private_reason
)
select c.workspace_id, c.round_id, c.document_id, c.id, c.selected_by,
  'rejected', 'Synthetic administrative proposal was declined.'
from public.correction_candidates c
where c.id = (select candidate_id from pg_temp.review_integrity_candidates where candidate_name = 'admin_rejected');
update public.correction_candidates
set status = 'rejected', revision = revision + 1
where id = (select candidate_id from pg_temp.review_integrity_candidates where candidate_name = 'admin_rejected');
update public.document_versions set version_status = 'rejected'
where id = (select version_id from pg_temp.review_integrity_candidates where candidate_name = 'admin_rejected');
update public.correction_rounds
set status = 'consolidating', active_candidate_id = null, revision = revision + 1
where id = (select round_id from pg_temp.review_integrity_rounds where round_name = 'admin');
select is((select v.version_status::text from public.document_versions v
  where v.id = (select version_id from pg_temp.review_integrity_candidates where candidate_name = 'admin_rejected')),
  'rejected', 'Only a ready rejected candidate receives rejected functional status');
select is((select count(*) from public.correction_return_items ri
  where ri.return_id in (select id from public.correction_returns where round_id =
    (select round_id from pg_temp.review_integrity_rounds where round_name = 'admin'))),
  0::bigint, 'Administrative rejection does not fabricate Member return items');
insert into pg_temp.review_integrity_candidates(candidate_name, candidate_id)
select 'admin_replacement', pg_temp.create_consolidated_candidate(r.round_id, f.admin_id)
from pg_temp.review_integrity_rounds r
join pg_temp.review_integrity_cases c on c.case_name = r.case_name
join pg_temp.review_fixture_case f on f.workspace_id = c.workspace_id
where r.round_name = 'admin';
update pg_temp.review_integrity_candidates x
set version_id = c.version_id from public.correction_candidates c where c.id = x.candidate_id;
select ok((select rejected.version_id <> replacement.version_id
  from pg_temp.review_integrity_candidates rejected
  join pg_temp.review_integrity_candidates replacement on true
  where rejected.candidate_name = 'admin_rejected' and replacement.candidate_name = 'admin_replacement'),
  'A rejected version is retained and a later candidate reserves another version');

select * from finish();
rollback;
