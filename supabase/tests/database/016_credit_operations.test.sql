begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
\ir analysis-fixtures.psql
\ir credit-fixtures.psql
select no_plan();

create temporary table credit_test_case (
  name text primary key,
  workspace_id uuid not null,
  analysis_id uuid,
  promotion_id uuid,
  reservation_id uuid,
  settlement_id uuid
) on commit drop;

insert into pg_temp.credit_test_case(name, workspace_id) values
  ('empty', pg_temp.create_credit_workspace()),
  ('promotion', pg_temp.create_credit_workspace()),
  ('success', pg_temp.create_credit_workspace()),
  ('consume_all', pg_temp.create_credit_workspace()),
  ('release', pg_temp.create_credit_workspace()),
  ('insufficient', pg_temp.create_credit_workspace()),
  ('no_promotion', pg_temp.create_credit_workspace()),
  ('wrong_state', pg_temp.create_credit_workspace()),
  ('no_reservation', pg_temp.create_credit_workspace()),
  ('legacy_promotion', pg_temp.create_credit_workspace()),
  ('bad_reservation', pg_temp.create_credit_workspace()),
  ('orphan_terminal', pg_temp.create_credit_workspace());

update pg_temp.credit_test_case c
set analysis_id = pg_temp.create_credit_analysis(c.workspace_id, case c.name
  when 'success' then 7 when 'consume_all' then 50 when 'release' then 5
  when 'insufficient' then 51 else 3 end,
  case when c.name in ('wrong_state', 'no_reservation') then 'completed'::public.analysis_job_status
       else 'queued'::public.analysis_job_status end)
where c.name in ('success', 'consume_all', 'release', 'insufficient', 'no_promotion', 'wrong_state', 'no_reservation');

select lives_ok(format('select private.grant_promotional_credits(%L::uuid)',
  (select workspace_id from pg_temp.credit_test_case where name = 'promotion')),
  'A workspace receives its initial promotion');
select lives_ok(format('update pg_temp.credit_test_case set promotion_id = private.grant_promotional_credits(%L::uuid) where name = ''promotion''',
  (select workspace_id from pg_temp.credit_test_case where name = 'promotion')),
  'The promotion movement ID is recorded');

-- The duplicate promotion ID check is performed without relying on row order.
select lives_ok(format(
  'select pg_temp.expect_text(%L, %L)',
  format('select private.grant_promotional_credits(%L::uuid)::text',
    (select workspace_id from pg_temp.credit_test_case where name = 'promotion')),
  (select promotion_id::text from pg_temp.credit_test_case where name = 'promotion')),
  'An identical promotion is idempotent');
select lives_ok(format('select pg_temp.expect_text(%L, %L)',
  format('select available::text || ''|'' || reserved::text from private.credit_balances(%L::uuid)',
    (select workspace_id from pg_temp.credit_test_case where name = 'empty')),
  '0|0'), 'An empty ledger has a zero balance');
select lives_ok(format('select pg_temp.expect_text(%L, %L)',
  format('select available::text || ''|'' || reserved::text from private.credit_balances(%L::uuid)',
    (select workspace_id from pg_temp.credit_test_case where name = 'promotion')),
  '50|0'), 'The promotion contributes exactly fifty available credits');
select throws_ok(format('select private.grant_promotional_credits(%L::uuid)', gen_random_uuid()),
  'P0002', null, 'Promotion rejects an unknown workspace');

-- A cost seven analysis consumes exactly seven credits and retains a replayable reservation.
select lives_ok(format('select private.grant_promotional_credits(%L::uuid)',
  (select workspace_id from pg_temp.credit_test_case where name = 'success')),
  'The success workspace is funded');
select lives_ok(format('update pg_temp.credit_test_case set promotion_id = private.grant_promotional_credits(%L::uuid) where name = ''success''',
  (select workspace_id from pg_temp.credit_test_case where name = 'success')),
  'The success promotion is recorded');
select lives_ok(format(
  'update pg_temp.credit_test_case set reservation_id = private.reserve_analysis_credits(%L::uuid, 7) where name = ''success''',
  (select analysis_id from pg_temp.credit_test_case where name = 'success')),
  'A funded queued analysis can reserve its fixed cost');
select lives_ok(format('update public.analyses set status = ''completed'' where id = %L::uuid',
  (select analysis_id from pg_temp.credit_test_case where name = 'success')),
  'The successful analysis reaches its terminal state');
