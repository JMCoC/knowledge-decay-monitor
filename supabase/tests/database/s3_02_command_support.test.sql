begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
\ir review-fixtures.psql
select no_plan();

select pg_temp.create_review_fixture_case();
select pg_temp.create_review_fixture_case();
create temporary table review_support_context (
  workspace_id uuid not null,
  admin_id uuid not null,
  member_a_id uuid not null,
  member_b_id uuid not null,
  finding_id uuid not null,
  foreign_workspace_id uuid not null,
  foreign_finding_id uuid not null
) on commit drop;
insert into pg_temp.review_support_context
select first_case.workspace_id, first_case.admin_id, first_case.member_a_id, first_case.member_b_id,
       first_case.finding_a_id, second_case.workspace_id, second_case.finding_a_id
from pg_temp.review_fixture_case first_case
cross join lateral (
  select x.* from pg_temp.review_fixture_case x
  where x.workspace_id <> first_case.workspace_id order by x.workspace_id limit 1
) second_case
order by first_case.workspace_id limit 1;

create temporary table review_support_drafts(round_id uuid not null) on commit drop;
update public.findings f set status = 'confirmed'
where f.id = (select finding_id from pg_temp.review_support_context);
insert into public.correction_rounds(workspace_id, document_id, mode, base_version_id, status, created_by)
select c.workspace_id, c.document_id, 'assigned_findings', c.version_id, 'draft', c.admin_id
from pg_temp.review_fixture_case c
where c.workspace_id = (select workspace_id from pg_temp.review_support_context)
returning id;
insert into pg_temp.review_support_drafts
select r.id from public.correction_rounds r
where r.workspace_id = (select workspace_id from pg_temp.review_support_context)
  and r.status = 'draft';
create temporary table review_support_foreign_drafts(round_id uuid not null) on commit drop;
insert into public.correction_rounds(workspace_id, document_id, mode, base_version_id, status, created_by)
select c.workspace_id, c.document_id, 'administrative', c.version_id, 'draft', c.admin_id
from pg_temp.review_fixture_case c
where c.workspace_id = (select foreign_workspace_id from pg_temp.review_support_context)
returning id;
insert into pg_temp.review_support_foreign_drafts
select r.id from public.correction_rounds r
where r.workspace_id = (select foreign_workspace_id from pg_temp.review_support_context)
  and r.status = 'draft';
insert into public.correction_round_items(
  workspace_id, round_id, document_id, finding_id, initial_assignee_id, assignee_id
)
select r.workspace_id, r.id, r.document_id, c.finding_id, c.member_a_id, c.member_a_id
from public.correction_rounds r
join pg_temp.review_support_context c on c.workspace_id = r.workspace_id
where r.id = (select round_id from pg_temp.review_support_drafts);

create temporary table review_support_audit_event(event_id uuid primary key) on commit drop;
insert into pg_temp.review_support_audit_event values
  ('20000000-0000-4000-8000-000000000031'),
  ('20000000-0000-4000-8000-000000000032');

select ok(to_regprocedure('private.lock_review_actor(uuid)') is not null,
  'Reviewer actor validation and workspace lock are available');
select ok(to_regprocedure('private.lock_review_documents(uuid,uuid[])') is not null,
  'Document locks use one ordered, tenant-checked helper');
select ok(to_regprocedure('private.check_review_receipt(uuid,uuid,text,text,jsonb)') is not null,
  'Review receipts can be checked against a normalized payload');
select ok(to_regprocedure('private.finish_review_receipt(uuid,uuid,text,text,jsonb,uuid,bigint,text)') is not null,
  'A minimal review receipt can be inserted without overwriting a prior request');
select ok(to_regprocedure('private.review_finding_snapshot(uuid,uuid)') is not null,
  'Finding snapshots are projected explicitly by a private SQL helper');
select ok(to_regprocedure('private.review_round_snapshot(uuid,uuid)') is not null,
  'Round snapshots are projected explicitly by a private SQL helper');
