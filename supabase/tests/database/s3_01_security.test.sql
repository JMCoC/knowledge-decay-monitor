begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
\ir review-fixtures.psql
select no_plan();

select has_function('private', 'current_review_finding_allowed', ARRAY['uuid'],
  'Finding capability is derived inside the database');
select has_function('private', 'current_review_submission_allowed', ARRAY['uuid'],
  'Submission capability is derived inside the database');
select has_function('private', 'current_review_version_allowed', ARRAY['uuid'],
  'Version capability is derived inside the database');
select ok(has_column_privilege('authenticated', 'public.correction_round_items', 'finding_id', 'SELECT'),
  'Members can read only their assigned item snapshots');
select ok(not has_column_privilege('authenticated', 'public.correction_submissions', 'version_id', 'SELECT'),
  'Member submission rows do not expose workflow version IDs');
select ok(not has_table_privilege('authenticated', 'public.correction_candidates', 'SELECT'),
  'Members cannot query global candidate contributions');
select ok(not has_column_privilege('authenticated', 'public.document_versions', 'storage_path', 'SELECT'),
  'Member capability checks do not expose Storage paths');
select is((
  select count(*)::integer from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in (
      'correction_rounds', 'correction_round_items', 'correction_submissions',
      'correction_submission_items', 'correction_candidates', 'correction_candidate_items',
      'correction_returns', 'correction_return_items', 'correction_candidate_decisions',
      'correction_approval_contributions'
    )
    and c.relrowsecurity
), 10, 'Every public review table enforces row-level security');

create temporary table review_security_workspaces(
  case_name text primary key,
  workspace_id uuid not null
) on commit drop;
insert into pg_temp.review_security_workspaces values
  ('a', pg_temp.create_review_fixture_case()),
  ('b', pg_temp.create_review_fixture_case());

create temporary table review_security_context(
  case_name text primary key,
  workspace_id uuid not null,
  admin_id uuid not null,
  member_a_id uuid not null,
  member_b_id uuid not null,
  member_c_id uuid,
  qa_id uuid,
  document_id uuid not null,
  base_version_id uuid not null,
  finding_a_id uuid not null,
  finding_b_id uuid not null,
  finding_c_id uuid not null,
  round_id uuid
) on commit drop;
insert into pg_temp.review_security_context(
  case_name, workspace_id, admin_id, member_a_id, member_b_id,
  document_id, base_version_id, finding_a_id, finding_b_id, finding_c_id
)
select c.case_name, f.workspace_id, f.admin_id, f.member_a_id, f.member_b_id,
  f.document_id, f.version_id, f.finding_a_id, f.finding_b_id, f.finding_c_id
from pg_temp.review_security_workspaces c
join pg_temp.review_fixture_case f on f.workspace_id = c.workspace_id;

do $$
declare
  v_workspace_id uuid;
  v_member_c_id uuid := gen_random_uuid();
  v_qa_id uuid := gen_random_uuid();
begin
  select workspace_id into strict v_workspace_id
  from pg_temp.review_security_context where case_name = 'a';
  insert into auth.users(id, email, aud, role) values
    (v_member_c_id, 'review-owner-' || v_member_c_id::text || '@example.test', 'authenticated', 'authenticated'),
    (v_qa_id, 'review-qa-' || v_qa_id::text || '@example.test', 'authenticated', 'authenticated');
  insert into public.profiles(id, workspace_id, role, full_name, email) values
    (v_member_c_id, v_workspace_id, 'Member', 'Unassigned document owner', 'review-owner-' || v_member_c_id::text || '@example.test'),
    (v_qa_id, v_workspace_id, 'QA Lead', 'Review QA lead', 'review-qa-' || v_qa_id::text || '@example.test');
  update pg_temp.review_security_context
  set member_c_id = v_member_c_id, qa_id = v_qa_id
  where case_name = 'a';
  update public.documents set owner_id = v_member_c_id
  where id = (select document_id from pg_temp.review_security_context where case_name = 'a');
end;
$$;

update pg_temp.review_security_context c
set round_id = pg_temp.create_review_round(c.workspace_id, 'assigned_findings',
  ARRAY[c.finding_a_id, c.finding_b_id, c.finding_c_id])
where c.case_name = 'a';

create temporary table review_security_items(
  finding_key text primary key,
  item_id uuid not null
) on commit drop;
insert into pg_temp.review_security_items
select case when i.finding_id = c.finding_a_id then 'a'
       when i.finding_id = c.finding_b_id then 'b' else 'c' end,
  i.id
