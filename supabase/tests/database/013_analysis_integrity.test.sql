begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
\ir analysis-fixtures.psql
select no_plan();

select is((
  select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private'
    and p.proname in ('lock_analysis_references', 'validate_analysis_integrity', 'check_analysis_integrity')
), 3, 'Internal analysis integrity trigger functions exist');
select ok(coalesce((
  select bool_and(not p.prosecdef) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private'
    and p.proname in ('lock_analysis_references', 'validate_analysis_integrity', 'check_analysis_integrity')
), false), 'Integrity functions do not bypass RLS');
select ok(not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private' and p.proname = 'validate_analysis_integrity'
    and has_function_privilege('authenticated', p.oid, 'EXECUTE')
),
  'Authenticated callers cannot invoke the internal validator');

select lives_ok($$select pg_temp.create_analysis_fixture_and_check(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '10000000-0000-4000-8000-000000000001', 'completed', 20)$$,
  '20 distinct versions are accepted when constraints are forced');
select throws_ok($$select pg_temp.create_analysis_fixture_and_check(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '10000000-0000-4000-8000-000000000001', 'completed', 21)$$,
  '23514', null, '21 distinct versions are rejected at transaction validation');
select lives_ok($$select pg_temp.create_overlap_analysis_and_check(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '10000000-0000-4000-8000-000000000001')$$,
  'A version with source and comparison roles counts once');
select throws_ok($$select pg_temp.create_analysis_fixture_and_check(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '10000000-0000-4000-8000-000000000001', 'completed', 0)$$,
  '23514', null, 'An analysis without a source is rejected');
select throws_ok($$select pg_temp.remove_all_source_and_check(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '10000000-0000-4000-8000-000000000001')$$,
  '23514', null, 'Deleting the last source is rejected');
select throws_ok($$select pg_temp.create_out_of_scope_evidence_and_check(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '10000000-0000-4000-8000-000000000001')$$,
  '23514', null, 'Evidence cannot reference another in-tenant analysis version');

insert into pg_temp.analysis_fixture_ids(name, analysis_id) values
  ('scope_pair', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001', 'completed', 2));
insert into public.analysis_documents(analysis_id, workspace_id, document_id, version_id, role)
select c.analysis_id, c.workspace_id, c.document_id, c.version_id, 'comparison'
from pg_temp.analysis_case c
where c.analysis_id = pg_temp.analysis_fixture_id('scope_pair') and c.ordinal = 1;
insert into pg_temp.finding_fixture_ids(name, finding_id, analysis_id)
select 'scope_pair_finding',
  pg_temp.insert_finding_row(a.analysis_id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 0.5),
  a.analysis_id
from pg_temp.analysis_fixture_ids a where a.name = 'scope_pair';
select lives_ok($$select pg_temp.record_fixture_evidence_and_check(
  'scope_pair_evidence', 'scope_pair', 'scope_pair_finding', 'scope_pair', 1, 'Synthetic evidence')$$,
  'Evidence remains valid while its source version is in scope');
select lives_ok(format('select pg_temp.remove_analysis_scope_and_check(%L::uuid, 1, ''source'')',
  pg_temp.analysis_fixture_id('scope_pair')),
  'Removing one role is allowed while the other role retains evidence scope');
select throws_ok(format('select pg_temp.remove_analysis_scope_and_check(%L::uuid, 1, ''comparison'')',
  pg_temp.analysis_fixture_id('scope_pair')),
  '23514', null, 'Removing the last role for an evidence version is rejected');

insert into pg_temp.analysis_fixture_ids(name, analysis_id) values
  ('move_a', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001', 'completed', 2)),
  ('move_b', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001', 'completed', 2));
select lives_ok($$select pg_temp.move_analysis_scope_and_check('move_a', 'move_b')$$,
  'Scope updates validate both old and new analyses against final state');

insert into pg_temp.analysis_fixture_ids(name, analysis_id) values
  ('chunk_update', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001', 'completed', 1)),
  ('update_target', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001', 'completed', 1));
insert into pg_temp.finding_fixture_ids(name, finding_id, analysis_id)
select 'chunk_update_finding',
  pg_temp.insert_finding_row(a.analysis_id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 0.5),
  a.analysis_id
from pg_temp.analysis_fixture_ids a where a.name = 'chunk_update';
select lives_ok($$select pg_temp.record_fixture_evidence_and_check(
  'chunk_update_evidence', 'chunk_update', 'chunk_update_finding', 'chunk_update', 1, 'Synthetic evidence')$$,
  'Evidence can be attached to a completed analysis scope');
select lives_ok($$select pg_temp.update_evidence_chunk_and_check(
  'chunk_update_evidence', 'chunk_update', 1)$$,
  'Evidence can change to another chunk of the same version');
select throws_ok($$select pg_temp.update_evidence_version_and_check(
  'chunk_update_evidence', 'chunk_update', 'update_target', 1)$$,
  '23514', null, 'Evidence cannot be updated to a version outside its analysis scope');

insert into pg_temp.analysis_fixture_ids(name, analysis_id) values
  ('historical', pg_temp.create_analysis_fixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001', 'completed', 1));
insert into pg_temp.finding_fixture_ids(name, finding_id, analysis_id)
select 'historical_finding',
  pg_temp.insert_finding_row(a.analysis_id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 0.5),
  a.analysis_id
from pg_temp.analysis_fixture_ids a where a.name = 'historical';
select lives_ok($$select pg_temp.record_fixture_evidence_and_check(
  'historical_evidence', 'historical', 'historical_finding', 'historical', 1, repeat('😀', 2000))$$,
  'A 2000-character Unicode snapshot remains valid with integrity triggers');
select throws_ok($$select pg_temp.insert_fixture_evidence(
  'historical', 'historical_finding', 'historical', 1, repeat('😀', 2001))$$,
  '23514', null, 'A 2001-character Unicode snapshot remains rejected');
select lives_ok($$select pg_temp.activate_next_fixture_version_and_check(
  'historical', 'historical_evidence')$$,
  'Historical evidence remains valid after activating a newer document version');
select is((select count(*)::integer from public.finding_evidence
  where id = (select evidence_id from pg_temp.evidence_fixture_ids where name = 'historical_evidence')),
  1, 'Version activation does not delete the historical evidence row');
select is((select analysis_status::text from public.document_versions
  where id = (select version_id from pg_temp.analysis_case
    where analysis_id = pg_temp.analysis_fixture_id('historical') and ordinal = 1)),
  'pending_reanalysis', 'Analysis integrity does not take ownership of ingestion analysis_status');

select lives_ok($$select pg_temp.create_delete_empty_analysis_and_check(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '10000000-0000-4000-8000-000000000001')$$,
  'An empty analysis created and deleted within the transaction leaves no invalid parent');
select lives_ok($$select pg_temp.create_analysis_fixture_and_check(
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  '10000000-0000-4000-8000-000000000004', 'completed', 1)$$,
  'Analysis and its source may be inserted in one transaction');

select * from finish();
rollback;
