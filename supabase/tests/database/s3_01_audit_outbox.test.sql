begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
\ir review-fixtures.psql
select no_plan();

create temporary table audit_outbox_fixtures on commit drop as
select f.*, null::uuid as round_id, null::uuid as candidate_id, null::uuid as finding_round_id,
       null::uuid as finding_item_id, null::uuid as submission_id
from pg_temp.review_fixture_case f
where false;
do $$
begin
  perform pg_temp.create_review_fixture_case();
  perform pg_temp.create_review_fixture_case();
end;
$$;
insert into pg_temp.audit_outbox_fixtures
select f.*, null, null, null, null, null
from pg_temp.review_fixture_case f
order by f.workspace_id;

update pg_temp.audit_outbox_fixtures f
set round_id = pg_temp.create_review_round(f.workspace_id, 'administrative', '{}'::uuid[])
where f.workspace_id = (select workspace_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1);
update public.correction_rounds r
set status = 'consolidating', revision = revision + 1
where r.id = (select round_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1);
update pg_temp.audit_outbox_fixtures f
set candidate_id = pg_temp.create_consolidated_candidate(f.round_id, f.admin_id)
where f.round_id is not null;

update pg_temp.audit_outbox_fixtures f
set finding_round_id = pg_temp.create_review_round(
      f.workspace_id, 'assigned_findings', array[f.finding_a_id]
    )
where f.workspace_id = (select workspace_id from pg_temp.audit_outbox_fixtures order by workspace_id desc limit 1);
update pg_temp.audit_outbox_fixtures f
set finding_item_id = i.id
from public.correction_round_items i
where i.round_id = f.finding_round_id;
update pg_temp.audit_outbox_fixtures f
set submission_id = pg_temp.create_review_submission(
      f.finding_round_id, f.member_a_id, array[f.finding_item_id]
    )
where f.finding_round_id is not null;

select has_table('public', 'audit_events', 'The internal audit ledger exists');
select has_column('public', 'notification_events', 'workflow_event_id',
  'Workflow notifications reference a business audit event');
select has_column('public', 'notification_events', 'workflow_type',
  'Workflow notifications have a separate kind from terminal S2 notifications');
select ok((select relrowsecurity from pg_class where oid = 'public.audit_events'::regclass),
  'Audit rows are protected by RLS');
select ok(not has_table_privilege('anon', 'public.audit_events', 'SELECT')
    and not has_table_privilege('authenticated', 'public.audit_events', 'SELECT')
    and not has_table_privilege('service_role', 'public.audit_events', 'SELECT'),
  'No client or service role can read the audit ledger directly');
select ok(not has_table_privilege('anon', 'public.audit_events', 'INSERT')
    and not has_table_privilege('authenticated', 'public.audit_events', 'INSERT')
    and not has_table_privilege('service_role', 'public.audit_events', 'INSERT'),
  'No client or service role can append arbitrary audit rows');
