begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

update private.upload_control set mode = 'active' where singleton;

set local role service_role;
select lives_ok($$select * from public.reserve_document_upload(
  '10000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001',
  repeat('a',64), '  S1-02 Runbook  ', 'SOP', '10000000-0000-4000-8000-000000000001',
  'md', 1, repeat('b',64))$$,
  'Admin creates an idempotent initial upload reservation');
select lives_ok($$select * from public.reserve_document_upload(
  '10000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001',
  repeat('a',64), '  S1-02 Runbook  ', 'SOP', '10000000-0000-4000-8000-000000000001',
  'md', 1, repeat('b',64))$$,
  'retrying the same key and fingerprint returns the original reservation');
select throws_ok($$select * from public.reserve_document_upload(
  '10000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001',
  repeat('c',64), 'Different payload', 'SOP', '10000000-0000-4000-8000-000000000001',
  'md', 1, repeat('b',64))$$,
  '23505', null, 'reusing a key with another fingerprint conflicts');
select throws_ok($$select * from public.reserve_document_upload(
  '10000000-0000-4000-8000-000000000003', 'f2000000-0000-4000-8000-000000000002',
  repeat('a',64), 'Member attempt', 'SOP', '10000000-0000-4000-8000-000000000003',
  'md', 1, repeat('b',64))$$,
  '42501', null, 'Member cannot reserve even when selected as Owner');
select throws_ok($$select * from public.reserve_document_upload(
  '10000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000003',
  repeat('a',64), 'Cross workspace owner', 'SOP', '10000000-0000-4000-8000-000000000004',
  'md', 1, repeat('b',64))$$,
  '22023', null, 'reservation rejects an Owner from another workspace');
select throws_ok($$select * from public.reserve_document_upload(
  '10000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000004',
  repeat('a',64), 'Invalid size', 'SOP', '10000000-0000-4000-8000-000000000001',
  'md', 0, repeat('b',64))$$,
  '22023', null, 'reservation rejects a zero-byte file');
reset role;

select is((select count(*) from public.document_versions
  where idempotency_key = 'f2000000-0000-4000-8000-000000000001'), 1::bigint,
  'duplicate reservation requests create exactly one version');
select is((select d.name from public.documents d join public.document_versions v on v.document_id = d.id
  where v.idempotency_key = 'f2000000-0000-4000-8000-000000000001'), 'S1-02 Runbook',
  'reservation normalizes the document name');
select is((select v.version_number from public.document_versions v
  where v.idempotency_key = 'f2000000-0000-4000-8000-000000000001'), 1,
  'reservation creates version one');
select is((select v.processing_status::text from public.document_versions v
  where v.idempotency_key = 'f2000000-0000-4000-8000-000000000001'), 'uploaded',
  'new content remains uploaded and is not parsed by S1-02');
select is((select v.version_status from public.document_versions v
  where v.idempotency_key = 'f2000000-0000-4000-8000-000000000001'), null,
  'new content has no active functional status');
select is((select d.active_version_id from public.documents d join public.document_versions v on v.document_id = d.id
  where v.idempotency_key = 'f2000000-0000-4000-8000-000000000001'), null,
  'reservation does not activate the document version');
select ok((select v.storage_path <> a.storage_path
  and a.storage_path like '%/attempts/%/original.md'
  from public.document_versions v join public.document_upload_attempts a
    on a.id = v.current_upload_attempt_id
  where v.idempotency_key = 'f2000000-0000-4000-8000-000000000001'),
  'browser transfer uses a unique temporary attempt path');
set local role service_role;
select ok((select r.attempt_id is not null and r.upload_state = 'pending'
    and r.storage_path like '%/attempts/%/original.md'
  from public.get_upload_resume_target(
    '10000000-0000-4000-8000-000000000001',
    (select id from public.document_versions where idempotency_key = 'f2000000-0000-4000-8000-000000000001')) r),
  'resume returns only the current pending temporary target');
reset role;
select is((select v.upload_state::text from public.document_versions v
  where v.idempotency_key = 'f2000000-0000-4000-8000-000000000001'), 'pending',
  'reservation starts in pending');

