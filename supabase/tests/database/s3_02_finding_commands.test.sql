begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
\ir review-fixtures.psql
select no_plan();

select pg_temp.create_review_fixture_case();
create temporary table finding_command_context on commit drop as
select f.*, (select count(*) from public.credit_ledger l where l.workspace_id = f.workspace_id) as ledger_count
from pg_temp.review_fixture_case f;

create function pg_temp.change_review_status(
  p_actor_id uuid,
  p_finding_id uuid,
  p_status text,
  p_key text
) returns jsonb
language plpgsql
set search_path = pg_temp, public
as $$
declare
  v_revision bigint;
begin
  select f.review_revision into strict v_revision
  from public.findings f where f.id = p_finding_id;
  return public.review_change_finding(
    p_actor_id, p_finding_id, v_revision,
    pg_catalog.jsonb_build_object('field', 'status', 'value', p_status), p_key
  );
end;
$$;

create temporary table finding_status_matrix(
  source_status text not null,
  destination_status text not null,
  finding_id uuid not null unique
) on commit drop;

insert into pg_temp.finding_status_matrix(source_status, destination_status, finding_id)
select source_status, destination_status,
  pg_temp.insert_finding_row(c.analysis_id, c.workspace_id, 0.8)
from pg_temp.finding_command_context c
cross join (values
  ('pending_review'), ('confirmed'), ('false_positive'), ('update_planned'), ('resolved')
) source_states(source_status)
cross join (values
  ('pending_review'), ('confirmed'), ('false_positive'), ('update_planned'), ('resolved')
) destination_states(destination_status);

create temporary table finding_status_matrix_results(
  transition text not null,
  passed boolean not null
) on commit drop;

do $$
declare
  v_case record;
  v_context pg_temp.finding_command_context%rowtype;
  v_revision bigint;
  v_revision_after bigint;
  v_audit_count bigint;
  v_audit_after bigint;
  v_receipt_count bigint;
  v_receipt_after bigint;
  v_conflict boolean;
  v_allowed boolean;
  v_noop boolean;
  v_passed boolean;
  v_result jsonb;
  v_expected_status text;
  v_key text;
  v_description text;
begin
  select * into strict v_context from pg_temp.finding_command_context;
  for v_case in select * from pg_temp.finding_status_matrix order by source_status, destination_status loop
    if v_case.source_status = 'confirmed' then
      perform pg_temp.change_review_status(v_context.admin_id, v_case.finding_id, 'confirmed', 'matrix-setup-confirmed-' || v_case.finding_id::text);
    elsif v_case.source_status = 'update_planned' then
      perform pg_temp.change_review_status(v_context.admin_id, v_case.finding_id, 'confirmed', 'matrix-setup-confirm-' || v_case.finding_id::text);
      perform pg_temp.change_review_status(v_context.admin_id, v_case.finding_id, 'update_planned', 'matrix-setup-planned-' || v_case.finding_id::text);
    elsif v_case.source_status = 'false_positive' then
      perform pg_temp.change_review_status(v_context.admin_id, v_case.finding_id, 'false_positive', 'matrix-setup-false-' || v_case.finding_id::text);
    elsif v_case.source_status = 'resolved' then
      perform pg_temp.change_review_status(v_context.admin_id, v_case.finding_id, 'false_positive', 'matrix-setup-false-' || v_case.finding_id::text);
      perform pg_temp.change_review_status(v_context.admin_id, v_case.finding_id, 'resolved', 'matrix-setup-resolved-' || v_case.finding_id::text);
    end if;

    select f.review_revision into strict v_revision from public.findings f where f.id = v_case.finding_id;
    select count(*) into v_audit_count from public.audit_events e where e.entity_id = v_case.finding_id;
    v_key := 'matrix-' || substr(v_case.source_status, 1, 4) || '-' || substr(v_case.destination_status, 1, 4) || '-' || v_case.finding_id::text;
    select count(*) into v_receipt_count from private.review_commands c
      where c.actor_id = v_context.admin_id and c.operation = 'changeFinding' and c.idempotency_key = v_key;
    v_noop := v_case.source_status = v_case.destination_status;
    v_allowed := v_noop
      or (v_case.source_status = 'pending_review' and v_case.destination_status in ('confirmed', 'false_positive'))
      or (v_case.source_status = 'confirmed' and v_case.destination_status in ('update_planned', 'resolved'))
      or (v_case.source_status = 'update_planned' and v_case.destination_status = 'resolved')
      or (v_case.source_status = 'false_positive' and v_case.destination_status = 'resolved');
    v_conflict := false;
    begin
      v_result := public.review_change_finding(
        v_context.admin_id, v_case.finding_id, v_revision,
        pg_catalog.jsonb_build_object('field', 'status', 'value', v_case.destination_status), v_key
      );
    exception when sqlstate 'P0001' then
      v_conflict := true;
    end;

    v_description := v_case.source_status || ' to ' || v_case.destination_status;
    select f.status::text, f.review_revision into v_expected_status, v_revision_after
    from public.findings f where f.id = v_case.finding_id;
    select count(*) into v_audit_after from public.audit_events e where e.entity_id = v_case.finding_id;
    select count(*) into v_receipt_after from private.review_commands c
      where c.actor_id = v_context.admin_id and c.operation = 'changeFinding' and c.idempotency_key = v_key;
    v_passed := v_conflict = not v_allowed
      and v_expected_status = case when v_allowed and not v_noop then v_case.destination_status else v_case.source_status end
      and v_revision_after = v_revision + case when v_allowed and not v_noop then 1 else 0 end
      and v_audit_after = v_audit_count + case when v_allowed and not v_noop then 1 else 0 end
      and v_receipt_after = v_receipt_count + case when v_allowed then 1 else 0 end
      and (not v_allowed or v_result->>'status' = case when v_noop then v_case.source_status else v_case.destination_status end);
    insert into pg_temp.finding_status_matrix_results values (v_description, v_passed);
  end loop;
