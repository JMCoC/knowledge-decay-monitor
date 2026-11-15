begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
\ir review-fixtures.psql
select no_plan();

select pg_temp.create_review_fixture_case();
select pg_temp.create_review_fixture_case();
select pg_temp.create_review_fixture_case();
select pg_temp.create_review_fixture_case();
select pg_temp.create_review_fixture_case();
select pg_temp.create_review_fixture_case();
select pg_temp.create_review_fixture_case();
select pg_temp.create_review_fixture_case();
select pg_temp.create_review_fixture_case();
select pg_temp.create_review_fixture_case();

create temporary table round_command_context on commit drop as
select row_number() over (order by f.workspace_id)::integer as slot, f.*,
  (select count(*) from public.credit_ledger l where l.workspace_id = f.workspace_id) as ledger_count
from pg_temp.review_fixture_case f;

select throws_ok(format(
  'select public.review_prepare_round(%L, %L, NULL, NULL, %L)',
  (select admin_id from pg_temp.round_command_context where slot = 4),
  (select document_id from pg_temp.round_command_context where slot = 4),
  'round-invalid-mode'
), '22023', null, 'Preparation rejects a missing round mode');
select throws_ok(format(
  'select public.review_prepare_round(%L, %L, %L, %L::uuid[], %L)',
  (select admin_id from pg_temp.round_command_context where slot = 4),
  (select document_id from pg_temp.round_command_context where slot = 4),
  'assigned_findings',
  array[(select finding_a_id::text from pg_temp.round_command_context where slot = 4),
    (select finding_a_id::text from pg_temp.round_command_context where slot = 4)],
  'round-duplicate-finding'
), '22023', null, 'Preparation rejects duplicate finding IDs');
select throws_ok(format(
  'select public.review_prepare_round(%L, %L, %L, %L::uuid[], %L)',
  (select admin_id from pg_temp.round_command_context where slot = 4),
  (select document_id from pg_temp.round_command_context where slot = 4),
  'assigned_findings',
  array[(select finding_c_id::text from pg_temp.round_command_context where slot = 1)],
  'round-cross-tenant-finding'
), 'P0002', null, 'Preparation hides a cross-tenant finding as unavailable');
create temporary table round_command_ineligible_finding(finding_id uuid not null) on commit drop;
do $$
declare
  c pg_temp.round_command_context%rowtype;
  v_chunk_id uuid;
  v_finding_id uuid;
begin
  select * into strict c from pg_temp.round_command_context where slot = 4;
  select x.chunk_id into strict v_chunk_id from pg_temp.analysis_case x
  where x.analysis_id = c.analysis_id and x.ordinal = 1;
  v_finding_id := pg_temp.insert_finding_row(c.analysis_id, c.workspace_id, 0.5, 'Synthetic unassigned selection finding');
  update public.findings set status = 'confirmed' where id = v_finding_id;
  perform pg_temp.insert_evidence_row(c.workspace_id, c.analysis_id, v_finding_id,
    c.document_id, c.version_id, v_chunk_id, 'Synthetic evidence for unassigned selection finding');
  insert into pg_temp.round_command_ineligible_finding values (v_finding_id);
end;
$$;
select throws_ok(format(
  'select public.review_prepare_round(%L, %L, %L, %L::uuid[], %L)',
  (select admin_id from pg_temp.round_command_context where slot = 4),
  (select document_id from pg_temp.round_command_context where slot = 4),
  'assigned_findings',
  array[(select finding_id::text from pg_temp.round_command_ineligible_finding)],
  'round-ineligible-finding'
), '22023', null, 'Preparation rejects a finding without an eligible Member assignment');
select throws_ok(format(
  'select public.review_prepare_round(%L, %L, %L, array(select pg_catalog.gen_random_uuid() from generate_series(1, 101)), %L)',
  (select admin_id from pg_temp.round_command_context where slot = 4),
  (select document_id from pg_temp.round_command_context where slot = 4),
  'assigned_findings',
  'round-too-many-findings'
), '22023', null, 'Preparation rejects more than one hundred selected findings');

create temporary table round_command_max_selection(round_id uuid not null, selection_count integer not null) on commit drop;
do $$
declare
  c pg_temp.round_command_context%rowtype;
  v_chunk_id uuid;
  v_finding_id uuid;
  v_finding_ids uuid[];
  v_index integer;
  v_snapshot jsonb;
begin
  select * into strict c from pg_temp.round_command_context where slot = 9;
  select x.chunk_id into strict v_chunk_id
  from pg_temp.analysis_case x where x.analysis_id = c.analysis_id and x.ordinal = 1;
  v_finding_ids := array[c.finding_a_id, c.finding_b_id, c.finding_c_id];
  for v_index in 1..97 loop
    v_finding_id := pg_temp.insert_finding_row(
      c.analysis_id, c.workspace_id, 0.5,
      pg_catalog.format('Synthetic boundary finding %s', v_index)
    );
    update public.findings set status = 'confirmed', assignee_id = c.member_a_id where id = v_finding_id;
    perform pg_temp.insert_evidence_row(
      c.workspace_id, c.analysis_id, v_finding_id, c.document_id, c.version_id, v_chunk_id,
      pg_catalog.format('Synthetic boundary evidence %s', v_index)
    );
    v_finding_ids := pg_catalog.array_append(v_finding_ids, v_finding_id);
  end loop;
  v_snapshot := public.review_prepare_round(
    c.admin_id, c.document_id, 'assigned_findings', v_finding_ids, 'round-max-selection'
  );
  insert into pg_temp.round_command_max_selection
  select (v_snapshot->>'roundId')::uuid, pg_catalog.cardinality(v_finding_ids);
end;
$$;
select is((select selection_count from pg_temp.round_command_max_selection),
  100, 'Preparation accepts a complete selection of one hundred eligible findings');
select is((select count(*) from public.correction_round_items i, pg_temp.round_command_max_selection s
  where i.round_id = s.round_id),
  100::bigint, 'Preparation creates one item for every finding in the maximum-size selection');

create temporary table round_command_main(round_id uuid not null, snapshot jsonb not null) on commit drop;
insert into pg_temp.round_command_main
select (x.snapshot->>'roundId')::uuid, x.snapshot
from (
  select public.review_prepare_round(
    c.admin_id, c.document_id, 'assigned_findings', array[c.finding_a_id, c.finding_b_id], 'round-main-prepare'
  ) as snapshot
  from pg_temp.round_command_context c where c.slot = 1
) x;