select ok(not has_table_privilege('anon', 'public.audit_events', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.audit_events', 'UPDATE')
    and not has_table_privilege('service_role', 'public.audit_events', 'UPDATE')
    and not has_table_privilege('anon', 'public.audit_events', 'DELETE')
    and not has_table_privilege('authenticated', 'public.audit_events', 'DELETE')
    and not has_table_privilege('service_role', 'public.audit_events', 'DELETE'),
  'Clients and service role cannot update or delete audit rows');
select ok(not has_function_privilege('anon',
    'private.append_review_audit(uuid,text,text,uuid,jsonb,uuid)', 'EXECUTE')
    and not has_function_privilege('authenticated',
    'private.append_review_audit(uuid,text,text,uuid,jsonb,uuid)', 'EXECUTE')
    and not has_function_privilege('service_role',
    'private.append_review_audit(uuid,text,text,uuid,jsonb,uuid)', 'EXECUTE'),
  'Only the transaction owner can call the audit append helper');
select ok(not has_function_privilege('service_role', 'private.guard_workflow_notification_event()', 'EXECUTE')
    and not has_function_privilege('service_role', 'private.reject_audit_event_mutation()', 'EXECUTE'),
  'Trigger implementation functions are not callable by the server role');

create temporary table audit_outbox_event_ids (
  event_name text primary key,
  event_id uuid not null,
  workspace_id uuid not null,
  recipient_id uuid
) on commit drop;
insert into pg_temp.audit_outbox_event_ids values
  ('assignment', '20000000-0000-4000-8000-000000000001',
    (select workspace_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
    (select member_a_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1)),
  ('approval', '20000000-0000-4000-8000-000000000002',
    (select workspace_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
    (select member_a_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1)),
  ('rejection', '20000000-0000-4000-8000-000000000003',
    (select workspace_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
    (select member_b_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1));

select is(pg_temp.append_review_audit_fixture(
    (select admin_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
    'finding_status_changed', 'finding',
    (select finding_a_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
    '{"previousStatus":"pending_review","status":"confirmed"}'::jsonb,
    '20000000-0000-4000-8000-000000000010'),
  '20000000-0000-4000-8000-000000000010'::uuid,
  'A valid finding status change is appended');
select is(private.append_review_audit(
    (select admin_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
    'finding_severity_changed', 'finding',
    (select finding_b_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
    '{"previousSeverity":"Low","severity":"High"}'::jsonb,
    '20000000-0000-4000-8000-000000000011'),
  '20000000-0000-4000-8000-000000000011'::uuid,
  'A valid severity change is appended');
select is(private.append_review_audit(
    (select admin_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
    'finding_assigned', 'finding',
    (select finding_a_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
    jsonb_build_object('assigneeId', (select member_b_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1)),
    (select event_id from pg_temp.audit_outbox_event_ids where event_name = 'assignment')),
  (select event_id from pg_temp.audit_outbox_event_ids where event_name = 'assignment'),
  'A valid assignment audit event is appended');
select is(private.append_review_audit(
    (select admin_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
    'correction_round_prepared', 'correction_round',
    (select round_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
    jsonb_build_object('roundId', (select round_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1)),
    '20000000-0000-4000-8000-000000000012'),
  '20000000-0000-4000-8000-000000000012'::uuid,
  'A valid round event is appended');
select is(private.append_review_audit(
    (select member_a_id from pg_temp.audit_outbox_fixtures order by workspace_id desc limit 1),
    'correction_submission_confirmed', 'correction_submission',
    (select submission_id from pg_temp.audit_outbox_fixtures order by workspace_id desc limit 1),
    jsonb_build_object(
      'roundId', (select finding_round_id from pg_temp.audit_outbox_fixtures order by workspace_id desc limit 1),
      'submissionId', (select submission_id from pg_temp.audit_outbox_fixtures order by workspace_id desc limit 1)
    ),
    '20000000-0000-4000-8000-000000000013'),
  '20000000-0000-4000-8000-000000000013'::uuid,
  'A valid Member delivery event is appended');
select is(private.append_review_audit(
    (select admin_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
    'correction_candidate_selected', 'correction_candidate',
    (select candidate_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
    jsonb_build_object(
      'candidateId', (select candidate_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
      'roundId', (select round_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1)
    ),
    '20000000-0000-4000-8000-000000000014'),
  '20000000-0000-4000-8000-000000000014'::uuid,
  'A valid candidate selection event is appended');
select is(private.append_review_audit(
    (select admin_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
    'correction_items_returned', 'correction_round',
    (select round_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
    jsonb_build_object(
      'roundId', (select round_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
      'outcome', 'rejected'
    ),
    '20000000-0000-4000-8000-000000000015'),
  '20000000-0000-4000-8000-000000000015'::uuid,
  'A valid returned-items event is appended');
select is(private.append_review_audit(
    (select admin_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
    'correction_candidate_approved', 'correction_candidate',
    (select candidate_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
    jsonb_build_object(
      'candidateId', (select candidate_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
      'outcome', 'approved', 'retention', 'retain'
    ),
    (select event_id from pg_temp.audit_outbox_event_ids where event_name = 'approval')),
  (select event_id from pg_temp.audit_outbox_event_ids where event_name = 'approval'),
  'A valid candidate decision is appended');
select is(private.append_review_audit(
    (select admin_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
    'correction_candidate_rejected', 'correction_candidate',
    (select candidate_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
    jsonb_build_object(
      'candidateId', (select candidate_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
      'outcome', 'rejected'
    ),
    (select event_id from pg_temp.audit_outbox_event_ids where event_name = 'rejection')),
  (select event_id from pg_temp.audit_outbox_event_ids where event_name = 'rejection'),
  'A valid rejected decision is appended');

select is(private.append_review_audit(
    (select admin_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
    'finding_assigned', 'finding',
    (select finding_a_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
    jsonb_build_object('assigneeId', (select member_b_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1)),
    (select event_id from pg_temp.audit_outbox_event_ids where event_name = 'assignment')),
  (select event_id from pg_temp.audit_outbox_event_ids where event_name = 'assignment'),
  'An exact event retry is idempotent');
select throws_ok(format(
  'select private.append_review_audit(%L, %L, %L, %L, %L::jsonb, %L)',
  (select admin_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
  'finding_assigned', 'finding',
  (select finding_a_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
  jsonb_build_object('assigneeId', (select member_a_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1)),
  (select event_id from pg_temp.audit_outbox_event_ids where event_name = 'assignment')),
  '23505', null, 'An event id cannot be replayed with different metadata');
select throws_ok(format(
  'select private.append_review_audit(%L, %L, %L, %L, %L::jsonb, %L)',
  (select admin_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
  'finding_assigned', 'finding',
  (select finding_a_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
  '{"assigneeId":null,"reason":"private text"}', gen_random_uuid()),
  '22023', null, 'Reasons are rejected from assignment audit metadata');
select throws_ok(format(
  'select private.append_review_audit(%L, %L, %L, %L, %L::jsonb, %L)',
  (select admin_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
  'finding_status_changed', 'finding',
  (select finding_a_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
  '{"previousStatus":"pending_review","status":"secret"}', gen_random_uuid()),
  '22023', null, 'Finding status values are checked against the enum allowlist');
select throws_ok(format(
  'select private.append_review_audit(%L, %L, %L, %L, %L::jsonb, %L)',
  (select admin_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
  'finding_status_changed', 'finding',
  (select finding_a_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
  '{"previousStatus":"pending_review","status":"confirmed","documentText":"private text"}', gen_random_uuid()),
  '22023', null, 'Document text is rejected from audit metadata');
select throws_ok(format(
  'select private.append_review_audit(%L, %L, %L, %L, %L::jsonb, %L)',
  (select admin_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
  'finding_assigned', 'finding',
  (select finding_a_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
  '{"assigneeId":null,"fileName":"source.docx"}', gen_random_uuid()),
  '22023', null, 'Filenames are rejected from audit metadata');
select throws_ok(format(
  'select private.append_review_audit(%L, %L, %L, %L, %L::jsonb, %L)',
  (select admin_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
  'finding_severity_changed', 'finding',
  (select finding_a_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
  '{"previousSeverity":"Low","severity":"High","sha256":"abc123"}', gen_random_uuid()),
  '22023', null, 'Hashes are rejected from audit metadata');
select throws_ok(format(
  'select private.append_review_audit(%L, %L, %L, %L, %L::jsonb, %L)',
  (select admin_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
  'correction_round_prepared', 'correction_round',
  (select round_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
  jsonb_build_object(
    'roundId', (select round_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
    'url', 'https://storage.example.test/signed'
  ), gen_random_uuid()),
  '22023', null, 'URLs are rejected from audit metadata');
select throws_ok(format(
  'select private.append_review_audit(%L, %L, %L, %L, %L::jsonb, %L)',
  (select admin_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
  'correction_candidate_approved', 'correction_candidate',
  (select candidate_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
  jsonb_build_object(
    'candidateId', (select candidate_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
    'outcome', 'approved', 'retention', null
  ), gen_random_uuid()),
  '22023', null, 'Decision metadata must not use null for a required value');
select throws_ok(format(
  'select private.append_review_audit(%L, %L, %L, %L, %L::jsonb, %L)',
  (select admin_id from pg_temp.audit_outbox_fixtures order by workspace_id desc limit 1),
  'finding_status_changed', 'finding',
  (select finding_a_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
  '{"previousStatus":"pending_review","status":"confirmed"}', gen_random_uuid()),
  '23514', null, 'An actor cannot append an event for a finding in another workspace');
select throws_ok(format(
  'select private.append_review_audit(%L, %L, %L, %L, %L::jsonb, %L)',
  (select member_a_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
  'finding_severity_changed', 'finding',
  (select finding_a_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
  '{"previousSeverity":"Low","severity":"High"}', gen_random_uuid()),
  '42501', null, 'A Member cannot author reviewer severity changes');

select throws_ok(format(
  'do $rollback$ declare v_audit_id uuid; v_workspace_id uuid; begin '
  || 'v_audit_id := private.append_review_audit(%L, %L, %L, %L, %L::jsonb, %L); '
  || 'select p.workspace_id into v_workspace_id from public.profiles p where p.id = %L; '
  || 'insert into public.notification_events(id, workspace_id, workflow_event_id, workflow_type, recipient_id) '
  || 'values (%L, v_workspace_id, v_audit_id, %L::public.workflow_notification_type, %L); '
  || 'raise exception using errcode = %L, message = %L; end $rollback$',
  (select admin_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
  'finding_assigned', 'finding',
  (select finding_a_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
  jsonb_build_object('assigneeId', (select member_b_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1)),
  '20000000-0000-4000-8000-000000000099',
  (select admin_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
  '30000000-0000-4000-8000-000000000099', 'assignment',
  (select member_b_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1),
  'P0001', 'forced rollback'),
  'P0001', 'forced rollback', 'Audit insert rolls back with its owning transaction');
select is((select count(*)::integer from public.audit_events
  where id = '20000000-0000-4000-8000-000000000099'), 0,
  'A failed owning transaction leaves no audit row');
select is((select count(*)::integer from public.notification_events
  where id = '30000000-0000-4000-8000-000000000099'), 0,
  'A failed owning transaction leaves no outbox notification');
select throws_ok('update public.audit_events set occurred_at = now()',
  '42501', null, 'Even the migration owner cannot update audit history through SQL');
select throws_ok('delete from public.audit_events',
  '42501', null, 'Even the migration owner cannot delete audit history through SQL');

create temporary table workflow_notification_fixtures (
  name text primary key,
  event_id uuid not null,
  audit_id uuid not null,
  workspace_id uuid not null,
  recipient_id uuid not null
) on commit drop;
insert into pg_temp.workflow_notification_fixtures values
  ('assignment', '30000000-0000-4000-8000-000000000001',
    (select event_id from pg_temp.audit_outbox_event_ids where event_name = 'assignment'),
    (select workspace_id from pg_temp.audit_outbox_event_ids where event_name = 'assignment'),
    (select recipient_id from pg_temp.audit_outbox_event_ids where event_name = 'assignment')),
  ('approval', '30000000-0000-4000-8000-000000000002',
    (select event_id from pg_temp.audit_outbox_event_ids where event_name = 'approval'),
    (select workspace_id from pg_temp.audit_outbox_event_ids where event_name = 'approval'),
    (select recipient_id from pg_temp.audit_outbox_event_ids where event_name = 'approval')),
  ('rejection', '30000000-0000-4000-8000-000000000003',
    (select event_id from pg_temp.audit_outbox_event_ids where event_name = 'rejection'),
    (select workspace_id from pg_temp.audit_outbox_event_ids where event_name = 'rejection'),
    (select member_b_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1));
insert into public.notification_events(
  id, workspace_id, analysis_id, type, workflow_event_id, workflow_type,
  recipient_id, status, attempt_count, operation_id, lease_expires_at, error_code
)
select event_id, workspace_id, null, null, audit_id,
       case name when 'assignment' then 'assignment'::public.workflow_notification_type
            when 'approval' then 'version_approved'::public.workflow_notification_type
            else 'version_rejected'::public.workflow_notification_type end,
       recipient_id,
       case when name = 'approval' then 'failed'::public.notification_status else 'pending'::public.notification_status end,
       case when name = 'assignment' then 0 else 1 end,
       case when name = 'rejection' then '30000000-0000-4000-8000-000000000004'::uuid end,
       case when name = 'rejection' then now() + interval '1 minute' end,
       case when name = 'approval' then 'DELIVERY_FAILED' end
from pg_temp.workflow_notification_fixtures;

select throws_ok(format(
  'insert into public.notification_events(workspace_id, workflow_event_id, workflow_type, recipient_id) '
  || 'select workspace_id, %L, %L, recipient_id from pg_temp.workflow_notification_fixtures where name = %L',
  (select audit_id from pg_temp.workflow_notification_fixtures where name = 'assignment'),
  'version_approved', 'assignment'),
  '23514', null, 'The workflow type must match its audit action');
select throws_ok(format(
  'insert into public.notification_events(workspace_id, analysis_id, type, recipient_id) '
  || 'select workspace_id, null, %L, recipient_id from pg_temp.workflow_notification_fixtures where name = %L',
  'analysis_completed', 'assignment'),
  '23514', null, 'S2 terminal types require a non-null analysis and no workflow event');

update private.notification_dispatch_settings set enabled = true where id;
select ok(not exists(select 1 from public.list_notification_candidates(5)
  where event_id = '30000000-0000-4000-8000-000000000001'),
  'S2 candidate listing omits workflow events');
select is((select count(*)::integer from public.claim_notification_event(
  '30000000-0000-4000-8000-000000000001')), 0,
  'A workflow event cannot be claimed by the S2 worker');
select is(public.get_notification_context(
  '30000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000004'),
  '{"ok":false,"code":"LEASE_LOST"}'::jsonb,
  'Workflow context lookup returns the controlled lost-lease result');
select is(public.prepare_notification_delivery(
  '30000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000004', '{}'),
  '{"ok":false,"code":"LEASE_LOST"}'::jsonb,
  'Workflow events cannot prepare S2 email payloads');
insert into private.notification_deliveries(event_id, request_json, idempotency_key, first_submission_at)
values ('30000000-0000-4000-8000-000000000003', '{"to":["member@example.test"]}', 's2-key', now());
select is(public.record_notification_failure(
  '30000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000004', 'DELIVERY_FAILED'),
  'lost', 'Workflow events cannot enter the S2 retry state machine');
select is(public.confirm_notification_sent(
  '30000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000004', 'provider-id'),
  false, 'Workflow events cannot be marked sent by S2');
select is(public.recover_notification_event('30000000-0000-4000-8000-000000000003'),
  'unchanged', 'Workflow events cannot be recovered by the S2 scheduler');
select ok((select status = 'pending' and attempt_count = 0 and operation_id is null
  from public.notification_events where id = '30000000-0000-4000-8000-000000000001'),
  'An S2 claim attempt leaves the workflow event untouched');

select ok(not exists(select 1 from public.list_notification_alerts(50)
  where event_id = '30000000-0000-4000-8000-000000000002'),
  'S2 alert listing omits failed workflow events');
select is(public.claim_notification_alert('30000000-0000-4000-8000-000000000002'), null::jsonb,
  'A workflow failure cannot be claimed as an S2 alert');
select ok(not exists(select 1 from private.notification_deliveries
  where event_id = '30000000-0000-4000-8000-000000000002'),
  'A rejected S2 alert claim does not create private delivery metadata for a workflow event');
insert into private.notification_deliveries(event_id, alert_operation_id, alert_lease_expires_at)
values ('30000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000005', now() + interval '1 minute');
select is(public.confirm_notification_alert(
  '30000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000005'),
  false, 'S2 cannot acknowledge a workflow failure alert');
select is(public.retry_notification_alert(
  '30000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000005'),
  false, 'S2 cannot change workflow alert backoff');
select ok((select failure_reported_at is null and alert_operation_id =
    '30000000-0000-4000-8000-000000000005'::uuid and alert_next_attempt_at is null
  from private.notification_deliveries where event_id = '30000000-0000-4000-8000-000000000002'),
  'Direct S2 alert calls leave workflow delivery metadata unchanged');

select ok((select status = 'pending' and operation_id = '30000000-0000-4000-8000-000000000004'::uuid
  from public.notification_events where id = '30000000-0000-4000-8000-000000000003'),
  'A workflow event with an active lease remains unchanged after direct terminal calls');
update public.notification_events
set lease_expires_at = now() - interval '1 minute'
where id = '30000000-0000-4000-8000-000000000003';
select is(public.recover_notification_event('30000000-0000-4000-8000-000000000003'),
  'unchanged', 'An expired workflow lease is never recovered by the S2 scheduler');
select ok((select status = 'pending' and operation_id = '30000000-0000-4000-8000-000000000004'::uuid
    and next_attempt_at is null
  from public.notification_events where id = '30000000-0000-4000-8000-000000000003'),
  'Recovery by event id leaves the expired workflow lease intact');

insert into public.notification_events(id, workspace_id, analysis_id, type, recipient_id)
select '30000000-0000-4000-8000-000000000010', workspace_id, analysis_id,
       'analysis_completed', admin_id
from pg_temp.audit_outbox_fixtures order by workspace_id limit 1;
select ok(exists(select 1 from public.list_notification_candidates(5)
  where event_id = '30000000-0000-4000-8000-000000000010'),
  'The terminal S2 candidate remains visible to its dispatcher');
select throws_ok(format(
  'insert into public.notification_events(workspace_id, analysis_id, type, recipient_id) '
  || 'select workspace_id, analysis_id, %L, admin_id from pg_temp.audit_outbox_fixtures order by workspace_id limit 1',
  'analysis_completed'),
  '23505', null, 'S2 notification idempotency remains unique by analysis, type, and recipient');

select * from finish();
rollback;
