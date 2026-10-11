begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
\ir analysis-fixtures.psql
\ir credit-fixtures.psql
select no_plan();

insert into auth.users(id, email, aud, role)
values ('60000000-0000-4000-8000-000000000001', 'bootstrap-promo@example.test', 'authenticated', 'authenticated');
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"60000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok($$select public.bootstrap_workspace('Promotion workspace', 'Promotion Admin')$$,
  'Bootstrap creates the workspace and its promotion');
select is((select count(*)::integer
  from public.credit_ledger l join public.profiles p on p.workspace_id = l.workspace_id
  where p.id = auth.uid() and l.event_type = 'Promotional'), 1,
  'Bootstrap stores one promotional movement');
select is((select amount from public.credit_ledger l
  join public.profiles p on p.workspace_id = l.workspace_id
  where p.id = auth.uid() and l.event_type = 'Promotional'), 50,
  'Bootstrap grants exactly fifty credits');
select throws_ok($$select public.bootstrap_workspace('Second workspace', 'Promotion Admin')$$,
  '23505', null, 'A second bootstrap is rejected');
select is((select count(*)::integer
  from public.credit_ledger l join public.profiles p on p.workspace_id = l.workspace_id
  where p.id = auth.uid() and l.event_type = 'Promotional'), 1,
  'Rejected bootstrap does not duplicate its promotion');
reset role;

insert into auth.users(id, email, aud, role)
values ('60000000-0000-4000-8000-000000000002', 'bootstrap-fault@example.test', 'authenticated', 'authenticated');
create function pg_temp.fail_test_promotion() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.event_type = 'Promotional' and exists (
    select 1 from public.workspaces w
    where w.id = new.workspace_id and w.name = 'S2-02 rollback case'
  ) then
    raise exception using errcode = 'P0001', message = 'Synthetic promotion failure.';
  end if;
  return new;
end;
$$;
create trigger test_fail_promotion before insert on public.credit_ledger
for each row execute function pg_temp.fail_test_promotion();
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"60000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select public.bootstrap_workspace('S2-02 rollback case', 'Rollback Admin')$$,
  'P0001', null, 'Promotion failure aborts bootstrap');
reset role;
select is((select count(*)::integer from public.workspaces where name = 'S2-02 rollback case'), 0,
  'Promotion failure rolls back the workspace');
select is((select count(*)::integer from public.profiles
  where id = '60000000-0000-4000-8000-000000000002'), 0,
  'Promotion failure rolls back the Profile');
select ok(not exists (
  select 1 from public.credit_ledger l join public.workspaces w on w.id = l.workspace_id
  where w.name = 'S2-02 rollback case'
), 'Promotion failure leaves no ledger movement');

create function pg_temp.create_credit_workspace(p_workspace_id uuid) returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_user uuid := gen_random_uuid();
begin
  insert into auth.users(id, email, aud, role)
  values (v_user, 'kdm-' || v_user::text || '@example.test', 'authenticated', 'authenticated');
  insert into public.workspaces(id, name)
  values (p_workspace_id, 'kdm-' || v_user::text);
  insert into public.profiles(id, workspace_id, role, full_name, email)
  values (v_user, p_workspace_id, 'Admin', 'Synthetic credit admin',
          'kdm-' || v_user::text || '@example.test');
  insert into pg_temp.credit_workspace(workspace_id, user_id)
  values (p_workspace_id, v_user);
  return p_workspace_id;
end;
$$;

create temporary table promotion_case (
  name text primary key,
  workspace_id uuid not null,
  promotion_id uuid
) on commit drop;
insert into pg_temp.promotion_case(name, workspace_id) values
  ('empty', pg_temp.create_credit_workspace()),
  ('existing_50', pg_temp.create_credit_workspace()),
  ('existing_49', pg_temp.create_credit_workspace('91000000-0000-4000-8000-000000000001')),
  ('rollback_empty', pg_temp.create_credit_workspace('90000000-0000-4000-8000-000000000001'));
insert into public.credit_ledger(workspace_id, event_type, amount)
select workspace_id, 'Promotional', 50 from pg_temp.promotion_case where name = 'existing_50';
insert into public.credit_ledger(workspace_id, event_type, amount)
select workspace_id, 'Promotional', 49 from pg_temp.promotion_case where name = 'existing_49';
update pg_temp.promotion_case c
set promotion_id = l.id
from public.credit_ledger l
where l.workspace_id = c.workspace_id and l.event_type = 'Promotional';

select lives_ok(format('update pg_temp.promotion_case set promotion_id = private.grant_promotional_credits(%L::uuid) where name = ''empty''',
  (select workspace_id from pg_temp.promotion_case where name = 'empty')),
  'A workspace without history receives its promotion');
select lives_ok(format('select pg_temp.expect_text(%L, %L)',
  format('select private.grant_promotional_credits(%L::uuid)::text',
    (select workspace_id from pg_temp.promotion_case where name = 'empty')),
  (select promotion_id::text from pg_temp.promotion_case where name = 'empty')),
  'Promotion grant replay returns the original movement');
select lives_ok(format('select pg_temp.expect_text(%L, %L)',
  format('select private.grant_promotional_credits(%L::uuid)::text',
    (select workspace_id from pg_temp.promotion_case where name = 'existing_50')),
  (select promotion_id::text from pg_temp.promotion_case where name = 'existing_50')),
  'An existing fifty-credit promotion keeps its ID');
select throws_ok(format('select private.grant_promotional_credits(%L::uuid)',
  (select workspace_id from pg_temp.promotion_case where name = 'existing_49')),
  'P2002', null, 'A noncanonical promotion blocks backfill');
select is((select amount from public.credit_ledger
  where workspace_id = (select workspace_id from pg_temp.promotion_case where name = 'existing_49')
    and event_type = 'Promotional'), 49,
  'A conflicting historical promotion is never rewritten');

select throws_ok($backfill$
do $credit_backfill$
declare
  v_workspace uuid;
begin
  for v_workspace in select w.id from public.workspaces w order by w.id loop
    perform private.grant_promotional_credits(v_workspace);
  end loop;
end;
$credit_backfill$;
$backfill$, 'P2002', null, 'A conflicting workspace aborts the entire backfill block');
select is((select count(*)::integer from public.credit_ledger
  where workspace_id = (select workspace_id from pg_temp.promotion_case where name = 'rollback_empty')
    and event_type = 'Promotional'), 0,
  'A failed backfill leaves other workspaces unchanged');
select is((select count(*)::integer from public.credit_ledger
  where workspace_id = (select workspace_id from pg_temp.promotion_case where name = 'existing_50')
    and event_type = 'Promotional'), 1,
  'A failed backfill does not duplicate existing valid grants');

select * from finish();
rollback;