select lives_ok(format(
  'update pg_temp.credit_test_case set settlement_id = private.settle_analysis_credits(%L::uuid, 7, ''Consumed'') where name = ''success''',
  (select analysis_id from pg_temp.credit_test_case where name = 'success')),
  'A completed analysis consumes its full reservation');
select lives_ok(format('select pg_temp.expect_text(%L, %L)',
  format('select available::text || ''|'' || reserved::text from private.credit_balances(%L::uuid)',
    (select workspace_id from pg_temp.credit_test_case where name = 'success')),
  '43|0'), 'Consumption leaves the exact available balance');
select lives_ok(format(
  'select pg_temp.expect_text(%L, (select settlement_id::text from pg_temp.credit_test_case where name = ''success''))',
  format('select private.settle_analysis_credits(%L::uuid, 7, ''Consumed'')::text',
    (select analysis_id from pg_temp.credit_test_case where name = 'success'))),
  'Settlement replay returns the original movement');
select lives_ok(format(
  'select pg_temp.expect_text(%L, (select reservation_id::text from pg_temp.credit_test_case where name = ''success''))',
  format('select private.reserve_analysis_credits(%L::uuid, 7)::text',
    (select analysis_id from pg_temp.credit_test_case where name = 'success'))),
  'Reservation replay returns the original movement');
select throws_ok(format('select private.reserve_analysis_credits(%L::uuid, 8)',
  (select analysis_id from pg_temp.credit_test_case where name = 'success')),
  'P2002', null, 'A different expected cost conflicts');
select throws_ok(format('select private.settle_analysis_credits(%L::uuid, 7, ''Released'')',
  (select analysis_id from pg_temp.credit_test_case where name = 'success')),
  'P2002', null, 'An opposite settlement conflicts');
select throws_ok(format('select private.settle_analysis_credits(%L::uuid, 6, ''Consumed'')',
  (select analysis_id from pg_temp.credit_test_case where name = 'success')),
  'P2002', null, 'A partial settlement conflicts');

-- Replaying a reservation after its entire balance has been consumed remains idempotent.
select lives_ok(format('select private.grant_promotional_credits(%L::uuid)',
  (select workspace_id from pg_temp.credit_test_case where name = 'consume_all')),
  'The consume-all workspace is funded');
select lives_ok(format(
  'update pg_temp.credit_test_case set reservation_id = private.reserve_analysis_credits(%L::uuid, 50) where name = ''consume_all''',
  (select analysis_id from pg_temp.credit_test_case where name = 'consume_all')),
  'The full promotion can be reserved');
select lives_ok(format('update public.analyses set status = ''completed'' where id = %L::uuid',
  (select analysis_id from pg_temp.credit_test_case where name = 'consume_all')),
  'The consume-all analysis completes');
select lives_ok(format(
  'update pg_temp.credit_test_case set settlement_id = private.settle_analysis_credits(%L::uuid, 50, ''Consumed'') where name = ''consume_all''',
  (select analysis_id from pg_temp.credit_test_case where name = 'consume_all')),
  'The full reservation is consumed');
select lives_ok(format(
  'select pg_temp.expect_text(%L, (select reservation_id::text from pg_temp.credit_test_case where name = ''consume_all''))',
  format('select private.reserve_analysis_credits(%L::uuid, 50)::text',
    (select analysis_id from pg_temp.credit_test_case where name = 'consume_all'))),
  'Reservation replay does not recheck current sufficiency');
select lives_ok(format('select pg_temp.expect_text(%L, %L)',
  format('select available::text || ''|'' || reserved::text from private.credit_balances(%L::uuid)',
    (select workspace_id from pg_temp.credit_test_case where name = 'consume_all')),
  '0|0'), 'Consuming the full promotion leaves zero credits');

-- Released reservations return all credits and can be replayed only for the same outcome.
select lives_ok(format('select private.grant_promotional_credits(%L::uuid)',
  (select workspace_id from pg_temp.credit_test_case where name = 'release')),
  'The release workspace is funded');
select lives_ok(format(
  'update pg_temp.credit_test_case set reservation_id = private.reserve_analysis_credits(%L::uuid, 5) where name = ''release''',
  (select analysis_id from pg_temp.credit_test_case where name = 'release')),
  'A failed analysis reserves its fixed cost');
select lives_ok(format('update public.analyses set status = ''failed'' where id = %L::uuid',
  (select analysis_id from pg_temp.credit_test_case where name = 'release')),
  'The failed analysis reaches its terminal state');