select is((select snapshot->>'status' from pg_temp.round_command_main), 'draft',
  'Preparing an assigned round returns a draft snapshot');
select is((select snapshot->'openedAt' from pg_temp.round_command_main), 'null'::jsonb,
  'Preparation does not set the opening timestamp');
select is((select count(*) from public.correction_round_items i, pg_temp.round_command_main r where i.round_id = r.round_id),
  2::bigint, 'Preparation snapshots every selected finding as a round item');
select is((select count(*) from public.correction_round_items i, pg_temp.round_command_main r
  where i.round_id = r.round_id and i.opened_assignee_id is not null),
  0::bigint, 'Preparation leaves the separate opening assignee snapshot unset');
select is(public.review_prepare_round(
  (select admin_id from pg_temp.round_command_context where slot = 1),
  (select document_id from pg_temp.round_command_context where slot = 1),
  'assigned_findings',
  array[(select finding_a_id from pg_temp.round_command_context where slot = 1),
    (select finding_b_id from pg_temp.round_command_context where slot = 1)],
  'round-main-prepare'
)->>'roundId', (select round_id::text from pg_temp.round_command_main),
  'A repeated prepare command replays the original round instead of creating another');
select throws_ok(format(
  'select public.review_prepare_round(%L, %L, %L, %L::uuid[], %L)',
  (select admin_id from pg_temp.round_command_context where slot = 1),
  (select document_id from pg_temp.round_command_context where slot = 1),
  'assigned_findings',
  array[(select finding_a_id::text from pg_temp.round_command_context where slot = 1)],
  'round-main-prepare'
), 'P0001', null, 'A prepare receipt rejects the same key with a different finding set');
select throws_ok(format(
  'select public.review_prepare_round(%L, %L, %L, %L::uuid[], %L)',
  (select admin_id from pg_temp.round_command_context where slot = 1),
  (select document_id from pg_temp.round_command_context where slot = 1),
  'assigned_findings',
  array[(select finding_c_id::text from pg_temp.round_command_context where slot = 1)],
  'round-main-second-open'
), 'P0001', null, 'A document cannot have two nonterminal rounds');

create temporary table round_command_initial_item on commit drop as
select i.id as retained_item_id, i.initial_assignee_id, r.revision as round_revision,
  r.coverage_revision
from public.correction_round_items i
join pg_temp.round_command_main m on m.round_id = i.round_id
join pg_temp.round_command_context c on c.slot = 1 and i.finding_id = c.finding_b_id
join public.correction_rounds r on r.id = i.round_id;
select public.review_assign_finding(
  (select admin_id from pg_temp.round_command_context where slot = 1),
  (select finding_b_id from pg_temp.round_command_context where slot = 1),
  (select f.review_revision from public.findings f join pg_temp.round_command_context c
    on c.slot = 1 and c.finding_b_id = f.id),
  (select member_a_id from pg_temp.round_command_context where slot = 1),
  'round-main-draft-reassign'
);
select is((select i.initial_assignee_id from public.correction_round_items i, pg_temp.round_command_initial_item b
  where i.id = b.retained_item_id),
  (select member_b_id from pg_temp.round_command_context where slot = 1),
  'A draft reassignment preserves the preparation assignee snapshot');
select is((select i.assignee_id from public.correction_round_items i, pg_temp.round_command_initial_item b
  where i.id = b.retained_item_id),
  (select member_a_id from pg_temp.round_command_context where slot = 1),
  'A draft reassignment synchronizes the current item assignee');

create temporary table round_command_before_edit on commit drop as
select r.revision, r.coverage_revision,
  (select count(*) from public.audit_events e where e.entity_id = r.id and e.action = 'correction_round_draft_updated') as edit_events
from public.correction_rounds r join pg_temp.round_command_main m on m.round_id = r.id;
select throws_ok(format(
  'select public.review_update_round_draft(%L, %L, %s, %L::uuid[], %L)',
  (select admin_id from pg_temp.round_command_context where slot = 1),
  (select round_id from pg_temp.round_command_main),
  (select revision from pg_temp.round_command_before_edit),
  '{}'::text[],
  'round-main-empty-edit'
), '22023', null, 'A draft cannot be replaced with an empty finding set');
create temporary table round_command_updated(snapshot jsonb not null) on commit drop;
insert into pg_temp.round_command_updated
select public.review_update_round_draft(
  c.admin_id, r.round_id,
  (select x.revision from public.correction_rounds x where x.id = r.round_id),
  array[c.finding_c_id, c.finding_b_id], 'round-main-edit'
)
from pg_temp.round_command_context c cross join pg_temp.round_command_main r where c.slot = 1;
select is(public.review_update_round_draft(
  (select admin_id from pg_temp.round_command_context where slot = 1),
  (select round_id from pg_temp.round_command_main),
  (select revision from pg_temp.round_command_before_edit),
  array[(select finding_c_id from pg_temp.round_command_context where slot = 1),
    (select finding_b_id from pg_temp.round_command_context where slot = 1)],
  'round-main-edit'
)->>'revision',
  ((select revision + 1 from pg_temp.round_command_before_edit))::text,
  'A lost draft-edit response replays the current round snapshot');
select is((select count(*) from public.correction_round_items i, pg_temp.round_command_main r
  where i.round_id = r.round_id and i.finding_id in (
    (select finding_b_id from pg_temp.round_command_context where slot = 1),
    (select finding_c_id from pg_temp.round_command_context where slot = 1))),
  2::bigint, 'Editing a draft replaces only the removed and added finding items');
select is((select i.id from public.correction_round_items i, pg_temp.round_command_initial_item b
  where i.id = b.retained_item_id), (select retained_item_id from pg_temp.round_command_initial_item),
  'Editing preserves the row identity of a retained finding item');
select is((select r.coverage_revision from public.correction_rounds r, pg_temp.round_command_main m where r.id = m.round_id),
  (select coverage_revision + 1 from pg_temp.round_command_before_edit),
  'A real draft selection edit advances round coverage once');
select is((select r.revision from public.correction_rounds r, pg_temp.round_command_main m where r.id = m.round_id),
  (select revision + 1 from pg_temp.round_command_before_edit),
  'A real draft selection edit advances round revision once');
select public.review_update_round_draft(
  (select admin_id from pg_temp.round_command_context where slot = 1),
  (select round_id from pg_temp.round_command_main),
  (select r.revision from public.correction_rounds r join pg_temp.round_command_main m on m.round_id = r.id),
  array[(select finding_b_id from pg_temp.round_command_context where slot = 1),
    (select finding_c_id from pg_temp.round_command_context where slot = 1)],
  'round-main-reorder'
);
select is((select r.coverage_revision from public.correction_rounds r, pg_temp.round_command_main m where r.id = m.round_id),
  (select coverage_revision + 1 from pg_temp.round_command_before_edit),
  'Reordering the same draft finding set is a no-op for coverage');
