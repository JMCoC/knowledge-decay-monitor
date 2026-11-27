begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
\ir review-fixtures.psql
select no_plan();

update private.upload_control set mode = 'active', updated_at = now() where singleton;

create temporary table s3_04_cases (
  case_name text primary key,
  workspace_id uuid not null
) on commit drop;
insert into s3_04_cases values
  ('success', pg_temp.create_review_fixture_case()),
  ('actor_other', pg_temp.create_review_fixture_case()),
  ('round_status', pg_temp.create_review_fixture_case()),
  ('round_doc', pg_temp.create_review_fixture_case()),
  ('finding_missing', pg_temp.create_review_fixture_case()),
  ('item_assignee', pg_temp.create_review_fixture_case()),
  ('item_revision', pg_temp.create_review_fixture_case()),
  ('finding_status', pg_temp.create_review_fixture_case()),
  ('empty', pg_temp.create_review_fixture_case()),
  ('cardinality', pg_temp.create_review_fixture_case()),
  ('extension', pg_temp.create_review_fixture_case()),
  ('size', pg_temp.create_review_fixture_case()),
  ('previous', pg_temp.create_review_fixture_case()),
  ('grants', pg_temp.create_review_fixture_case());

create temporary table s3_04_ctx on commit drop as
select c.case_name, f.*
from s3_04_cases c
join pg_temp.review_fixture_case f on f.workspace_id = c.workspace_id;

create temporary table s3_04_rounds on commit drop as
select c.case_name, c.workspace_id, c.document_id, c.version_id as base_version_id,
  c.admin_id, c.member_a_id, c.member_b_id, c.finding_a_id, c.finding_b_id,
  c.finding_c_id,
  pg_temp.create_review_round(
    c.workspace_id, 'assigned_findings', array[c.finding_a_id]
  ) as round_id
from s3_04_ctx c;

create temporary table s3_04_items on commit drop as
select r.case_name, i.id as item_id, i.revision, i.assignee_id
from s3_04_rounds r
join public.correction_round_items i
  on i.round_id = r.round_id and i.finding_id = r.finding_a_id;

-- 1. A successful reservation creates submission, items, vN, and attempt.
create temporary table s3_04_success on commit drop as
select *
from public.reserve_correction_upload(
  (select member_a_id from s3_04_ctx where case_name = 'success'),
  (select workspace_id from s3_04_ctx where case_name = 'success'),
  'reserve-success',
  repeat('b', 64),
  (select round_id from s3_04_rounds where case_name = 'success'),
  (select document_id from s3_04_ctx where case_name = 'success'),
  (select array[finding_a_id] from s3_04_ctx where case_name = 'success'),
  (select array[revision] from s3_04_items where case_name = 'success'),
  (select version_id from s3_04_ctx where case_name = 'success'),
  'md',
  123,
  repeat('a', 64)
);

