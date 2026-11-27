begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
\ir review-fixtures.psql
select no_plan();

create temporary table s3_04_cases (
  case_name text primary key,
  workspace_id uuid not null
) on commit drop;
insert into s3_04_cases values
  ('base', pg_temp.create_review_fixture_case()),
  ('expire', pg_temp.create_review_fixture_case()),
  ('candidate', pg_temp.create_review_fixture_case()),
  ('verifying', pg_temp.create_review_fixture_case());

create temporary table s3_04_context on commit drop as
select c.case_name, f.*
from s3_04_cases c
join pg_temp.review_fixture_case f on f.workspace_id = c.workspace_id;

-- 1. Atomic version allocation.
select is(
  private.allocate_document_version_number(
    (select document_id from s3_04_context where case_name = 'base'),
    (select workspace_id from s3_04_context where case_name = 'base')
  ),
  2,
  'allocate_document_version_number returns v2 for a document with v1'
);

-- 2. Documents without versions cannot allocate correction numbers.
create temporary table s3_04_empty_document on commit drop as
select gen_random_uuid() as document_id, workspace_id, admin_id
from s3_04_context where case_name = 'base';

insert into public.documents(id, workspace_id, name, category, owner_id)
select document_id, workspace_id, 'S3-04 empty document', 'SOP', admin_id
from s3_04_empty_document;

select throws_ok(
  format(
    'select private.allocate_document_version_number(%L, %L)',
    (select document_id from s3_04_empty_document),
    (select workspace_id from s3_04_empty_document)
  ),
  '23514',
  'Allocated version_number must be > 1 for corrections.',
  'allocate_document_version_number rejects a document without versions'
);

-- 3. Expired reservations are swept atomically.
create temporary table s3_04_expire_round on commit drop as
select workspace_id, admin_id, member_a_id, finding_a_id,
  pg_temp.create_review_round(
    workspace_id, 'assigned_findings', ARRAY[finding_a_id]
  ) as round_id
from s3_04_context where case_name = 'expire';

create temporary table s3_04_expire_item on commit drop as
select r.workspace_id, r.round_id, i.id as item_id
from s3_04_expire_round r
join public.correction_round_items i
  on i.round_id = r.round_id and i.finding_id = r.finding_a_id;

create temporary table s3_04_expire_submission on commit drop as
select pg_temp.create_review_reservation(
    r.round_id, r.member_a_id, ARRAY[i.item_id], true
  ) as submission_id,
  null::uuid as workspace_id,
  null::uuid as version_id,
  null::uuid as submitter_id
from s3_04_expire_round r
join s3_04_expire_item i on i.round_id = r.round_id;

update s3_04_expire_submission x
set workspace_id = s.workspace_id,
    version_id = s.version_id,
    submitter_id = s.submitter_id
from public.correction_submissions s
where s.id = x.submission_id;

set local session_replication_role = replica;
update public.correction_submissions
set expires_at = now() - interval '1 second'
where id = (select submission_id from s3_04_expire_submission);
set local session_replication_role = origin;

create temporary table s3_04_expire_result on commit drop as
select * from public.expire_stale_correction_reservations(100);

select is(
  (select outcome from s3_04_expire_result
    where submission_id = (select submission_id from s3_04_expire_submission)),
  'expired',
  'sweep expires a TTL-expired reservation'
);

select ok(
  (select state = 'expired' from public.correction_submissions
    where id = (select submission_id from s3_04_expire_submission))
  and (select upload_state = 'rejected' from public.document_versions
    where id = (select version_id from s3_04_expire_submission))
  and (select retired_at is not null from public.document_upload_attempts
    where version_id = (select version_id from s3_04_expire_submission))
  and exists (
    select 1 from public.audit_events
    where action = 'correction_submission_expired'
      and entity_id = (select submission_id from s3_04_expire_submission)
      and actor_id = (select submitter_id from s3_04_expire_submission)
      and metadata->>'reason' = 'ttl_expired'
  ),
  'sweep expires submission, rejects version, retires attempt, and audits'
);

-- 4. A live candidate protects the round from reservation expiry.
create temporary table s3_04_candidate_round on commit drop as
select workspace_id, admin_id, member_a_id, finding_a_id,
  pg_temp.create_review_round(
    workspace_id, 'assigned_findings', ARRAY[finding_a_id]
  ) as round_id
from s3_04_context where case_name = 'candidate';

