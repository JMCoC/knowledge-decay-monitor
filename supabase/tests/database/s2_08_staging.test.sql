begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
\ir analysis-fixtures.psql
select no_plan();

-- (a) The two private staging tables exist with the exact columns (spec §5.1).
select has_table('private', 'analysis_finding_staging', 'Staging findings table exists');
select has_table('private', 'analysis_finding_evidence_staging', 'Staging evidence table exists');

select has_column('private', 'analysis_finding_staging', 'id', 'finding staging has id');
select has_column('private', 'analysis_finding_staging', 'analysis_id', 'finding staging has analysis_id');
select has_column('private', 'analysis_finding_staging', 'workspace_id', 'finding staging has workspace_id');
select has_column('private', 'analysis_finding_staging', 'operation_id', 'finding staging has operation_id');
select has_column('private', 'analysis_finding_staging', 'batch_index', 'finding staging has batch_index');
select has_column('private', 'analysis_finding_staging', 'finding_ordinal', 'finding staging has finding_ordinal');
select has_column('private', 'analysis_finding_staging', 'type', 'finding staging has type');
select has_column('private', 'analysis_finding_staging', 'severity', 'finding staging has severity');
select has_column('private', 'analysis_finding_staging', 'confidence', 'finding staging has confidence');
select has_column('private', 'analysis_finding_staging', 'explanation', 'finding staging has explanation');
select has_column('private', 'analysis_finding_staging', 'fingerprint', 'finding staging has fingerprint');
select has_column('private', 'analysis_finding_staging', 'created_at', 'finding staging has created_at');

select has_column('private', 'analysis_finding_evidence_staging', 'id', 'evidence staging has id');
select has_column('private', 'analysis_finding_evidence_staging', 'analysis_id', 'evidence staging has analysis_id');
select has_column('private', 'analysis_finding_evidence_staging', 'workspace_id', 'evidence staging has workspace_id');
select has_column('private', 'analysis_finding_evidence_staging', 'operation_id', 'evidence staging has operation_id');
select has_column('private', 'analysis_finding_evidence_staging', 'batch_index', 'evidence staging has batch_index');
select has_column('private', 'analysis_finding_evidence_staging', 'finding_ordinal', 'evidence staging has finding_ordinal');
select has_column('private', 'analysis_finding_evidence_staging', 'fingerprint', 'evidence staging has fingerprint');
select has_column('private', 'analysis_finding_evidence_staging', 'evidence_ordinal', 'evidence staging has evidence_ordinal');
select has_column('private', 'analysis_finding_evidence_staging', 'role', 'evidence staging has role');
select has_column('private', 'analysis_finding_evidence_staging', 'document_id', 'evidence staging has document_id');
select has_column('private', 'analysis_finding_evidence_staging', 'version_id', 'evidence staging has version_id');
select has_column('private', 'analysis_finding_evidence_staging', 'chunk_id', 'evidence staging has chunk_id');
select has_column('private', 'analysis_finding_evidence_staging', 'page_number', 'evidence staging has page_number');
select has_column('private', 'analysis_finding_evidence_staging', 'section', 'evidence staging has section');
select has_column('private', 'analysis_finding_evidence_staging', 'section_heading', 'evidence staging has section_heading');
select has_column('private', 'analysis_finding_evidence_staging', 'snapshot', 'evidence staging has snapshot');
select has_column('private', 'analysis_finding_evidence_staging', 'created_at', 'evidence staging has created_at');

select is((select data_type from information_schema.columns
  where table_schema = 'private' and table_name = 'analysis_finding_staging' and column_name = 'confidence'),
  'double precision', 'confidence is double precision');
select is((select data_type from information_schema.columns
  where table_schema = 'private' and table_name = 'analysis_finding_staging' and column_name = 'explanation'),
  'text', 'explanation is text');
select is((select data_type from information_schema.columns
  where table_schema = 'private' and table_name = 'analysis_finding_evidence_staging' and column_name = 'page_number'),
  'integer', 'page_number is integer');
select is((select data_type from information_schema.columns
  where table_schema = 'private' and table_name = 'analysis_finding_evidence_staging' and column_name = 'snapshot'),
  'text', 'snapshot is text');

-- (b) Staging keys are per analysis and exclude operation_id (P2, spec §5.1).
select lives_ok($$insert into private.analysis_finding_staging(
    analysis_id, workspace_id, operation_id, batch_index, finding_ordinal,
    type, severity, confidence, explanation, fingerprint)
  values ('a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001', 0, 0,
    'contradiction', 'Medium', 0.5, 'Synthetic staging explanation', 'fp-unique-a')$$,
  'A finding staging row inserts');
select throws_ok($$insert into private.analysis_finding_staging(
    analysis_id, workspace_id, operation_id, batch_index, finding_ordinal,
    type, severity, confidence, explanation, fingerprint)
  values ('a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001',
    'd0000000-0000-4000-8000-000000000002', 5, 5,
    'obsolescence', 'Low', 0.9, 'A different attempt', 'fp-unique-a')$$,
  '23505', null, 'A repeated (analysis_id, fingerprint) is rejected regardless of operation_id');
select lives_ok($$insert into private.analysis_finding_staging(
    analysis_id, workspace_id, operation_id, batch_index, finding_ordinal,
    type, severity, confidence, explanation, fingerprint)
  values ('a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001', 0, 1,
    'contradiction', 'Medium', 0.5, 'Synthetic staging explanation', 'fp-unique-b')$$,
  'A second distinct fingerprint inserts');

select lives_ok($$insert into private.analysis_finding_evidence_staging(
    analysis_id, workspace_id, operation_id, batch_index, finding_ordinal, fingerprint,
    evidence_ordinal, role, document_id, version_id, chunk_id, snapshot)
  values ('a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001', 0, 0, 'fp-unique-a', 0, 'source',
    'e0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001',
    'e0000000-0000-4000-8000-0000000000a1', 'Synthetic evidence')$$,
  'An evidence staging row inserts');
select throws_ok($$insert into private.analysis_finding_evidence_staging(
    analysis_id, workspace_id, operation_id, batch_index, finding_ordinal, fingerprint,
    evidence_ordinal, role, document_id, version_id, chunk_id, snapshot)
  values ('a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001', 0, 0, 'fp-unique-a', 0, 'source',
    'e0000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-000000000002',
    'e0000000-0000-4000-8000-0000000000a2', 'Duplicate ordinal')$$,
  '23505', null, 'A repeated (analysis_id, fingerprint, evidence_ordinal) is rejected');

-- (c) RLS is enabled on both tables.
select is((select relrowsecurity from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'private' and c.relname = 'analysis_finding_staging'),
  true, 'Staging findings has row level security enabled');
select is((select relrowsecurity from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'private' and c.relname = 'analysis_finding_evidence_staging'),
  true, 'Staging evidence has row level security enabled');