end;
$$;

select is((select count(*) from pg_temp.finding_status_matrix_results where not passed), 0::bigint,
  'All 25 status transitions, no-ops, CAS revisions, audits and receipts match the review matrix');

select is((select count(*) from public.credit_ledger l, pg_temp.finding_command_context c where l.workspace_id = c.workspace_id),
  (select ledger_count from pg_temp.finding_command_context),
  'Manual finding decisions, including resolution, do not consume or release analysis credits');
select is((select a.status::text from public.analyses a, pg_temp.finding_command_context c where a.id = c.analysis_id),
  'completed', 'Manual resolution does not change the completed analysis');

create temporary table finding_resolution_setup(
  finding_id uuid not null,
  round_id uuid not null,
  item_id uuid not null,
  sibling_item_id uuid not null,
  confirmed_submission_id uuid not null,
  reserved_submission_id uuid not null,
  candidate_id uuid not null,
  candidate_version_id uuid not null,
  operation_id uuid not null,
  finding_revision bigint not null,
  item_revision bigint not null,
  sibling_revision bigint not null,
  round_revision bigint not null,
  round_coverage_revision bigint not null,
  item_coverage_revision bigint not null,
  candidate_revision bigint not null,
  ledger_count bigint not null
) on commit drop;
select pg_temp.create_review_fixture_case();
create temporary table finding_resolution_context on commit drop as
select f.*, (select count(*) from public.credit_ledger l where l.workspace_id = f.workspace_id) as ledger_count
from pg_temp.review_fixture_case f
where f.workspace_id <> (select workspace_id from pg_temp.finding_command_context);
do $$
declare
  c record;
  v_finding uuid;
  v_round uuid;
  v_item uuid;
  v_sibling uuid;
  v_reserved uuid;
  v_confirmed uuid;
  v_candidate uuid;
  v_candidate_version uuid;
  v_operation uuid;
begin
  select * into strict c from pg_temp.finding_resolution_context;
  v_finding := pg_temp.insert_finding_row(c.analysis_id, c.workspace_id, 0.66, 'Finding resolved during a live candidate');
  update public.findings set status = 'confirmed', assignee_id = c.member_a_id where id = v_finding;
  perform pg_temp.insert_evidence_row(c.workspace_id, c.analysis_id, v_finding, c.document_id, c.version_id,
    (select chunk_id from pg_temp.analysis_case where analysis_id = c.analysis_id and ordinal = 1),
    'Evidence for resolution authorization test');
  v_round := pg_temp.create_review_round(c.workspace_id, 'assigned_findings', array[v_finding, c.finding_c_id]);
  select i.id into strict v_item from public.correction_round_items i
  where i.round_id = v_round and i.finding_id = v_finding;
  select i.id into strict v_sibling from public.correction_round_items i
  where i.round_id = v_round and i.finding_id = c.finding_c_id;
  v_reserved := pg_temp.create_review_reservation(v_round, c.member_a_id, array[v_item, v_sibling]);
  v_confirmed := pg_temp.create_review_submission(v_round, c.member_a_id, array[v_item, v_sibling]);
  v_candidate := pg_temp.select_direct_review_candidate(v_round, c.admin_id, v_confirmed);
  perform pg_temp.start_review_candidate(v_candidate);
  select x.version_id into strict v_candidate_version from public.correction_candidates x where x.id = v_candidate;
  select v.processing_operation_id into strict v_operation from public.document_versions v where v.id = v_candidate_version;
  insert into pg_temp.finding_resolution_setup
  select v_finding, v_round, v_item, v_sibling, v_confirmed, v_reserved, v_candidate, v_candidate_version,
    v_operation, f.review_revision, i.revision, sibling.revision, r.revision, r.coverage_revision,
    i.coverage_revision, candidate.revision,
    (select count(*) from public.credit_ledger l where l.workspace_id = c.workspace_id)
  from public.findings f
  join public.correction_round_items i on i.id = v_item
  join public.correction_round_items sibling on sibling.id = v_sibling
  join public.correction_rounds r on r.id = v_round
  join public.correction_candidates candidate on candidate.id = v_candidate
  where f.id = v_finding;
