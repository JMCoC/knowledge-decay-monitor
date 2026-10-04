begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

-- Review Focus #4: a Member is denied outright.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select throws_ok($$select public.reserve_document(
  gen_random_uuid(), gen_random_uuid(), 'Attack', 'Other',
  '10000000-0000-4000-8000-000000000003', 'md', 2048)$$,
  '42501', null, 'Member cannot reserve a document');
-- Count as Admin A: RLS hides every row from the Member JWT above.
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is((select count(*) from documents), 3::bigint, 'Member reservation created no document');

-- The legacy RPC is revoked for every authenticated role after cutover.
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select throws_ok($$select public.reserve_document(
  gen_random_uuid(), gen_random_uuid(), 'Runbook', 'SOP',
  '10000000-0000-4000-8000-000000000003', 'md', 2048)$$,
  '42501', null, 'Admin cannot invoke the retired reservation RPC');
reset role;

-- Exercise the immutable Dev 2 RPC as a privileged fixture helper so its
-- validation and path constraints remain covered; it is not an app entrypoint.
select lives_ok($$select public.reserve_document(
  '20000000-0000-4000-8000-0000000000f1', '30000000-0000-4000-8000-0000000000f1',
  '  Runbook  ', 'SOP', '10000000-0000-4000-8000-000000000003', 'md', 2048)$$,
  'Privileged fixture uses the immutable legacy reservation RPC');
select is((select name from documents where id = '20000000-0000-4000-8000-0000000000f1'), 'Runbook',
  'The RPC trims the document name');
select is((select storage_path from document_versions where id = '30000000-0000-4000-8000-0000000000f1'),
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-0000000000f1/30000000-0000-4000-8000-0000000000f1/original.md',
  'The RPC builds the storage path in SQL');
select is((select version_number from document_versions where id = '30000000-0000-4000-8000-0000000000f1'), 1,
  'The reserved version is number one');
-- Authenticated callers cannot insert a version directly, even with a valid
-- canonical path and version number.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select throws_ok($$insert into public.document_versions
  (id, document_id, version_number, storage_path, size_bytes) values
  ('30000000-0000-4000-8000-0000000000f9', '20000000-0000-4000-8000-0000000000f1', 2,
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-0000000000f1/30000000-0000-4000-8000-0000000000f9/original.md',
   2048)$$,
  '42501', null, 'Authenticated users cannot insert document versions directly');
reset role;
select is((select processing_status::text from document_versions where id = '30000000-0000-4000-8000-0000000000f1'), 'uploaded',
  'The reserved version starts as uploaded');
select is((select version_status from document_versions where id = '30000000-0000-4000-8000-0000000000f1'), null,
  'The reserved version has no functional status');
select is((select active_version_id from documents where id = '20000000-0000-4000-8000-0000000000f1'), null,
  'The reserved document has no active pointer');
select is((select size_bytes from document_versions where id = '30000000-0000-4000-8000-0000000000f1'), 2048::bigint,
  'The RPC records the declared size for finalizeUpload to compare against');
insert into public.document_versions(
  id,workspace_id,document_id,version_number,storage_path,processing_status,size_bytes
) values (
  '30000000-0000-4000-8000-0000000000f4','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '20000000-0000-4000-8000-000000000002',2,
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-000000000002/30000000-0000-4000-8000-0000000000f4/original.md',
  'uploaded',null
);
select is((select size_bytes from public.document_versions
  where id = '30000000-0000-4000-8000-0000000000f4'),
  null,
  'A new legacy version can retain a null size until reconciled');

-- Review Focus #2: the extension allowlist is enforced in SQL, not only in Zod.
select throws_ok($$select public.reserve_document(
  gen_random_uuid(), gen_random_uuid(), 'Bad', 'Other',
  '10000000-0000-4000-8000-000000000003', 'exe', 2048)$$,
  '22023', null, 'An extension outside the allowlist is rejected');
select throws_ok($$select public.reserve_document(
  gen_random_uuid(), gen_random_uuid(), 'Bad', 'Other',
  '10000000-0000-4000-8000-000000000003', 'PDF', 2048)$$,
  '22023', null, 'The extension allowlist is case sensitive and lowercase only');
select throws_ok($$select public.reserve_document(
  gen_random_uuid(), gen_random_uuid(), '   ', 'Other',
  '10000000-0000-4000-8000-000000000003', 'md', 2048)$$,
  '22023', null, 'A blank document name is rejected before the CHECK fires');
select throws_ok($$select public.reserve_document(
  gen_random_uuid(), gen_random_uuid(), repeat('n', 201), 'Other',
  '10000000-0000-4000-8000-000000000003', 'md', 2048)$$,
  '22023', null, 'A 201 character name is rejected before the CHECK fires');