-- (d) No table privileges are granted to any role (spec §5.1).
select ok(not has_table_privilege('service_role', 'private.analysis_finding_staging', 'SELECT'),
  'service_role cannot SELECT staging findings');
select ok(not has_table_privilege('service_role', 'private.analysis_finding_staging', 'INSERT'),
  'service_role cannot INSERT staging findings');
select ok(not has_table_privilege('service_role', 'private.analysis_finding_staging', 'UPDATE'),
  'service_role cannot UPDATE staging findings');
select ok(not has_table_privilege('service_role', 'private.analysis_finding_staging', 'DELETE'),
  'service_role cannot DELETE staging findings');
select ok(not has_table_privilege('anon', 'private.analysis_finding_staging', 'SELECT'),
  'anon cannot SELECT staging findings');
select ok(not has_table_privilege('anon', 'private.analysis_finding_staging', 'INSERT'),
  'anon cannot INSERT staging findings');
select ok(not has_table_privilege('anon', 'private.analysis_finding_staging', 'UPDATE'),
  'anon cannot UPDATE staging findings');
select ok(not has_table_privilege('anon', 'private.analysis_finding_staging', 'DELETE'),
  'anon cannot DELETE staging findings');
select ok(not has_table_privilege('authenticated', 'private.analysis_finding_staging', 'SELECT'),
  'authenticated cannot SELECT staging findings');
select ok(not has_table_privilege('authenticated', 'private.analysis_finding_staging', 'INSERT'),
  'authenticated cannot INSERT staging findings');
select ok(not has_table_privilege('authenticated', 'private.analysis_finding_staging', 'UPDATE'),
  'authenticated cannot UPDATE staging findings');
select ok(not has_table_privilege('authenticated', 'private.analysis_finding_staging', 'DELETE'),
  'authenticated cannot DELETE staging findings');
select ok(not has_table_privilege('public', 'private.analysis_finding_staging', 'SELECT'),
  'public cannot SELECT staging findings');
select ok(not has_table_privilege('public', 'private.analysis_finding_staging', 'INSERT'),
  'public cannot INSERT staging findings');
select ok(not has_table_privilege('public', 'private.analysis_finding_staging', 'UPDATE'),
  'public cannot UPDATE staging findings');
select ok(not has_table_privilege('public', 'private.analysis_finding_staging', 'DELETE'),
  'public cannot DELETE staging findings');
select ok(not has_table_privilege('service_role', 'private.analysis_finding_evidence_staging', 'SELECT'),
  'service_role cannot SELECT staging evidence');
select ok(not has_table_privilege('service_role', 'private.analysis_finding_evidence_staging', 'INSERT'),
  'service_role cannot INSERT staging evidence');
select ok(not has_table_privilege('service_role', 'private.analysis_finding_evidence_staging', 'UPDATE'),
  'service_role cannot UPDATE staging evidence');
select ok(not has_table_privilege('service_role', 'private.analysis_finding_evidence_staging', 'DELETE'),
  'service_role cannot DELETE staging evidence');
select ok(not has_table_privilege('anon', 'private.analysis_finding_evidence_staging', 'SELECT'),
  'anon cannot SELECT staging evidence');
select ok(not has_table_privilege('anon', 'private.analysis_finding_evidence_staging', 'INSERT'),
  'anon cannot INSERT staging evidence');
select ok(not has_table_privilege('anon', 'private.analysis_finding_evidence_staging', 'UPDATE'),
  'anon cannot UPDATE staging evidence');
select ok(not has_table_privilege('anon', 'private.analysis_finding_evidence_staging', 'DELETE'),
  'anon cannot DELETE staging evidence');
select ok(not has_table_privilege('authenticated', 'private.analysis_finding_evidence_staging', 'SELECT'),
  'authenticated cannot SELECT staging evidence');
select ok(not has_table_privilege('authenticated', 'private.analysis_finding_evidence_staging', 'INSERT'),
  'authenticated cannot INSERT staging evidence');
select ok(not has_table_privilege('authenticated', 'private.analysis_finding_evidence_staging', 'UPDATE'),
  'authenticated cannot UPDATE staging evidence');
select ok(not has_table_privilege('authenticated', 'private.analysis_finding_evidence_staging', 'DELETE'),
  'authenticated cannot DELETE staging evidence');
select ok(not has_table_privilege('public', 'private.analysis_finding_evidence_staging', 'SELECT'),
  'public cannot SELECT staging evidence');
select ok(not has_table_privilege('public', 'private.analysis_finding_evidence_staging', 'INSERT'),
  'public cannot INSERT staging evidence');
select ok(not has_table_privilege('public', 'private.analysis_finding_evidence_staging', 'UPDATE'),
  'public cannot UPDATE staging evidence');
select ok(not has_table_privilege('public', 'private.analysis_finding_evidence_staging', 'DELETE'),
  'public cannot DELETE staging evidence');

-- (e) confidence CHECK is 0..1 inclusive.
select throws_ok($$insert into private.analysis_finding_staging(
    analysis_id, workspace_id, operation_id, batch_index, finding_ordinal,
    type, severity, confidence, explanation, fingerprint)
  values ('a0000000-0000-4000-8000-00000000000a', 'b0000000-0000-4000-8000-00000000000a',
    'c0000000-0000-4000-8000-00000000000a', 0, 0,
    'contradiction', 'Medium', -0.1, 'conf', 'fp-conf-low')$$,
  '23514', null, 'confidence below 0 is rejected');
select throws_ok($$insert into private.analysis_finding_staging(
    analysis_id, workspace_id, operation_id, batch_index, finding_ordinal,
    type, severity, confidence, explanation, fingerprint)
  values ('a0000000-0000-4000-8000-00000000000a', 'b0000000-0000-4000-8000-00000000000a',
    'c0000000-0000-4000-8000-00000000000a', 0, 0,
    'contradiction', 'Medium', 1.1, 'conf', 'fp-conf-high')$$,
  '23514', null, 'confidence above 1 is rejected');
select lives_ok($$insert into private.analysis_finding_staging(
    analysis_id, workspace_id, operation_id, batch_index, finding_ordinal,
    type, severity, confidence, explanation, fingerprint)
  values ('a0000000-0000-4000-8000-00000000000a', 'b0000000-0000-4000-8000-00000000000a',
    'c0000000-0000-4000-8000-00000000000a', 0, 0,
    'contradiction', 'Medium', 0, 'conf', 'fp-conf-zero')$$,
  'confidence 0 is accepted');
select lives_ok($$insert into private.analysis_finding_staging(
    analysis_id, workspace_id, operation_id, batch_index, finding_ordinal,
    type, severity, confidence, explanation, fingerprint)
  values ('a0000000-0000-4000-8000-00000000000b', 'b0000000-0000-4000-8000-00000000000b',
    'c0000000-0000-4000-8000-00000000000b', 0, 0,
    'contradiction', 'Medium', 1, 'conf', 'fp-conf-one')$$,
  'confidence 1 is accepted');