select is((select count(*) from public.audit_events e, pg_temp.round_command_main m
  where e.entity_id = m.round_id and e.action = 'correction_round_draft_updated'),
  (select edit_events + 1 from pg_temp.round_command_before_edit),
  'A no-op draft update adds no audit event');

create temporary table round_command_opened(snapshot jsonb not null) on commit drop;
insert into pg_temp.round_command_opened
select public.review_open_round(
  c.admin_id, m.round_id, r.revision, 'round-main-open'
)
from pg_temp.round_command_context c
cross join pg_temp.round_command_main m
join public.correction_rounds r on r.id = m.round_id
where c.slot = 1;
select is((select snapshot->>'status' from pg_temp.round_command_opened), 'collecting',
  'An eligible assigned draft opens for Member collection');
select ok((select snapshot->'openedAt' <> 'null'::jsonb from pg_temp.round_command_opened),
  'Opening fixes a timestamp');
select is((select i.initial_assignee_id from public.correction_round_items i, pg_temp.round_command_initial_item b
  where i.id = b.retained_item_id),
  (select member_b_id from pg_temp.round_command_context where slot = 1),
  'Opening never rewrites the original preparation assignee');
select is((select i.opened_assignee_id from public.correction_round_items i, pg_temp.round_command_initial_item b
  where i.id = b.retained_item_id),
  (select member_a_id from pg_temp.round_command_context where slot = 1),
  'Opening snapshots the current assignee separately');
select throws_ok(format(
  'select public.review_update_round_draft(%L, %L, %s, %L::uuid[], %L)',
  (select admin_id from pg_temp.round_command_context where slot = 1),
  (select round_id from pg_temp.round_command_main),
  (select revision from public.correction_rounds r join pg_temp.round_command_main m on m.round_id = r.id),
  array[(select finding_b_id::text from pg_temp.round_command_context where slot = 1)],
  'round-main-edit-after-open'
), 'P0001', null, 'An opened round cannot be edited as a draft');

create temporary table round_command_admin(snapshot jsonb not null) on commit drop;
select throws_ok(format(
  'select public.review_prepare_round(%L, %L, %L, %L::uuid[], %L)',
  (select admin_id from pg_temp.round_command_context where slot = 2),
  (select document_id from pg_temp.round_command_context where slot = 2),
  'administrative',
  array[(select finding_a_id::text from pg_temp.round_command_context where slot = 2)],
  'round-admin-with-findings'
), '22023', null, 'Administrative preparation rejects any finding IDs');
insert into pg_temp.round_command_admin
select public.review_prepare_round(c.admin_id, c.document_id, 'administrative', null, 'round-admin-prepare')
from pg_temp.round_command_context c where c.slot = 2;
select is((select snapshot->>'status' from pg_temp.round_command_admin), 'draft',
  'An administrative round prepares as a draft');
select throws_ok(format(
  'select public.review_update_round_draft(%L, %L, %s, %L::uuid[], %L)',
  (select admin_id from pg_temp.round_command_context where slot = 2),
  (select (snapshot->>'roundId')::uuid from pg_temp.round_command_admin),
  (select (snapshot->>'revision')::bigint from pg_temp.round_command_admin),
  array[(select finding_a_id::text from pg_temp.round_command_context where slot = 2)],
  'round-admin-edit'
), 'P0001', null, 'An administrative draft cannot be edited as a finding set');
select is((select count(*) from public.correction_round_items i join public.correction_rounds r on r.id = i.round_id
  where r.workspace_id = (select workspace_id from pg_temp.round_command_context where slot = 2)),
  0::bigint, 'An administrative round never fabricates finding items');
create temporary table round_command_admin_opened(snapshot jsonb not null) on commit drop;
insert into pg_temp.round_command_admin_opened
select public.review_open_round(c.admin_id, (a.snapshot->>'roundId')::uuid,
  (a.snapshot->>'revision')::bigint, 'round-admin-open')
from pg_temp.round_command_context c cross join pg_temp.round_command_admin a where c.slot = 2;
select is((select snapshot->>'status' from pg_temp.round_command_admin_opened), 'consolidating',
  'An administrative draft opens directly to consolidation');
select is((select jsonb_array_length(snapshot->'items') from pg_temp.round_command_admin_opened),
  0, 'Opening an administrative round produces no Member items');

create temporary table round_command_revalidation(round_id uuid not null) on commit drop;
insert into pg_temp.round_command_revalidation
select (x.snapshot->>'roundId')::uuid
from (
  select public.review_prepare_round(c.admin_id, c.document_id, 'assigned_findings',
    array[c.finding_a_id, c.finding_b_id], 'round-revalidate-prepare') as snapshot
  from pg_temp.round_command_context c where c.slot = 4
) x;
select public.review_assign_finding(
  (select admin_id from pg_temp.round_command_context where slot = 4),
  (select finding_a_id from pg_temp.round_command_context where slot = 4),
  (select f.review_revision from public.findings f join pg_temp.round_command_context c
    on c.slot = 4 and c.finding_a_id = f.id),
  null,
  'round-revalidate-unassign'
);
select throws_ok(format(
  'select public.review_open_round(%L, %L, %s, %L)',
  (select admin_id from pg_temp.round_command_context where slot = 4),
  (select round_id from pg_temp.round_command_revalidation),
  (select r.revision from public.correction_rounds r, pg_temp.round_command_revalidation x where r.id = x.round_id),
  'round-revalidate-open-unassigned'
), 'P0001', null, 'Opening revalidates and rejects a draft with an unassigned finding');
select is((select r.status::text from public.correction_rounds r, pg_temp.round_command_revalidation x where r.id = x.round_id),
  'draft', 'A rejected opening keeps the entire round in draft');
select ok((select r.opened_at is null from public.correction_rounds r, pg_temp.round_command_revalidation x where r.id = x.round_id),
  'A rejected opening does not set opened_at');
select ok(not exists (select 1 from public.correction_round_items i, pg_temp.round_command_revalidation x
  where i.round_id = x.round_id and i.opened_assignee_id is not null),
  'A rejected opening does not snapshot any item assignee');