from pg_temp.review_security_context c
join public.correction_round_items i on i.round_id = c.round_id
where c.case_name = 'a';

create temporary table review_security_submissions(
  submission_name text primary key,
  submission_id uuid not null,
  version_id uuid
) on commit drop;
insert into pg_temp.review_security_submissions(submission_name, submission_id)
values ('member_a_original', pg_temp.create_review_submission(
  (select round_id from pg_temp.review_security_context where case_name = 'a'),
  (select member_a_id from pg_temp.review_security_context where case_name = 'a'),
  ARRAY[(select item_id from pg_temp.review_security_items where finding_key = 'a')]
));
insert into pg_temp.review_security_submissions(submission_name, submission_id)
values ('member_a_current', pg_temp.create_review_submission(
  (select round_id from pg_temp.review_security_context where case_name = 'a'),
  (select member_a_id from pg_temp.review_security_context where case_name = 'a'),
  ARRAY[(select item_id from pg_temp.review_security_items where finding_key = 'c')]
));
insert into pg_temp.review_security_submissions(submission_name, submission_id)
values ('member_b_original', pg_temp.create_review_submission(
  (select round_id from pg_temp.review_security_context where case_name = 'a'),
  (select member_b_id from pg_temp.review_security_context where case_name = 'a'),
  ARRAY[(select item_id from pg_temp.review_security_items where finding_key = 'b')]
));
update pg_temp.review_security_submissions x set version_id = s.version_id
from public.correction_submissions s where s.id = x.submission_id;

insert into storage.objects(bucket_id, name)
select 'documents', v.storage_path
from public.document_versions v
join pg_temp.review_security_context c on c.workspace_id = v.workspace_id
where c.case_name in ('a', 'b')
on conflict do nothing;

grant select on pg_temp.review_security_context, pg_temp.review_security_items,
  pg_temp.review_security_submissions to authenticated;
select is((select s.state::text from public.correction_submissions s
  where s.id = (select submission_id from pg_temp.review_security_submissions where submission_name = 'member_a_original')),
  'confirmed', 'Fixture submission is confirmed before member authorization checks');
select is((select i.current_submission_id from public.correction_round_items i
  where i.id = (select item_id from pg_temp.review_security_items where finding_key = 'a')),
  (select submission_id from pg_temp.review_security_submissions where submission_name = 'member_a_original'),
  'Fixture item points at the own confirmed submission');
select is((select si.expected_revision from public.correction_submission_items si
  where si.submission_id = (select submission_id from pg_temp.review_security_submissions where submission_name = 'member_a_original')),
  (select revision from public.correction_round_items i
   where i.id = (select item_id from pg_temp.review_security_items where finding_key = 'a')),
  'Fixture submission snapshot matches the current item revision');

set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', (select member_a_id::text from pg_temp.review_security_context where case_name = 'a'),
  'role', 'authenticated',
  'app_metadata', jsonb_build_object('role', 'Admin',
    'workspace_id', (select workspace_id::text from pg_temp.review_security_context where case_name = 'b'))
)::text, true);
select is((select count(*)::integer from public.findings f
  where f.id in (
    select finding_a_id from pg_temp.review_security_context where case_name = 'a'
    union all select finding_c_id from pg_temp.review_security_context where case_name = 'a'
  )), 2, 'Member reads current assigned findings in the completed analysis');
select is((select count(*)::integer from public.finding_evidence e
  where e.finding_id in (
    select finding_a_id from pg_temp.review_security_context where case_name = 'a'
    union all select finding_c_id from pg_temp.review_security_context where case_name = 'a'
  )), 2, 'Member reads exact evidence snapshots for assigned findings');
select is((select count(*)::integer from public.findings f
  where f.id = (select finding_b_id from pg_temp.review_security_context where case_name = 'a')),
  0, 'A Member cannot read another Member finding in the same document');
select ok(private.current_review_finding_allowed(
  (select finding_a_id from pg_temp.review_security_context where case_name = 'a')),
  'Persisted assignment authorizes the matching finding capability');
select ok(private.current_review_item_allowed(
  (select item_id from pg_temp.review_security_items where finding_key = 'a')),
  'Current round item capability is scoped to its assigned Member');
