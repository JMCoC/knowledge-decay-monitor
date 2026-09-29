begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();
insert into auth.users(id, email, aud, role) values
 ('10000000-0000-4000-8000-000000000099','new@example.test','authenticated','authenticated');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000099","role":"authenticated"}',true);
select throws_ok($$select bootstrap_workspace('   ','New Admin')$$,'22023',null,'Whitespace workspace name rejected');
select throws_ok($$select bootstrap_workspace('New workspace',null)$$,'22023',null,'Missing full name rejected');
select is((select count(*) from workspaces),0::bigint,'Unassigned user sees no workspace');
select lives_ok($$select bootstrap_workspace('New workspace','New Admin')$$,'Authenticated user can bootstrap');
select is((select count(*) from workspaces),1::bigint,'Creator sees exactly one workspace');
select is((select role::text from profiles where id = auth.uid()),'Admin','Creator becomes Admin');
select is((select email from profiles where id = auth.uid()),'new@example.test','Email comes from Auth');
select throws_ok($$select bootstrap_workspace('Second workspace','New Admin')$$,'23505',null,'Second workspace rejected');
select is((select count(*) from workspaces),1::bigint,'Failed repeat does not create orphan workspace');
select throws_ok($$insert into workspaces(name) values ('Bypass')$$,'42501',null,'Direct workspace insert denied');
select throws_ok($$insert into profiles(id,workspace_id,role,full_name,email) values
 ('10000000-0000-4000-8000-000000000098','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Admin','Attack','attack@example.test')$$,
 '42501',null,'Direct membership insert denied');
select lives_ok($$update workspaces set name='Renamed'$$,'Admin can rename own workspace');
select is((select name from workspaces),'Renamed','Workspace rename persisted');
select set_config('request.jwt.claims','{}',true);
select throws_ok($$select bootstrap_workspace('Anonymous','Nobody')$$,'42501',null,'Missing identity rejected');
set local role anon;
select throws_ok($$select bootstrap_workspace('Anonymous','Nobody')$$,'42501',null,'Anon cannot execute bootstrap');
reset role;
select is((select count(*) from workspaces w
  join profiles p on p.workspace_id = w.id
  where p.id = '10000000-0000-4000-8000-000000000099'
    and w.name = 'Renamed'),1::bigint,'Only one new workspace was created for the test user');
select * from finish();
rollback;
