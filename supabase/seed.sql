-- LOCAL FIXTURES ONLY. Applied after migrations by `supabase db reset --local`.
-- Not a production script or an upsert: reset the disposable local DB to replay.
begin;
create extension if not exists pgcrypto with schema extensions;

insert into auth.users (
  instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at,
  confirmation_token,email_change,email_change_token_new,recovery_token
)
select '00000000-0000-0000-0000-000000000000'::uuid,id,'authenticated','authenticated',email,
  extensions.crypt('LocalOnly-KDM-2026!',extensions.gen_salt('bf')),now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  jsonb_build_object('full_name',full_name),now(),now(),'','','',''
from (values
  ('10000000-0000-4000-8000-000000000001'::uuid,'admin.a@example.test','Admin A'),
  ('10000000-0000-4000-8000-000000000002'::uuid,'qa.a@example.test','QA Lead A'),
  ('10000000-0000-4000-8000-000000000003'::uuid,'member.a@example.test','Member A'),
  ('10000000-0000-4000-8000-000000000004'::uuid,'admin.b@example.test','Admin B')
) as fixture(id,email,full_name);

insert into auth.identities(id,user_id,provider_id,identity_data,provider,last_sign_in_at,created_at,updated_at)
select id,id,id::text,jsonb_build_object('sub',id::text,'email',email,'email_verified',true),
  'email',now(),now(),now()
from auth.users where id in (
  '10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000004'
);

insert into public.workspaces(id,name) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Workspace A'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Workspace B');
insert into public.profiles(id,workspace_id,role,full_name,email) values
  ('10000000-0000-4000-8000-000000000001','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Admin','Admin A','admin.a@example.test'),
  ('10000000-0000-4000-8000-000000000002','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','QA Lead','QA Lead A','qa.a@example.test'),
  ('10000000-0000-4000-8000-000000000003','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Member','Member A','member.a@example.test'),
  ('10000000-0000-4000-8000-000000000004','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Admin','Admin B','admin.b@example.test');

-- Member is Owner of a document to demonstrate that ownership is NOT assignment.
insert into public.documents(id,workspace_id,name,category,owner_id) values
  ('20000000-0000-4000-8000-000000000001','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Incident response','SOP','10000000-0000-4000-8000-000000000003'),
  ('20000000-0000-4000-8000-000000000002','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Engineering handbook','Engineering Guideline','10000000-0000-4000-8000-000000000002'),
  ('20000000-0000-4000-8000-000000000003','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Recovery drill','QA Process','10000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000004','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Private policy B','Policy','10000000-0000-4000-8000-000000000004');

insert into public.document_versions(id,workspace_id,document_id,version_number,storage_path,processing_status,version_status)
select v.id,d.workspace_id,d.id,1,
  d.workspace_id::text || '/' || d.id::text || '/' || v.id::text || '/original.md',
  v.processing_status::public.processing_status,v.version_status::public.version_status
from (values
  ('30000000-0000-4000-8000-000000000001'::uuid,'20000000-0000-4000-8000-000000000001'::uuid,'ready','active'),
  ('30000000-0000-4000-8000-000000000002'::uuid,'20000000-0000-4000-8000-000000000002'::uuid,'processing',null),
  ('30000000-0000-4000-8000-000000000003'::uuid,'20000000-0000-4000-8000-000000000003'::uuid,'processing_failed',null),
  ('30000000-0000-4000-8000-000000000004'::uuid,'20000000-0000-4000-8000-000000000004'::uuid,'ready','active')
) as v(id,document_id,processing_status,version_status)
join public.documents d on d.id = v.document_id;

insert into public.document_chunks(id,workspace_id,version_id,chunk_index,text_content,page_number,section_heading,embedding)
select c.id,v.workspace_id,v.id,c.chunk_index,c.text_content,null,c.heading,
  (case when c.chunk_index = 0 then '[1,' || repeat('0,',382) || '0]'
    else '[0,1,' || repeat('0,',381) || '0]' end)::extensions.vector(384)
from (values
  ('40000000-0000-4000-8000-000000000001'::uuid,'30000000-0000-4000-8000-000000000001'::uuid,0,
    'The on-call engineer records the incident and assigns its initial severity.','Triage'),
  ('40000000-0000-4000-8000-000000000002'::uuid,'30000000-0000-4000-8000-000000000001'::uuid,1,
    'The incident lead posts a status update every thirty minutes until recovery.','Communication'),
  ('40000000-0000-4000-8000-000000000003'::uuid,'30000000-0000-4000-8000-000000000004'::uuid,0,
    'Only Workspace B staff may read this synthetic tenant isolation fixture.','Private policy B')
) as c(id,version_id,chunk_index,text_content,heading)
join public.document_versions v on v.id = c.version_id;

update public.documents d set active_version_id = v.id
from public.document_versions v where v.document_id = d.id and v.version_status = 'active';
commit;
