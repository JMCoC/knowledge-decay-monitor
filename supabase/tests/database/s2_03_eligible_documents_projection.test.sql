begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(7);

-- 1. View exists
select has_view('public', 'eligible_analysis_documents', 'eligible_analysis_documents view exists');

-- 2. Projects only active + ready versions
select results_eq(
  $$ select count(*)::integer from public.eligible_analysis_documents $$,
  $$ select count(*)::integer from public.document_versions v join public.documents d on d.active_version_id = v.id where v.version_status = 'active' and v.processing_status = 'ready' $$,
  'Projects only active and ready document versions'
);

-- 3. Excludes processing_failed and historical versions
select is_empty(
  $$ select * from public.eligible_analysis_documents where version_id in (select id from public.document_versions where processing_status = 'processing_failed' or version_status is distinct from 'active') $$,
  'Excludes failed, in-flight, and non-active versions'
);

-- 4. pending_reanalysis does not make an otherwise eligible version disappear
select is(
  (select count(*)::integer from public.eligible_analysis_documents
    where version_id = '30000000-0000-4000-8000-000000000001'
      and analysis_status = 'pending_reanalysis'),
  1,
  'Pending reanalysis remains eligible'
);

-- 5. Verify tenant isolation as an authenticated Admin, not as the DB owner
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is(
  (select count(*)::integer from public.eligible_analysis_documents
    where workspace_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  0,
  'Admin A cannot see eligible documents from Workspace B'
);

-- 6. Member is denied the projection through underlying RLS
select set_config('request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select is((select count(*)::integer from public.eligible_analysis_documents), 0,
  'Member cannot see eligible documents');

-- 7. Anonymous callers cannot query the projection
reset role;
set local role anon;
select throws_ok(
  $$ select * from public.eligible_analysis_documents $$,
  '42501',
  null,
  'Anon cannot read eligible_analysis_documents'
);

select * from finish();
rollback;
