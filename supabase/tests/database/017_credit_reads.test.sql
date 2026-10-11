begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
\ir analysis-fixtures.psql
\ir credit-fixtures.psql
select no_plan();

create temporary table credit_read_workspace (
  name text primary key,
  workspace_id uuid not null,
  admin_id uuid
) on commit drop;
insert into pg_temp.credit_read_workspace(name, workspace_id) values
  ('a', pg_temp.create_credit_workspace()),
  ('b', pg_temp.create_credit_workspace());
update pg_temp.credit_read_workspace w
set admin_id = c.user_id
from pg_temp.credit_workspace c
where c.workspace_id = w.workspace_id;

create temporary table credit_read_user (
  name text primary key,
  workspace_name text,
  user_id uuid not null,
  role public.workspace_role not null
) on commit drop;
insert into pg_temp.credit_read_user(name, workspace_name, user_id, role) values
  ('qa_a', 'a', gen_random_uuid(), 'QA Lead'),
  ('member_a', 'a', gen_random_uuid(), 'Member'),
  ('unassigned', null, gen_random_uuid(), 'Member');
insert into auth.users(id, email, aud, role)
select user_id, 'kdm-' || user_id::text || '@example.test', 'authenticated', 'authenticated'
from pg_temp.credit_read_user;
insert into public.profiles(id, workspace_id, role, full_name, email)
select u.user_id, w.workspace_id, u.role, 'Synthetic read user',
       'kdm-' || u.user_id::text || '@example.test'
from pg_temp.credit_read_user u
join pg_temp.credit_read_workspace w on w.name = u.workspace_name
where u.workspace_name is not null;

select private.grant_promotional_credits(workspace_id)
from pg_temp.credit_read_workspace;

create temporary table credit_read_analysis (
  name text primary key,
  workspace_id uuid not null,
  analysis_id uuid not null
) on commit drop;
insert into pg_temp.credit_read_analysis(name, workspace_id, analysis_id)
select 'first', w.workspace_id,
       pg_temp.create_credit_analysis(w.workspace_id, 3)
from pg_temp.credit_read_workspace w where w.name = 'a';
select private.reserve_analysis_credits(analysis_id, 3)
from pg_temp.credit_read_analysis where name = 'first';
update public.analyses set status = 'completed'
where id = (select analysis_id from pg_temp.credit_read_analysis where name = 'first');
select private.settle_analysis_credits(analysis_id, 3, 'Consumed')
from pg_temp.credit_read_analysis where name = 'first';

insert into pg_temp.credit_read_analysis(name, workspace_id, analysis_id)
select 'second', w.workspace_id,
       pg_temp.create_credit_analysis(w.workspace_id, 2)
from pg_temp.credit_read_workspace w where w.name = 'a';
select private.reserve_analysis_credits(analysis_id, 2)
from pg_temp.credit_read_analysis where name = 'second';
update public.analyses set status = 'completed'
where id = (select analysis_id from pg_temp.credit_read_analysis where name = 'second');
select private.settle_analysis_credits(analysis_id, 2, 'Consumed')
from pg_temp.credit_read_analysis where name = 'second';
update public.credit_ledger set created_at = '2026-10-10 12:00:00+00'
where workspace_id = (select workspace_id from pg_temp.credit_read_workspace where name = 'a');

create function pg_temp.credit_ledger_ids(p_page bigint, p_page_size integer)
returns text language plpgsql set search_path = '' as $$
declare
  v_result jsonb;
  v_ids text;
begin
  execute 'select public.list_credit_ledger($1, $2)'
    into v_result using p_page, p_page_size;
  select coalesce(string_agg(e.value ->> 'id', ',' order by e.ordinality), '')
    into v_ids
  from pg_catalog.jsonb_array_elements(v_result -> 'items') with ordinality as e(value, ordinality);
  return v_ids;
end;
$$;

create function pg_temp.credit_ledger_summary(p_page bigint, p_page_size integer)
returns text language plpgsql set search_path = '' as $$
declare
  v_result jsonb;
begin
  execute 'select public.list_credit_ledger($1, $2)'
    into v_result using p_page, p_page_size;
  return pg_catalog.jsonb_array_length(v_result -> 'items')::text
    || '|' || (v_result ->> 'total')
    || '|' || (v_result ->> 'page')
    || '|' || (v_result ->> 'pageSize');
end;
$$;

grant select on pg_temp.credit_read_workspace, pg_temp.credit_read_user,
  pg_temp.credit_workspace, pg_temp.credit_read_analysis to authenticated;