end;
$$;

select is(public.review_change_finding(
  (select admin_id from pg_temp.finding_resolution_context),
  (select finding_id from pg_temp.finding_resolution_setup),
  (select finding_revision from pg_temp.finding_resolution_setup),
  '{"field":"status","value":"resolved"}'::jsonb, 'resolution-live-candidate'
)->>'status', 'resolved', 'A finding can be resolved while its contribution candidate is processing');
select is((select f.review_revision from public.findings f, pg_temp.finding_resolution_setup s where f.id = s.finding_id),
  (select finding_revision + 1 from pg_temp.finding_resolution_setup), 'Resolution advances the finding revision once');
select is((select i.revision from public.correction_round_items i, pg_temp.finding_resolution_setup s where i.id = s.item_id),
  (select item_revision + 1 from pg_temp.finding_resolution_setup), 'Resolution revokes only the affected item authorization revision');
select is((select i.revision from public.correction_round_items i, pg_temp.finding_resolution_setup s where i.id = s.sibling_item_id),
  (select sibling_revision from pg_temp.finding_resolution_setup), 'Resolution leaves sibling item authorization intact');
select is((select r.revision from public.correction_rounds r, pg_temp.finding_resolution_setup s where r.id = s.round_id),
  (select round_revision + 1 from pg_temp.finding_resolution_setup), 'Resolution advances the affected round revision once');
select is((select r.coverage_revision from public.correction_rounds r, pg_temp.finding_resolution_setup s where r.id = s.round_id),
  (select round_coverage_revision from pg_temp.finding_resolution_setup), 'Resolution preserves round coverage revision');
select is((select i.coverage_revision from public.correction_round_items i, pg_temp.finding_resolution_setup s where i.id = s.item_id),
  (select item_coverage_revision from pg_temp.finding_resolution_setup), 'Resolution preserves confirmed item coverage revision');
select is((select i.current_submission_id from public.correction_round_items i, pg_temp.finding_resolution_setup s where i.id = s.item_id),
  (select confirmed_submission_id from pg_temp.finding_resolution_setup), 'Resolution preserves the confirmed contribution pointer');
select is((select s.state::text from public.correction_submissions s, pg_temp.finding_resolution_setup x where s.id = x.confirmed_submission_id),
  'confirmed', 'Resolution preserves the confirmed submission history');
select is((select s.state::text from public.correction_submissions s, pg_temp.finding_resolution_setup x where s.id = x.reserved_submission_id),
  'invalidated', 'Resolution invalidates the pending grouped reservation that included the finding');
select is((select c.status::text from public.correction_candidates c, pg_temp.finding_resolution_setup s where c.id = s.candidate_id),
  'processing', 'Resolution preserves the in-flight candidate');
select is((select c.revision from public.correction_candidates c, pg_temp.finding_resolution_setup s where c.id = s.candidate_id),
  (select candidate_revision from pg_temp.finding_resolution_setup), 'Resolution preserves the candidate worker fence');
select is((select v.processing_operation_id from public.document_versions v, pg_temp.finding_resolution_setup s where v.id = s.candidate_version_id),
  (select operation_id from pg_temp.finding_resolution_setup), 'Resolution preserves the active processing operation');
select is((select f.assignee_id from public.findings f, pg_temp.finding_resolution_setup s where f.id = s.finding_id),
  (select member_a_id from pg_temp.finding_resolution_context), 'Resolution preserves the historical finding assignee');
select is((select count(*) from public.credit_ledger l, pg_temp.finding_resolution_setup s where l.workspace_id = (select workspace_id from pg_temp.finding_resolution_context)),
  (select ledger_count from pg_temp.finding_resolution_setup), 'Resolution in a live round does not alter the credit ledger');