select ok(to_regprocedure('private.review_open_round_snapshot(uuid,uuid)') is not null,
  'Open-round projections include only review DTO fields');
select ok(to_regprocedure('private.append_assignment_outbox(uuid,uuid,uuid)') is not null,
  'Assignment outbox insertion is coupled to a tenant-matched audit event');
select ok(to_regprocedure('public.review_list_assignees(uuid,bigint,integer)') is not null,
  'Assignees are read through an actor-scoped paginated RPC');
select ok(to_regprocedure('public.review_get_finding(uuid,uuid)') is not null,
  'A finding review snapshot is read through an actor-scoped RPC');
select ok(to_regprocedure('public.review_get_round_draft(uuid,uuid)') is not null,
  'Only an authorized draft selection is exposed by the draft RPC');

select ok(exists (
  select 1 from pg_catalog.pg_proc p
  where p.oid = to_regprocedure('public.review_list_assignees(uuid,bigint,integer)')
    and has_function_privilege('service_role', p.oid, 'EXECUTE')
    and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
    and not has_function_privilege('anon', p.oid, 'EXECUTE')
), 'Only the server service role may execute reviewer directory RPC');
select ok(exists (
  select 1 from pg_catalog.pg_proc p
  where p.oid = to_regprocedure('public.review_get_finding(uuid,uuid)')
    and has_function_privilege('service_role', p.oid, 'EXECUTE')
    and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
    and not has_function_privilege('anon', p.oid, 'EXECUTE')
), 'Authenticated and anonymous users cannot supply an actor to the privileged finding RPC');
select ok(exists (
  select 1 from pg_catalog.pg_proc p
  where p.oid = to_regprocedure('public.review_get_round_draft(uuid,uuid)')
    and has_function_privilege('service_role', p.oid, 'EXECUTE')
    and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
    and not has_function_privilege('anon', p.oid, 'EXECUTE')
), 'Only the service role can invoke private-draft recovery');
select ok(not exists (
  select 1 from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private'
    and p.proname in (
      'review_canonical_payload', 'review_command_fingerprint', 'review_reader_workspace',
      'lock_review_actor', 'lock_review_documents', 'check_review_receipt',
      'finish_review_receipt', 'review_finding_snapshot', 'review_round_snapshot',
      'review_open_round_snapshot', 'append_assignment_outbox'
    )
    and (
      has_function_privilege('public', p.oid, 'EXECUTE')
      or has_function_privilege('anon', p.oid, 'EXECUTE')
      or has_function_privilege('authenticated', p.oid, 'EXECUTE')
      or has_function_privilege('service_role', p.oid, 'EXECUTE')
    )
), 'Private helpers expose no callable API to Supabase client roles');

select is(public.review_list_assignees((select admin_id from pg_temp.review_support_context))->>'page', '1',
  'Reviewer directory defaults to page one');
select is(public.review_list_assignees((select admin_id from pg_temp.review_support_context))->>'pageSize', '25',
  'Reviewer directory defaults to page size 25');
select is(public.review_list_assignees((select admin_id from pg_temp.review_support_context))->>'total', '2',
  'Directory total counts only the authorized workspace Members');
select is(jsonb_array_length(public.review_list_assignees(
  (select admin_id from pg_temp.review_support_context), 2, 1)->'items'), 1,
  'Reviewer directory applies bounded pagination in SQL');
select throws_ok(format('select public.review_list_assignees(%L, 1, 25)',
  (select member_a_id from pg_temp.review_support_context)),
  '42501', null, 'A Member cannot enumerate workspace assignees');