set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', (select admin_id from pg_temp.credit_read_workspace where name = 'a'),
  'role', 'authenticated')::text, true);
select lives_ok($$select pg_temp.expect_text(
  'select (public.get_credit_snapshot()->>''available'') || ''|'' || (public.get_credit_snapshot()->>''reserved'')', '45|0')$$,
  'Admin receives the ledger-derived balance for its workspace');
select lives_ok($$select pg_temp.expect_text(
  'select jsonb_array_length(public.list_credit_ledger(1,25)->''items'')::text', '5')$$,
  'Admin receives all detailed movements');
select lives_ok(format('select pg_temp.expect_text(%L, %L)',
  'select pg_temp.credit_ledger_ids(1,25)',
  (select string_agg(id::text, ',' order by id) from public.credit_ledger
   where workspace_id = (select workspace_id from pg_temp.credit_read_workspace where name = 'a'))),
  'Equal timestamps use ascending ledger IDs');
select lives_ok($$select pg_temp.expect_text(
  'select pg_temp.credit_ledger_summary(9007199254740991::bigint,100)',
  '0|5|9007199254740991|100')$$,
  'A maximum safe page returns an empty page and retains the total');
select throws_ok($$select public.list_credit_ledger(0,25)$$,
  '22023', null, 'Page zero is rejected');
select throws_ok($$select public.list_credit_ledger(1,101)$$,
  '22023', null, 'Page size above 100 is rejected');
reset role;

set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', (select user_id from pg_temp.credit_read_user where name = 'qa_a'),
  'role', 'authenticated')::text, true);
select lives_ok($$select pg_temp.expect_text(
  'select (public.get_credit_snapshot()->>''available'') || ''|'' || (public.get_credit_snapshot()->>''reserved'')', '45|0')$$,
  'QA Lead reads the same workspace balance');
select lives_ok($$select pg_temp.expect_count(
  'select (public.list_credit_ledger(1,25)->>''total'')::integer', 5)$$,
  'QA Lead reads its workspace ledger');
reset role;

set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', (select user_id from pg_temp.credit_read_user where name = 'member_a'),
  'role', 'authenticated')::text, true);
select lives_ok($$select pg_temp.expect_text(
  'select (public.get_credit_snapshot()->>''available'') || ''|'' || (public.get_credit_snapshot()->>''reserved'')', '45|0')$$,
  'Member can read the aggregate balance');
select lives_ok($$select pg_temp.expect_count(
  'select count(*)::integer from public.credit_ledger', 0)$$,
  'Member RLS returns no detailed ledger rows');
select throws_ok($$select public.list_credit_ledger(1,25)$$,
  '42501', null, 'Member cannot call the detailed ledger RPC');
reset role;

-- Change the persisted Profile while reusing the same QA JWT.
update public.profiles set role = 'Member'
where id = (select user_id from pg_temp.credit_read_user where name = 'qa_a');
set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', (select user_id from pg_temp.credit_read_user where name = 'qa_a'),
  'role', 'authenticated')::text, true);
select throws_ok($$select public.list_credit_ledger(1,25)$$,
  '42501', null, 'A changed Profile immediately loses ledger access');
select lives_ok($$select pg_temp.expect_text(
  'select (public.get_credit_snapshot()->>''available'') || ''|'' || (public.get_credit_snapshot()->>''reserved'')', '45|0')$$,
  'A changed Profile retains aggregate balance access');
reset role;

set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', (select admin_id from pg_temp.credit_read_workspace where name = 'b'),
  'role', 'authenticated')::text, true);
select lives_ok($$select pg_temp.expect_text(
  'select (public.get_credit_snapshot()->>''available'') || ''|'' || (public.get_credit_snapshot()->>''reserved'')', '50|0')$$,
  'Workspace B receives only its own promotional balance');
select lives_ok($$select pg_temp.expect_count(
  'select (public.list_credit_ledger(1,25)->>''total'')::integer', 1)$$,
  'Workspace B sees only its own movement');
reset role;

set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', (select user_id from pg_temp.credit_read_user where name = 'unassigned'),
  'role', 'authenticated')::text, true);
select throws_ok($$select public.get_credit_snapshot()$$,
  '42501', null, 'A verified user without a Profile cannot read a balance');
reset role;

set local role anon;
select throws_ok($$select public.get_credit_snapshot()$$,
  '42501', null, 'Anonymous callers cannot read a balance');
select throws_ok($$select public.list_credit_ledger(1,25)$$,
  '42501', null, 'Anonymous callers cannot read the ledger');
reset role;

select * from finish();
rollback;
