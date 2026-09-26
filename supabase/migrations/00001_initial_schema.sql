-- Day-zero baseline. PostgreSQL 15+. Immutable after first shared deployment.
create schema if not exists extensions;
create extension if not exists vector with schema extensions;
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

create type public.workspace_role as enum ('Admin', 'QA Lead', 'Member');
create type public.document_category as enum ('SOP', 'Policy', 'Manual', 'QA Process', 'Security', 'Engineering Guideline', 'Other');
create type public.processing_status as enum ('uploaded', 'processing', 'ready', 'processing_failed');
create type public.version_status as enum ('active', 'historical', 'pending_approval', 'rejected');
create type public.analysis_status as enum ('pending_reanalysis', 'analyzed');

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  role public.workspace_role not null default 'Member',
  full_name text not null check (char_length(btrim(full_name)) between 1 and 120),
  email text not null check (char_length(btrim(email)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id)
);
create index profiles_workspace_idx on public.profiles(workspace_id);

-- Fixed identity; no caller-supplied user_id, workspace or editable JWT metadata.
create function private.current_workspace_id() returns uuid
language sql stable security definer set search_path = ''
as $$ select workspace_id from public.profiles where id = (select auth.uid()) $$;

create function private.current_workspace_role() returns public.workspace_role
language sql stable security definer set search_path = ''
as $$ select role from public.profiles where id = (select auth.uid()) $$;

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null default private.current_workspace_id()
    references public.workspaces(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 200),
  category public.document_category not null,
  owner_id uuid,
  active_version_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (owner_id, workspace_id) references public.profiles(id, workspace_id)
    on delete set null (owner_id)
);
create index documents_workspace_created_idx on public.documents(workspace_id, created_at desc, id);
create index documents_workspace_category_idx on public.documents(workspace_id, category);
create index documents_owner_idx on public.documents(owner_id, workspace_id);

create table public.document_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null default private.current_workspace_id(),
  document_id uuid not null,
  version_number integer not null check (version_number > 0),
  storage_path text not null unique,
  processing_status public.processing_status not null default 'uploaded',
  version_status public.version_status,
  analysis_status public.analysis_status not null default 'pending_reanalysis',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (document_id, version_number),
  unique (id, workspace_id),
  unique (id, document_id, workspace_id),
  foreign key (document_id, workspace_id) references public.documents(id, workspace_id) on delete cascade,
  constraint unprocessed_version_has_no_functional_status
    check (processing_status = 'ready' or version_status is null),
  constraint storage_path_matches_identity check (
    storage_path in (
      workspace_id::text || '/' || document_id::text || '/' || id::text || '/original.pdf',
      workspace_id::text || '/' || document_id::text || '/' || id::text || '/original.docx',
      workspace_id::text || '/' || document_id::text || '/' || id::text || '/original.md'
    )
  )
);
create unique index one_active_version_per_document on public.document_versions(document_id)
  where version_status = 'active';
create index document_versions_workspace_idx on public.document_versions(workspace_id);

alter table public.documents add constraint documents_active_version_fk
  foreign key (active_version_id, id, workspace_id)
  references public.document_versions(id, document_id, workspace_id)
  deferrable initially immediate;

create table public.document_chunks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  version_id uuid not null,
  chunk_index integer not null check (chunk_index >= 0),
  text_content text not null check (char_length(btrim(text_content)) > 0),
  page_number integer check (page_number > 0),
  section_heading text,
  embedding extensions.vector(384) not null,
  created_at timestamptz not null default now(),
  unique (version_id, chunk_index),
  foreign key (version_id, workspace_id) references public.document_versions(id, workspace_id) on delete cascade
);
create index document_chunks_workspace_idx on public.document_chunks(workspace_id);
-- No approximate vector index yet: Sprint 1 searches names, not embeddings.

create function private.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
create trigger workspaces_updated before update on public.workspaces
  for each row execute function private.touch_updated_at();
create trigger profiles_updated before update on public.profiles
  for each row execute function private.touch_updated_at();
create trigger documents_updated before update on public.documents
  for each row execute function private.touch_updated_at();
create trigger document_versions_updated before update on public.document_versions
  for each row execute function private.touch_updated_at();

-- End-of-transaction check permits atomic activation in either statement order.
create function private.check_active_version() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  target_document_id uuid;
  doc public.documents;
begin
  if tg_table_name = 'documents' then
    target_document_id := coalesce(new.id, old.id);
  else
    target_document_id := coalesce(new.document_id, old.document_id);
  end if;
  select * into doc from public.documents where id = target_document_id;
  if not found then return null; end if;
  if (doc.active_version_id is not null and not exists (
    select 1 from public.document_versions v
    where v.id = doc.active_version_id and v.document_id = doc.id
      and v.workspace_id = doc.workspace_id
      and v.processing_status = 'ready' and v.version_status = 'active'
  )) or exists (
    select 1 from public.document_versions v
    where v.document_id = doc.id and v.version_status = 'active'
      and v.id is distinct from doc.active_version_id
  ) then
    raise exception 'Active version and document pointer must agree' using errcode = '23514';
  end if;
  return null;
end;
$$;
create constraint trigger documents_active_consistent after insert or update on public.documents
  deferrable initially deferred for each row execute function private.check_active_version();
