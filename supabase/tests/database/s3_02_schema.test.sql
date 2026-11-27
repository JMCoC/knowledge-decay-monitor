begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
\ir review-fixtures.psql
select no_plan();

select has_column('public', 'correction_rounds', 'coverage_revision',
  'Round coverage has a revision independent of reviewer decisions');
select has_column('public', 'correction_round_items', 'coverage_revision',
  'Item coverage has a revision independent of current assignment');
select has_column('public', 'correction_round_items', 'opened_assignee_id',
  'Opened rounds preserve the assignee snapshot at publication');
select col_not_null('public', 'correction_rounds', 'coverage_revision',
  'Round coverage revision is always present');
select col_not_null('public', 'correction_round_items', 'coverage_revision',
  'Item coverage revision is always present');
select col_default_is('public', 'correction_rounds', 'coverage_revision', '1',
  'New rounds begin with a positive coverage revision');
select col_default_is('public', 'correction_round_items', 'coverage_revision', '1',
  'New items begin with a positive coverage revision');

select has_table('private', 'review_round_cancellations',
  'Private cancellation reasons are stored separately from public round snapshots');
select ok(not has_table_privilege('authenticated', 'private.review_round_cancellations', 'SELECT')
    and not has_table_privilege('anon', 'private.review_round_cancellations', 'SELECT')
    and not has_table_privilege('service_role', 'private.review_round_cancellations', 'SELECT'),
  'No API role can read private cancellation reasons directly');
select ok(not has_table_privilege('authenticated', 'private.review_round_cancellations', 'INSERT')
    and not has_table_privilege('anon', 'private.review_round_cancellations', 'INSERT')
    and not has_table_privilege('service_role', 'private.review_round_cancellations', 'INSERT'),
  'Cancellation reasons can only be stored by owning database functions');

select ok(exists (
  select 1 from pg_constraint
  where conrelid = 'private.review_commands'::regclass
    and conname = 'review_commands_operation_check'
    and pg_get_constraintdef(oid) like '%updateRoundDraft%'
), 'Private command receipts accept the draft-edit operation');
select is((
  select array_agg(e.enumlabel::text order by e.enumsortorder)
  from pg_type t join pg_namespace n on n.oid = t.typnamespace
  join pg_enum e on e.enumtypid = t.oid
  where n.nspname = 'public' and t.typname = 'review_audit_action'
), ARRAY[
  'finding_status_changed', 'finding_severity_changed', 'finding_assigned',
  'correction_round_prepared', 'correction_round_opened', 'correction_round_cancelled',
  'correction_submission_confirmed', 'correction_candidate_selected', 'correction_items_returned',
  'correction_candidate_approved', 'correction_candidate_rejected', 'correction_candidate_invalidated',
  'correction_round_draft_updated', 'correction_submission_expired'
]::text[], 'Audit enum includes the appended draft-edit event');

select finish();
rollback;