select is((select count(*)::integer from public.correction_submission_items si
  where si.submission_id = (select submission_id from pg_temp.review_security_submissions where submission_name = 'member_a_original')),
  1, 'Own submission item is visible when the item remains current');
select ok(not private.current_review_finding_allowed(
  (select finding_b_id from pg_temp.review_security_context where case_name = 'a')),
  'A forged role or workspace in JWT metadata does not grant a peer finding');
select ok(private.current_review_submission_allowed(
  (select submission_id from pg_temp.review_security_submissions where submission_name = 'member_a_original')),
  'Member can access an own confirmed submission while its item is current');
select ok(not private.current_review_submission_allowed(
  (select submission_id from pg_temp.review_security_submissions where submission_name = 'member_b_original')),
  'Member cannot access a peer submission');
select ok(private.current_review_version_allowed(
  (select base_version_id from pg_temp.review_security_context where case_name = 'a')),
  'Related active original is authorized for a current assignee');
select ok(private.current_review_version_allowed(
  (select version_id from pg_temp.review_security_submissions where submission_name = 'member_a_original')),
  'Member can access an own confirmed submission version with current permission');
select ok(not private.current_review_version_allowed(
  (select version_id from pg_temp.review_security_submissions where submission_name = 'member_b_original')),
  'A foreign submission version is denied even when its UUID is known');
select is((select count(*)::integer from public.correction_round_items i
  where i.round_id = (select round_id from pg_temp.review_security_context where case_name = 'a')),
  2, 'Member sees only their current round items');
select is((select count(*)::integer from public.correction_rounds
  where id = (select round_id from pg_temp.review_security_context where case_name = 'a')),
  1, 'Member can see a round only while it contains current assigned work');
select is((select count(*)::integer from public.correction_submissions), 2,
  'Member sees only own current submissions');
select is((select count(*)::integer from public.correction_submission_items), 2,
  'Member sees only links for currently assigned items');
select is((select count(*)::integer from public.correction_candidates), 0,
  'Members cannot see global candidate state');
select is((select count(*)::integer from public.correction_candidate_items), 0,
  'Members cannot see other contributors or candidate coverage');
select is((select count(*)::integer from public.document_versions), 0,
  'A review capability does not grant direct Repository version access');
select is((select count(*)::integer from public.documents), 0,
  'A review capability does not grant direct Repository document access');
select is((select count(*)::integer from public.repository_documents), 0,
  'Member cannot read the global Repository projection');
select is((select count(*)::integer from public.analysis_documents), 0,
  'Member cannot read analysis scope');
select is((select count(*)::integer from public.document_chunks), 0,
  'Member cannot read global chunks');
select is((select count(*)::integer from storage.objects where bucket_id = 'documents'), 0,
  'Member cannot list or download Storage originals through the S1 policy');
select throws_ok($$select private_reason from public.correction_candidate_decisions$$,
  '42501', null, 'Private candidate reasons are not exposed by direct table grants');
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', (select member_c_id::text from pg_temp.review_security_context where case_name = 'a'),
  'role', 'authenticated',
  'app_metadata', jsonb_build_object('role', 'Admin')
)::text, true);
select ok(not private.current_review_finding_allowed(
  (select finding_a_id from pg_temp.review_security_context where case_name = 'a')),
  'Document owner metadata does not authorize an unassigned finding');
select ok(not private.current_review_version_allowed(
  (select base_version_id from pg_temp.review_security_context where case_name = 'a')),
  'Document owner metadata does not authorize an active original');
select is((select count(*)::integer from public.documents), 0,
  'Owner metadata does not open the global Repository');
select is((select count(*)::integer from storage.objects where bucket_id = 'documents'), 0,
  'Owner metadata does not grant original Storage reads');
reset role;

update public.findings
set assignee_id = (select member_b_id from pg_temp.review_security_context where case_name = 'a')
where id = (select finding_a_id from pg_temp.review_security_context where case_name = 'a');
update public.correction_round_items
set assignee_id = (select member_b_id from pg_temp.review_security_context where case_name = 'a'),
    revision = revision + 1, current_submission_id = null
where id = (select item_id from pg_temp.review_security_items where finding_key = 'a');
insert into pg_temp.review_security_submissions(submission_name, submission_id)
values ('member_b_current', pg_temp.create_review_submission(
  (select round_id from pg_temp.review_security_context where case_name = 'a'),
  (select member_b_id from pg_temp.review_security_context where case_name = 'a'),
  ARRAY[
    (select item_id from pg_temp.review_security_items where finding_key = 'a'),
    (select item_id from pg_temp.review_security_items where finding_key = 'b')
  ]
));
update pg_temp.review_security_submissions x set version_id = s.version_id
from public.correction_submissions s where s.id = x.submission_id;