create constraint trigger versions_active_consistent after insert or update or delete on public.document_versions
  deferrable initially deferred for each row execute function private.check_active_version();

alter table public.workspaces enable row level security;
alter table public.profiles enable row level security;
alter table public.documents enable row level security;
alter table public.document_versions enable row level security;
alter table public.document_chunks enable row level security;

create policy workspace_read on public.workspaces for select to authenticated
  using (id = (select private.current_workspace_id()));
create policy workspace_admin_update on public.workspaces for update to authenticated
  using (id = (select private.current_workspace_id()) and (select private.current_workspace_role()) = 'Admin')
  with check (id = (select private.current_workspace_id()) and (select private.current_workspace_role()) = 'Admin');
create policy profile_read on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (
    workspace_id = (select private.current_workspace_id())
    and (select private.current_workspace_role()) in ('Admin', 'QA Lead')
  ));
create policy document_read on public.documents for select to authenticated
  using (workspace_id = (select private.current_workspace_id())
    and (select private.current_workspace_role()) in ('Admin', 'QA Lead'));
create policy document_insert on public.documents for insert to authenticated
  with check (workspace_id = (select private.current_workspace_id())
    and (select private.current_workspace_role()) in ('Admin', 'QA Lead')
    and owner_id is not null and active_version_id is null);
create policy document_metadata_update on public.documents for update to authenticated
  using (workspace_id = (select private.current_workspace_id())
    and (select private.current_workspace_role()) in ('Admin', 'QA Lead'))
  with check (workspace_id = (select private.current_workspace_id())
    and (select private.current_workspace_role()) in ('Admin', 'QA Lead'));
create policy version_read on public.document_versions for select to authenticated
  using (workspace_id = (select private.current_workspace_id())
    and (select private.current_workspace_role()) in ('Admin', 'QA Lead'));
create policy version_reserve on public.document_versions for insert to authenticated
  with check (workspace_id = (select private.current_workspace_id())
    and (select private.current_workspace_role()) in ('Admin', 'QA Lead')
    and version_number = 1 and processing_status = 'uploaded'
    and version_status is null and analysis_status = 'pending_reanalysis'
    and exists (select 1 from public.documents d
      where d.id = document_id and d.workspace_id = document_versions.workspace_id));
create policy chunk_read on public.document_chunks for select to authenticated
  using (workspace_id = (select private.current_workspace_id())
    and (select private.current_workspace_role()) in ('Admin', 'QA Lead'));

-- Atomic bootstrap. Row lock serializes concurrent requests for the same user.
create function public.bootstrap_workspace(workspace_name text, full_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  caller_id uuid := auth.uid();
  caller_email text;
  new_workspace_id uuid;
begin
  if caller_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if workspace_name is null or char_length(btrim(workspace_name)) not between 1 and 120
    or full_name is null or char_length(btrim(full_name)) not between 1 and 120 then
    raise exception 'Invalid workspace or full name' using errcode = '22023';
  end if;
  select u.email into caller_email from auth.users u where u.id = caller_id for update;
  if not found or caller_email is null then
    raise exception 'Authenticated email user required' using errcode = '42501';
  end if;
  if exists (select 1 from public.profiles where id = caller_id) then
    raise exception 'User already belongs to a workspace' using errcode = '23505';
  end if;
  insert into public.workspaces(name) values (btrim(workspace_name)) returning id into new_workspace_id;
  insert into public.profiles(id,workspace_id,role,full_name,email)
    values (caller_id,new_workspace_id,'Admin',btrim(full_name),caller_email);
  return new_workspace_id;
end;
$$;

-- Supabase's default grants are intentionally replaced for these objects only.
revoke all on public.workspaces, public.profiles, public.documents, public.document_versions, public.document_chunks
  from public, anon, authenticated;
grant select on public.workspaces, public.profiles, public.documents, public.document_versions, public.document_chunks to authenticated;
grant update (name) on public.workspaces to authenticated;
grant insert on public.documents, public.document_versions to authenticated;
grant update (name, category, owner_id) on public.documents to authenticated;
grant all on public.workspaces, public.profiles, public.documents, public.document_versions, public.document_chunks to service_role;
revoke all on function private.current_workspace_id(), private.current_workspace_role(),
  private.touch_updated_at(), private.check_active_version() from public, anon, authenticated;
grant execute on function private.current_workspace_id(), private.current_workspace_role() to authenticated, service_role;
revoke all on function public.bootstrap_workspace(text,text) from public, anon, authenticated;
grant execute on function public.bootstrap_workspace(text,text) to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('documents','documents',false,10485760,
  array['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/markdown','text/plain','text/plain; charset=utf-8','text/markdown; charset=utf-8']);

create policy document_original_read on storage.objects for select to authenticated
  using (bucket_id = 'documents' and exists (
    select 1 from public.document_versions v where v.storage_path = name
      and v.workspace_id = (select private.current_workspace_id())
      and (select private.current_workspace_role()) in ('Admin', 'QA Lead')
  ));
create policy document_original_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'documents' and exists (
    select 1 from public.document_versions v where v.storage_path = name
      and v.workspace_id = (select private.current_workspace_id())
      and v.processing_status = 'uploaded'
      and (select private.current_workspace_role()) in ('Admin', 'QA Lead')
  ));
-- No authenticated UPDATE/DELETE Storage policy: originals are immutable.