select ok(not (public.review_get_finding(
  (select admin_id from pg_temp.review_support_context),
  (select finding_id from pg_temp.review_support_context)
)->'confidence' is not null), 'Finding snapshot omits confidence');
select ok(not (public.review_get_finding(
  (select admin_id from pg_temp.review_support_context),
  (select finding_id from pg_temp.review_support_context)
)? 'fingerprint'), 'Finding snapshot omits fingerprint');
select is(public.review_get_finding(
  (select admin_id from pg_temp.review_support_context),
  (select finding_id from pg_temp.review_support_context)
)->>'status', 'confirmed', 'Finding snapshot reflects the current persisted review state');
select throws_ok(format('select public.review_get_finding(%L, %L)',
  (select admin_id from pg_temp.review_support_context),
  (select foreign_finding_id from pg_temp.review_support_context)),
  'P0002', null, 'A foreign-tenant finding is indistinguishable from a missing one');
select throws_ok(format('select public.review_get_finding(%L, %L)',
  (select admin_id from pg_temp.review_support_context), gen_random_uuid()),
  'P0002', null, 'An absent finding uses the same not-found code');

select is(public.review_get_round_draft(
  (select admin_id from pg_temp.review_support_context),
  (select round_id from pg_temp.review_support_drafts)
)->'findingIds',
  jsonb_build_array((select finding_id from pg_temp.review_support_context)),
  'Draft recovery returns only the selected finding IDs');
select is(private.append_review_audit(
  (select admin_id from pg_temp.review_support_context), 'correction_round_draft_updated', 'correction_round',
  (select round_id from pg_temp.review_support_drafts),
  jsonb_build_object('roundId', (select round_id from pg_temp.review_support_drafts)),
  '20000000-0000-4000-8000-000000000032'
), '20000000-0000-4000-8000-000000000032'::uuid,
  'Draft-edit audit event accepts only the typed roundId metadata');
select throws_ok(format('select public.review_get_round_draft(%L, %L)',
  (select admin_id from pg_temp.review_support_context), gen_random_uuid()),
  'P0002', null, 'A missing draft does not reveal whether another workspace owns the ID');
select throws_ok(format('select public.review_get_round_draft(%L, %L)',
  (select admin_id from pg_temp.review_support_context),
  (select round_id from pg_temp.review_support_foreign_drafts)),
  'P0002', null, 'A foreign draft and a missing draft use the same not-found result');
select throws_ok(format('select public.review_get_round_draft(%L, %L)',
  (select member_a_id from pg_temp.review_support_context),
  (select round_id from pg_temp.review_support_drafts)),
  '42501', null, 'A Member cannot read a reviewer draft');
select lives_ok(format(
  'update public.correction_rounds set status = %L, opened_at = now(), revision = revision + 1 where id = %L',
  'collecting', (select round_id from pg_temp.review_support_drafts)
), 'A prepared assigned round can open after its draft projection was recovered');
select throws_ok(format('select public.review_get_round_draft(%L, %L)',
  (select admin_id from pg_temp.review_support_context),
  (select round_id from pg_temp.review_support_drafts)),
  'P0001', null, 'The owner gets a conflict rather than an editable projection after opening');
select is((private.review_open_round_snapshot(
  (select workspace_id from pg_temp.review_support_context),
  (select round_id from pg_temp.review_support_drafts)
)->'coverage'->>'requiredItemCount'), '1', 'Open-round projection derives its required coverage count');
select ok(not (private.review_open_round_snapshot(
  (select workspace_id from pg_temp.review_support_context),
  (select round_id from pg_temp.review_support_drafts)
)? 'confidence'), 'Open-round projection omits confidence even in nested findings');