set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', (select member_a_id::text from pg_temp.review_security_context where case_name = 'a'),
  'role', 'authenticated'
)::text, true);
select is((select count(*)::integer from public.findings f
  where f.id = (select finding_a_id from pg_temp.review_security_context where case_name = 'a')),
  0, 'Reassignment revokes the previous Member finding immediately');
select ok(not private.current_review_submission_allowed(
  (select submission_id from pg_temp.review_security_submissions where submission_name = 'member_a_original')),
  'Reassignment revokes the old Member submission capability');
select ok(not private.current_review_version_allowed(
  (select version_id from pg_temp.review_security_submissions where submission_name = 'member_a_original')),
  'A historical own submission does not restore access after reassignment');
select is((select count(*)::integer from public.correction_submissions), 1,
  'Only the still-current own submission remains visible after reassignment');
select is((select count(*)::integer from public.correction_submission_items), 1,
  'A stale submission item link does not restore finding access');
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', (select member_b_id::text from pg_temp.review_security_context where case_name = 'a'),
  'role', 'authenticated'
)::text, true);
select is((select count(*)::integer from public.findings f
  where f.id in (
    select finding_a_id from pg_temp.review_security_context where case_name = 'a'
    union all select finding_b_id from pg_temp.review_security_context where case_name = 'a'
  )), 2, 'The new persisted assignee can read their current findings');
select is((select count(*)::integer from public.correction_submissions), 1,
  'The new assignee sees only the current grouped submission');
select is((select count(*)::integer from public.correction_submission_items), 2,
  'A grouped file cannot reveal an item no longer assigned to its submitter');
reset role;

create temporary table review_security_candidates(
  candidate_name text primary key,
  candidate_id uuid not null,
  version_id uuid
) on commit drop;
update public.correction_rounds
set status = 'consolidating', revision = revision + 1
where id = (select round_id from pg_temp.review_security_context where case_name = 'a');
insert into pg_temp.review_security_candidates(candidate_name, candidate_id)
select 'failed', pg_temp.create_consolidated_candidate(c.round_id, c.admin_id)
from pg_temp.review_security_context c where c.case_name = 'a';
update pg_temp.review_security_candidates x
set version_id = c.version_id from public.correction_candidates c where c.id = x.candidate_id;
select pg_temp.select_review_candidate(
  (select candidate_id from pg_temp.review_security_candidates where candidate_name = 'failed')
);
select pg_temp.fail_review_candidate(
  (select candidate_id from pg_temp.review_security_candidates where candidate_name = 'failed')
);
create temporary table review_security_returns(return_id uuid not null) on commit drop;
insert into pg_temp.review_security_returns
select pg_temp.return_failed_review_item(
  (select candidate_id from pg_temp.review_security_candidates where candidate_name = 'failed'),
  (select item_id from pg_temp.review_security_items where finding_key = 'b'),
  'Update the assigned release procedure.'
);
grant select on pg_temp.review_security_candidates to authenticated;
grant select on pg_temp.review_security_returns to authenticated;

set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', (select member_a_id::text from pg_temp.review_security_context where case_name = 'a'),
  'role', 'authenticated'
)::text, true);
select is((select count(*)::integer from public.correction_returns), 0,
  'A Member cannot see returns addressed to a peer');
select is((select count(*)::integer from public.correction_return_items), 0,
  'A Member cannot read a peer return reason');
select is((select count(*)::integer from public.correction_candidate_decisions), 0,
  'A Member cannot see private candidate decisions');
select ok(not private.current_review_version_allowed(
  (select version_id from pg_temp.review_security_candidates where candidate_name = 'failed')),
  'A consolidated candidate file is never a Member-accessible version');
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', (select member_b_id::text from pg_temp.review_security_context where case_name = 'a'),
  'role', 'authenticated'
)::text, true);
select is((select count(*)::integer from public.correction_returns), 1,
  'A Member sees a return that contains their current assignment');
select is((select count(*)::integer from public.correction_return_items), 1,
  'A return reason is visible only to its current recipient');