select is(
  (select count(*) from pg_attribute
    where attrelid = 's3_04_success'::regclass and attnum > 0 and not attisdropped),
  7::bigint,
  'reserve_correction_upload returns seven columns'
);
select is(
  (select count(*) from s3_04_success),
  1::bigint,
  'a successful reservation returns one target row'
);
select is(
  (select canonical_mime_type from s3_04_success),
  'text/markdown',
  'the target carries the canonical Markdown MIME type'
);
select is(
  (select upload_state from s3_04_success),
  'pending'::public.upload_state,
  'the target starts in pending upload state'
);
select ok(
  (select expires_at > now() from s3_04_success),
  'the target has a future expiration'
);
select is(
  (select count(*) from public.correction_submissions s
    join s3_04_success t on t.submission_id = s.id
    where s.state = 'reserved'
      and s.submitter_id = (select member_a_id from s3_04_ctx where case_name = 'success')
      and s.idempotency_key = 'reserve-success'
      and s.request_fingerprint = repeat('b', 64)
      and s.previous_submission_id is null),
  1::bigint,
  'the reservation is stored with its key, fingerprint, and no previous submission'
);
select is(
  (select s.expires_at - s.reserved_at from public.correction_submissions s
    join s3_04_success t on t.submission_id = s.id),
  interval '24 hours',
  'the reservation window is exactly 24 hours'
);
select is(
  (select count(*) from public.correction_submission_items si
    join s3_04_success t on t.submission_id = si.submission_id
    join s3_04_items i on i.case_name = 'success' and i.item_id = si.round_item_id
    where si.assignee_at_submit_id = (select member_a_id from s3_04_ctx where case_name = 'success')
      and si.expected_revision = i.revision),
  1::bigint,
  'the reservation snapshots one item with the submitter and current revision'
);
select is(
  (select v.version_number from public.document_versions v
    join s3_04_success t on t.version_id = v.id),
  2,
  'the correction version is v2, never v1'
);
select is(
  (select v.workflow_kind from public.document_versions v
    join s3_04_success t on t.version_id = v.id),
  'correction_submission',
  'the version carries correction submission provenance'
);
select is(
  (select v.idempotency_key from public.document_versions v
    join s3_04_success t on t.version_id = v.id),
  null::uuid,
  'version idempotency is owned by the submission, not the version'
);
select is(
  (select v.request_fingerprint from public.document_versions v
    join s3_04_success t on t.version_id = v.id),
  null::text,
  'version fingerprint is owned by the submission, not the version'
);
select is(
  (select v.current_upload_attempt_id from public.document_versions v
    join s3_04_success t on t.version_id = v.id),
  (select attempt_id from s3_04_success),
  'the version points at the new attempt'
);
select is(
  (select count(*) from public.document_upload_attempts a
    join s3_04_success t on a.id = t.attempt_id and a.version_id = t.version_id
    where a.storage_path = (select storage_path from s3_04_success)),
  1::bigint,
  'the attempt exists with the returned transfer path'
);

-- 2. Replaying the same key and fingerprint returns the same target.
create temporary table s3_04_replay on commit drop as
select *
from public.reserve_correction_upload(
  (select member_a_id from s3_04_ctx where case_name = 'success'),
  (select workspace_id from s3_04_ctx where case_name = 'success'),
  'reserve-success',
  repeat('b', 64),
  (select round_id from s3_04_rounds where case_name = 'success'),
  (select document_id from s3_04_ctx where case_name = 'success'),
  (select array[finding_a_id] from s3_04_ctx where case_name = 'success'),
  (select array[revision] from s3_04_items where case_name = 'success'),
  (select version_id from s3_04_ctx where case_name = 'success'),
  'md',
  123,
  repeat('a', 64)
);

select is(
  (select submission_id from s3_04_replay),
  (select submission_id from s3_04_success),
  'replay returns the original submission'
);
select is(
  (select version_id from s3_04_replay),
  (select version_id from s3_04_success),
  'replay returns the original version'
);
select is(
  (select attempt_id from s3_04_replay),
  (select attempt_id from s3_04_success),
  'replay returns the original attempt'
);
select is(
  (select count(*) from public.document_versions v
    join s3_04_ctx c on c.case_name = 'success' and v.document_id = c.document_id),
  2::bigint,
  'replay does not allocate another version'
);
select is(
  (select count(*) from public.correction_submissions s
    where s.round_id = (select round_id from s3_04_rounds where case_name = 'success')),
  1::bigint,
  'replay does not create another submission'
);

-- 3. A different fingerprint for the same key is a conflict.
select throws_ok(
  format(
    'select * from public.reserve_correction_upload(%L, %L, %L, %L, %L, %L, %L::uuid[], %L::bigint[], %L, %L, %s, %L)',
    (select member_a_id from s3_04_ctx where case_name = 'success'),
    (select workspace_id from s3_04_ctx where case_name = 'success'),
    'reserve-success',
    repeat('c', 64),
    (select round_id from s3_04_rounds where case_name = 'success'),
    (select document_id from s3_04_ctx where case_name = 'success'),
    (select array[finding_a_id] from s3_04_ctx where case_name = 'success'),
    (select array[revision] from s3_04_items where case_name = 'success'),
    (select version_id from s3_04_ctx where case_name = 'success'),
    'md',
    123,
    repeat('a', 64)
  ),
  '23505',
  null,
  'a different fingerprint for the same key is a conflict'
);