select public.review_assign_finding(
  (select admin_id from pg_temp.round_command_context where slot = 4),
  (select finding_a_id from pg_temp.round_command_context where slot = 4),
  (select f.review_revision from public.findings f join pg_temp.round_command_context c
    on c.slot = 4 and c.finding_a_id = f.id),
  (select member_a_id from pg_temp.round_command_context where slot = 4),
  'round-revalidate-restore-assignment'
);
select public.review_change_finding(
  (select admin_id from pg_temp.round_command_context where slot = 4),
  (select finding_b_id from pg_temp.round_command_context where slot = 4),
  (select f.review_revision from public.findings f join pg_temp.round_command_context c
    on c.slot = 4 and c.finding_b_id = f.id),
  jsonb_build_object('field', 'status', 'value', 'resolved'),
  'round-revalidate-resolve'
);
select throws_ok(format(
  'select public.review_open_round(%L, %L, %s, %L)',
  (select admin_id from pg_temp.round_command_context where slot = 4),
  (select round_id from pg_temp.round_command_revalidation),
  (select r.revision from public.correction_rounds r, pg_temp.round_command_revalidation x where r.id = x.round_id),
  'round-revalidate-open-resolved'
), 'P0001', null, 'Opening revalidates and rejects a finding that was resolved after preparation');
select is((select r.status::text from public.correction_rounds r, pg_temp.round_command_revalidation x where r.id = x.round_id),
  'draft', 'A failed status revalidation keeps the entire round in draft');
select ok(not exists (select 1 from public.correction_round_items i, pg_temp.round_command_revalidation x
  where i.round_id = x.round_id and i.opened_assignee_id is not null),
  'A failed status revalidation does not partially snapshot assignments');

update public.documents d set active_version_id = null
from pg_temp.round_command_context c where c.slot = 5 and d.id = c.document_id;
select throws_ok(format(
  'select public.review_prepare_round(%L, %L, %L, %L::uuid[], %L)',
  (select admin_id from pg_temp.round_command_context where slot = 5),
  (select document_id from pg_temp.round_command_context where slot = 5),
  'assigned_findings',
  array[(select finding_a_id::text from pg_temp.round_command_context where slot = 5)],
  'round-base-unavailable-prepare'
), 'P0001', null, 'Preparation requires an active ready base version');
update public.documents d set active_version_id = c.version_id
from pg_temp.round_command_context c where c.slot = 5 and d.id = c.document_id;
create temporary table round_command_base(round_id uuid not null, revision bigint not null) on commit drop;
insert into pg_temp.round_command_base
select (x.snapshot->>'roundId')::uuid, (x.snapshot->>'revision')::bigint
from (
  select public.review_prepare_round(c.admin_id, c.document_id, 'assigned_findings',
    array[c.finding_a_id], 'round-base-revalidate-prepare') as snapshot
  from pg_temp.round_command_context c where c.slot = 5
) x;
update public.documents d set active_version_id = null
from pg_temp.round_command_context c where c.slot = 5 and d.id = c.document_id;
select throws_ok(format(
  'select public.review_open_round(%L, %L, %s, %L)',
  (select admin_id from pg_temp.round_command_context where slot = 5),
  (select round_id from pg_temp.round_command_base),
  (select revision from pg_temp.round_command_base),
  'round-base-revalidate-open'
), 'P0001', null, 'Opening rejects a draft whose active base version changed');
select is((select r.status::text from public.correction_rounds r, pg_temp.round_command_base b where r.id = b.round_id),
  'draft', 'A stale base leaves the round in draft');
select ok((select r.opened_at is null from public.correction_rounds r, pg_temp.round_command_base b where r.id = b.round_id),
  'A stale base does not set opened_at');
update public.documents d set active_version_id = c.version_id
from pg_temp.round_command_context c where c.slot = 5 and d.id = c.document_id;

create temporary table round_command_failed_candidate_setup(
  round_id uuid not null,
  candidate_id uuid not null,
  version_id uuid not null,
  submission_id uuid not null,
  covered_item_id uuid not null,
  ledger_count bigint not null
) on commit drop;
do $$
declare
  c pg_temp.round_command_context%rowtype;
  v_snapshot jsonb;
  v_round_id uuid;
  v_item_ids uuid[];
  v_candidate_id uuid;
  v_submission_id uuid;
  v_version_id uuid;
begin
  select * into strict c from pg_temp.round_command_context where slot = 6;
  v_snapshot := public.review_prepare_round(c.admin_id, c.document_id, 'assigned_findings',
    array[c.finding_a_id, c.finding_c_id], 'round-failed-candidate-prepare');
  v_round_id := (v_snapshot->>'roundId')::uuid;
  perform public.review_open_round(c.admin_id, v_round_id, (v_snapshot->>'revision')::bigint, 'round-failed-candidate-open');
  select array_agg(i.id order by i.finding_id) into strict v_item_ids
  from public.correction_round_items i where i.round_id = v_round_id;
  v_submission_id := pg_temp.create_review_submission(v_round_id, c.member_a_id, v_item_ids);
  v_candidate_id := pg_temp.select_direct_review_candidate(v_round_id, c.admin_id, v_submission_id);
  perform pg_temp.fail_review_candidate(v_candidate_id);
  select x.version_id into strict v_version_id from public.correction_candidates x where x.id = v_candidate_id;
  insert into pg_temp.round_command_failed_candidate_setup
  select v_round_id, v_candidate_id, v_version_id, v_submission_id, v_item_ids[1], c.ledger_count;
end;
$$;
create temporary table round_command_failed_candidate_before on commit drop as
select r.revision, r.coverage_revision, c.status as candidate_status,
  v.processing_status, v.processing_operation_id, j.status as job_status, j.attempt_count, j.operation_id
from pg_temp.round_command_failed_candidate_setup s
join public.correction_rounds r on r.id = s.round_id
join public.correction_candidates c on c.id = s.candidate_id
join public.document_versions v on v.id = s.version_id
join private.ingestion_jobs j on j.version_id = s.version_id;
select is(public.review_cancel_round(
  c.admin_id, s.round_id, r.revision, '  Worker processing failed  ', 'round-failed-candidate-cancel'
)->>'status', 'cancelled', 'A failed-candidate round can be cancelled')
from pg_temp.round_command_context c
join pg_temp.round_command_failed_candidate_setup s on true
join public.correction_rounds r on r.id = s.round_id
where c.slot = 6;
select is((select c.status::text from public.correction_candidates c, pg_temp.round_command_failed_candidate_setup s where c.id = s.candidate_id),
  'invalidated', 'Cancellation invalidates a failed candidate');