select is(public.review_change_finding(
  (select admin_id from pg_temp.finding_command_context),
  (select finding_id from pg_temp.finding_status_matrix where source_status = 'resolved' and destination_status = 'resolved'),
  (select f.review_revision from public.findings f join pg_temp.finding_status_matrix m on m.finding_id = f.id
    where m.source_status = 'resolved' and m.destination_status = 'resolved'),
  '{"field":"severity","value":"Low"}'::jsonb, 'resolved-severity-change'
)->>'severityCurrent', 'Low', 'A resolved finding may receive a human severity override');
select is((select f.severity_original from public.findings f join pg_temp.finding_status_matrix m on m.finding_id = f.id
  where m.source_status = 'resolved' and m.destination_status = 'resolved'),
  'Medium'::public.finding_severity, 'A human severity override never rewrites original severity');
select throws_ok(format('update public.findings set severity_original = %L where id = %L',
  'High', (select finding_id from pg_temp.finding_status_matrix where source_status = 'resolved' and destination_status = 'resolved')),
  '23514', 'Finding identity and original evidence metadata are immutable', 'Direct producers cannot change original severity');

create temporary table finding_assignment_setup(
  finding_id uuid not null,
  second_document_id uuid not null,
  second_version_id uuid not null,
  round_one_id uuid not null,
  round_two_id uuid not null,
  item_one_id uuid not null,
  sibling_item_id uuid not null,
  item_two_id uuid not null,
  confirmed_submission_id uuid not null,
  reserved_submission_id uuid not null,
  candidate_id uuid not null
) on commit drop;

do $$
declare
  v_context pg_temp.finding_command_context%rowtype;
  v_analysis_two uuid;
  v_document_two uuid;
  v_version_two uuid;
  v_chunk_two uuid;
  v_finding_id uuid;
  v_round_one uuid;
  v_round_two uuid;
  v_item_one uuid;
  v_sibling_item uuid;
  v_item_two uuid;
  v_submission uuid;
  v_reserved uuid;
  v_candidate uuid;
begin
  select * into strict v_context from pg_temp.finding_command_context;
  v_finding_id := v_context.finding_a_id;
  perform pg_temp.change_review_status(v_context.admin_id, v_finding_id, 'confirmed', 'assignment-prepare-confirmed');

  v_analysis_two := pg_temp.create_analysis_fixture(v_context.workspace_id, v_context.admin_id, 'completed', 1);
  select a.document_id, a.version_id, a.chunk_id into strict v_document_two, v_version_two, v_chunk_two
  from pg_temp.analysis_case a where a.analysis_id = v_analysis_two and a.ordinal = 1;
  insert into public.analysis_documents(analysis_id, workspace_id, document_id, version_id, role)
  values (v_context.analysis_id, v_context.workspace_id, v_document_two, v_version_two, 'source');
  perform pg_temp.insert_evidence_row(v_context.workspace_id, v_context.analysis_id, v_finding_id,
    v_document_two, v_version_two, v_chunk_two, 'Synthetic second-document evidence');

  v_round_one := pg_temp.create_review_round(v_context.workspace_id, 'assigned_findings',
    array[v_context.finding_a_id, v_context.finding_c_id]);
  v_round_two := pg_temp.create_review_round_for_document(v_context.workspace_id, v_document_two,
    v_context.admin_id, 'assigned_findings', array[v_context.finding_a_id]);
  select i.id into strict v_item_one from public.correction_round_items i
    where i.round_id = v_round_one and i.finding_id = v_finding_id;
  select i.id into strict v_sibling_item from public.correction_round_items i
    where i.round_id = v_round_one and i.finding_id = v_context.finding_c_id;
  select i.id into strict v_item_two from public.correction_round_items i
    where i.round_id = v_round_two and i.finding_id = v_finding_id;
  v_reserved := pg_temp.create_review_reservation(v_round_one, v_context.member_a_id, array[v_item_one, v_sibling_item]);
  v_submission := pg_temp.create_review_submission(v_round_one, v_context.member_a_id, array[v_item_one, v_sibling_item]);
  v_candidate := pg_temp.select_direct_review_candidate(v_round_one, v_context.admin_id, v_submission);
  perform pg_temp.start_review_candidate(v_candidate);

  insert into pg_temp.finding_assignment_setup values (
    v_finding_id, v_document_two, v_version_two, v_round_one, v_round_two,
    v_item_one, v_sibling_item, v_item_two, v_submission, v_reserved, v_candidate
  );
end;
$$;