-- 4. Only Member profiles may reserve.
select throws_ok(
  format(
    'select * from public.reserve_correction_upload(%L, %L, %L, %L, %L, %L, %L::uuid[], %L::bigint[], %L, %L, %s, %L)',
    (select admin_id from s3_04_ctx where case_name = 'success'),
    (select workspace_id from s3_04_ctx where case_name = 'success'),
    'actor-admin',
    repeat('b', 64),
    (select round_id from s3_04_rounds where case_name = 'success'),
    (select document_id from s3_04_ctx where case_name = 'success'),
    (select array[finding_a_id] from s3_04_ctx where case_name = 'success'),
    (select array[revision] from s3_04_items where case_name = 'success'),
    (select version_id from s3_04_ctx where case_name = 'success'),
    'md',
    123,
    repeat('a', 64)
  ),
  '42501',
  null,
  'an Admin cannot reserve a Member correction upload'
);

-- 5. A Member from another workspace is rejected.
select throws_ok(
  format(
    'select * from public.reserve_correction_upload(%L, %L, %L, %L, %L, %L, %L::uuid[], %L::bigint[], %L, %L, %s, %L)',
    (select member_a_id from s3_04_ctx where case_name = 'success'),
    (select workspace_id from s3_04_ctx where case_name = 'actor_other'),
    'actor-other-workspace',
    repeat('b', 64),
    (select round_id from s3_04_rounds where case_name = 'actor_other'),
    (select document_id from s3_04_ctx where case_name = 'actor_other'),
    (select array[finding_a_id] from s3_04_ctx where case_name = 'actor_other'),
    (select array[revision] from s3_04_items where case_name = 'actor_other'),
    (select version_id from s3_04_ctx where case_name = 'actor_other'),
    'md',
    123,
    repeat('a', 64)
  ),
  '42501',
  null,
  'a Member cannot reserve in another workspace'
);

-- 6. The round must be collecting.
update public.correction_rounds r
set status = 'cancelled', revision = revision + 1
from s3_04_rounds x
where r.id = x.round_id and x.case_name = 'round_status';

select throws_ok(
  format(
    'select * from public.reserve_correction_upload(%L, %L, %L, %L, %L, %L, %L::uuid[], %L::bigint[], %L, %L, %s, %L)',
    (select member_a_id from s3_04_ctx where case_name = 'round_status'),
    (select workspace_id from s3_04_ctx where case_name = 'round_status'),
    'round-status',
    repeat('b', 64),
    (select round_id from s3_04_rounds where case_name = 'round_status'),
    (select document_id from s3_04_ctx where case_name = 'round_status'),
    (select array[finding_a_id] from s3_04_ctx where case_name = 'round_status'),
    (select array[revision] from s3_04_items where case_name = 'round_status'),
    (select version_id from s3_04_ctx where case_name = 'round_status'),
    'md',
    123,
    repeat('a', 64)
  ),
  '23514',
  null,
  'a non-collecting round rejects the reservation'
);

-- 7. The round must belong to the locked document.
create temporary table s3_04_second_doc on commit drop as
select r.workspace_id, r.member_a_id as owner_id,
  gen_random_uuid() as document_id, gen_random_uuid() as version_id
from s3_04_rounds r
where r.case_name = 'round_doc';

insert into public.documents(id, workspace_id, name, category, owner_id)
select document_id, workspace_id, 'S3-04 second document', 'SOP', owner_id
from s3_04_second_doc;

insert into public.document_versions(
  id, workspace_id, document_id, version_number, storage_path,
  processing_status, version_status, size_bytes
)
select version_id, workspace_id, document_id, 1,
  workspace_id::text || '/' || document_id::text || '/' || version_id::text || '/original.md',
  'ready', 'active', 1