select is((select reason from public.correction_return_items limit 1),
  'Update the assigned release procedure.', 'The recipient can read their own return reason');
select throws_ok($$select previous_submission_id from public.correction_return_items$$,
  '42501', null, 'A return does not expose the previous file reference');
select is((select count(*)::integer from public.correction_candidate_decisions), 0,
  'A returned item does not expose the private candidate reason');
reset role;

insert into pg_temp.review_security_submissions(submission_name, submission_id)
values ('member_b_resubmitted', pg_temp.create_review_submission(
  (select round_id from pg_temp.review_security_context where case_name = 'a'),
  (select member_b_id from pg_temp.review_security_context where case_name = 'a'),
  ARRAY[(select item_id from pg_temp.review_security_items where finding_key = 'b')]
));
update pg_temp.review_security_submissions x set version_id = s.version_id
from public.correction_submissions s where s.id = x.submission_id;
update public.correction_rounds
set status = 'consolidating', revision = revision + 1
where id = (select round_id from pg_temp.review_security_context where case_name = 'a');
insert into pg_temp.review_security_candidates(candidate_name, candidate_id)
select 'approved', pg_temp.create_consolidated_candidate(c.round_id, c.admin_id)
from pg_temp.review_security_context c where c.case_name = 'a';
update pg_temp.review_security_candidates x
set version_id = c.version_id from public.correction_candidates c where c.id = x.candidate_id;
select pg_temp.select_review_candidate(
  (select candidate_id from pg_temp.review_security_candidates where candidate_name = 'approved')
);
select pg_temp.complete_review_candidate(
  (select candidate_id from pg_temp.review_security_candidates where candidate_name = 'approved')
);
insert into public.correction_candidate_decisions(
  workspace_id, round_id, document_id, candidate_id, actor_id, outcome, retention
)
select c.workspace_id, c.round_id, c.document_id, c.id, c.selected_by, 'approved', 'retain'
from public.correction_candidates c
where c.id = (select candidate_id from pg_temp.review_security_candidates where candidate_name = 'approved');
insert into public.correction_approval_contributions(
  approval_id, document_id, workspace_id, contributor_id, own_item_count
)
select d.id, d.document_id, d.workspace_id, si.assignee_at_submit_id, count(*)::integer
from public.correction_candidate_decisions d
join public.correction_candidates c on c.id = d.candidate_id
join public.correction_candidate_items ci on ci.candidate_id = c.id
join public.correction_submission_items si
  on si.submission_id = ci.submission_id and si.round_item_id = ci.round_item_id
where c.id = (select candidate_id from pg_temp.review_security_candidates where candidate_name = 'approved')
group by d.id, d.document_id, d.workspace_id, si.assignee_at_submit_id;
update public.document_versions
set version_status = 'historical'
where id = (select base_version_id from pg_temp.review_security_context where case_name = 'a');
update public.document_versions
set version_status = 'active'
where id = (select version_id from pg_temp.review_security_candidates where candidate_name = 'approved');
update public.documents
set active_version_id = (select version_id from pg_temp.review_security_candidates where candidate_name = 'approved')
where id = (select document_id from pg_temp.review_security_context where case_name = 'a');
update public.correction_candidates
set status = 'approved', revision = revision + 1
where id = (select candidate_id from pg_temp.review_security_candidates where candidate_name = 'approved');
update public.correction_rounds
set status = 'approved', revision = revision + 1
where id = (select round_id from pg_temp.review_security_context where case_name = 'a');

set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', (select member_a_id::text from pg_temp.review_security_context where case_name = 'a'),
  'role', 'authenticated'
)::text, true);
select is((select count(*)::integer from public.correction_approval_contributions), 1,
  'A Member recovers only their own minimal approval contribution');
select is((select own_item_count from public.correction_approval_contributions limit 1),
  1, 'The own contribution reports the number of items without names or files');
select throws_ok($$select document_id from public.correction_approval_contributions$$,
  '42501', null, 'A minimal approval contribution does not expose document identity');
select ok(private.current_review_version_allowed(
  (select version_id from pg_temp.review_security_candidates where candidate_name = 'approved')),
  'The new active version remains available while a related assignment is current');
select ok(not private.current_review_version_allowed(
  (select base_version_id from pg_temp.review_security_context where case_name = 'a')),
  'An approved switch revokes the previous historical original');