select throws_ok($$select public.reserve_document(
  gen_random_uuid(), gen_random_uuid(), 'Bad size', 'Other',
  '10000000-0000-4000-8000-000000000003', 'md', 0)$$,
  '22023', null, 'A zero size is rejected before the CHECK fires');
select throws_ok($$select public.reserve_document(
  gen_random_uuid(), gen_random_uuid(), 'Big size', 'Other',
  '10000000-0000-4000-8000-000000000003', 'md', 10485761)$$,
  '22023', null, 'A size over the bucket limit is rejected before the CHECK fires');
select throws_ok($$select public.reserve_document(
  gen_random_uuid(), gen_random_uuid(), 'No size', 'Other',
  '10000000-0000-4000-8000-000000000003', 'md', null)$$,
  '22023', null, 'A null size is rejected');

-- Review Focus #4: a cross-tenant owner fails on the composite FK, not on RLS.
select throws_ok($$select public.reserve_document(
  gen_random_uuid(), gen_random_uuid(), 'Attack', 'Other',
  '10000000-0000-4000-8000-000000000004', 'md', 2048)$$,
  '23503', null, 'A Workspace B profile cannot be the owner of a Workspace A document');

-- An authenticated user of another tenant cannot write into Workspace A.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
select throws_ok($$insert into public.documents (id, workspace_id, name, category, owner_id)
  values (gen_random_uuid(), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Attack', 'Other',
    '10000000-0000-4000-8000-000000000004')$$,
  '42501', null, 'Admin B cannot insert into Workspace A');
-- Count as Admin A: the B caller's JWT cannot see Workspace A rows.
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
-- 3 from the seed + f1 reserved by the Admin test above. The B caller
-- contributed nothing.
select is((select count(*) from documents where workspace_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 4::bigint,
  'No document was created in Workspace A by the B caller');
reset role;

-- Review Focus #5: the original is immutable once uploaded.
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true);

-- The old canonical upload route is denied; only an attempt-specific path
-- issued through the server reservation may use Storage INSERT.
select throws_ok($$insert into storage.objects(bucket_id, name) values
  ('documents','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-0000000000f1/30000000-0000-4000-8000-0000000000f1/original.md')$$,
  '42501', null, 'Admin cannot upload directly to a canonical original path');
reset role;
insert into storage.objects(bucket_id, name) values
  ('documents','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-0000000000f1/30000000-0000-4000-8000-0000000000f1/original.md');
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select is((select count(*) from storage.objects
  where bucket_id = 'documents'
    and name = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-0000000000f1/30000000-0000-4000-8000-0000000000f1/original.md'),
  0::bigint,
  'An unconfirmed canonical object cannot be read');

-- No UPDATE policy on the bucket, and the unconfirmed original is not
-- SELECT-visible to the client: this request affects no visible row.
select lives_ok($$update storage.objects set name = name || '-tampered'
  where bucket_id = 'documents'
    and name = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-0000000000f1/30000000-0000-4000-8000-0000000000f1/original.md'$$,
  'Direct UPDATE on the original runs without error');

select is((select count(*) from storage.objects
  where bucket_id = 'documents'
    and name = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-0000000000f1/30000000-0000-4000-8000-0000000000f1/original.md'),
  0::bigint,
  'The unconfirmed original stays hidden after an UPDATE attempt');

reset role;
select is((select count(*) from storage.objects
  where bucket_id = 'documents'
    and name = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-0000000000f1/30000000-0000-4000-8000-0000000000f1/original.md'),
  1::bigint,
  'The privileged fixture object remains at its canonical path');
select lives_ok($$update document_versions set processing_status = 'processing'
  where id = '30000000-0000-4000-8000-0000000000f1'$$);

-- The new column is bounded when present and absent otherwise.
select throws_ok($$update document_versions set size_bytes = 0 where id = '30000000-0000-4000-8000-000000000001'$$,
  '23514', null, 'size_bytes cannot be zero');
select throws_ok($$update document_versions set size_bytes = 10485761 where id = '30000000-0000-4000-8000-000000000001'$$,
  '23514', null, 'size_bytes cannot exceed the bucket limit');
select lives_ok($$update document_versions set size_bytes = 10485760 where id = '30000000-0000-4000-8000-000000000001'$$);

select is((select count(*) from pg_policies where tablename = 'documents'), 2::bigint,
  'Documents retain only the read and metadata-update policies');
select is((select count(*) from pg_policies where schemaname = 'public' and policyname = 'reserve_document'), 0::bigint,
  'The RPC added no policy named reserve_document');
-- Only SELECT of confirmed canonical originals remains under the original
-- policy name; attempts have their own operation-scoped INSERT policy.
select is((select string_agg(cmd::text, ',' order by cmd::text) from pg_policies
  where schemaname = 'storage' and tablename = 'objects' and policyname like 'document_original\_%'),
  'SELECT',
  'Canonical originals are readable only through the confirmed-read policy');

select * from finish();
rollback;