create temporary table finding_assignment_before on commit drop as
select
  f.review_revision as finding_revision,
  r1.revision as round_one_revision,
  r1.coverage_revision as round_one_coverage,
  r2.revision as round_two_revision,
  r2.coverage_revision as round_two_coverage,
  i1.revision as item_one_revision,
  i1.coverage_revision as item_one_coverage,
  i1.current_submission_id as item_one_submission,
  i1.initial_assignee_id as item_one_initial_assignee,
  i1.opened_assignee_id as item_one_opened_assignee,
  ic.revision as sibling_revision,
  i2.revision as item_two_revision,
  i2.coverage_revision as item_two_coverage,
  c.revision as candidate_revision,
  c.coverage_revision as candidate_coverage,
  v.processing_operation_id,
  (select count(*) from public.notification_events n where n.workflow_type = 'assignment') as assignment_outbox_count
from pg_temp.finding_assignment_setup s
join public.findings f on f.id = s.finding_id
join public.correction_rounds r1 on r1.id = s.round_one_id
join public.correction_rounds r2 on r2.id = s.round_two_id
join public.correction_round_items i1 on i1.id = s.item_one_id
join public.correction_round_items ic on ic.id = s.sibling_item_id
join public.correction_round_items i2 on i2.id = s.item_two_id
join public.correction_candidates c on c.id = s.candidate_id
join public.document_versions v on v.id = c.version_id;

select is(public.review_assign_finding(
  (select admin_id from pg_temp.finding_command_context),
  (select finding_id from pg_temp.finding_assignment_setup),
  (select finding_revision from pg_temp.finding_assignment_before),
  (select member_b_id from pg_temp.finding_command_context), 'assignment-reassign'
)->'assignee'->>'id',
  (select member_b_id::text from pg_temp.finding_command_context), 'Assignment moves to a persisted Member in the same workspace');
select is((select f.review_revision from public.findings f, pg_temp.finding_assignment_setup s where f.id = s.finding_id),
  (select finding_revision + 1 from pg_temp.finding_assignment_before), 'A real reassignment advances the finding authorization revision once');
select is((select i.assignee_id from public.correction_round_items i, pg_temp.finding_assignment_setup s where i.id = s.item_one_id),
  (select member_b_id from pg_temp.finding_command_context), 'Reassignment synchronizes the first open-round item');
select is((select i.assignee_id from public.correction_round_items i, pg_temp.finding_assignment_setup s where i.id = s.item_two_id),
  (select member_b_id from pg_temp.finding_command_context), 'A finding with evidence in another document synchronizes every open-round item');
select is((select i.initial_assignee_id from public.correction_round_items i, pg_temp.finding_assignment_setup s where i.id = s.item_one_id),
  (select item_one_initial_assignee from pg_temp.finding_assignment_before), 'Reassignment preserves the original prepared assignee');
select is((select i.opened_assignee_id from public.correction_round_items i, pg_temp.finding_assignment_setup s where i.id = s.item_one_id),
  (select item_one_opened_assignee from pg_temp.finding_assignment_before), 'Reassignment preserves the opening assignee snapshot');
select is((select i.current_submission_id from public.correction_round_items i, pg_temp.finding_assignment_setup s where i.id = s.item_one_id),
  (select item_one_submission from pg_temp.finding_assignment_before), 'Reassignment preserves confirmed contribution pointers');
select is((select i.coverage_revision from public.correction_round_items i, pg_temp.finding_assignment_setup s where i.id = s.item_one_id),
  (select item_one_coverage from pg_temp.finding_assignment_before), 'Reassignment does not advance item coverage');
select is((select r.coverage_revision from public.correction_rounds r, pg_temp.finding_assignment_setup s where r.id = s.round_one_id),
  (select round_one_coverage from pg_temp.finding_assignment_before), 'Reassignment does not advance first-round coverage');
select is((select r.coverage_revision from public.correction_rounds r, pg_temp.finding_assignment_setup s where r.id = s.round_two_id),
  (select round_two_coverage from pg_temp.finding_assignment_before), 'Reassignment does not advance second-round coverage');
select is((select c.status::text from public.correction_candidates c, pg_temp.finding_assignment_setup s where c.id = s.candidate_id),
  'processing', 'Reassignment preserves a live processing candidate');
select is((select c.revision from public.correction_candidates c, pg_temp.finding_assignment_setup s where c.id = s.candidate_id),
  (select candidate_revision from pg_temp.finding_assignment_before), 'Reassignment preserves the candidate worker fence');