from s3_04_second_doc;

update public.documents d
set active_version_id = s.version_id
from s3_04_second_doc s
where d.id = s.document_id;

select throws_ok(
  format(
    'select * from public.reserve_correction_upload(%L, %L, %L, %L, %L, %L, %L::uuid[], %L::bigint[], %L, %L, %s, %L)',
    (select member_a_id from s3_04_ctx where case_name = 'round_doc'),
    (select workspace_id from s3_04_ctx where case_name = 'round_doc'),
    'round-other-document',
    repeat('b', 64),
    (select round_id from s3_04_rounds where case_name = 'round_doc'),
    (select document_id from s3_04_second_doc),
    (select array[finding_a_id] from s3_04_ctx where case_name = 'round_doc'),
    (select array[revision] from s3_04_items where case_name = 'round_doc'),
    (select version_id from s3_04_second_doc),
    'md',
    123,
    repeat('a', 64)
  ),
  '23514',
  null,
  'a round from another document rejects the reservation'
);

-- 8. A changed active base is a conflict, without rebase.
select throws_ok(
  format(
    'select * from public.reserve_correction_upload(%L, %L, %L, %L, %L, %L, %L::uuid[], %L::bigint[], %L, %L, %s, %L)',
    (select member_a_id from s3_04_ctx where case_name = 'success'),
    (select workspace_id from s3_04_ctx where case_name = 'success'),
    'base-changed',
    repeat('b', 64),
    (select round_id from s3_04_rounds where case_name = 'success'),
    (select document_id from s3_04_ctx where case_name = 'success'),
    (select array[finding_a_id] from s3_04_ctx where case_name = 'success'),
    (select array[revision] from s3_04_items where case_name = 'success'),
    (select version_id from s3_04_success),
    'md',
    123,
    repeat('a', 64)
  ),
  '23514',
  null,
  'a changed active base rejects the reservation'
);

-- 9. Every selected finding needs a round item.
select throws_ok(
  format(
    'select * from public.reserve_correction_upload(%L, %L, %L, %L, %L, %L, %L::uuid[], %L::bigint[], %L, %L, %s, %L)',
    (select member_a_id from s3_04_ctx where case_name = 'finding_missing'),
    (select workspace_id from s3_04_ctx where case_name = 'finding_missing'),
    'finding-without-item',
    repeat('b', 64),
    (select round_id from s3_04_rounds where case_name = 'finding_missing'),
    (select document_id from s3_04_ctx where case_name = 'finding_missing'),
    (select array[finding_c_id] from s3_04_ctx where case_name = 'finding_missing'),
    (select array[1::bigint]),
    (select version_id from s3_04_ctx where case_name = 'finding_missing'),
    'md',
    123,
    repeat('a', 64)
  ),
  'P0002',
  null,
  'a finding without a round item is unavailable'
);

-- 10. The round item must be assigned to the actor.
select throws_ok(
  format(
    'select * from public.reserve_correction_upload(%L, %L, %L, %L, %L, %L, %L::uuid[], %L::bigint[], %L, %L, %s, %L)',
    (select member_b_id from s3_04_ctx where case_name = 'item_assignee'),
    (select workspace_id from s3_04_ctx where case_name = 'item_assignee'),
    'item-assignee',
    repeat('b', 64),
    (select round_id from s3_04_rounds where case_name = 'item_assignee'),
    (select document_id from s3_04_ctx where case_name = 'item_assignee'),
    (select array[finding_a_id] from s3_04_ctx where case_name = 'item_assignee'),
    (select array[revision] from s3_04_items where case_name = 'item_assignee'),
    (select version_id from s3_04_ctx where case_name = 'item_assignee'),
    'md',
    123,
    repeat('a', 64)
  ),
  '42501',
  null,
  'an item assigned to another Member rejects the reservation'
);