select is((select count(*)::integer from public.finding_evidence e
  where e.finding_id = (select finding_c_id from pg_temp.review_security_context where case_name = 'a')
    and e.version_id = (select base_version_id from pg_temp.review_security_context where case_name = 'a')),
  1, 'A current assignee retains the exact historical evidence snapshot without file access');
select ok(not private.current_review_version_allowed(
  (select base_version_id from pg_temp.review_security_context where case_name = 'b')),
  'A known active version from another workspace is denied');
select is((select count(*)::integer from public.correction_submissions), 0,
  'Finalized workflow history does not restore prior submission files');
select is((select count(*)::integer from public.document_versions), 0,
  'Even an allowed version capability does not expose the global versions table');
select is((select count(*)::integer from public.repository_documents), 0,
  'The approved assignment does not open the global Repository projection');
reset role;

update public.findings
set assignee_id = (select member_b_id from pg_temp.review_security_context where case_name = 'a')
where id = (select finding_c_id from pg_temp.review_security_context where case_name = 'a');
update public.findings set status = 'resolved'
where id = (select finding_c_id from pg_temp.review_security_context where case_name = 'a');
set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', (select member_a_id::text from pg_temp.review_security_context where case_name = 'a'),
  'role', 'authenticated'
)::text, true);
select ok(not private.current_review_finding_allowed(
  (select finding_c_id from pg_temp.review_security_context where case_name = 'a')),
  'Reassignment and resolved state revoke the former finding capability');
select ok(not private.current_review_version_allowed(
  (select version_id from pg_temp.review_security_candidates where candidate_name = 'approved')),
  'Losing every related assignment revokes the new active original');
select is((select count(*)::integer from public.correction_approval_contributions), 1,
  'The approved contribution remains available after assignment is lost');
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', (select member_c_id::text from pg_temp.review_security_context where case_name = 'a'),
  'role', 'authenticated',
  'app_metadata', jsonb_build_object('role', 'Admin')
)::text, true);
select ok(not private.current_review_finding_allowed(
  (select finding_a_id from pg_temp.review_security_context where case_name = 'a')),
  'Being the document owner does not authorize finding access');
select is((select count(*)::integer from public.documents), 0,
  'Document ownership does not grant Repository access');
select is((select count(*)::integer from storage.objects where bucket_id = 'documents'), 0,
  'Document ownership does not grant Storage reads');
reset role;

set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', (select admin_id::text from pg_temp.review_security_context where case_name = 'a'),
  'role', 'authenticated'
)::text, true);
select is((select count(*)::integer from public.correction_candidates), 2,
  'Workspace Admin can review candidate history in their tenant');
select is((select count(*)::integer from public.correction_candidate_decisions), 2,
  'Workspace Admin can read decisions in their tenant');
select is((select count(*)::integer from public.correction_approval_contributions), 2,
  'Workspace Admin can read all approval contributions in their tenant');
select is((select count(*)::integer from public.correction_return_items), 1,
  'Workspace Admin can read return reasons in their tenant');
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', (select qa_id::text from pg_temp.review_security_context where case_name = 'a'),
  'role', 'authenticated'
)::text, true);
select is((select count(*)::integer from public.correction_candidates), 2,
  'Workspace QA Lead has the same review read scope as Admin');
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', (select member_a_id::text from pg_temp.review_security_context where case_name = 'b'),
  'role', 'authenticated'
)::text, true);
select is((select count(*)::integer from public.correction_candidates), 0,
  'A Member in another tenant cannot read candidates by known UUID');
select is((select count(*)::integer from public.correction_returns), 0,
  'A Member in another tenant cannot read return history');
reset role;

set local role anon;
select throws_ok($$select private.current_review_finding_allowed(gen_random_uuid())$$,
  '42501', null, 'Anonymous callers cannot invoke Member capability helpers');
reset role;
select ok(not has_function_privilege('anon', 'private.current_review_finding_allowed(uuid)', 'EXECUTE'),
  'Anonymous callers cannot probe assignment capabilities');
select ok(not has_table_privilege('authenticated', 'public.correction_rounds', 'INSERT'),
  'Authenticated clients cannot insert correction rounds directly');
select ok(not has_table_privilege('authenticated', 'public.correction_candidates', 'UPDATE'),
  'Authenticated clients cannot select or mutate candidates directly');
select ok(not has_table_privilege('authenticated', 'public.correction_return_items', 'INSERT'),
  'Authenticated clients cannot write private return reasons directly');

select * from finish();
rollback;