select is((select d.outcome::text from public.correction_candidate_decisions d, pg_temp.round_command_failed_candidate_setup s where d.candidate_id = s.candidate_id),
  'invalidated', 'Cancellation adds an invalidation decision for the failed candidate');
select is((select d.private_reason from public.correction_candidate_decisions d, pg_temp.round_command_failed_candidate_setup s where d.candidate_id = s.candidate_id),
  'Worker processing failed', 'The failed-candidate decision stores the trimmed private reason');
select is((select v.version_status::text from public.document_versions v, pg_temp.round_command_failed_candidate_setup s where v.id = s.version_id),
  null, 'A cancelled failed candidate has no version status');
select is((select v.processing_status::text from public.document_versions v, pg_temp.round_command_failed_candidate_setup s where v.id = s.version_id),
  (select processing_status::text from pg_temp.round_command_failed_candidate_before),
  'Cancellation preserves the failed worker processing state');
select is((select v.processing_operation_id from public.document_versions v, pg_temp.round_command_failed_candidate_setup s where v.id = s.version_id),
  (select processing_operation_id from pg_temp.round_command_failed_candidate_before),
  'Cancellation preserves the worker operation fence');
select is((select j.status::text from private.ingestion_jobs j, pg_temp.round_command_failed_candidate_setup s where j.version_id = s.version_id),
  (select job_status::text from pg_temp.round_command_failed_candidate_before),
  'Cancellation does not rewrite the failed worker job');
select is((select j.attempt_count from private.ingestion_jobs j, pg_temp.round_command_failed_candidate_setup s where j.version_id = s.version_id),
  (select attempt_count from pg_temp.round_command_failed_candidate_before),
  'Cancellation preserves worker retry history');
select is((select j.operation_id from private.ingestion_jobs j, pg_temp.round_command_failed_candidate_setup s where j.version_id = s.version_id),
  (select operation_id from pg_temp.round_command_failed_candidate_before),
  'Cancellation preserves the worker job fence');
select is((select i.current_submission_id from public.correction_round_items i, pg_temp.round_command_failed_candidate_setup s where i.id = s.covered_item_id),
  (select submission_id from pg_temp.round_command_failed_candidate_setup),
  'Cancellation preserves confirmed Member coverage');
select is((select s.state::text from public.correction_submissions s, pg_temp.round_command_failed_candidate_setup x where s.id = x.submission_id),
  'confirmed', 'Cancellation preserves the confirmed submission');
select is((select r.coverage_revision from public.correction_rounds r, pg_temp.round_command_failed_candidate_setup s where r.id = s.round_id),
  (select coverage_revision from pg_temp.round_command_failed_candidate_before),
  'Cancellation preserves coverage history for a failed candidate');
select is((select count(*) from public.credit_ledger l, pg_temp.round_command_context c
  where c.slot = 6 and l.workspace_id = c.workspace_id),
  (select ledger_count from pg_temp.round_command_failed_candidate_setup),
  'Cancelling a failed candidate does not consume analysis credits');

create temporary table round_command_phase_guard_setup(
  round_id uuid not null,
  candidate_id uuid not null,
  version_id uuid not null,
  submission_id uuid not null,
  ledger_count bigint not null
) on commit drop;
do $$
declare
  c pg_temp.round_command_context%rowtype;
  v_snapshot jsonb;
  v_round_id uuid;
  v_item_ids uuid[];
  v_submission_id uuid;
  v_candidate_id uuid;
  v_version_id uuid;
begin
  select * into strict c from pg_temp.round_command_context where slot = 7;
  v_snapshot := public.review_prepare_round(c.admin_id, c.document_id, 'assigned_findings',
    array[c.finding_a_id, c.finding_c_id], 'round-phase-guard-prepare');
  v_round_id := (v_snapshot->>'roundId')::uuid;
  perform public.review_open_round(c.admin_id, v_round_id, (v_snapshot->>'revision')::bigint, 'round-phase-guard-open');
  select array_agg(i.id order by i.finding_id) into strict v_item_ids
  from public.correction_round_items i where i.round_id = v_round_id;
  v_submission_id := pg_temp.create_review_submission(v_round_id, c.member_a_id, v_item_ids);
  v_candidate_id := pg_temp.select_direct_review_candidate(v_round_id, c.admin_id, v_submission_id);
  perform pg_temp.start_review_candidate(v_candidate_id);
  select x.version_id into strict v_version_id from public.correction_candidates x where x.id = v_candidate_id;
  insert into pg_temp.round_command_phase_guard_setup
  values (v_round_id, v_candidate_id, v_version_id, v_submission_id, c.ledger_count);
end;
$$;
select throws_ok(format(
  'select public.review_cancel_round(%L, %L, %s, %L, %L)',
  (select admin_id from pg_temp.round_command_context where slot = 7),
  (select round_id from pg_temp.round_command_phase_guard_setup),
  (select revision from public.correction_rounds r join pg_temp.round_command_phase_guard_setup s on s.round_id = r.id),
  'Cannot cancel while a worker is active',
  'round-processing-cancel-blocked'
), 'P0001', null, 'Candidate processing cannot be cancelled');
select is((select r.status::text from public.correction_rounds r, pg_temp.round_command_phase_guard_setup s where r.id = s.round_id),
  'candidate_processing', 'A blocked cancellation preserves candidate processing');
select is((select v.processing_operation_id from public.document_versions v, pg_temp.round_command_phase_guard_setup s where v.id = s.version_id),
  (select operation_id from private.ingestion_jobs j, pg_temp.round_command_phase_guard_setup s where j.version_id = s.version_id),
  'A blocked cancellation preserves the active worker operation');
select pg_temp.complete_review_candidate((select candidate_id from pg_temp.round_command_phase_guard_setup));
select throws_ok(format(
  'select public.review_cancel_round(%L, %L, %s, %L, %L)',
  (select admin_id from pg_temp.round_command_context where slot = 7),
  (select round_id from pg_temp.round_command_phase_guard_setup),
  (select revision from public.correction_rounds r join pg_temp.round_command_phase_guard_setup s on s.round_id = r.id),
  'Use the approval flow',
  'round-approval-cancel-blocked'
), 'P0001', null, 'Pending approval cannot be cancelled');
select is((select r.status::text from public.correction_rounds r, pg_temp.round_command_phase_guard_setup s where r.id = s.round_id),
  'pending_approval', 'A blocked cancellation preserves pending approval');
do $$
declare
  s pg_temp.round_command_phase_guard_setup%rowtype;
  v_decision_id uuid;