-- 11. The expected item revision must match.
select throws_ok(
  format(
    'select * from public.reserve_correction_upload(%L, %L, %L, %L, %L, %L, %L::uuid[], %L::bigint[], %L, %L, %s, %L)',
    (select member_a_id from s3_04_ctx where case_name = 'item_revision'),
    (select workspace_id from s3_04_ctx where case_name = 'item_revision'),
    'item-revision',
    repeat('b', 64),
    (select round_id from s3_04_rounds where case_name = 'item_revision'),
    (select document_id from s3_04_ctx where case_name = 'item_revision'),
    (select array[finding_a_id] from s3_04_ctx where case_name = 'item_revision'),
    (select array[revision + 1] from s3_04_items where case_name = 'item_revision'),
    (select version_id from s3_04_ctx where case_name = 'item_revision'),
    'md',
    123,
    repeat('a', 64)
  ),
  '23514',
  null,
  'a stale item revision rejects the reservation'
);

-- 12. The finding must remain confirmed or update_planned.
update public.findings f
set status = 'pending_review'
from s3_04_ctx c
where f.id = c.finding_a_id and c.case_name = 'finding_status';

select throws_ok(
  format(
    'select * from public.reserve_correction_upload(%L, %L, %L, %L, %L, %L, %L::uuid[], %L::bigint[], %L, %L, %s, %L)',
    (select member_a_id from s3_04_ctx where case_name = 'finding_status'),
    (select workspace_id from s3_04_ctx where case_name = 'finding_status'),
    'finding-status',
    repeat('b', 64),
    (select round_id from s3_04_rounds where case_name = 'finding_status'),
    (select document_id from s3_04_ctx where case_name = 'finding_status'),
    (select array[finding_a_id] from s3_04_ctx where case_name = 'finding_status'),
    (select array[revision] from s3_04_items where case_name = 'finding_status'),
    (select version_id from s3_04_ctx where case_name = 'finding_status'),
    'md',
    123,
    repeat('a', 64)
  ),
  '23514',
  null,
  'an ineligible finding rejects the reservation'
);

-- 13. Empty finding selection is invalid input.
select throws_ok(
  format(
    'select * from public.reserve_correction_upload(%L, %L, %L, %L, %L, %L, %L::uuid[], %L::bigint[], %L, %L, %s, %L)',
    (select member_a_id from s3_04_ctx where case_name = 'empty'),
    (select workspace_id from s3_04_ctx where case_name = 'empty'),
    'empty-findings',
    repeat('b', 64),
    (select round_id from s3_04_rounds where case_name = 'empty'),
    (select document_id from s3_04_ctx where case_name = 'empty'),
    '{}'::uuid[],
    '{}'::bigint[],
    (select version_id from s3_04_ctx where case_name = 'empty'),
    'md',
    123,
    repeat('a', 64)
  ),
  '22023',
  null,
  'an empty finding selection is invalid input'
);

-- 14. Finding and revision arrays must have equal cardinality.
select throws_ok(
  format(
    'select * from public.reserve_correction_upload(%L, %L, %L, %L, %L, %L, %L::uuid[], %L::bigint[], %L, %L, %s, %L)',
    (select member_a_id from s3_04_ctx where case_name = 'cardinality'),
    (select workspace_id from s3_04_ctx where case_name = 'cardinality'),
    'cardinality',
    repeat('b', 64),
    (select round_id from s3_04_rounds where case_name = 'cardinality'),
    (select document_id from s3_04_ctx where case_name = 'cardinality'),
    (select array[finding_a_id, finding_b_id] from s3_04_ctx where case_name = 'cardinality'),
    (select array[revision] from s3_04_items where case_name = 'cardinality'),
    (select version_id from s3_04_ctx where case_name = 'cardinality'),
    'md',
    123,
    repeat('a', 64)
  ),
  '22023',
  null,
  'mismatched finding and revision arrays are invalid input'
);