create temporary table s3_04_candidate_item on commit drop as
select r.workspace_id, r.round_id, i.id as item_id
from s3_04_candidate_round r
join public.correction_round_items i
  on i.round_id = r.round_id and i.finding_id = r.finding_a_id;

create temporary table s3_04_candidate_submission on commit drop as
select pg_temp.create_review_reservation(
    r.round_id, r.member_a_id, ARRAY[i.item_id], true
  ) as submission_id,
  null::uuid as workspace_id,
  null::uuid as version_id
from s3_04_candidate_round r
join s3_04_candidate_item i on i.round_id = r.round_id;

update s3_04_candidate_submission x
set workspace_id = s.workspace_id,
    version_id = s.version_id
from public.correction_submissions s
where s.id = x.submission_id;

select pg_temp.create_review_submission(
  r.round_id, r.member_a_id, ARRAY[i.item_id]
)
from s3_04_candidate_round r
join s3_04_candidate_item i on i.round_id = r.round_id;

update public.correction_rounds r
set status = 'consolidating', revision = revision + 1
where r.id = (select round_id from s3_04_candidate_round);

select pg_temp.create_consolidated_candidate(r.round_id, r.admin_id, true)
from s3_04_candidate_round r;

set local session_replication_role = replica;
update public.correction_submissions
set expires_at = now() - interval '1 second'
where id = (select submission_id from s3_04_candidate_submission);
set local session_replication_role = origin;

create temporary table s3_04_candidate_result on commit drop as
select * from public.expire_stale_correction_reservations(100);

select is(
  (select outcome from s3_04_candidate_result
    where submission_id = (select submission_id from s3_04_candidate_submission)),
  'skipped_candidate_alive',
  'sweep skips a reservation when the round has a live candidate'
);

-- 5. Active verifying leases are never expired by the sweep.
create temporary table s3_04_verifying_round on commit drop as
select workspace_id, admin_id, member_a_id, finding_a_id,
  pg_temp.create_review_round(
    workspace_id, 'assigned_findings', ARRAY[finding_a_id]
  ) as round_id
from s3_04_context where case_name = 'verifying';

create temporary table s3_04_verifying_item on commit drop as
select r.workspace_id, r.round_id, i.id as item_id
from s3_04_verifying_round r
join public.correction_round_items i
  on i.round_id = r.round_id and i.finding_id = r.finding_a_id;

create temporary table s3_04_verifying_submission on commit drop as
select pg_temp.create_review_reservation(
    r.round_id, r.member_a_id, ARRAY[i.item_id], true
  ) as submission_id,
  null::uuid as workspace_id,
  null::uuid as version_id
from s3_04_verifying_round r
join s3_04_verifying_item i on i.round_id = r.round_id;

update s3_04_verifying_submission x
set workspace_id = s.workspace_id,
    version_id = s.version_id
from public.correction_submissions s
where s.id = x.submission_id;

update public.document_versions
set upload_state = 'verifying',
    upload_operation_id = gen_random_uuid(),
    upload_lease_expires_at = now() + interval '1 hour'
where id = (select version_id from s3_04_verifying_submission);

set local session_replication_role = replica;
update public.correction_submissions
set expires_at = now() - interval '1 second'
where id = (select submission_id from s3_04_verifying_submission);
set local session_replication_role = origin;

create temporary table s3_04_verifying_result on commit drop as
select * from public.expire_stale_correction_reservations(100);

select is(
  (select outcome from s3_04_verifying_result
    where submission_id = (select submission_id from s3_04_verifying_submission)),
  'skipped_not_confirmed',
  'sweep skips a reservation whose version has an active verifying lease'
);

-- 6. Only service_role may execute the system sweep.
select ok(
  has_function_privilege(
    'service_role',
    'public.expire_stale_correction_reservations(integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.expire_stale_correction_reservations(integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.expire_stale_correction_reservations(integer)',
    'EXECUTE'
  ),
  'only service_role can execute the sweep'
);

set local role anon;
select throws_ok(
  'select public.expire_stale_correction_reservations(1)',
  '42501',
  'permission denied for function expire_stale_correction_reservations',
  'anon cannot execute the sweep'
);
reset role;

set local role authenticated;
select throws_ok(
  'select public.expire_stale_correction_reservations(1)',
  '42501',
  'permission denied for function expire_stale_correction_reservations',
  'authenticated cannot execute the sweep'
);
reset role;

select * from finish();
rollback;