select is((select c.coverage_revision from public.correction_candidates c, pg_temp.finding_assignment_setup s where c.id = s.candidate_id),
  (select candidate_coverage from pg_temp.finding_assignment_before), 'Reassignment preserves the candidate coverage fence');
select is((select v.processing_operation_id from public.document_versions v join public.correction_candidates c on c.version_id = v.id, pg_temp.finding_assignment_setup s where c.id = s.candidate_id),
  (select processing_operation_id from pg_temp.finding_assignment_before), 'Reassignment does not fence or replace an in-flight processing operation');
select is((select s.state::text from public.correction_submissions s, pg_temp.finding_assignment_setup x where s.id = x.confirmed_submission_id),
  'confirmed', 'Reassignment never invalidates a confirmed submission');
select is((select i.revision from public.correction_round_items i, pg_temp.finding_assignment_setup s where i.id = s.item_one_id),
  (select item_one_revision + 1 from pg_temp.finding_assignment_before), 'Reassignment advances affected item authorization exactly once');
select is((select i.revision from public.correction_round_items i, pg_temp.finding_assignment_setup s where i.id = s.sibling_item_id),
  (select sibling_revision from pg_temp.finding_assignment_before), 'Reassignment leaves sibling finding authorization unchanged');
select is((select r.revision from public.correction_rounds r, pg_temp.finding_assignment_setup s where r.id = s.round_one_id),
  (select round_one_revision + 1 from pg_temp.finding_assignment_before), 'Reassignment advances each affected round revision once');
select is((select r.revision from public.correction_rounds r, pg_temp.finding_assignment_setup s where r.id = s.round_two_id),
  (select round_two_revision + 1 from pg_temp.finding_assignment_before), 'Multi-document reassignment advances each related round once');
select is((select s.state::text from public.correction_submissions s, pg_temp.finding_assignment_setup x where s.id = x.reserved_submission_id),
  'invalidated', 'A grouped unconfirmed reservation is invalidated as a whole');
select is((select count(*) from public.notification_events n, pg_temp.finding_command_context c, pg_temp.finding_assignment_setup s
  where n.workflow_type = 'assignment' and n.workflow_event_id in (
    select e.id from public.audit_events e where e.entity_id = s.finding_id and e.action = 'finding_assigned'
  ) and n.recipient_id = c.member_b_id),
  1::bigint, 'Only the new Member receives the typed assignment outbox event');

select is(public.review_change_finding(
  (select admin_id from pg_temp.finding_command_context),
  (select finding_id from pg_temp.finding_assignment_setup),
  (select f.review_revision from public.findings f join pg_temp.finding_assignment_setup s on s.finding_id = f.id),
  '{"field":"severity","value":"High"}'::jsonb, 'replay-follow-up-severity'
)->>'severityCurrent', 'High', 'A later command can change the finding before a receipt replay');
select is(public.review_assign_finding(
  (select admin_id from pg_temp.finding_command_context),
  (select finding_id from pg_temp.finding_assignment_setup),
  (select finding_revision from pg_temp.finding_assignment_before),
  (select member_b_id from pg_temp.finding_command_context), 'assignment-reassign'
)->>'severityCurrent', 'High', 'Replaying a committed assignment returns the current authorized snapshot');
select throws_ok(format('select public.review_assign_finding(%L, %L, %s, %L, %L)',
  (select admin_id from pg_temp.finding_command_context),
  (select finding_id from pg_temp.finding_assignment_setup),
  (select finding_revision from pg_temp.finding_assignment_before),
  (select member_a_id::text from pg_temp.finding_command_context), 'assignment-reassign'),
  'P0001', null, 'The same receipt key with a changed assignment payload conflicts');

select is(public.review_assign_finding(
  (select admin_id from pg_temp.finding_command_context),
  (select finding_id from pg_temp.finding_assignment_setup),
  (select f.review_revision from public.findings f join pg_temp.finding_assignment_setup s on s.finding_id = f.id),
  (select member_b_id from pg_temp.finding_command_context), 'assignment-noop'
)->'assignee'->>'id',
  (select member_b_id::text from pg_temp.finding_command_context), 'A same-recipient assignment with current CAS is a successful no-op');
select is((select f.review_revision from public.findings f join pg_temp.finding_assignment_setup s on s.finding_id = f.id),
  (select finding_revision + 2 from pg_temp.finding_assignment_before), 'A no-op assignment does not advance the finding revision');
select is((select count(*) from public.audit_events e, pg_temp.finding_assignment_setup s
  where e.entity_id = s.finding_id and e.action = 'finding_assigned'),
  1::bigint, 'A no-op assignment does not append another audit event');