select lives_ok(format(
  'update pg_temp.credit_test_case set settlement_id = private.settle_analysis_credits(%L::uuid, 5, ''Released'') where name = ''release''',
  (select analysis_id from pg_temp.credit_test_case where name = 'release')),
  'A failed analysis releases its full reservation');
select lives_ok(format('select pg_temp.expect_text(%L, %L)',
  format('select available::text || ''|'' || reserved::text from private.credit_balances(%L::uuid)',
    (select workspace_id from pg_temp.credit_test_case where name = 'release')),
  '50|0'), 'Released credits return to the available balance');
select throws_ok(format('select private.settle_analysis_credits(%L::uuid, 5, ''Consumed'')',
  (select analysis_id from pg_temp.credit_test_case where name = 'release')),
  'P2002', null, 'A release cannot be changed to consumption');

select lives_ok(format('select private.grant_promotional_credits(%L::uuid)',
  (select workspace_id from pg_temp.credit_test_case where name = 'insufficient')),
  'The insufficient workspace is funded');
select throws_ok(format('select private.reserve_analysis_credits(%L::uuid, 51)',
  (select analysis_id from pg_temp.credit_test_case where name = 'insufficient')),
  'P2001', null, 'A reservation cannot overdraw the workspace');
select lives_ok(format('select pg_temp.expect_count(%L, 0)', format(
  'select count(*)::integer from public.credit_ledger where workspace_id = %L::uuid and event_type = ''Reserved''',
  (select workspace_id from pg_temp.credit_test_case where name = 'insufficient'))),
  'Insufficient balance creates no reservation');
select lives_ok(format('select pg_temp.expect_text(%L, %L)',
  format('select available::text || ''|'' || reserved::text from private.credit_balances(%L::uuid)',
    (select workspace_id from pg_temp.credit_test_case where name = 'insufficient')),
  '50|0'), 'Insufficient reservation leaves the balance unchanged');
select throws_ok(format('select private.reserve_analysis_credits(%L::uuid, 3)',
  (select analysis_id from pg_temp.credit_test_case where name = 'no_promotion')),
  'P2001', null, 'Reservation requires available credits');
select lives_ok(format('select pg_temp.expect_text(%L, %L)',
  format('select available::text || ''|'' || reserved::text from private.credit_balances(%L::uuid)',
    (select workspace_id from pg_temp.credit_test_case where name = 'no_promotion')),
  '0|0'), 'Rejected unfunded reservation leaves the balance unchanged');
select throws_ok(format('select private.reserve_analysis_credits(%L::uuid, 3)',
  (select analysis_id from pg_temp.credit_test_case where name = 'wrong_state')),
  'P2002', null, 'Only queued analyses can reserve');
select throws_ok(format('select private.settle_analysis_credits(%L::uuid, 3, ''Consumed'')',
  (select analysis_id from pg_temp.credit_test_case where name = 'no_reservation')),
  'P2002', null, 'A terminal movement requires an existing reservation');
select throws_ok(format('select private.reserve_analysis_credits(%L::uuid, 0)',
  (select analysis_id from pg_temp.credit_test_case where name = 'no_promotion')),
  '22023', null, 'Zero reservation amount is invalid');
select throws_ok(format('select private.reserve_analysis_credits(%L::uuid, null)',
  (select analysis_id from pg_temp.credit_test_case where name = 'no_promotion')),
  '22023', null, 'Null reservation amount is invalid');
select throws_ok(format('select private.reserve_analysis_credits(%L::uuid, -1)',
  (select analysis_id from pg_temp.credit_test_case where name = 'no_promotion')),
  '22023', null, 'Negative reservation amount is invalid');
select throws_ok(format('select private.reserve_analysis_credits(%L::uuid, 3)', gen_random_uuid()),
  'P0002', null, 'Unknown analysis is rejected');
select throws_ok(format('select private.settle_analysis_credits(%L::uuid, 3, ''Promotional'')',
  (select analysis_id from pg_temp.credit_test_case where name = 'no_reservation')),
  '22023', null, 'Settlement accepts only Consumed or Released');
select throws_ok(format('select private.settle_analysis_credits(%L::uuid, 3, null)',
  (select analysis_id from pg_temp.credit_test_case where name = 'no_reservation')),
  '22023', null, 'Null settlement type is invalid');
select throws_ok(format('select private.settle_analysis_credits(%L::uuid, 0, ''Consumed'')',
  (select analysis_id from pg_temp.credit_test_case where name = 'no_reservation')),
  '22023', null, 'Zero settlement amount is invalid');
