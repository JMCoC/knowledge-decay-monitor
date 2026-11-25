begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
\ir review-fixtures.psql
select no_plan();

select pg_temp.create_review_fixture_case();
create temporary table smoke_case on commit drop as
select * from pg_temp.review_fixture_case;

-- 1. Initial v1 keeps the durable queue contract.
create temporary table smoke_initial_document on commit drop as
select gen_random_uuid() as document_id, workspace_id, admin_id
from pg_temp.smoke_case;

insert into public.documents(id, workspace_id, name, category, owner_id)
select document_id, workspace_id, 'S3-05 smoke initial', 'SOP', admin_id
from pg_temp.smoke_initial_document;

create temporary table smoke_initial_version on commit drop as
select gen_random_uuid() as version_id, document_id, workspace_id, admin_id
from pg_temp.smoke_initial_document;

insert into public.document_versions(
  id, workspace_id, document_id, version_number, storage_path,
  processing_status, upload_state, size_bytes, expected_sha256, hash_source,
  current_upload_attempt_id, reference_set_at, reference_set_by, upload_confirmed_at
)
select version_id, workspace_id, document_id, 1,
  workspace_id::text || '/' || document_id::text || '/' || version_id::text || '/original.md',
  'uploaded', 'confirmed', 1024, repeat('a', 64), 'client_declared',
  gen_random_uuid(), now(), admin_id, now()
from pg_temp.smoke_initial_version;

select is(
  public.enqueue_ingestion_job(
    (select workspace_id from pg_temp.smoke_initial_version),
    (select version_id from pg_temp.smoke_initial_version)
  ),
  'queued',
  'initial v1 enqueue remains queued'
);

-- 2. A correction submission without a selected candidate cannot be queued.
create temporary table smoke_orphan on commit drop as
select pg_temp.create_review_upload_version(
  workspace_id, document_id, admin_id, 'correction_submission'
) as version_id, workspace_id
from pg_temp.smoke_case;

select pg_temp.confirm_review_upload(version_id) from pg_temp.smoke_orphan;

select is(
  public.enqueue_ingestion_job(
    (select workspace_id from pg_temp.smoke_orphan),
    (select version_id from pg_temp.smoke_orphan)
  ),
  'conflict',
  'correction submission without a candidate stays conflict'
);

-- 3. A selected direct candidate owned by its processing round is queued.
create temporary table smoke_candidate on commit drop as
select workspace_id, document_id, admin_id, member_a_id, finding_a_id,
  null::uuid as round_id, null::uuid as item_id, null::uuid as submission_id,
  null::uuid as candidate_id, null::uuid as candidate_version_id
from pg_temp.smoke_case;

update pg_temp.smoke_candidate c
set round_id = pg_temp.create_review_round(c.workspace_id, 'assigned_findings', ARRAY[c.finding_a_id]);

update pg_temp.smoke_candidate c
set item_id = (select i.id from public.correction_round_items i
  where i.round_id = c.round_id and i.finding_id = c.finding_a_id);

update pg_temp.smoke_candidate c
set submission_id = pg_temp.create_review_submission(c.round_id, c.member_a_id, ARRAY[c.item_id]);

update pg_temp.smoke_candidate c
set candidate_id = pg_temp.select_direct_review_candidate(c.round_id, c.admin_id, c.submission_id);

update pg_temp.smoke_candidate c
set candidate_version_id = (select x.version_id from public.correction_candidates x where x.id = c.candidate_id);

select is(
  public.enqueue_ingestion_job(
    (select workspace_id from pg_temp.smoke_candidate),
    (select candidate_version_id from pg_temp.smoke_candidate)
  ),
  'queued',
  'selected candidate owned by its round is queued'
);

-- 4. Completion produces ready+pending_approval without activating the candidate.
update private.ingestion_jobs
set available_at = clock_timestamp() + interval '1 day'
where version_id is distinct from (select candidate_version_id from pg_temp.smoke_candidate);

create temporary table smoke_claim on commit drop as
select * from public.claim_ingestion_job();

select is((select count(*)::integer from pg_temp.smoke_claim), 1, 'candidate claim is selected');
select is(
  (select version_id from pg_temp.smoke_claim),
  (select candidate_version_id from pg_temp.smoke_candidate),
  'claim picks the correction candidate'
);

select public.finish_processing(
  (select version_id from pg_temp.smoke_claim),
  (select operation_id from pg_temp.smoke_claim),
  jsonb_build_array(jsonb_build_object(
    'chunk_index', 0, 'text_content', 'Smoke correction chunk',
    'page_number', 1, 'section_heading', 'Smoke',
    'embedding', '[1,' || repeat('0,', 382) || '0]'
  ))
);

select is(
  (select processing_status::text from public.document_versions
    where id = (select candidate_version_id from pg_temp.smoke_candidate)),
  'ready',
  'correction candidate version becomes ready'
);
select is(
  (select version_status::text from public.document_versions
    where id = (select candidate_version_id from pg_temp.smoke_candidate)),
  'pending_approval',
  'correction candidate version waits for approval'
);
select is(
  (select status::text from public.correction_candidates
    where id = (select candidate_id from pg_temp.smoke_candidate)),
  'pending_approval',
  'correction candidate waits for approval'
);
select is(
  (select active_version_id from public.documents
    where id = (select document_id from pg_temp.smoke_case)),
  (select version_id from pg_temp.smoke_case),
  'completion never changes the active v1 pointer'
);

select * from finish();
rollback;