set local role service_role;
select lives_ok($$select * from public.claim_upload_verification(
  '10000000-0000-4000-8000-000000000001',
  (select id from public.document_versions where idempotency_key = 'f2000000-0000-4000-8000-000000000001'),
  (select current_upload_attempt_id from public.document_versions where idempotency_key = 'f2000000-0000-4000-8000-000000000001'))$$,
  'Admin claims the current attempt for verification');
select throws_ok($$select * from public.claim_upload_verification(
  '10000000-0000-4000-8000-000000000001',
  (select id from public.document_versions where idempotency_key = 'f2000000-0000-4000-8000-000000000001'),
  (select current_upload_attempt_id from public.document_versions where idempotency_key = 'f2000000-0000-4000-8000-000000000001'))$$,
  '55000', null, 'a second verifier cannot take an active lease');
select lives_ok($$select * from public.finish_upload_verification(
  '10000000-0000-4000-8000-000000000001',
  (select id from public.document_versions where idempotency_key = 'f2000000-0000-4000-8000-000000000001'),
  (select current_upload_attempt_id from public.document_versions where idempotency_key = 'f2000000-0000-4000-8000-000000000001'),
  (select upload_operation_id from public.document_versions where idempotency_key = 'f2000000-0000-4000-8000-000000000001'),
  'rejected')$$,
  'current verifier can reject a mismatched upload');
select lives_ok($$select * from public.claim_upload_recovery(
  '10000000-0000-4000-8000-000000000001',
  (select id from public.document_versions where idempotency_key = 'f2000000-0000-4000-8000-000000000001'))$$,
  'Admin claims cleanup for the rejected temporary attempt');
select throws_ok($$select * from public.claim_upload_recovery(
  '10000000-0000-4000-8000-000000000001',
  (select id from public.document_versions where idempotency_key = 'f2000000-0000-4000-8000-000000000001'))$$,
  '55000', null, 'a second recovery cannot take an active cleanup lease');
select lives_ok($$select * from public.finish_upload_recovery(
  '10000000-0000-4000-8000-000000000001',
  (select id from public.document_versions where idempotency_key = 'f2000000-0000-4000-8000-000000000001'),
  (select current_upload_attempt_id from public.document_versions where idempotency_key = 'f2000000-0000-4000-8000-000000000001'),
  (select upload_operation_id from public.document_versions where idempotency_key = 'f2000000-0000-4000-8000-000000000001'),
  true)$$,
  'only verified absence creates a fresh transfer attempt');
reset role;

select is((select v.upload_state::text from public.document_versions v
  where v.idempotency_key = 'f2000000-0000-4000-8000-000000000001'), 'pending',
  'recovery returns the version to pending');
select ok((select v.current_upload_attempt_id <> a.id
  and a.retired_at is not null and a.cleanup_status = 'absent'
  from public.document_versions v
  join public.document_upload_attempts a on a.version_id = v.id
    and a.retired_at is not null and a.cleanup_status = 'absent'
  where v.idempotency_key = 'f2000000-0000-4000-8000-000000000001'
  order by a.created_at limit 1),
  'the old attempt is retired and the new attempt has a different identity');
set local role service_role;
select is(public.mark_upload_attempt_cleanup(
  (select id from public.document_versions where idempotency_key = 'f2000000-0000-4000-8000-000000000001'),
  (select a.id from public.document_upload_attempts a join public.document_versions v
    on v.id = a.version_id and v.workspace_id = a.workspace_id
    where v.idempotency_key = 'f2000000-0000-4000-8000-000000000001' and a.retired_at is not null
    order by a.created_at limit 1), false), true,
  'cleanup failure is recorded for the exact retired attempt');
select is(public.mark_upload_attempt_cleanup(
  (select id from public.document_versions where idempotency_key = 'f2000000-0000-4000-8000-000000000001'),
  (select a.id from public.document_upload_attempts a join public.document_versions v
    on v.id = a.version_id and v.workspace_id = a.workspace_id
    where v.idempotency_key = 'f2000000-0000-4000-8000-000000000001' and a.retired_at is not null
    order by a.created_at limit 1), true), true,
  'verified absence can be recorded on a retry');