select is((select count(*) from public.notification_events n where n.workflow_type = 'assignment'),
  (select assignment_outbox_count + 1 from pg_temp.finding_assignment_before),
  'A no-op assignment does not append another outbox event');
select throws_ok(format('select public.review_assign_finding(%L, %L, %s, %L, %L)',
  (select admin_id from pg_temp.finding_command_context),
  (select finding_id from pg_temp.finding_assignment_setup),
  (select f.review_revision - 1 from public.findings f join pg_temp.finding_assignment_setup s on s.finding_id = f.id),
  (select member_b_id::text from pg_temp.finding_command_context), 'assignment-stale-noop'),
  'P0001', null, 'A same-recipient no-op with a stale revision still conflicts');

create temporary table finding_assignment_before_unassign on commit drop as
select f.review_revision as finding_revision,
  (select count(*) from public.notification_events n where n.workflow_type = 'assignment') as assignment_outbox_count
from pg_temp.finding_assignment_setup s join public.findings f on f.id = s.finding_id;
select is(public.review_assign_finding(
  (select admin_id from pg_temp.finding_command_context),
  (select finding_id from pg_temp.finding_assignment_setup),
  (select finding_revision from pg_temp.finding_assignment_before_unassign),
  null, 'assignment-unassign'
)->'assignee', 'null'::jsonb, 'Unassignment clears the current assignee without changing finding status');
select is((select f.status::text from public.findings f join pg_temp.finding_assignment_setup s on s.finding_id = f.id),
  'confirmed', 'Unassignment does not change the finding status');
select is((select count(*) from public.notification_events n where n.workflow_type = 'assignment'),
  (select assignment_outbox_count from pg_temp.finding_assignment_before_unassign),
  'Unassignment sends no assignment notification');
select is((select count(*) from public.audit_events e join pg_temp.finding_assignment_setup s on s.finding_id = e.entity_id
  where e.action = 'finding_assigned'
    and e.metadata = jsonb_build_object('previousAssigneeId', (select member_b_id from pg_temp.finding_command_context), 'assigneeId', null)),
  1::bigint, 'Unassignment records typed previous and null assignee IDs');

select pg_temp.create_review_fixture_case();
create temporary table finding_command_foreign_recipient(member_id uuid not null) on commit drop;
insert into pg_temp.finding_command_foreign_recipient
select c.member_a_id from pg_temp.review_fixture_case c, pg_temp.finding_command_context x
where c.workspace_id <> x.workspace_id limit 1;
select throws_ok(format('select public.review_assign_finding(%L, %L, %s, %L, %L)',
  (select admin_id from pg_temp.finding_command_context),
  (select finding_id from pg_temp.finding_assignment_setup),
  (select f.review_revision from public.findings f join pg_temp.finding_assignment_setup s on s.finding_id = f.id),
  (select admin_id::text from pg_temp.finding_command_context), 'assignment-admin-target'),
  '22023', null, 'An Admin cannot be selected as a Member assignee');
select throws_ok(format('select public.review_assign_finding(%L, %L, %s, %L, %L)',
  (select admin_id from pg_temp.finding_command_context),
  (select finding_id from pg_temp.finding_assignment_setup),
  (select f.review_revision from public.findings f join pg_temp.finding_assignment_setup s on s.finding_id = f.id),
  (select member_id::text from pg_temp.finding_command_foreign_recipient), 'assignment-foreign-target'),
  '22023', null, 'A foreign workspace recipient is rejected without revealing its profile');
select throws_ok(format('select public.review_assign_finding(%L, %L, %s, %L, %L)',
  (select admin_id from pg_temp.finding_command_context),
  (select finding_id from pg_temp.finding_assignment_setup),
  (select f.review_revision from public.findings f join pg_temp.finding_assignment_setup s on s.finding_id = f.id),
  gen_random_uuid()::text, 'assignment-missing-target'),
  '22023', null, 'A nonexistent recipient uses the same invalid-assignment result');
select throws_ok(format('select public.review_assign_finding(%L, %L, %s, null, %L)',
  (select admin_id from pg_temp.finding_command_context),
  (select finding_id from pg_temp.finding_status_matrix where source_status = 'resolved' and destination_status = 'resolved'),
  (select f.review_revision from public.findings f join pg_temp.finding_status_matrix m on m.finding_id = f.id
    where m.source_status = 'resolved' and m.destination_status = 'resolved'),
  'resolved-assignment-noop'),
  'P0001', null, 'Resolved findings reject even a fresh unassignment no-op');

create function public.s3_02_test_fail_finding_audit() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.action = 'finding_assigned' then
    raise exception 'Synthetic review audit failure' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger s3_02_test_fail_finding_audit