-- (f) explanation CHECK requires non-blank text.
select throws_ok($$insert into private.analysis_finding_staging(
    analysis_id, workspace_id, operation_id, batch_index, finding_ordinal,
    type, severity, confidence, explanation, fingerprint)
  values ('a0000000-0000-4000-8000-00000000000c', 'b0000000-0000-4000-8000-00000000000c',
    'c0000000-0000-4000-8000-00000000000c', 0, 0,
    'contradiction', 'Medium', 0.5, '', 'fp-expl-empty')$$,
  '23514', null, 'An empty explanation is rejected');
select throws_ok($$insert into private.analysis_finding_staging(
    analysis_id, workspace_id, operation_id, batch_index, finding_ordinal,
    type, severity, confidence, explanation, fingerprint)
  values ('a0000000-0000-4000-8000-00000000000c', 'b0000000-0000-4000-8000-00000000000c',
    'c0000000-0000-4000-8000-00000000000c', 0, 0,
    'contradiction', 'Medium', 0.5, '   ', 'fp-expl-blank')$$,
  '23514', null, 'A whitespace-only explanation is rejected');

-- (g) snapshot CHECK is 1..2000 characters and non-blank.
select throws_ok($$insert into private.analysis_finding_evidence_staging(
    analysis_id, workspace_id, operation_id, batch_index, finding_ordinal, fingerprint,
    evidence_ordinal, role, document_id, version_id, chunk_id, snapshot)
  values ('a0000000-0000-4000-8000-00000000000d', 'b0000000-0000-4000-8000-00000000000d',
    'c0000000-0000-4000-8000-00000000000d', 0, 0, 'fp-snap', 0, 'source',
    'e0000000-0000-4000-8000-00000000000d', 'f0000000-0000-4000-8000-00000000000d',
    'e0000000-0000-4000-8000-0000000000d1', '')$$,
  '23514', null, 'An empty snapshot is rejected');
select throws_ok($$insert into private.analysis_finding_evidence_staging(
    analysis_id, workspace_id, operation_id, batch_index, finding_ordinal, fingerprint,
    evidence_ordinal, role, document_id, version_id, chunk_id, snapshot)
  values ('a0000000-0000-4000-8000-00000000000d', 'b0000000-0000-4000-8000-00000000000d',
    'c0000000-0000-4000-8000-00000000000d', 0, 0, 'fp-snap', 0, 'source',
    'e0000000-0000-4000-8000-00000000000d', 'f0000000-0000-4000-8000-00000000000d',
    'e0000000-0000-4000-8000-0000000000d1', repeat('a', 2001))$$,
  '23514', null, 'A 2001-character snapshot is rejected');
select lives_ok($$insert into private.analysis_finding_evidence_staging(
    analysis_id, workspace_id, operation_id, batch_index, finding_ordinal, fingerprint,
    evidence_ordinal, role, document_id, version_id, chunk_id, snapshot)
  values ('a0000000-0000-4000-8000-00000000000e', 'b0000000-0000-4000-8000-00000000000e',
    'c0000000-0000-4000-8000-00000000000e', 0, 0, 'fp-snap-ok', 0, 'comparison',
    'e0000000-0000-4000-8000-00000000000e', 'f0000000-0000-4000-8000-00000000000e',
    'e0000000-0000-4000-8000-0000000000e1', repeat('a', 2000))$$,
  'A 2000-character snapshot is accepted');

-- (h) page_number CHECK requires a positive value when present.
select throws_ok($$insert into private.analysis_finding_evidence_staging(
    analysis_id, workspace_id, operation_id, batch_index, finding_ordinal, fingerprint,
    evidence_ordinal, role, document_id, version_id, chunk_id, page_number, snapshot)
  values ('a0000000-0000-4000-8000-00000000000f', 'b0000000-0000-4000-8000-00000000000f',
    'c0000000-0000-4000-8000-00000000000f', 0, 0, 'fp-page', 0, 'source',
    'e0000000-0000-4000-8000-00000000000f', 'f0000000-0000-4000-8000-00000000000f',
    'e0000000-0000-4000-8000-0000000000f1', 0, 'page')$$,
  '23514', null, 'A zero page_number is rejected');
select throws_ok($$insert into private.analysis_finding_evidence_staging(
    analysis_id, workspace_id, operation_id, batch_index, finding_ordinal, fingerprint,
    evidence_ordinal, role, document_id, version_id, chunk_id, page_number, snapshot)
  values ('a0000000-0000-4000-8000-00000000000f', 'b0000000-0000-4000-8000-00000000000f',
    'c0000000-0000-4000-8000-00000000000f', 0, 0, 'fp-page', 0, 'source',
    'e0000000-0000-4000-8000-00000000000f', 'f0000000-0000-4000-8000-00000000000f',
    'e0000000-0000-4000-8000-0000000000f1', -3, 'page')$$,
  '23514', null, 'A negative page_number is rejected');