reset role;
select is((select d.active_version_id from public.documents d join public.document_versions v on v.document_id = d.id
  where v.idempotency_key = 'f2000000-0000-4000-8000-000000000001'), null,
  'recovery never changes the active document pointer');

-- A persisted role change between claim and finish invalidates the operation.
set local role service_role;
select lives_ok($$select * from public.reserve_document_upload(
  '10000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000005',
  repeat('d',64), 'QA upload', 'SOP', '10000000-0000-4000-8000-000000000002',
  'md', 1, repeat('e',64))$$,
  'QA Lead can reserve in the same workspace');
select lives_ok($$select * from public.claim_upload_verification(
  '10000000-0000-4000-8000-000000000002',
  (select id from public.document_versions where idempotency_key = 'f2000000-0000-4000-8000-000000000005'),
  (select current_upload_attempt_id from public.document_versions where idempotency_key = 'f2000000-0000-4000-8000-000000000005'))$$,
  'QA Lead claims verification');
reset role;
update public.profiles set role = 'Member'
where id = '10000000-0000-4000-8000-000000000002';
set local role service_role;
select throws_ok($$select * from public.finish_upload_verification(
  '10000000-0000-4000-8000-000000000002',
  (select id from public.document_versions where idempotency_key = 'f2000000-0000-4000-8000-000000000005'),
  (select current_upload_attempt_id from public.document_versions where idempotency_key = 'f2000000-0000-4000-8000-000000000005'),
  (select upload_operation_id from public.document_versions where idempotency_key = 'f2000000-0000-4000-8000-000000000005'),
  'confirmed')$$,
  '42501', null, 'finish revalidates the persisted role after the Storage call');
reset role;
update public.profiles set role = 'QA Lead'
where id = '10000000-0000-4000-8000-000000000002';

-- Legacy binding is a one-time operation available only while uploads are paused.
insert into public.documents(id, workspace_id, name, category, owner_id)
values ('20000000-0000-4000-8000-000000000099', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'Unprocessed legacy upload', 'SOP', '10000000-0000-4000-8000-000000000001');
insert into public.document_versions(id, workspace_id, document_id, version_number, storage_path, processing_status)
values ('30000000-0000-4000-8000-000000000099', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '20000000-0000-4000-8000-000000000099', 1,
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-000000000099/30000000-0000-4000-8000-000000000099/original.md',
  'uploaded');
update private.upload_control set mode = 'paused' where singleton;
set local role service_role;
select throws_ok($$select * from public.bind_legacy_upload_reference(
  '10000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001', 10, repeat('f',64))$$,
  '55000', null, 'processed legacy content cannot be converted into a new upload');
select lives_ok($$select * from public.bind_legacy_upload_reference(
  '10000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000099', 10, repeat('f',64))$$,
  'Admin can bind a verified size and digest to an unprocessed legacy version');
select throws_ok($$select * from public.bind_legacy_upload_reference(
  '10000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000099', 10, repeat('f',64))$$,
  '55000', null, 'legacy reference cannot be silently replaced');
reset role;
select is((select hash_source::text from public.document_versions
  where id = '30000000-0000-4000-8000-000000000099'), 'client_declared',
  'legacy reference records its provenance');
select is((select upload_state::text from public.document_versions
  where id = '30000000-0000-4000-8000-000000000099'), 'pending',
  'binding an absent, unprocessed legacy original creates a recoverable attempt without claiming verification');
select ok((select current_upload_attempt_id is not null
    and upload_state = 'pending' and size_bytes = 10
    and expected_sha256 = repeat('f',64)
  from public.document_versions where id = '30000000-0000-4000-8000-000000000099'),
  'legacy binding stores the one-time reference and a fresh temporary attempt');
select is((select processing_status::text from public.document_versions
  where id = '30000000-0000-4000-8000-000000000001'), 'ready',
  'processed legacy state is preserved when binding is refused');
select is((select active_version_id::text from public.documents
  where id = '20000000-0000-4000-8000-000000000001'), '30000000-0000-4000-8000-000000000001',
  'processed legacy active pointer is preserved when binding is refused');

select * from finish();
rollback;