select private.finish_review_receipt(
  (select workspace_id from pg_temp.review_support_context),
  (select admin_id from pg_temp.review_support_context),
  'updateRoundDraft', 'canonical-set-key',
  jsonb_build_object(
    'roundId', (select round_id from pg_temp.review_support_drafts),
    'revision', 2,
    'findingIds', jsonb_build_array(
      upper((select finding_id::text from pg_temp.review_support_context)),
      upper((select foreign_finding_id::text from pg_temp.review_support_context))
    )
  ),
  (select round_id from pg_temp.review_support_drafts), 1, 'draft'
);
select is((select replayed from private.check_review_receipt(
  (select workspace_id from pg_temp.review_support_context),
  (select admin_id from pg_temp.review_support_context),
  'updateRoundDraft', 'canonical-set-key',
  jsonb_build_object(
    'findingIds', jsonb_build_array(
      (select foreign_finding_id::text from pg_temp.review_support_context),
      (select finding_id::text from pg_temp.review_support_context)
    ),
    'revision', 2,
    'roundId', (select round_id from pg_temp.review_support_drafts)
  )
)), true, 'UUID case and set order canonicalize to the same receipt');
select is((select result_id from private.check_review_receipt(
  (select workspace_id from pg_temp.review_support_context),
  (select admin_id from pg_temp.review_support_context),
  'updateRoundDraft', 'canonical-set-key',
  jsonb_build_object(
    'findingIds', jsonb_build_array(
      (select foreign_finding_id::text from pg_temp.review_support_context),
      (select finding_id::text from pg_temp.review_support_context)
    ),
    'revision', 2,
    'roundId', (select round_id from pg_temp.review_support_drafts)
  )
)), (select round_id from pg_temp.review_support_drafts), 'Replay returns only the saved result identifier');
select throws_ok(format(
  'select * from private.check_review_receipt(%L, %L, %L, %L, %L::jsonb)',
  (select workspace_id from pg_temp.review_support_context),
  (select admin_id from pg_temp.review_support_context), 'updateRoundDraft', 'canonical-set-key',
  jsonb_build_object(
    'roundId', (select round_id from pg_temp.review_support_drafts),
    'revision', 3,
    'findingIds', jsonb_build_array(
      (select finding_id::text from pg_temp.review_support_context),
      (select foreign_finding_id::text from pg_temp.review_support_context)
    )
  )), 'P0001', null, 'Reusing an idempotency key with a different revision conflicts');

select is(private.append_review_audit(
  (select admin_id from pg_temp.review_support_context), 'finding_assigned', 'finding',
  (select finding_id from pg_temp.review_support_context),
  jsonb_build_object(
    'previousAssigneeId', (select member_a_id from pg_temp.review_support_context),
    'assigneeId', (select member_b_id from pg_temp.review_support_context)
  ),
  (select event_id from pg_temp.review_support_audit_event where event_id = '20000000-0000-4000-8000-000000000031')
), (select event_id from pg_temp.review_support_audit_event where event_id = '20000000-0000-4000-8000-000000000031'),
  'Assignment audit validates both prior and new same-tenant Member IDs');
select lives_ok(format('select private.append_assignment_outbox(%L, %L, %L)',
  (select workspace_id from pg_temp.review_support_context),
  (select event_id from pg_temp.review_support_audit_event where event_id = '20000000-0000-4000-8000-000000000031'),
  (select member_b_id from pg_temp.review_support_context)),
  'A valid assignment audit event creates a typed outbox record');
select lives_ok(format('select private.append_assignment_outbox(%L, %L, %L)',
  (select workspace_id from pg_temp.review_support_context),
  (select event_id from pg_temp.review_support_audit_event where event_id = '20000000-0000-4000-8000-000000000031'),
  (select member_b_id from pg_temp.review_support_context)),
  'Repeated outbox insertion preserves one idempotent recipient event');
select is((select count(*)::integer from public.notification_events e
  where e.workspace_id = (select workspace_id from pg_temp.review_support_context)
    and e.workflow_event_id = (select event_id from pg_temp.review_support_audit_event where event_id = '20000000-0000-4000-8000-000000000031')
    and e.workflow_type = 'assignment'
    and e.recipient_id = (select member_b_id from pg_temp.review_support_context)), 1,
  'Assignment outbox has one row for the intended new Member');
select throws_ok(format('select private.append_assignment_outbox(%L, %L, %L)',
  (select workspace_id from pg_temp.review_support_context),
  (select event_id from pg_temp.review_support_audit_event where event_id = '20000000-0000-4000-8000-000000000031'),
  (select member_a_id from pg_temp.review_support_context)),
  '22023', null, 'Outbox recipient must match the validated assignment audit');

select finish();
rollback;
