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

-- An Admin of Workspace A can reserve, and the RPC builds the path itself.
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok($$select public.reserve_document(
  '20000000-0000-4000-8000-0000000000f1', '30000000-0000-4000-8000-0000000000f1',
  '  Runbook  ', 'SOP', '10000000-0000-4000-8000-000000000003', 'md', 2048)$$,
  'Admin reserves a document and its first version');
select is((select name from documents where id = '20000000-0000-4000-8000-0000000000f1'), 'Runbook',
  'The RPC trims the document name');
select is((select storage_path from document_versions where id = '30000000-0000-4000-8000-0000000000f1'),
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-0000000000f1/30000000-0000-4000-8000-0000000000f1/original.md',
  'The RPC builds the storage path in SQL');
select is((select version_number from document_versions where id = '30000000-0000-4000-8000-0000000000f1'), 1,
  'The reserved version is number one');
-- The RPC hardcodes version_number 1, so any other number is only reachable
-- by direct insert — and the version_reserve WITH CHECK rejects it even for
-- an Admin. The path below satisfies storage_path_matches_identity on
-- purpose, so the only possible failure is the policy itself (42501).
select throws_ok($$insert into public.document_versions
  (id, document_id, version_number, storage_path, size_bytes) values
  ('30000000-0000-4000-8000-0000000000f9', '20000000-0000-4000-8000-0000000000f1', 2,
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-0000000000f1/30000000-0000-4000-8000-0000000000f9/original.md',
   2048)$$,
  '42501', null, 'A version_number other than 1 is rejected by version_reserve');
select is((select processing_status::text from document_versions where id = '30000000-0000-4000-8000-0000000000f1'), 'uploaded',
  'The reserved version starts as uploaded');
select is((select version_status from document_versions where id = '30000000-0000-4000-8000-0000000000f1'), null,
  'The reserved version has no functional status');
select is((select active_version_id from documents where id = '20000000-0000-4000-8000-0000000000f1'), null,
  'The reserved document has no active pointer');
select is((select size_bytes from document_versions where id = '30000000-0000-4000-8000-0000000000f1'), 2048::bigint,
  'The RPC records the declared size for finalizeUpload to compare against');
select is((select size_bytes from public.document_versions
  where storage_path = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-000000000001/30000000-0000-4000-8000-000000000001/original.md'),
  null,
  'A Day Cero seed row keeps a null size, which finalize compares by existence alone');

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

-- Review Focus #5: the original is immutable once uploaded.
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true);

-- Admin A uploads the reserved original. The INSERT passes because
-- document_original_upload requires a version in 'uploaded' state,
-- which the reserve_document test above just created.
select lives_ok($$insert into storage.objects(bucket_id, name) values
  ('documents','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-0000000000f1/30000000-0000-4000-8000-0000000000f1/original.md')$$,
  'Admin uploads the reserved original');

select is((select count(*) from storage.objects
  where bucket_id = 'documents'
    and name = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-0000000000f1/30000000-0000-4000-8000-0000000000f1/original.md'),
  1::bigint,
  'Exactly one object exists at the reserved path');

-- No UPDATE policy on the bucket, so a direct modification is
-- silently denied by RLS: the statement runs, affects 0 rows, and
-- the original path stays as is.
select lives_ok($$update storage.objects set name = name || '-tampered'
  where bucket_id = 'documents'
    and name = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-0000000000f1/30000000-0000-4000-8000-0000000000f1/original.md'$$,
  'Direct UPDATE on the original runs without error');

select is((select count(*) from storage.objects
  where bucket_id = 'documents'
    and name = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-0000000000f1/30000000-0000-4000-8000-0000000000f1/original.md'),
  1::bigint,
  'The original path is unchanged after the UPDATE attempt');

reset role;
select lives_ok($$update document_versions set processing_status = 'processing'
  where id = '30000000-0000-4000-8000-0000000000f1'$$);

-- The new column is bounded when present and absent otherwise.
select throws_ok($$update document_versions set size_bytes = 0 where id = '30000000-0000-4000-8000-000000000001'$$,
  '23514', null, 'size_bytes cannot be zero');
select throws_ok($$update document_versions set size_bytes = 10485761 where id = '30000000-0000-4000-8000-000000000001'$$,
  '23514', null, 'size_bytes cannot exceed the bucket limit');
select lives_ok($$update document_versions set size_bytes = 10485760 where id = '30000000-0000-4000-8000-000000000001'$$);

select is((select count(*) from pg_policies where tablename = 'documents'), 3::bigint,
  'The RPC added no policy to documents');
select is((select count(*) from pg_policies where schemaname = 'public' and policyname = 'reserve_document'), 0::bigint,
  'The RPC added no policy named reserve_document');
-- Day Cero ships exactly SELECT + INSERT on the bucket (document_original_read,
-- document_original_upload). Scoped by policy name so Supabase's own default
-- storage policies cannot break this assertion.
select is((select string_agg(cmd::text, ',' order by cmd::text) from pg_policies
  where schemaname = 'storage' and tablename = 'objects' and policyname like 'document_original\_%'),
  'INSERT,SELECT',
  'The documents bucket has no UPDATE or DELETE policy: originals are immutable');

select * from finish();
rollback;