select throws_ok(format('select private.settle_analysis_credits(%L::uuid, null, ''Consumed'')',
  (select analysis_id from pg_temp.credit_test_case where name = 'no_reservation')),
  '22023', null, 'Null settlement amount is invalid');
select throws_ok(format('select private.settle_analysis_credits(%L::uuid, -1, ''Consumed'')',
  (select analysis_id from pg_temp.credit_test_case where name = 'no_reservation')),
  '22023', null, 'Negative settlement amount is invalid');

-- Historical or administratively corrupted rows remain unchanged and fail closed.
insert into public.credit_ledger(workspace_id, event_type, amount)
select workspace_id, 'Promotional', 49 from pg_temp.credit_test_case where name = 'legacy_promotion';
select throws_ok(format('select private.grant_promotional_credits(%L::uuid)',
  (select workspace_id from pg_temp.credit_test_case where name = 'legacy_promotion')),
  'P2002', null, 'A noncanonical historical promotion is not rewritten');
select throws_ok(format('select * from private.credit_balances(%L::uuid)',
  (select workspace_id from pg_temp.credit_test_case where name = 'legacy_promotion')),
  'P2003', null, 'A noncanonical promotion is reported as ledger corruption');
update pg_temp.credit_test_case c
set analysis_id = pg_temp.create_credit_analysis(c.workspace_id, 3, 'completed')
where c.name = 'bad_reservation';
insert into public.credit_ledger(workspace_id, event_type, amount, analysis_id)
select workspace_id, 'Reserved', 2, analysis_id
from pg_temp.credit_test_case where name = 'bad_reservation';
select throws_ok(format('select * from private.credit_balances(%L::uuid)',
  (select workspace_id from pg_temp.credit_test_case where name = 'bad_reservation')),
  'P2003', null, 'A reservation with a different amount is ledger corruption');
update pg_temp.credit_test_case c
set analysis_id = pg_temp.create_credit_analysis(c.workspace_id, 3, 'completed')
where c.name = 'orphan_terminal';
insert into public.credit_ledger(workspace_id, event_type, amount, analysis_id)
select workspace_id, 'Consumed', 3, analysis_id
from pg_temp.credit_test_case where name = 'orphan_terminal';
select throws_ok(format('select * from private.credit_balances(%L::uuid)',
  (select workspace_id from pg_temp.credit_test_case where name = 'orphan_terminal')),
  'P2003', null, 'A terminal movement without a reservation is corruption');

select ok(not has_table_privilege('service_role', 'public.credit_ledger', 'INSERT'),
  'Service role cannot insert ledger rows directly');
select ok(not has_table_privilege('service_role', 'public.credit_ledger', 'UPDATE'),
  'Service role cannot update ledger rows');
select ok(not has_table_privilege('service_role', 'public.credit_ledger', 'DELETE'),
  'Service role cannot delete ledger rows');
select ok(not has_table_privilege('service_role', 'public.credit_ledger', 'TRUNCATE'),
  'Service role cannot truncate the ledger');
select ok(has_function_privilege('service_role', to_regprocedure('private.grant_promotional_credits(uuid)'), 'EXECUTE'),
  'Service role can grant promotion through the private function');
select ok(has_function_privilege('service_role', to_regprocedure('private.reserve_analysis_credits(uuid,integer)'), 'EXECUTE'),
  'Service role can reserve through the private function');
select ok(has_function_privilege('service_role', to_regprocedure('private.settle_analysis_credits(uuid,integer,public.credit_event_type)'), 'EXECUTE'),
  'Service role can settle through the private function');
select ok(not has_function_privilege('authenticated', to_regprocedure('private.credit_balances(uuid)'), 'EXECUTE'),
  'Authenticated callers cannot execute the internal balance helper');
select ok(not has_function_privilege('anon', to_regprocedure('private.grant_promotional_credits(uuid)'), 'EXECUTE'),
  'Anonymous callers cannot grant promotion');
select ok(not has_function_privilege('authenticated', to_regprocedure('private.reserve_analysis_credits(uuid,integer)'), 'EXECUTE'),
  'Authenticated callers cannot reserve directly');
select ok(not has_function_privilege('authenticated', to_regprocedure('private.settle_analysis_credits(uuid,integer,public.credit_event_type)'), 'EXECUTE'),
  'Authenticated callers cannot settle directly');

select * from finish();
rollback;