begin
  select * into strict s from pg_temp.round_command_phase_guard_setup;
  insert into public.correction_candidate_decisions(
    workspace_id, round_id, document_id, candidate_id, actor_id, outcome, retention
  ) select c.workspace_id, c.round_id, c.document_id, c.id, c.selected_by, 'approved', 'retain'
    from public.correction_candidates c where c.id = s.candidate_id
  returning id into strict v_decision_id;
  insert into public.correction_approval_contributions(
    approval_id, document_id, workspace_id, contributor_id, own_item_count
  ) select v_decision_id, c.document_id, c.workspace_id, si.assignee_at_submit_id, count(*)::integer
    from public.correction_candidates c
    join public.correction_candidate_items ci on ci.candidate_id = c.id
    join public.correction_submission_items si on si.submission_id = ci.submission_id and si.round_item_id = ci.round_item_id
    where c.id = s.candidate_id
    group by c.document_id, c.workspace_id, si.assignee_at_submit_id;
  update public.document_versions set version_status = 'historical'
  where id = (select r.base_version_id from public.correction_rounds r where r.id = s.round_id);
  update public.document_versions set version_status = 'active' where id = s.version_id;
  update public.documents set active_version_id = s.version_id where id = (
    select r.document_id from public.correction_rounds r where r.id = s.round_id
  );
  update public.correction_candidates set status = 'approved', revision = revision + 1 where id = s.candidate_id;
  update public.correction_rounds set status = 'approved', revision = revision + 1 where id = s.round_id;
end;
$$;
select throws_ok(format(
  'select public.review_cancel_round(%L, %L, %s, %L, %L)',
  (select admin_id from pg_temp.round_command_context where slot = 7),
  (select round_id from pg_temp.round_command_phase_guard_setup),
  (select revision from public.correction_rounds r join pg_temp.round_command_phase_guard_setup s on s.round_id = r.id),
  'An approved round is final',
  'round-approved-cancel-blocked'
), 'P0001', null, 'An approved round cannot be cancelled');
select is((select r.status::text from public.correction_rounds r, pg_temp.round_command_phase_guard_setup s where r.id = s.round_id),
  'approved', 'A blocked cancellation preserves approval');
select is((select c.status::text from public.correction_candidates c, pg_temp.round_command_phase_guard_setup s where c.id = s.candidate_id),
  'approved', 'A blocked cancellation preserves the approved candidate');
select is((select d.active_version_id from public.documents d join public.correction_rounds r on r.document_id = d.id, pg_temp.round_command_phase_guard_setup s where r.id = s.round_id),
  (select version_id from pg_temp.round_command_phase_guard_setup), 'A blocked cancellation preserves the active version pointer');
select is((select count(*) from private.review_round_cancellations c, pg_temp.round_command_phase_guard_setup s where c.round_id = s.round_id),
  0::bigint, 'Blocked phase cancellations store no private reason');

create temporary table round_command_cancel_setup(
  round_id uuid not null,
  confirmed_item_id uuid not null,
  reserved_submission_id uuid not null,
  confirmed_submission_id uuid not null,
  open_revision bigint not null,
  round_revision bigint not null,
  coverage_revision bigint not null
) on commit drop;
do $$
declare
  c pg_temp.round_command_context%rowtype;
  v_round jsonb;
  v_open_revision bigint;
  v_round_id uuid;
  v_item_a uuid;
  v_item_c uuid;
  v_reserved uuid;
  v_confirmed uuid;
begin
  select * into strict c from pg_temp.round_command_context where slot = 3;
  v_round := public.review_prepare_round(c.admin_id, c.document_id, 'assigned_findings',
    array[c.finding_a_id, c.finding_c_id], 'round-cancel-prepare');
  v_round_id := (v_round->>'roundId')::uuid;
  v_open_revision := (v_round->>'revision')::bigint;
  v_round := public.review_open_round(c.admin_id, v_round_id, v_open_revision, 'round-cancel-open');
  select i.id into strict v_item_a from public.correction_round_items i where i.round_id = v_round_id and i.finding_id = c.finding_a_id;
  select i.id into strict v_item_c from public.correction_round_items i where i.round_id = v_round_id and i.finding_id = c.finding_c_id;
  v_reserved := pg_temp.create_review_reservation(v_round_id, c.member_a_id, array[v_item_a, v_item_c]);
  v_confirmed := pg_temp.create_review_submission(v_round_id, c.member_a_id, array[v_item_c]);
  insert into pg_temp.round_command_cancel_setup
  select v_round_id, v_item_c, v_reserved, v_confirmed, v_open_revision, r.revision, r.coverage_revision
  from public.correction_rounds r where r.id = v_round_id;
end;
$$;
create temporary table round_command_cancelled(snapshot jsonb not null) on commit drop;
insert into pg_temp.round_command_cancelled
select public.review_cancel_round(c.admin_id, s.round_id, s.round_revision, '  Pause this work  ', 'round-cancel-collecting')
from pg_temp.round_command_context c cross join pg_temp.round_command_cancel_setup s where c.slot = 3;
select is((select snapshot->>'status' from pg_temp.round_command_cancelled), 'cancelled',
  'A collecting round can be cancelled');
select is((select reason from private.review_round_cancellations x, pg_temp.round_command_cancel_setup s where x.round_id = s.round_id),
  'Pause this work', 'Cancellation stores only the trimmed private reason');
select is((select s.state::text from public.correction_submissions s, pg_temp.round_command_cancel_setup x where s.id = x.reserved_submission_id),
  'invalidated', 'Cancellation invalidates a pending reservation');
select is((select s.state::text from public.correction_submissions s, pg_temp.round_command_cancel_setup x where s.id = x.confirmed_submission_id),
  'confirmed', 'Cancellation preserves confirmed submissions');
select is((select r.active_candidate_id from public.correction_rounds r, pg_temp.round_command_cancel_setup x
  where r.id = x.round_id), null, 'Cancellation clears the candidate pointer');
select is((select i.current_submission_id from public.correction_round_items i, pg_temp.round_command_cancel_setup x where i.id = x.confirmed_item_id),
  (select confirmed_submission_id from pg_temp.round_command_cancel_setup),
  'Cancellation preserves confirmed coverage pointers');
select is((select r.coverage_revision from public.correction_rounds r, pg_temp.round_command_cancel_setup x where r.id = x.round_id),
  (select coverage_revision from pg_temp.round_command_cancel_setup),
  'Cancellation does not rewrite coverage history');
