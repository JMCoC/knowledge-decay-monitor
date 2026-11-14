begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
\ir review-fixtures.psql
select no_plan();

select ok(pg_temp.create_review_fixture_case() is not null,
  'Shared review fixtures create synthetic findings with two independent Members');

select has_table('public', 'correction_rounds', 'Correction rounds persist per document');
select has_table('public', 'correction_round_items', 'An opened round persists its fixed findings');
select has_table('public', 'correction_submissions', 'Member deliveries persist independently');
select has_table('public', 'correction_submission_items', 'A delivery can cover multiple round items');
select has_table('public', 'correction_candidates', 'Final candidates are persisted separately');
select has_table('public', 'correction_candidate_items', 'Candidate contribution snapshots persist');
select has_table('public', 'correction_returns', 'Return decisions are append-only records');
select has_table('public', 'correction_return_items', 'Returns identify only the affected items');
select has_table('public', 'correction_candidate_decisions', 'Candidate decisions persist explicitly');
select has_table('public', 'correction_approval_contributions', 'Own approval history is projectable');
select has_table('private', 'review_commands', 'Idempotency receipts stay in the private schema');

select has_column('public', 'findings', 'review_revision', 'Finding review uses a monotonic revision');
select col_not_null('public', 'findings', 'review_revision', 'Finding review revision is required');
select col_default_is('public', 'findings', 'review_revision', '1', 'New findings begin at review revision one');
select ok(exists (
  select 1 from pg_constraint
  where conrelid = 'public.findings'::regclass
    and conname = 'findings_review_revision_positive'
), 'Finding review revision rejects non-positive values');
select col_not_null('public', 'document_versions', 'workflow_kind', 'Version workflow provenance is required');
select col_default_is(
  'public', 'document_versions', 'workflow_kind', 'initial',
  'Existing and new initial versions default to initial provenance'
);
select is((
  select data_type from information_schema.columns
  where table_schema = 'public' and table_name = 'document_versions' and column_name = 'workflow_kind'
), 'text', 'Workflow provenance remains additive text');

select is((
  select array_agg(e.enumlabel::text order by e.enumsortorder)
  from pg_type t
  join pg_namespace n on n.oid = t.typnamespace
  left join pg_enum e on e.enumtypid = t.oid
  where n.nspname = 'public' and t.typname = 'finding_status'
), ARRAY['pending_review', 'confirmed', 'false_positive', 'update_planned', 'resolved']::text[],
  'Finding enum includes every PRD review state');

select has_index(
  'public', 'findings', 'findings_id_workspace_key', ARRAY['id', 'workspace_id']::name[],
  'Findings expose a composite tenant key for new foreign keys'
);
select ok(coalesce((
  select i.indisunique
  from pg_index i
  where i.indexrelid = to_regclass('public.findings_id_workspace_key')
), false), 'Finding id/workspace composite index is unique');
select fk_ok(
  'public', 'correction_rounds', ARRAY['document_id', 'workspace_id']::name[],
  'public', 'documents', ARRAY['id', 'workspace_id']::name[],
  'Rounds reference a document in the same workspace'
);
select fk_ok(
  'public', 'correction_round_items', ARRAY['finding_id', 'workspace_id']::name[],
  'public', 'findings', ARRAY['id', 'workspace_id']::name[],
  'Round items reference findings in the same workspace'
);
select fk_ok(
  'public', 'correction_submission_items',
  ARRAY['round_item_id', 'round_id', 'document_id', 'workspace_id']::name[],
  'public', 'correction_round_items', ARRAY['id', 'round_id', 'document_id', 'workspace_id']::name[],
  'Grouped deliveries cannot cross their round, document, or tenant'
);
select ok(coalesce((
  select c.relrowsecurity
  from pg_class c
  where c.oid = to_regclass('public.correction_rounds')
), false), 'New public workflow tables enable RLS from creation');
select ok(coalesce((
  select c.relrowsecurity
  from pg_class c
  where c.oid = to_regclass('private.review_commands')
), false), 'Private command receipts enable RLS');

select * from finish();
rollback;