before insert on public.audit_events for each row execute function public.s3_02_test_fail_finding_audit();

create temporary table finding_command_rollback_before on commit drop as
select f.review_revision as finding_revision,
  f.assignee_id,
  (select count(*) from public.audit_events e where e.entity_id = f.id and e.action = 'finding_assigned') as audit_count
from pg_temp.finding_command_context c
join public.findings f on f.id = c.finding_b_id;
select throws_ok(format('select public.review_assign_finding(%L, %L, %s, %L, %L)',
  (select admin_id from pg_temp.finding_command_context),
  (select finding_b_id from pg_temp.finding_command_context),
  (select finding_revision from pg_temp.finding_command_rollback_before),
  (select member_a_id::text from pg_temp.finding_command_context), 'assignment-audit-rollback'),
  'P0001', 'Synthetic review audit failure', 'An audit failure aborts the assignment transaction');
drop trigger s3_02_test_fail_finding_audit on public.audit_events;
drop function public.s3_02_test_fail_finding_audit();
select is((select f.review_revision from public.findings f, pg_temp.finding_command_context c where f.id = c.finding_b_id),
  (select finding_revision from pg_temp.finding_command_rollback_before), 'An audit failure rolls back the finding revision');
select is((select f.assignee_id from public.findings f, pg_temp.finding_command_context c where f.id = c.finding_b_id),
  (select assignee_id from pg_temp.finding_command_rollback_before), 'An audit failure rolls back the finding assignment');
select is((select count(*) from public.audit_events e, pg_temp.finding_command_context c
  where e.entity_id = c.finding_b_id and e.action = 'finding_assigned'),
  (select audit_count from pg_temp.finding_command_rollback_before), 'An audit failure leaves no audit row');
select is((select count(*) from private.review_commands r where r.idempotency_key = 'assignment-audit-rollback'),
  0::bigint, 'An audit failure leaves no replay receipt');

create function public.s3_02_test_fail_assignment_outbox() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.workflow_type = 'assignment' then
    raise exception 'Synthetic assignment outbox failure' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger s3_02_test_fail_assignment_outbox
before insert on public.notification_events for each row execute function public.s3_02_test_fail_assignment_outbox();
select throws_ok(format('select public.review_assign_finding(%L, %L, %s, %L, %L)',
  (select admin_id from pg_temp.finding_command_context),
  (select finding_b_id from pg_temp.finding_command_context),
  (select finding_revision from pg_temp.finding_command_rollback_before),
  (select member_a_id::text from pg_temp.finding_command_context), 'assignment-outbox-rollback'),
  'P0001', 'Synthetic assignment outbox failure', 'An outbox failure aborts the assignment transaction');
drop trigger s3_02_test_fail_assignment_outbox on public.notification_events;
drop function public.s3_02_test_fail_assignment_outbox();
select is((select f.review_revision from public.findings f, pg_temp.finding_command_context c where f.id = c.finding_b_id),
  (select finding_revision from pg_temp.finding_command_rollback_before), 'An outbox failure rolls back the finding revision');
select is((select f.assignee_id from public.findings f, pg_temp.finding_command_context c where f.id = c.finding_b_id),
  (select assignee_id from pg_temp.finding_command_rollback_before), 'An outbox failure rolls back the finding assignment');
select is((select count(*) from public.audit_events e, pg_temp.finding_command_context c
  where e.entity_id = c.finding_b_id and e.action = 'finding_assigned'),
  (select audit_count from pg_temp.finding_command_rollback_before), 'An outbox failure rolls back the earlier audit row');
select is((select count(*) from private.review_commands r where r.idempotency_key = 'assignment-outbox-rollback'),
  0::bigint, 'An outbox failure leaves no replay receipt');

select ok(has_function_privilege('service_role', 'public.review_change_finding(uuid,uuid,bigint,jsonb,text)', 'EXECUTE'),
  'Only the server service role can execute the change command RPC');
select ok(has_function_privilege('service_role', 'public.review_assign_finding(uuid,uuid,bigint,uuid,text)', 'EXECUTE'),
  'Only the server service role can execute the assignment command RPC');
select ok(not has_function_privilege('authenticated', 'public.review_change_finding(uuid,uuid,bigint,jsonb,text)', 'EXECUTE'),
  'A browser role cannot forge an Admin actor ID for the change RPC');
select ok(not has_function_privilege('anon', 'public.review_assign_finding(uuid,uuid,bigint,uuid,text)', 'EXECUTE'),
  'An anonymous role cannot execute assignment commands');

select finish();
rollback;