-- 15. Only PDF, DOCX, and Markdown extensions are accepted.
select throws_ok(
  format(
    'select * from public.reserve_correction_upload(%L, %L, %L, %L, %L, %L, %L::uuid[], %L::bigint[], %L, %L, %s, %L)',
    (select member_a_id from s3_04_ctx where case_name = 'extension'),
    (select workspace_id from s3_04_ctx where case_name = 'extension'),
    'extension',
    repeat('b', 64),
    (select round_id from s3_04_rounds where case_name = 'extension'),
    (select document_id from s3_04_ctx where case_name = 'extension'),
    (select array[finding_a_id] from s3_04_ctx where case_name = 'extension'),
    (select array[revision] from s3_04_items where case_name = 'extension'),
    (select version_id from s3_04_ctx where case_name = 'extension'),
    'exe',
    123,
    repeat('a', 64)
  ),
  '22023',
  null,
  'an invalid extension is rejected'
);

-- 16. The file size is capped at 10 MiB.
select throws_ok(
  format(
    'select * from public.reserve_correction_upload(%L, %L, %L, %L, %L, %L, %L::uuid[], %L::bigint[], %L, %L, %s, %L)',
    (select member_a_id from s3_04_ctx where case_name = 'size'),
    (select workspace_id from s3_04_ctx where case_name = 'size'),
    'size',
    repeat('b', 64),
    (select round_id from s3_04_rounds where case_name = 'size'),
    (select document_id from s3_04_ctx where case_name = 'size'),
    (select array[finding_a_id] from s3_04_ctx where case_name = 'size'),
    (select array[revision] from s3_04_items where case_name = 'size'),
    (select version_id from s3_04_ctx where case_name = 'size'),
    'md',
    10485761,
    repeat('a', 64)
  ),
  '22023',
  null,
  'a file larger than 10 MiB is rejected'
);

-- 17. A reserved but expired submission is terminal and requires a new key.
set local session_replication_role = replica;
update public.correction_submissions s
set expires_at = now() - interval '1 second'
from s3_04_success t
where s.id = t.submission_id;
set local session_replication_role = origin;

select throws_ok(
  format(
    'select * from public.reserve_correction_upload(%L, %L, %L, %L, %L, %L, %L::uuid[], %L::bigint[], %L, %L, %s, %L)',
    (select member_a_id from s3_04_ctx where case_name = 'success'),
    (select workspace_id from s3_04_ctx where case_name = 'success'),
    'reserve-success',
    repeat('b', 64),
    (select round_id from s3_04_rounds where case_name = 'success'),
    (select document_id from s3_04_ctx where case_name = 'success'),
    (select array[finding_a_id] from s3_04_ctx where case_name = 'success'),
    (select array[revision] from s3_04_items where case_name = 'success'),
    (select version_id from s3_04_ctx where case_name = 'success'),
    'md',
    123,
    repeat('a', 64)
  ),
  '23505',
  null,
  'an expired reservation requires a new idempotency key'
);

set local session_replication_role = replica;
update public.correction_submissions s
set state = 'expired'
from s3_04_success t
where s.id = t.submission_id;
set local session_replication_role = origin;

select throws_ok(
  format(
    'select * from public.reserve_correction_upload(%L, %L, %L, %L, %L, %L, %L::uuid[], %L::bigint[], %L, %L, %s, %L)',
    (select member_a_id from s3_04_ctx where case_name = 'success'),
    (select workspace_id from s3_04_ctx where case_name = 'success'),
    'reserve-success',
    repeat('b', 64),
    (select round_id from s3_04_rounds where case_name = 'success'),
    (select document_id from s3_04_ctx where case_name = 'success'),
    (select array[finding_a_id] from s3_04_ctx where case_name = 'success'),
    (select array[revision] from s3_04_items where case_name = 'success'),
    (select version_id from s3_04_ctx where case_name = 'success'),
    'md',
    123,
    repeat('a', 64)
  ),
  '23505',
  null,
  'an already expired submission is terminal'
);