-- (i) The cleanup trigger only wipes staging on a terminal status (spec §5.4).
insert into pg_temp.analysis_fixture_ids(name, analysis_id) values
  ('staging_cleanup', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001', 'processing', 1));

insert into private.analysis_finding_staging(
  analysis_id, workspace_id, operation_id, batch_index, finding_ordinal,
  type, severity, confidence, explanation, fingerprint)
values
  (pg_temp.analysis_fixture_id('staging_cleanup'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    gen_random_uuid(), 0, 0, 'contradiction', 'Medium', 0.5, 'staged one', 'fp-clean-1'),
  (pg_temp.analysis_fixture_id('staging_cleanup'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    gen_random_uuid(), 1, 0, 'obsolescence', 'High', 0.7, 'staged two', 'fp-clean-2');

insert into private.analysis_finding_evidence_staging(
  analysis_id, workspace_id, operation_id, batch_index, finding_ordinal,
  fingerprint, evidence_ordinal, role, document_id, version_id, chunk_id,
  snapshot)
values
  (pg_temp.analysis_fixture_id('staging_cleanup'),
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   gen_random_uuid(), 0, 0, 'fp-clean-1', 0, 'source',
   'e0000000-0000-4000-8000-0000000000a1',
   'f0000000-0000-4000-8000-0000000000a1',
   'e0000000-0000-4000-8000-0000000000a2', 'failed evidence');

select is((select count(*)::integer from private.analysis_finding_staging
  where analysis_id = pg_temp.analysis_fixture_id('staging_cleanup')), 2,
  'Two staging rows are present before the status transitions');

update public.analyses set status = 'queued'
  where id = pg_temp.analysis_fixture_id('staging_cleanup');
select is((select count(*)::integer from private.analysis_finding_staging
  where analysis_id = pg_temp.analysis_fixture_id('staging_cleanup')), 2,
  'A has_more queued transition keeps staging');
update public.analyses set status = 'processing'
  where id = pg_temp.analysis_fixture_id('staging_cleanup');
select is((select count(*)::integer from private.analysis_finding_staging
  where analysis_id = pg_temp.analysis_fixture_id('staging_cleanup')), 2,
  'A processing transition keeps staging');
update public.analyses set status = 'failed', error_code = 'INTERNAL_ERROR'
  where id = pg_temp.analysis_fixture_id('staging_cleanup');
select is((select count(*)::integer from private.analysis_finding_staging
  where analysis_id = pg_temp.analysis_fixture_id('staging_cleanup')), 0,
  'A terminal failed transition wipes staging via the safety trigger');
select is((select count(*)::integer from private.analysis_finding_evidence_staging
  where analysis_id = pg_temp.analysis_fixture_id('staging_cleanup')), 0,
  'A terminal failed transition wipes evidence staging too');

-- (i-b) The same safety trigger fires on the happy-path terminal status `completed`.
insert into pg_temp.analysis_fixture_ids(name, analysis_id) values
  ('staging_cleanup_completed', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001', 'processing', 1));

insert into private.analysis_finding_staging(
  analysis_id, workspace_id, operation_id, batch_index, finding_ordinal,
  type, severity, confidence, explanation, fingerprint)
values
  (pg_temp.analysis_fixture_id('staging_cleanup_completed'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    gen_random_uuid(), 0, 0, 'contradiction', 'Medium', 0.5, 'completed one', 'fp-done-1'),
  (pg_temp.analysis_fixture_id('staging_cleanup_completed'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    gen_random_uuid(), 1, 0, 'obsolescence', 'High', 0.7, 'completed two', 'fp-done-2');

insert into private.analysis_finding_evidence_staging(
  analysis_id, workspace_id, operation_id, batch_index, finding_ordinal, fingerprint,
  evidence_ordinal, role, document_id, version_id, chunk_id, snapshot)
values
  (pg_temp.analysis_fixture_id('staging_cleanup_completed'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    gen_random_uuid(), 0, 0, 'fp-done-1', 0, 'source',
    'e0000000-0000-4000-8000-0000000000c1', 'f0000000-0000-4000-8000-0000000000c1',
    'e0000000-0000-4000-8000-0000000000c2', 'completed evidence');

update public.analyses set status = 'completed'
  where id = pg_temp.analysis_fixture_id('staging_cleanup_completed');
select is(
  (select count(*)::integer from private.analysis_finding_staging
    where analysis_id = pg_temp.analysis_fixture_id('staging_cleanup_completed'))
  + (select count(*)::integer from private.analysis_finding_evidence_staging
    where analysis_id = pg_temp.analysis_fixture_id('staging_cleanup_completed')),
  0,
  'A terminal completed transition wipes both staging tables via the safety trigger');

-- (j) The staging ownership comment is recorded on document_versions.analysis_status (spec §6.4).
select ok((select col_description('public.document_versions'::regclass,
    (select attnum from pg_catalog.pg_attribute
     where attrelid = 'public.document_versions'::regclass and attname = 'analysis_status'))
  is not null),
  'analysis_status has a column comment');
select is(
  (select col_description('public.document_versions'::regclass,
     (select attnum from pg_catalog.pg_attribute
      where attrelid = 'public.document_versions'::regclass
        and attname = 'analysis_status'))),
  'Owned by S2-08: only pending_reanalysis → analyzed for source versions of a completed analysis.',
  'The analysis_status ownership comment is exact');

-- (k) persist_analysis_batch: atomic staging + checkpoint advance (spec §5.3).
create temporary table persist_ops(
  name text primary key,
  operation_id uuid not null
) on commit drop;

create function pg_temp.persist_op(p_name text)
returns uuid
language sql stable
set search_path = pg_temp, public
as $$
  select operation_id from pg_temp.persist_ops where name = p_name
$$;

create function pg_temp.persist_analysis_fixture(
  p_name text,
  p_version_count integer default 2
) returns uuid
language plpgsql
set search_path = pg_temp, public
as $$
declare
  v_analysis uuid;
  v_op uuid;
  v_case pg_temp.analysis_case%rowtype;
begin
  v_analysis := pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '10000000-0000-4000-8000-000000000001',
    'queued', p_version_count);
  select * into v_case from pg_temp.analysis_case
    where analysis_id = v_analysis and ordinal = 2;
  insert into public.analysis_documents(analysis_id, workspace_id, document_id, version_id, role)
  values (v_analysis, v_case.workspace_id, v_case.document_id, v_case.version_id, 'comparison')
  on conflict do nothing;
  perform pg_temp.force_analysis_checks();

  select c.operation_id into v_op from public.claim_analysis(v_analysis) c;
  update public.analyses
     set checkpoint = '{"processedPairs":0,"totalPairs":10,"findingsCount":0}'::jsonb
   where id = v_analysis;

  insert into pg_temp.persist_ops(name, operation_id) values (p_name, v_op);
  insert into pg_temp.analysis_fixture_ids(name, analysis_id) values (p_name, v_analysis);
  return v_analysis;
end;
$$;

create function pg_temp.close_persist_fixture(p_name text)
returns void
language sql
set search_path = pg_temp, public
as $$
  update public.analyses
     set status = 'failed', error_code = 'INTERNAL_ERROR'
   where id = pg_temp.analysis_fixture_id(p_name)
$$;

create function pg_temp.persist_finding(
  p_analysis_name text,
  p_type text,
  p_severity text,
  p_source_snapshot text,
  p_comparison_snapshot text,
  p_explanation text default 'Synthetic persist finding',
  p_confidence double precision default 0.8,
  p_source_scope text default null,
  p_source_ordinal integer default 1,
  p_comparison_scope text default null,
  p_comparison_ordinal integer default 2
) returns jsonb
language sql stable
set search_path = pg_temp, public
as $$
  select jsonb_build_object(
    'type', p_type,
    'severity', p_severity,
    'confidence', p_confidence,
    'explanation', p_explanation,
    'evidence', jsonb_build_array(
      (select jsonb_build_object(
        'documentId', c.document_id,
        'versionId', c.version_id,
        'chunkId', c.chunk_id,
        'role', 'source',
        'snapshot', p_source_snapshot,
        'pageNumber', null,
        'section', null,
        'sectionHeading', null)
       from pg_temp.analysis_case c
       where c.analysis_id = pg_temp.analysis_fixture_id(coalesce(p_source_scope, p_analysis_name))
         and c.ordinal = p_source_ordinal),
      (select jsonb_build_object(
        'documentId', c.document_id,
        'versionId', c.version_id,
        'chunkId', c.chunk_id,
        'role', 'comparison',
        'snapshot', p_comparison_snapshot,
        'pageNumber', null,
        'section', null,
        'sectionHeading', null)
       from pg_temp.analysis_case c
       where c.analysis_id = pg_temp.analysis_fixture_id(coalesce(p_comparison_scope, p_analysis_name))
         and c.ordinal = p_comparison_ordinal)
    )
  )
$$;

select has_function('public', 'persist_analysis_batch',
  array['uuid', 'uuid', 'integer', 'jsonb', 'jsonb', 'boolean'],
  'The worker can atomically persist a batch and advance the checkpoint');
select ok(has_function_privilege('service_role',
    'public.persist_analysis_batch(uuid,uuid,integer,jsonb,jsonb,boolean)', 'EXECUTE'),
  'service_role can execute persist_analysis_batch');
select ok(not has_function_privilege('anon',
    'public.persist_analysis_batch(uuid,uuid,integer,jsonb,jsonb,boolean)', 'EXECUTE'),
  'anon cannot execute persist_analysis_batch');
select ok(not has_function_privilege('authenticated',
    'public.persist_analysis_batch(uuid,uuid,integer,jsonb,jsonb,boolean)', 'EXECUTE'),
  'authenticated cannot execute persist_analysis_batch');

-- (k-1) Stale operation, expired lease and cursor mismatch return false untouched.
select pg_temp.persist_analysis_fixture('persist_guard');
select is(public.persist_analysis_batch(
    pg_temp.analysis_fixture_id('persist_guard'),
    gen_random_uuid(), 0,
    '{"processedPairs":5,"totalPairs":10,"findingsCount":1}'::jsonb,
    jsonb_build_array(pg_temp.persist_finding(
      'persist_guard', 'contradiction', 'Medium', 'guard source', 'guard comparison')),
    false),
  false, 'A stale operation_id is rejected');
select is((select count(*)::integer from private.analysis_finding_staging
    where analysis_id = pg_temp.analysis_fixture_id('persist_guard')), 0,
  'A stale operation_id writes no staging');
select is((select checkpoint ->> 'processedPairs' from public.analyses
    where id = pg_temp.analysis_fixture_id('persist_guard')), '0',
  'A stale operation_id does not advance the checkpoint');

update public.analyses set lease_expires_at = clock_timestamp() - interval '1 second'
  where id = pg_temp.analysis_fixture_id('persist_guard');
select is(public.persist_analysis_batch(
    pg_temp.analysis_fixture_id('persist_guard'),
    pg_temp.persist_op('persist_guard'), 0,
    '{"processedPairs":5,"totalPairs":10,"findingsCount":1}'::jsonb,
    jsonb_build_array(pg_temp.persist_finding(
      'persist_guard', 'contradiction', 'Medium', 'guard source', 'guard comparison')),
    false),
  false, 'An expired lease is rejected');
select is((select count(*)::integer from private.analysis_finding_staging
    where analysis_id = pg_temp.analysis_fixture_id('persist_guard')), 0,
  'An expired lease writes no staging');

update public.analyses set lease_expires_at = clock_timestamp() + interval '60 seconds'
  where id = pg_temp.analysis_fixture_id('persist_guard');
select is(public.persist_analysis_batch(
    pg_temp.analysis_fixture_id('persist_guard'),
    pg_temp.persist_op('persist_guard'), 5,
    '{"processedPairs":10,"totalPairs":10,"findingsCount":1}'::jsonb,
    jsonb_build_array(pg_temp.persist_finding(
      'persist_guard', 'contradiction', 'Medium', 'guard source', 'guard comparison')),
    false),
  false, 'A cursor mismatch returns false instead of re-CASing in a legacy RPC');
select is((select count(*)::integer from private.analysis_finding_staging
    where analysis_id = pg_temp.analysis_fixture_id('persist_guard')), 0,
  'A cursor mismatch writes no staging');
select is((select checkpoint ->> 'processedPairs' from public.analyses
    where id = pg_temp.analysis_fixture_id('persist_guard')), '0',
  'A cursor mismatch does not advance the checkpoint');
select pg_temp.close_persist_fixture('persist_guard');

-- (k-2) A non-processing analysis returns false.
insert into pg_temp.analysis_fixture_ids(name, analysis_id) values
  ('persist_not_processing', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '10000000-0000-4000-8000-000000000001', 'queued', 2));
update public.analyses
   set checkpoint = '{"processedPairs":0,"totalPairs":10,"findingsCount":0}'::jsonb
 where id = pg_temp.analysis_fixture_id('persist_not_processing');
select is(public.persist_analysis_batch(
    pg_temp.analysis_fixture_id('persist_not_processing'),
    gen_random_uuid(), 0,
    '{"processedPairs":5,"totalPairs":10,"findingsCount":0}'::jsonb,
    jsonb_build_array(pg_temp.persist_finding(
      'persist_not_processing', 'contradiction', 'Medium', 'queued source', 'queued comparison')),
    false),
  false, 'A non-processing analysis is rejected');
select is((select count(*)::integer from private.analysis_finding_staging
    where analysis_id = pg_temp.analysis_fixture_id('persist_not_processing')), 0,
  'A non-processing analysis writes no staging');
select pg_temp.close_persist_fixture('persist_not_processing');

-- (k-3) has_more=true stages the batch and yields a continuation.
select pg_temp.persist_analysis_fixture('persist_more');
select is(public.persist_analysis_batch(
    pg_temp.analysis_fixture_id('persist_more'),
    pg_temp.persist_op('persist_more'), 0,
    '{"processedPairs":5,"totalPairs":10,"findingsCount":1}'::jsonb,
    jsonb_build_array(pg_temp.persist_finding(
      'persist_more', 'contradiction', 'Medium', 'more source', 'more comparison')),
    true),
  true, 'A valid batch with has_more=true persists');
select ok((select status = 'queued' and continuation_pending
    and operation_id is null and lease_expires_at is null
    and checkpoint ->> 'processedPairs' = '5'
    from public.analyses where id = pg_temp.analysis_fixture_id('persist_more')),
  'has_more=true yields the continuation and advances the checkpoint');
select is((select count(*)::integer from private.analysis_finding_staging
    where analysis_id = pg_temp.analysis_fixture_id('persist_more')), 1,
  'has_more=true keeps the staged finding');
select is((select count(*)::integer from private.analysis_finding_evidence_staging
    where analysis_id = pg_temp.analysis_fixture_id('persist_more')), 2,
  'has_more=true keeps both staged evidence sides');
select pg_temp.close_persist_fixture('persist_more');

-- (k-4) has_more=false extends the lease, keeps processing and advances the cursor.
select pg_temp.persist_analysis_fixture('persist_final');
select is(public.persist_analysis_batch(
    pg_temp.analysis_fixture_id('persist_final'),
    pg_temp.persist_op('persist_final'), 0,
    '{"processedPairs":5,"totalPairs":10,"findingsCount":1}'::jsonb,
    jsonb_build_array(pg_temp.persist_finding(
      'persist_final', 'obsolescence', 'High', 'final source', 'final comparison')),
    false),
  true, 'A valid batch with has_more=false persists');
select ok((select status = 'processing' and not continuation_pending
    and checkpoint ->> 'processedPairs' = '5'
    and lease_expires_at > clock_timestamp() + interval '170 seconds'
    and lease_expires_at <= started_at + interval '30 minutes'
    from public.analyses where id = pg_temp.analysis_fixture_id('persist_final')),
  'has_more=false renews the lease without changing the checkpoint semantics');
select is((select count(*)::integer from private.analysis_finding_staging
    where analysis_id = pg_temp.analysis_fixture_id('persist_final')), 1,
  'has_more=false stages the finding');
select pg_temp.close_persist_fixture('persist_final');

-- (k-4b) A fresh analysis has checkpoint NULL; the first batch must treat it
-- as processedPairs=0, matching yield_analysis_batch.
select pg_temp.persist_analysis_fixture('persist_null_initial');
update public.analyses set checkpoint = null
  where id = pg_temp.analysis_fixture_id('persist_null_initial');
select is(public.persist_analysis_batch(
    pg_temp.analysis_fixture_id('persist_null_initial'),
    pg_temp.persist_op('persist_null_initial'), 0,
    '{"processedPairs":1,"totalPairs":10,"findingsCount":1}'::jsonb,
    jsonb_build_array(pg_temp.persist_finding(
      'persist_null_initial', 'contradiction', 'Medium', 'null source', 'null comparison')),
    false),
  true, 'A NULL checkpoint accepts the first batch at expected cursor 0');
select is((select checkpoint ->> 'processedPairs' from public.analyses
    where id = pg_temp.analysis_fixture_id('persist_null_initial')), '1',
  'A NULL checkpoint advances to the first batch cursor');
select pg_temp.close_persist_fixture('persist_null_initial');

-- (k-5) Malformed findings are rejected before any write.
select pg_temp.persist_analysis_fixture('persist_malformed');
select throws_ok(format(
    'select public.persist_analysis_batch(%L::uuid, %L::uuid, 0, %L::jsonb, %L::jsonb, false)',
    pg_temp.analysis_fixture_id('persist_malformed'), pg_temp.persist_op('persist_malformed'),
    '{"processedPairs":5,"totalPairs":10,"findingsCount":0}', '{}'),
  '22023', null, 'A non-array findings payload is rejected');
select throws_ok(format(
    'select public.persist_analysis_batch(%L::uuid, %L::uuid, 0, %L::jsonb, %L::jsonb, false)',
    pg_temp.analysis_fixture_id('persist_malformed'), pg_temp.persist_op('persist_malformed'),
    '{"processedPairs":5,"totalPairs":10,"findingsCount":0}',
    '[{"type":"contradiction","severity":"Medium","confidence":0.8,"explanation":"x","evidence":[]}]'),
  '22023', null, 'A finding without two evidence sides is rejected');
select throws_ok(format(
    'select public.persist_analysis_batch(%L::uuid, %L::uuid, 0, %L::jsonb, %L::jsonb, false)',
    pg_temp.analysis_fixture_id('persist_malformed'), pg_temp.persist_op('persist_malformed'),
    '{"processedPairs":5,"totalPairs":10,"findingsCount":0}',
    jsonb_build_array(jsonb_set(
      pg_temp.persist_finding('persist_malformed', 'contradiction', 'Medium', 'bad source', 'bad comparison'),
      '{evidence,1,role}', '"source"'))::text),
  '22023', null, 'Two source evidence sides are rejected');
select throws_ok(format(
    'select public.persist_analysis_batch(%L::uuid, %L::uuid, 0, %L::jsonb, %L::jsonb, false)',
    pg_temp.analysis_fixture_id('persist_malformed'), pg_temp.persist_op('persist_malformed'),
    '{"processedPairs":5,"totalPairs":10,"findingsCount":0}',
    jsonb_build_array(jsonb_set(
      pg_temp.persist_finding('persist_malformed', 'contradiction', 'Medium', repeat('x', 2001), 'ok'),
      '{evidence,0,snapshot}', to_jsonb(repeat('x', 2001))))::text),
  '22023', null, 'A snapshot over 2.000 characters is rejected');
select throws_ok(format(
    'select public.persist_analysis_batch(%L::uuid, %L::uuid, 0, %L::jsonb, %L::jsonb, false)',
    pg_temp.analysis_fixture_id('persist_malformed'), pg_temp.persist_op('persist_malformed'),
    '{"processedPairs":5,"totalPairs":10,"findingsCount":0}',
    jsonb_build_array(jsonb_set(
      pg_temp.persist_finding('persist_malformed', 'contradiction', 'Medium', 'bad confidence', 'ok'),
      '{confidence}', '1.5'::jsonb))::text),
  '22023', null, 'A confidence outside [0,1] is rejected');
select is((select count(*)::integer from private.analysis_finding_staging
    where analysis_id = pg_temp.analysis_fixture_id('persist_malformed')), 0,
  'Malformed findings write no staging');
select is((select checkpoint ->> 'processedPairs' from public.analyses
    where id = pg_temp.analysis_fixture_id('persist_malformed')), '0',
  'Malformed findings do not advance the checkpoint');
select pg_temp.close_persist_fixture('persist_malformed');

-- (k-6) Out-of-scope evidence raises P0001 and rolls the whole batch back.
select pg_temp.persist_analysis_fixture('persist_scope');
insert into pg_temp.analysis_fixture_ids(name, analysis_id) values
  ('persist_scope_other', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '10000000-0000-4000-8000-000000000001', 'completed', 2));
select throws_ok(format(
    'select public.persist_analysis_batch(%L::uuid, %L::uuid, 0, %L::jsonb, %L::jsonb, false)',
    pg_temp.analysis_fixture_id('persist_scope'), pg_temp.persist_op('persist_scope'),
    '{"processedPairs":5,"totalPairs":10,"findingsCount":1}',
    jsonb_build_array(pg_temp.persist_finding(
      'persist_scope', 'contradiction', 'Medium', 'scope source', 'scope comparison',
      p_comparison_scope => 'persist_scope_other'))::text),
  'P0001', null, 'Evidence outside the analysis scope is rejected');
select is((select count(*)::integer from private.analysis_finding_staging
    where analysis_id = pg_temp.analysis_fixture_id('persist_scope')), 0,
  'Out-of-scope evidence writes no staging');
select is((select count(*)::integer from private.analysis_finding_evidence_staging
    where analysis_id = pg_temp.analysis_fixture_id('persist_scope')), 0,
  'Out-of-scope evidence writes no evidence staging');
select is((select checkpoint ->> 'processedPairs' from public.analyses
    where id = pg_temp.analysis_fixture_id('persist_scope')), '0',
  'Out-of-scope evidence does not advance the checkpoint');
select pg_temp.close_persist_fixture('persist_scope');

-- (k-7) Duplicate canonical fingerprints are first-wins within and across batches.
select pg_temp.persist_analysis_fixture('persist_dedup');
select is(public.persist_analysis_batch(
    pg_temp.analysis_fixture_id('persist_dedup'),
    pg_temp.persist_op('persist_dedup'), 0,
    '{"processedPairs":5,"totalPairs":10,"findingsCount":1}'::jsonb,
    jsonb_build_array(
      pg_temp.persist_finding('persist_dedup', 'contradiction', 'Medium', 'duplicate text', 'duplicate text', 'first wins'),
      pg_temp.persist_finding('persist_dedup', 'contradiction', 'Medium', 'duplicate text', 'duplicate text', 'second loses')),
    false),
  true, 'A batch with duplicate fingerprints persists');
select is((select count(*)::integer from private.analysis_finding_staging
    where analysis_id = pg_temp.analysis_fixture_id('persist_dedup')), 1,
  'Duplicate findings in one batch keep one staging row');
select is((select explanation from private.analysis_finding_staging
    where analysis_id = pg_temp.analysis_fixture_id('persist_dedup')), 'first wins',
  'The first canonical finding wins');
select is((select count(*)::integer from private.analysis_finding_evidence_staging
    where analysis_id = pg_temp.analysis_fixture_id('persist_dedup')), 2,
  'The duplicate keeps one evidence side per ordinal');

select is(public.persist_analysis_batch(
    pg_temp.analysis_fixture_id('persist_dedup'),
    pg_temp.persist_op('persist_dedup'), 5,
    '{"processedPairs":10,"totalPairs":10,"findingsCount":1}'::jsonb,
    jsonb_build_array(pg_temp.persist_finding(
      'persist_dedup', 'contradiction', 'Medium', 'duplicate text', 'duplicate text', 'third loses')),
    false),
  true, 'A second batch with the same fingerprint persists');
select is((select count(*)::integer from private.analysis_finding_staging
    where analysis_id = pg_temp.analysis_fixture_id('persist_dedup')), 1,
  'The second batch does not duplicate the staging finding');
select ok((select explanation = 'first wins' and batch_index = 0
    from private.analysis_finding_staging
    where analysis_id = pg_temp.analysis_fixture_id('persist_dedup')),
  'The first-wins row keeps its explanation and batch index');
select pg_temp.close_persist_fixture('persist_dedup');

-- (k-8) SQL recompute matches the frozen 8a-2 TS vectors byte-for-byte.
insert into public.analyses(
  id, workspace_id, initiator_id, status, fixed_cost, reserved_credits,
  idempotency_key, request_fingerprint, retrieval_config, pricing_version,
  prompt_version, output_schema_version, provider_config, attempt_count,
  operation_id, lease_expires_at, attempt_started_at, attempt_deadline_at,
  analysis_deadline_at, started_at, checkpoint
) values (
  'f1000000-0000-4000-8000-0000000000f1',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '10000000-0000-4000-8000-000000000001',
  'processing', 3, 3, 'parity-fingerprint', 'parity-fingerprint',
  '{"topK":5}'::jsonb, 'synthetic-v1', 'synthetic-v1', 'synthetic-v1',
  '{"primary":{"provider":"synthetic","model":"synthetic"}}'::jsonb, 1,
  'f2000000-0000-4000-8000-0000000000f2',
  clock_timestamp() + interval '60 seconds',
  clock_timestamp(), clock_timestamp() + interval '30 minutes',
  clock_timestamp() + interval '90 minutes', clock_timestamp(),
  '{"processedPairs":0,"totalPairs":10,"findingsCount":0}'::jsonb);

insert into public.documents(id, workspace_id, name, category, owner_id) values
  ('dddddddd-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'Parity source document', 'SOP', '10000000-0000-4000-8000-000000000001'),
  ('eeeeeeee-0000-4000-8000-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'Parity comparison document', 'SOP', '10000000-0000-4000-8000-000000000001');

insert into public.document_versions(
  id, workspace_id, document_id, version_number, storage_path, processing_status, version_status
) values
  ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'dddddddd-0000-4000-8000-000000000001', 1,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/dddddddd-0000-4000-8000-000000000001/11111111-1111-4111-8111-111111111111/original.md',
    'ready', 'active'),
  ('22222222-2222-4222-8222-222222222222', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'eeeeeeee-0000-4000-8000-000000000002', 1,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/eeeeeeee-0000-4000-8000-000000000002/22222222-2222-4222-8222-222222222222/original.md',
    'ready', 'active');
update public.documents set active_version_id = '11111111-1111-4111-8111-111111111111'
 where id = 'dddddddd-0000-4000-8000-000000000001';
update public.documents set active_version_id = '22222222-2222-4222-8222-222222222222'
 where id = 'eeeeeeee-0000-4000-8000-000000000002';

insert into public.document_chunks(
  id, workspace_id, version_id, chunk_index, text_content, embedding
) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '11111111-1111-4111-8111-111111111111', 0, 'Parity source chunk',
    ('[1,' || repeat('0,', 382) || '0]')::extensions.vector(384)),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '22222222-2222-4222-8222-222222222222', 0, 'Parity comparison chunk',
    ('[0,1,' || repeat('0,', 381) || '0]')::extensions.vector(384));

insert into public.analysis_documents(analysis_id, workspace_id, document_id, version_id, role) values
  ('f1000000-0000-4000-8000-0000000000f1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'dddddddd-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'source'),
  ('f1000000-0000-4000-8000-0000000000f1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'eeeeeeee-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 'comparison'),
  ('f1000000-0000-4000-8000-0000000000f1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'dddddddd-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'comparison');

insert into pg_temp.analysis_fixture_ids(name, analysis_id) values
  ('persist_parity', 'f1000000-0000-4000-8000-0000000000f1');
insert into pg_temp.persist_ops(name, operation_id) values
  ('persist_parity', 'f2000000-0000-4000-8000-0000000000f2');
insert into pg_temp.analysis_case(analysis_id, workspace_id, document_id, version_id, chunk_id, ordinal) values
  ('f1000000-0000-4000-8000-0000000000f1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'dddddddd-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-0000-4000-8000-000000000001', 1),
  ('f1000000-0000-4000-8000-0000000000f1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'eeeeeeee-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222',
    'bbbbbbbb-0000-4000-8000-000000000002', 2);

select is(public.persist_analysis_batch(
    'f1000000-0000-4000-8000-0000000000f1',
    'f2000000-0000-4000-8000-0000000000f2', 0,
    '{"processedPairs":10,"totalPairs":10,"findingsCount":7}'::jsonb,
    jsonb_build_array(
      pg_temp.persist_finding('persist_parity', 'contradiction', 'Medium',
        'Deploy is manual', 'Deploy is automated'),
      pg_temp.persist_finding('persist_parity', 'obsolescence', 'Medium',
        'Use Node 18', '  Use   Node 22  '),
      pg_temp.persist_finding('persist_parity', 'contradiction', 'Medium',
        'caf' || U&'\00E9', 'cafe' || U&'\0301'),
      pg_temp.persist_finding('persist_parity', 'contradiction', 'Medium',
        chr(128512), chr(57344), 'emoji', 0.8, p_comparison_ordinal => 1),
      pg_temp.persist_finding('persist_parity', 'contradiction', 'Medium',
        'a' || U&'\00A0' || 'b', 'a b'),
      pg_temp.persist_finding('persist_parity', 'contradiction', 'Medium',
        'a' || U&'\0085' || 'b', 'a b'),
      pg_temp.persist_finding('persist_parity', 'contradiction', 'Medium',
        E'\t\nDeploy  is\tmanual\n', 'Deploy is manual')),
    false),
  true, 'The parity batch persists');
select is(
  (select snapshot from private.analysis_finding_evidence_staging
   where analysis_id = 'f1000000-0000-4000-8000-0000000000f1'
     and fingerprint = '9f3762362bed0ff0edfd143ad20b29399f633dded3fa58b91f9be26395cda481'
     and role = 'source'),
  E'\t\nDeploy  is\tmanual\n',
  'Staging stores the original snapshot, not the normalized form');
select is((select fingerprint from private.analysis_finding_staging
    where analysis_id = 'f1000000-0000-4000-8000-0000000000f1' and finding_ordinal = 0),
  'a0b6c1003ed74ae73c1a76aba1c43c80a0c1cd47503bf627c8c8de2868652da9',
  'SQL fingerprint matches the plain TS golden vector');
select is((select fingerprint from private.analysis_finding_staging
    where analysis_id = 'f1000000-0000-4000-8000-0000000000f1' and finding_ordinal = 1),
  'cd58d8f5153b11f5ca5f0b07079dc3696dce9c148da13961f7f40daa1bd89e45',
  'SQL fingerprint matches the whitespace TS golden vector');
select is((select fingerprint from private.analysis_finding_staging
    where analysis_id = 'f1000000-0000-4000-8000-0000000000f1' and finding_ordinal = 2),
  'ca8e448658a753496c17ac1dce14dc4e678cdb7100569356f4e56cc4e7214e81',
  'SQL fingerprint matches the NFC/NFD TS golden vector');
select is((select fingerprint from private.analysis_finding_staging
    where analysis_id = 'f1000000-0000-4000-8000-0000000000f1' and finding_ordinal = 3),
  'ce102d8863f0f7cba24be6cf6e1b2dd5dfc870a2f537cb675e2e2b4b2311d77b',
  'SQL fingerprint matches the astral/BMP TS vector');
select is((select fingerprint from private.analysis_finding_staging
    where analysis_id = 'f1000000-0000-4000-8000-0000000000f1' and finding_ordinal = 4),
  '613061f4b7faf92dd9554c88d43ce240f1df4bb6b1dd680f80be7417835dc643',
  'SQL fingerprint keeps NBSP distinct');
select is((select fingerprint from private.analysis_finding_staging
    where analysis_id = 'f1000000-0000-4000-8000-0000000000f1' and finding_ordinal = 5),
  '04ca07748f138b784f2137298456c668e28aad4985bfe2cbc91b4a54d0bd89fc',
  'SQL fingerprint keeps NEL distinct');
select is((select fingerprint from private.analysis_finding_staging
    where analysis_id = 'f1000000-0000-4000-8000-0000000000f1' and finding_ordinal = 6),
  '9f3762362bed0ff0edfd143ad20b29399f633dded3fa58b91f9be26395cda481',
  'SQL fingerprint trims and collapses ASCII whitespace at the edges');
select pg_temp.close_persist_fixture('persist_parity');

-- (k-9) An empty findings array still stages nothing and advances the checkpoint.
select pg_temp.persist_analysis_fixture('persist_empty');
select is(public.persist_analysis_batch(
    pg_temp.analysis_fixture_id('persist_empty'),
    pg_temp.persist_op('persist_empty'), 0,
    '{"processedPairs":5,"totalPairs":10,"findingsCount":0}'::jsonb,
    '[]'::jsonb, true),
  true, 'An empty findings array persists successfully');
select is((select count(*)::integer from private.analysis_finding_staging
    where analysis_id = pg_temp.analysis_fixture_id('persist_empty')), 0,
  'An empty findings array stages nothing');
select ok((select status = 'queued' and continuation_pending
    and checkpoint ->> 'processedPairs' = '5'
    from public.analyses where id = pg_temp.analysis_fixture_id('persist_empty')),
  'An empty findings array still advances the checkpoint');
select pg_temp.close_persist_fixture('persist_empty');

-- (k-10) A failure mid-batch rolls back the findings already staged.
select pg_temp.persist_analysis_fixture('persist_rollback');
insert into pg_temp.analysis_fixture_ids(name, analysis_id) values
  ('persist_rollback_other', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '10000000-0000-4000-8000-000000000001', 'completed', 2));
select throws_ok(format(
    'select public.persist_analysis_batch(%L::uuid, %L::uuid, 0, %L::jsonb, %L::jsonb, false)',
    pg_temp.analysis_fixture_id('persist_rollback'),
    pg_temp.persist_op('persist_rollback'),
    '{"processedPairs":5,"totalPairs":10,"findingsCount":2}',
    jsonb_build_array(
      pg_temp.persist_finding(
        'persist_rollback', 'contradiction', 'Medium',
        'valid before rollback', 'valid before rollback'),
      pg_temp.persist_finding(
        'persist_rollback', 'contradiction', 'Medium',
        'out of scope', 'out of scope',
        p_comparison_scope => 'persist_rollback_other')
    )::text),
  'P0001', null,
  'A rollback mid-batch reverts the valid finding');
select is((select count(*)::integer from private.analysis_finding_staging
    where analysis_id = pg_temp.analysis_fixture_id('persist_rollback')), 0,
  'The valid finding from the partial batch is rolled back');
select is((select count(*)::integer from private.analysis_finding_evidence_staging
    where analysis_id = pg_temp.analysis_fixture_id('persist_rollback')), 0,
  'The valid evidence from the partial batch is rolled back');
select is((select checkpoint ->> 'processedPairs' from public.analyses
    where id = pg_temp.analysis_fixture_id('persist_rollback')), '0',
  'The checkpoint is not advanced by a failed batch');
select pg_temp.close_persist_fixture('persist_rollback');

-- (k-11) pageNumber 1.0 is truncated to 1 before the integer cast.
select pg_temp.persist_analysis_fixture('persist_pagenum');
select is(public.persist_analysis_batch(
    pg_temp.analysis_fixture_id('persist_pagenum'),
    pg_temp.persist_op('persist_pagenum'), 0,
    '{"processedPairs":5,"totalPairs":10,"findingsCount":1}'::jsonb,
    jsonb_build_array(jsonb_set(
      pg_temp.persist_finding('persist_pagenum', 'contradiction', 'Medium',
        'page one', 'page one'),
      '{evidence,0,pageNumber}', '1.0'::jsonb)),
    false),
  true, 'A pageNumber 1.0 is accepted and truncated');
select is((select page_number from private.analysis_finding_evidence_staging
    where analysis_id = pg_temp.analysis_fixture_id('persist_pagenum')
      and role = 'source'),
  1, 'The stored pageNumber is 1 (truncated from 1.0)');
select pg_temp.close_persist_fixture('persist_pagenum');

select * from finish();
rollback;