select is((select e.metadata from public.audit_events e, pg_temp.round_command_cancel_setup s
  where e.entity_id = s.round_id and e.action = 'correction_round_cancelled'),
  jsonb_build_object('roundId', (select round_id from pg_temp.round_command_cancel_setup)),
  'The cancellation audit contains no private reason');
select ok(not exists (
  select 1 from private.review_commands r, pg_temp.round_command_cancel_setup s
  where r.result_id = s.round_id and r.fingerprint like '%Pause this work%'
), 'The private cancellation reason is never stored in a review receipt');
select public.review_cancel_round(
  (select admin_id from pg_temp.round_command_context where slot = 3),
  (select round_id from pg_temp.round_command_cancel_setup),
  (select r.revision from public.correction_rounds r, pg_temp.round_command_cancel_setup x where r.id = x.round_id),
  'A later request must not replace the original reason',
  'round-cancel-noop'
);
select is((select x.reason from private.review_round_cancellations x, pg_temp.round_command_cancel_setup s
  where x.round_id = s.round_id),
  'Pause this work', 'A later cancel request leaves the first private reason unchanged');
select is((select count(*) from private.review_round_cancellations x, pg_temp.round_command_cancel_setup s
  where x.round_id = s.round_id),
  1::bigint, 'A cancelled round stores one private cancellation record');
select is((select r.revision from public.correction_rounds r, pg_temp.round_command_cancel_setup x where r.id = x.round_id),
  (select round_revision + 1 from pg_temp.round_command_cancel_setup),
  'Repeating cancellation does not advance the round revision');
select is(public.review_cancel_round(
  (select admin_id from pg_temp.round_command_context where slot = 3),
  (select round_id from pg_temp.round_command_cancel_setup),
  (select round_revision from pg_temp.round_command_cancel_setup),
  '  Pause this work  ',
  'round-cancel-collecting'
)->>'status', 'cancelled', 'A lost cancel response replays the current cancelled snapshot');
select is(public.review_open_round(
  (select admin_id from pg_temp.round_command_context where slot = 3),
  (select round_id from pg_temp.round_command_cancel_setup),
  (select open_revision from pg_temp.round_command_cancel_setup),
  'round-cancel-open'
)->>'status', 'cancelled', 'A lost open response replays the current cancelled round snapshot');
select is((select count(*) from public.audit_events e, pg_temp.round_command_cancel_setup s
  where e.entity_id = s.round_id and e.action = 'correction_round_cancelled'),
  1::bigint, 'A cancellation replay or no-op does not duplicate its audit event');
select is((select count(*) from public.audit_events e, pg_temp.round_command_cancel_setup s
  where e.entity_id = s.round_id and e.action = 'correction_round_opened'),
  1::bigint, 'An open replay does not duplicate its audit event');

create temporary table round_command_reserved_candidate_setup(
  round_id uuid not null,
  candidate_id uuid not null,
  version_id uuid not null,
  round_revision bigint not null,
  coverage_revision bigint not null,
  ledger_count bigint not null
) on commit drop;
do $$
declare
  c pg_temp.round_command_context%rowtype;
  v_snapshot jsonb;
  v_round_id uuid;
  v_candidate_id uuid;
  v_version_id uuid;
begin
  select * into strict c from pg_temp.round_command_context where slot = 8;
  v_snapshot := public.review_prepare_round(c.admin_id, c.document_id, 'administrative', '{}'::uuid[], 'round-reserved-prepare');
  v_round_id := (v_snapshot->>'roundId')::uuid;
  v_snapshot := public.review_open_round(c.admin_id, v_round_id, (v_snapshot->>'revision')::bigint, 'round-reserved-open');
  v_candidate_id := pg_temp.create_consolidated_candidate(v_round_id, c.admin_id);
  select x.version_id into strict v_version_id from public.correction_candidates x where x.id = v_candidate_id;
  insert into pg_temp.round_command_reserved_candidate_setup
  select v_round_id, v_candidate_id, v_version_id, r.revision, r.coverage_revision, c.ledger_count
  from public.correction_rounds r where r.id = v_round_id;
end;
$$;
select is(public.review_cancel_round(
  c.admin_id, s.round_id, s.round_revision, 'Unused reserved candidate', 'round-reserved-cancel'
)->>'status', 'cancelled', 'A consolidating administrative round can cancel a reserved candidate')
from pg_temp.round_command_context c cross join pg_temp.round_command_reserved_candidate_setup s
where c.slot = 8;
select is((select c.status::text from public.correction_candidates c, pg_temp.round_command_reserved_candidate_setup s
  where c.id = s.candidate_id), 'invalidated', 'Cancellation invalidates a reserved candidate');
select is((select d.outcome::text from public.correction_candidate_decisions d, pg_temp.round_command_reserved_candidate_setup s
  where d.candidate_id = s.candidate_id), 'invalidated', 'Cancellation records a decision for a reserved candidate');
select is((select d.private_reason from public.correction_candidate_decisions d, pg_temp.round_command_reserved_candidate_setup s
  where d.candidate_id = s.candidate_id), 'Unused reserved candidate', 'The private cancellation reason is retained with the candidate decision');
select is((select v.version_status::text from public.document_versions v, pg_temp.round_command_reserved_candidate_setup s
  where v.id = s.version_id), null, 'Invalidating a reserved candidate leaves its version non-active');
select is((select v.processing_status::text from public.document_versions v, pg_temp.round_command_reserved_candidate_setup s
  where v.id = s.version_id), 'uploaded', 'Cancellation preserves the candidate version processing phase');
select ok(not exists (select 1 from private.ingestion_jobs j, pg_temp.round_command_reserved_candidate_setup s
  where j.version_id = s.version_id), 'Cancellation does not enqueue a candidate worker job');
select is((select r.active_candidate_id from public.correction_rounds r, pg_temp.round_command_reserved_candidate_setup s
  where r.id = s.round_id), null, 'Cancellation clears the reserved candidate pointer');
select is((select r.coverage_revision from public.correction_rounds r, pg_temp.round_command_reserved_candidate_setup s
  where r.id = s.round_id),
  (select coverage_revision from pg_temp.round_command_reserved_candidate_setup),
  'Invalidating an unused candidate does not change round coverage');
select is((select count(*) from public.credit_ledger l, pg_temp.round_command_context c
  where c.slot = 8 and l.workspace_id = c.workspace_id),
  (select ledger_count from pg_temp.round_command_reserved_candidate_setup),
  'Cancellation does not reserve or consume analysis credits');