-- 18. A confirmed earlier submission becomes previous_submission_id.
create temporary table s3_04_previous_submission on commit drop as
select pg_temp.create_review_submission(
  (select round_id from s3_04_rounds where case_name = 'previous'),
  (select member_a_id from s3_04_ctx where case_name = 'previous'),
  (select array[item_id] from s3_04_items where case_name = 'previous')
) as submission_id;

create temporary table s3_04_previous_result on commit drop as
select *
from public.reserve_correction_upload(
  (select member_a_id from s3_04_ctx where case_name = 'previous'),
  (select workspace_id from s3_04_ctx where case_name = 'previous'),
  'previous-key',
  repeat('b', 64),
  (select round_id from s3_04_rounds where case_name = 'previous'),
  (select document_id from s3_04_ctx where case_name = 'previous'),
  (select array[finding_a_id] from s3_04_ctx where case_name = 'previous'),
  (select array[revision] from s3_04_items where case_name = 'previous'),
  (select version_id from s3_04_ctx where case_name = 'previous'),
  'md',
  123,
  repeat('a', 64)
);

select is(
  (select s.previous_submission_id
    from public.correction_submissions s
    join s3_04_previous_result t on t.submission_id = s.id),
  (select submission_id from s3_04_previous_submission),
  'previous_submission_id points at the earlier confirmed coverage'
);

-- 19. Only service_role can execute the RPC.
select ok(
  has_function_privilege(
    'service_role',
    'public.reserve_correction_upload(uuid, uuid, text, text, uuid, uuid, uuid[], bigint[], uuid, text, bigint, text)',
    'EXECUTE'
  ),
  'service_role can execute reserve_correction_upload'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.reserve_correction_upload(uuid, uuid, text, text, uuid, uuid, uuid[], bigint[], uuid, text, bigint, text)',
    'EXECUTE'
  ),
  'anon cannot execute reserve_correction_upload'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.reserve_correction_upload(uuid, uuid, text, text, uuid, uuid, uuid[], bigint[], uuid, text, bigint, text)',
    'EXECUTE'
  ),
  'authenticated cannot execute reserve_correction_upload'
);

set local role anon;
select throws_ok(
  'select * from public.reserve_correction_upload(null::uuid, null::uuid, null::text, null::text, null::uuid, null::uuid, null::uuid[], null::bigint[], null::uuid, null::text, null::bigint, null::text)',
  '42501',
  null,
  'anon execution is denied'
);
reset role;

set local role authenticated;
select throws_ok(
  'select * from public.reserve_correction_upload(null::uuid, null::uuid, null::text, null::text, null::uuid, null::uuid, null::uuid[], null::bigint[], null::uuid, null::text, null::bigint, null::text)',
  '42501',
  null,
  'authenticated execution is denied'
);
reset role;

select format(
  'select * from public.reserve_correction_upload(%L, %L, %L, %L, %L, %L, %L::uuid[], %L::bigint[], %L, %L, %s, %L)',
  (select member_a_id from s3_04_ctx where case_name = 'grants'),
  (select workspace_id from s3_04_ctx where case_name = 'grants'),
  'grants-key',
  repeat('b', 64),
  (select round_id from s3_04_rounds where case_name = 'grants'),
  (select document_id from s3_04_ctx where case_name = 'grants'),
  (select array[finding_a_id] from s3_04_ctx where case_name = 'grants'),
  (select array[revision] from s3_04_items where case_name = 'grants'),
  (select version_id from s3_04_ctx where case_name = 'grants'),
  'md',
  123,
  repeat('a', 64)
) as service_call \gset

set local role service_role;
select lives_ok(:'service_call', 'service_role can execute reserve_correction_upload');
reset role;

-- 20. A correction reservation never allocates v1 and never enqueues initial processing.
select ok(
  (select v.version_number > 1 from public.document_versions v
    join s3_04_success t on t.version_id = v.id),
  'a correction reservation never allocates version 1'
);
select is(
  (select count(*) from private.ingestion_jobs j
    join s3_04_success t on t.version_id = j.version_id),
  0::bigint,
  'a correction reservation does not enqueue initial ingestion'
);

select * from finish();
rollback;