create function pg_temp.reject_review_command_audit_for_test() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if pg_catalog.current_setting('kdm.review_test_reject_audit', true) = new.action::text then
    raise exception 'Synthetic review audit failure' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger review_round_command_audit_failure_test
before insert on public.audit_events
for each row execute function pg_temp.reject_review_command_audit_for_test();

select set_config('kdm.review_test_reject_audit', 'correction_round_prepared', true);
select throws_ok(format(
  'select public.review_prepare_round(%L, %L, %L, %L::uuid[], %L)',
  (select admin_id from pg_temp.round_command_context where slot = 10),
  (select document_id from pg_temp.round_command_context where slot = 10),
  'assigned_findings',
  array[(select finding_a_id::text from pg_temp.round_command_context where slot = 10),
    (select finding_b_id::text from pg_temp.round_command_context where slot = 10)],
  'round-rollback-prepare'
), 'P0001', null, 'A failed prepare audit rolls back the round and command receipt');
select set_config('kdm.review_test_reject_audit', '', true);
select is((select count(*) from public.correction_rounds r join pg_temp.round_command_context c
  on c.slot = 10 and c.document_id = r.document_id),
  0::bigint, 'A prepare audit failure leaves no draft');
select is((select count(*) from private.review_commands r, pg_temp.round_command_context c
  where c.slot = 10 and r.operation = 'prepareRound' and r.idempotency_key = 'round-rollback-prepare'),
  0::bigint, 'A prepare audit failure leaves no idempotency receipt');

create temporary table round_command_rollback(round_id uuid not null, revision bigint not null, coverage_revision bigint) on commit drop;
insert into pg_temp.round_command_rollback
select (x.snapshot->>'roundId')::uuid, (x.snapshot->>'revision')::bigint
from (
  select public.review_prepare_round(c.admin_id, c.document_id, 'assigned_findings',
    array[c.finding_a_id, c.finding_b_id], 'round-rollback-successful-prepare') as snapshot
  from pg_temp.round_command_context c where c.slot = 10
) x;
update pg_temp.round_command_rollback x set coverage_revision = r.coverage_revision
from public.correction_rounds r where r.id = x.round_id;
select set_config('kdm.review_test_reject_audit', 'correction_round_draft_updated', true);
select throws_ok(format(
  'select public.review_update_round_draft(%L, %L, %s, %L::uuid[], %L)',
  (select admin_id from pg_temp.round_command_context where slot = 10),
  (select round_id from pg_temp.round_command_rollback),
  (select revision from pg_temp.round_command_rollback),
  array[(select finding_a_id::text from pg_temp.round_command_context where slot = 10),
    (select finding_c_id::text from pg_temp.round_command_context where slot = 10)],
  'round-rollback-update'
), 'P0001', null, 'A failed draft audit rolls back both selection edits and receipt');
select set_config('kdm.review_test_reject_audit', '', true);
select is((select r.revision from public.correction_rounds r, pg_temp.round_command_rollback x where r.id = x.round_id),
  (select revision from pg_temp.round_command_rollback), 'A failed draft audit preserves the original round revision');
select is((select r.coverage_revision from public.correction_rounds r, pg_temp.round_command_rollback x where r.id = x.round_id),
  (select coverage_revision from pg_temp.round_command_rollback), 'A failed draft audit preserves the original coverage revision');
select is((select count(*) from public.correction_round_items i, pg_temp.round_command_rollback x
  where i.round_id = x.round_id and i.finding_id in (
    (select finding_a_id from pg_temp.round_command_context where slot = 10),
    (select finding_b_id from pg_temp.round_command_context where slot = 10))),
  2::bigint, 'A failed draft audit restores the original finding set');
select is((select count(*) from private.review_commands r, pg_temp.round_command_rollback x
  where r.result_id = x.round_id and r.operation = 'updateRoundDraft' and r.idempotency_key = 'round-rollback-update'),
  0::bigint, 'A failed draft audit leaves no update receipt');

select set_config('kdm.review_test_reject_audit', 'correction_round_opened', true);
select throws_ok(format(
  'select public.review_open_round(%L, %L, %s, %L)',
  (select admin_id from pg_temp.round_command_context where slot = 10),
  (select round_id from pg_temp.round_command_rollback),
  (select revision from pg_temp.round_command_rollback),
  'round-rollback-open'
), 'P0001', null, 'A failed open audit rolls back phase and opening snapshots');
select set_config('kdm.review_test_reject_audit', '', true);
select is((select r.status::text from public.correction_rounds r, pg_temp.round_command_rollback x where r.id = x.round_id),
  'draft', 'A failed open audit leaves the round in draft');
select ok((select r.opened_at is null from public.correction_rounds r, pg_temp.round_command_rollback x where r.id = x.round_id),
  'A failed open audit leaves the opening timestamp unset');
select ok(not exists (select 1 from public.correction_round_items i, pg_temp.round_command_rollback x
  where i.round_id = x.round_id and i.opened_assignee_id is not null),
  'A failed open audit leaves all opened-assignee snapshots unset');
select is((select count(*) from private.review_commands r, pg_temp.round_command_rollback x
  where r.result_id = x.round_id and r.operation = 'openRound' and r.idempotency_key = 'round-rollback-open'),
  0::bigint, 'A failed open audit leaves no opening receipt');

select set_config('kdm.review_test_reject_audit', 'correction_round_cancelled', true);
select throws_ok(format(
  'select public.review_cancel_round(%L, %L, %s, %L, %L)',
  (select admin_id from pg_temp.round_command_context where slot = 10),
  (select round_id from pg_temp.round_command_rollback),
  (select revision from pg_temp.round_command_rollback),
  'Rollback this cancellation',
  'round-rollback-cancel'
), 'P0001', null, 'A failed cancel audit rolls back cancellation reason and phase');
select set_config('kdm.review_test_reject_audit', '', true);
select is((select r.status::text from public.correction_rounds r, pg_temp.round_command_rollback x where r.id = x.round_id),
  'draft', 'A failed cancel audit leaves the round in draft');
select is((select count(*) from private.review_round_cancellations c, pg_temp.round_command_rollback x where c.round_id = x.round_id),
  0::bigint, 'A failed cancel audit leaves no private cancellation reason');
select is((select count(*) from private.review_commands c, pg_temp.round_command_rollback x
  where c.result_id = x.round_id and c.operation = 'cancelRound' and c.idempotency_key = 'round-rollback-cancel'),
  0::bigint, 'A failed cancel audit leaves no cancellation receipt');

select finish();
rollback;
