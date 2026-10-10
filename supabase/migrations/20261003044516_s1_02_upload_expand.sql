-- Additive S1-02 upload lifecycle. The legacy reserve RPC and Storage policy
-- remain available until the separately reviewed cutover migration.

create type public.upload_state as enum ('pending', 'verifying', 'rejected', 'recovering', 'confirmed');
create type public.upload_hash_source as enum ('client_declared', 'legacy_reconciled');
create type public.upload_cleanup_status as enum ('pending', 'absent', 'failed');
create type public.upload_control_mode as enum ('paused', 'active');

alter table public.document_versions
  add column upload_state public.upload_state,
  add column expected_sha256 text,
  add column hash_source public.upload_hash_source,
  add column upload_initiator_id uuid,
  add column idempotency_key uuid,
  add column request_fingerprint text,
  add column current_upload_attempt_id uuid,
  add column upload_operation_id uuid,
  add column upload_lease_expires_at timestamptz,
  add column upload_confirmed_at timestamptz,
  add column reference_set_at timestamptz,
  add column reference_set_by uuid;

alter table public.document_versions
  add constraint document_versions_upload_sha256_format
    check (expected_sha256 is null or expected_sha256 ~ '^[0-9a-f]{64}$'),
  add constraint document_versions_upload_fingerprint_format
    check (request_fingerprint is null or request_fingerprint ~ '^[0-9a-f]{64}$'),
  add constraint document_versions_upload_initiator_workspace_fk
    foreign key (upload_initiator_id, workspace_id)
    references public.profiles(id, workspace_id),
  add constraint document_versions_reference_set_by_workspace_fk
    foreign key (reference_set_by, workspace_id)
    references public.profiles(id, workspace_id),
  add constraint document_versions_upload_fields_consistent check (
    (idempotency_key is null) = (request_fingerprint is null)
    and (idempotency_key is null or upload_initiator_id is not null)
    and (upload_confirmed_at is null or upload_state = 'confirmed')
    and (
      (upload_state is null and upload_operation_id is null and upload_lease_expires_at is null
        and upload_confirmed_at is null)
      or
      (upload_state is not null
        and size_bytes between 1 and 10485760
        and expected_sha256 is not null
        and hash_source is not null
        and current_upload_attempt_id is not null
        and reference_set_at is not null
        and reference_set_by is not null
        and (
          (upload_state in ('verifying', 'recovering')
            and upload_operation_id is not null and upload_lease_expires_at is not null)
          or
          (upload_state not in ('verifying', 'recovering')
            and upload_operation_id is null and upload_lease_expires_at is null)
        )
        and (
          (upload_state = 'confirmed' and upload_confirmed_at is not null)
          or (upload_state <> 'confirmed' and upload_confirmed_at is null)
        )
      )
    )
  );

create unique index document_versions_upload_idempotency_idx
  on public.document_versions(workspace_id, upload_initiator_id, idempotency_key)
  where idempotency_key is not null;
create index document_versions_upload_state_idx
  on public.document_versions(workspace_id, upload_state, upload_lease_expires_at);

create table public.document_upload_attempts (
  id uuid primary key,
  workspace_id uuid not null,
  version_id uuid not null,
  storage_path text not null unique,
  created_at timestamptz not null default now(),
  retired_at timestamptz,
  cleanup_checked_at timestamptz,
  cleanup_status public.upload_cleanup_status not null default 'pending',
  unique (id, version_id, workspace_id),
  foreign key (version_id, workspace_id)
    references public.document_versions(id, workspace_id) on delete cascade,
  check (storage_path <> ''),
  check (retired_at is not null or cleanup_checked_at is null),
  check (cleanup_checked_at is null or retired_at is not null)
);
create index document_upload_attempts_workspace_version_idx
  on public.document_upload_attempts(workspace_id, version_id, created_at);
create index document_upload_attempts_cleanup_idx
  on public.document_upload_attempts(retired_at, cleanup_status, cleanup_checked_at)
  where retired_at is not null;

alter table public.document_versions
  add constraint document_versions_current_upload_attempt_fk
    foreign key (current_upload_attempt_id, id, workspace_id)
    references public.document_upload_attempts(id, version_id, workspace_id)
    deferrable initially deferred;

create function private.guard_document_upload_attempt_path() returns trigger
language plpgsql set search_path = '' as $$
declare
  canonical_path text;
  extension text;
  expected_path text;
begin
  if tg_op = 'UPDATE' and (
    new.id is distinct from old.id
    or new.workspace_id is distinct from old.workspace_id
    or new.version_id is distinct from old.version_id
    or new.storage_path is distinct from old.storage_path
    or new.created_at is distinct from old.created_at
  ) then
    raise exception 'Upload attempt identity and storage path are immutable' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and old.retired_at is not null and new.retired_at is null then
    raise exception 'A retired upload attempt cannot be reactivated' using errcode = '23514';
  end if;
  select v.storage_path into canonical_path from public.document_versions v
  where v.id = new.version_id and v.workspace_id = new.workspace_id;
  if not found then raise exception 'Upload version not found' using errcode = '23503'; end if;
  extension := substring(canonical_path from '\.([a-z]+)$');
  if extension not in ('pdf', 'docx', 'md') then
    raise exception 'Canonical upload path is invalid' using errcode = '23514';
  end if;
  expected_path := left(canonical_path, length(canonical_path) - length('original.' || extension))
    || 'attempts/' || new.id::text || '/original.' || extension;
  if new.storage_path is distinct from expected_path then
    raise exception 'Upload attempt path does not match its version and attempt' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger document_upload_attempt_path_guard
  before insert or update on public.document_upload_attempts
  for each row execute function private.guard_document_upload_attempt_path();

create table private.upload_control (
  singleton boolean primary key default true check (singleton),
  mode public.upload_control_mode not null default 'paused',
  updated_at timestamptz not null default now()
);
insert into private.upload_control(singleton, mode) values (true, 'paused');
revoke all on private.upload_control from public, anon, authenticated, service_role;

create function private.uploads_enabled() returns boolean
language sql stable security definer set search_path = '' set row_security = off
as $$ select coalesce((select c.mode = 'active' from private.upload_control c where c.singleton), false) $$;

create function private.authorized_document_workspace(p_user_id uuid) returns uuid
language plpgsql volatile security definer set search_path = '' set row_security = off
as $$
declare
  resolved_workspace_id uuid;
  resolved_role public.workspace_role;
begin
  if p_user_id is null then
    raise exception 'Document capability required' using errcode = '42501';
  end if;
  select p.workspace_id, p.role into resolved_workspace_id, resolved_role
  from public.profiles p where p.id = p_user_id for share;
  if not found or resolved_role not in ('Admin', 'QA Lead') then
    raise exception 'Document capability required' using errcode = '42501';
  end if;
  return resolved_workspace_id;
end;
$$;

create function private.insert_upload_attempt(
  p_workspace_id uuid, p_document_id uuid, p_version_id uuid, p_attempt_id uuid
) returns text
language plpgsql security invoker set search_path = '' as $$
declare
  canonical_path text;
  extension text;
  attempt_path text;
begin
  select v.storage_path into canonical_path from public.document_versions v
  where v.id = p_version_id and v.document_id = p_document_id and v.workspace_id = p_workspace_id;
  if not found then raise exception 'Upload version not found' using errcode = 'P0002'; end if;
  extension := substring(canonical_path from '\.([a-z]+)$');
  attempt_path := left(canonical_path, length(canonical_path) - length('original.' || extension))
    || 'attempts/' || p_attempt_id::text || '/original.' || extension;
  insert into public.document_upload_attempts(id, workspace_id, version_id, storage_path)
    values (p_attempt_id, p_workspace_id, p_version_id, attempt_path);
  return attempt_path;
end;
$$;

create function private.upload_snapshot(p_version_id uuid, p_workspace_id uuid)
returns table (
  version_id uuid, upload_state public.upload_state, attempt_id uuid,
  can_open boolean, can_resume boolean, can_recover boolean
)
language sql stable security invoker set search_path = '' as $$
  select v.id, v.upload_state, v.current_upload_attempt_id,
    v.upload_state = 'confirmed',
    v.upload_state is null or v.upload_state = 'pending',
    v.upload_state = 'rejected'
      or (v.upload_state in ('verifying', 'recovering') and v.upload_lease_expires_at <= now())
  from public.document_versions v
  where v.id = p_version_id and v.workspace_id = p_workspace_id
$$;

alter table public.document_upload_attempts enable row level security;
create policy document_upload_attempt_read on public.document_upload_attempts
  for select to authenticated
  using (workspace_id = (select private.current_workspace_id())
    and (select private.current_workspace_role()) in ('Admin', 'QA Lead'));
revoke all on public.document_upload_attempts from public, anon, authenticated;
grant select (id, workspace_id, version_id, created_at, retired_at, cleanup_checked_at, cleanup_status)
  on public.document_upload_attempts to authenticated;
grant all on public.document_upload_attempts to service_role;
revoke all on function private.guard_document_upload_attempt_path(), private.uploads_enabled(),
  private.authorized_document_workspace(uuid), private.insert_upload_attempt(uuid,uuid,uuid,uuid),
  private.upload_snapshot(uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function private.uploads_enabled() to authenticated, service_role;
grant execute on function private.authorized_document_workspace(uuid),
  private.insert_upload_attempt(uuid,uuid,uuid,uuid), private.upload_snapshot(uuid,uuid) to service_role;

create function public.reserve_document_upload(
  p_user_id uuid,
  p_idempotency_key uuid,
  p_request_fingerprint text,
  p_name text,
  p_category public.document_category,
  p_owner_id uuid,
  p_extension text,
  p_size_bytes bigint,
  p_expected_sha256 text
) returns table (
  document_id uuid, version_id uuid, attempt_id uuid, storage_path text,
  canonical_mime_type text, upload_state public.upload_state
)
language plpgsql security invoker set search_path = '' as $$
declare
  actor_workspace_id uuid;
  existing_version public.document_versions%rowtype;
  new_document_id uuid := gen_random_uuid();
  new_version_id uuid := gen_random_uuid();
  new_attempt_id uuid := gen_random_uuid();
  canonical_path text;
  transfer_path text;
begin
  actor_workspace_id := private.authorized_document_workspace(p_user_id);
  if not private.uploads_enabled() then
    raise exception 'Upload flow is paused' using errcode = '55000';
  end if;
  if p_idempotency_key is null
    or p_request_fingerprint is null or p_request_fingerprint !~ '^[0-9a-f]{64}$'
    or p_name is null or char_length(btrim(p_name)) not between 1 and 200
    or p_category is null or p_owner_id is null
    or p_extension is null or p_extension not in ('pdf', 'docx', 'md')
    or p_size_bytes is null or p_size_bytes not between 1 and 10485760
    or p_expected_sha256 is null or p_expected_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid upload reservation' using errcode = '22023';
  end if;
  if not exists (select 1 from public.profiles p
    where p.id = p_owner_id and p.workspace_id = actor_workspace_id) then
    raise exception 'Invalid upload owner' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    actor_workspace_id::text || ':' || p_user_id::text || ':' || p_idempotency_key::text, 0));
  select v.* into existing_version
  from public.document_versions v
  where v.workspace_id = actor_workspace_id
    and v.upload_initiator_id = p_user_id and v.idempotency_key = p_idempotency_key
  for update;
  if found then
    if existing_version.request_fingerprint is distinct from p_request_fingerprint then
      raise exception 'Upload idempotency key conflicts with another request' using errcode = '40001';
    end if;
    return query
      select existing_version.document_id, existing_version.id, a.id, a.storage_path,
        case when existing_version.storage_path like '%.pdf' then 'application/pdf'
          when existing_version.storage_path like '%.docx' then 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          else 'text/markdown' end,
        existing_version.upload_state
      from public.document_upload_attempts a
      where a.id = existing_version.current_upload_attempt_id;
    return;
  end if;

  canonical_path := actor_workspace_id::text || '/' || new_document_id::text || '/'
    || new_version_id::text || '/original.' || p_extension;
  transfer_path := actor_workspace_id::text || '/' || new_document_id::text || '/'
    || new_version_id::text || '/attempts/' || new_attempt_id::text || '/original.' || p_extension;
  insert into public.documents(id, workspace_id, name, category, owner_id)
    values (new_document_id, actor_workspace_id, btrim(p_name), p_category, p_owner_id);
  insert into public.document_versions(
    id, workspace_id, document_id, version_number, storage_path, size_bytes,
    upload_state, expected_sha256, hash_source, upload_initiator_id,
    idempotency_key, request_fingerprint, current_upload_attempt_id,
    reference_set_at, reference_set_by
  ) values (
    new_version_id, actor_workspace_id, new_document_id, 1, canonical_path, p_size_bytes,
    'pending', p_expected_sha256, 'client_declared', p_user_id,
    p_idempotency_key, p_request_fingerprint, new_attempt_id,
    now(), p_user_id
  );
  perform private.insert_upload_attempt(actor_workspace_id, new_document_id, new_version_id, new_attempt_id);
  return query select new_document_id, new_version_id, new_attempt_id, transfer_path,
    case when p_extension = 'pdf' then 'application/pdf'
      when p_extension = 'docx' then 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      else 'text/markdown' end,
    'pending'::public.upload_state;
end;
$$;

create function public.get_document_upload_state(p_user_id uuid, p_version_id uuid)
returns table (
  version_id uuid, upload_state public.upload_state, attempt_id uuid,
  can_open boolean, can_resume boolean, can_recover boolean
)
language plpgsql security invoker set search_path = '' as $$
declare
  actor_workspace_id uuid;
begin
  actor_workspace_id := private.authorized_document_workspace(p_user_id);
  if not exists (select 1 from public.document_versions v
    where v.id = p_version_id and v.workspace_id = actor_workspace_id) then
    raise exception 'Upload version not found' using errcode = 'P0002';
  end if;
  return query select * from private.upload_snapshot(p_version_id, actor_workspace_id);
end;
$$;

create function public.claim_upload_verification(p_user_id uuid, p_version_id uuid, p_attempt_id uuid)
returns table (
  version_id uuid, attempt_id uuid, operation_id uuid, workspace_id uuid,
  temporary_path text, canonical_path text, expected_sha256 text,
  expected_size_bytes bigint, canonical_mime_type text, upload_state public.upload_state
)
language plpgsql security invoker set search_path = '' as $$
declare
  actor_workspace_id uuid;
  v public.document_versions%rowtype;
  op_id uuid := gen_random_uuid();
begin
  actor_workspace_id := private.authorized_document_workspace(p_user_id);
  if not private.uploads_enabled() then
    raise exception 'Upload flow is paused' using errcode = '55000';
  end if;
  select x.* into v from public.document_versions x
  where x.id = p_version_id and x.workspace_id = actor_workspace_id for update;
  if not found then raise exception 'Upload version not found' using errcode = 'P0002'; end if;
  if v.upload_state = 'confirmed' then
    return query select v.id, v.current_upload_attempt_id, null::uuid, v.workspace_id,
      a.storage_path, v.storage_path, v.expected_sha256, v.size_bytes,
      case when v.storage_path like '%.pdf' then 'application/pdf'
        when v.storage_path like '%.docx' then 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        else 'text/markdown' end,
      v.upload_state
    from public.document_upload_attempts a where a.id = v.current_upload_attempt_id;
    return;
  end if;
  if v.upload_state <> 'pending' and not
      (v.upload_state = 'verifying' and v.upload_lease_expires_at <= now()) then
    raise exception 'Upload state cannot be verified' using errcode = '40001';
  end if;
  if v.current_upload_attempt_id is distinct from p_attempt_id or not exists (
    select 1 from public.document_upload_attempts a
    where a.id = p_attempt_id and a.version_id = v.id and a.workspace_id = v.workspace_id
      and a.retired_at is null
  ) then
    raise exception 'Upload attempt is no longer current' using errcode = '40001';
  end if;
  update public.document_versions x set upload_state = 'verifying', upload_operation_id = op_id,
    upload_lease_expires_at = now() + interval '120 seconds'
  where x.id = v.id and x.workspace_id = actor_workspace_id;
  return query select v.id, p_attempt_id, op_id, v.workspace_id, a.storage_path, v.storage_path,
    v.expected_sha256, v.size_bytes,
    case when v.storage_path like '%.pdf' then 'application/pdf'
      when v.storage_path like '%.docx' then 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      else 'text/markdown' end,
    'verifying'::public.upload_state
  from public.document_upload_attempts a where a.id = p_attempt_id;
end;
$$;

create function public.finish_upload_verification(
  p_user_id uuid, p_version_id uuid, p_attempt_id uuid,
  p_operation_id uuid, p_result public.upload_state
) returns table (
  version_id uuid, upload_state public.upload_state, attempt_id uuid,
  can_open boolean, can_resume boolean, can_recover boolean
)
language plpgsql security invoker set search_path = '' as $$
declare
  actor_workspace_id uuid;
  affected integer;
begin
  actor_workspace_id := private.authorized_document_workspace(p_user_id);
  if p_result not in ('pending', 'rejected', 'confirmed') then
    raise exception 'Invalid verification result' using errcode = '22023';
  end if;
  update public.document_versions v set
    upload_state = p_result, upload_operation_id = null, upload_lease_expires_at = null,
    upload_confirmed_at = case when p_result = 'confirmed' then now() else null end
  where v.id = p_version_id and v.workspace_id = actor_workspace_id
    and v.current_upload_attempt_id = p_attempt_id
    and v.upload_operation_id = p_operation_id and v.upload_state = 'verifying'
    and v.upload_lease_expires_at > now();
  get diagnostics affected = row_count;
  if affected <> 1 then
    if not exists (select 1 from public.document_versions v
      where v.id = p_version_id and v.workspace_id = actor_workspace_id) then
      raise exception 'Upload version not found' using errcode = 'P0002';
    end if;
    raise exception 'Upload verification lease is stale' using errcode = '40001';
  end if;
  if p_result = 'confirmed' then
    update public.document_upload_attempts a set retired_at = coalesce(a.retired_at, now()),
      cleanup_status = 'pending'
    where a.id = p_attempt_id and a.version_id = p_version_id and a.workspace_id = actor_workspace_id;
  end if;
  return query select * from private.upload_snapshot(p_version_id, actor_workspace_id);
end;
$$;

create function public.claim_upload_recovery(p_user_id uuid, p_version_id uuid)
returns table (
  version_id uuid, attempt_id uuid, operation_id uuid, workspace_id uuid,
  temporary_path text, canonical_path text, expected_sha256 text,
  expected_size_bytes bigint, canonical_mime_type text, upload_state public.upload_state
)
language plpgsql security invoker set search_path = '' as $$
declare
  actor_workspace_id uuid;
  v public.document_versions%rowtype;
  op_id uuid := gen_random_uuid();
begin
  actor_workspace_id := private.authorized_document_workspace(p_user_id);
  if not private.uploads_enabled() then
    raise exception 'Upload flow is paused' using errcode = '55000';
  end if;
  select x.* into v from public.document_versions x
  where x.id = p_version_id and x.workspace_id = actor_workspace_id for update;
  if not found then raise exception 'Upload version not found' using errcode = 'P0002'; end if;
  if v.upload_state is null or v.upload_state not in ('pending', 'rejected', 'verifying', 'recovering') then
    raise exception 'Upload state cannot be recovered' using errcode = '40001';
  end if;
  if v.upload_state in ('verifying', 'recovering') and v.upload_lease_expires_at > now() then
    raise exception 'Upload operation is still active' using errcode = '40001';
  end if;
  if v.current_upload_attempt_id is null then
    raise exception 'Legacy upload must be reconciled first' using errcode = '40001';
  end if;
  update public.document_upload_attempts a
    set retired_at = coalesce(a.retired_at, now()), cleanup_status = 'pending'
  where a.id = v.current_upload_attempt_id and a.version_id = v.id and a.workspace_id = v.workspace_id;
  update public.document_versions x set upload_state = 'recovering', upload_operation_id = op_id,
    upload_lease_expires_at = now() + interval '120 seconds'
  where x.id = v.id and x.workspace_id = actor_workspace_id;
  return query select v.id, v.current_upload_attempt_id, op_id, v.workspace_id, a.storage_path,
    v.storage_path, v.expected_sha256, v.size_bytes,
    case when v.storage_path like '%.pdf' then 'application/pdf'
      when v.storage_path like '%.docx' then 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      else 'text/markdown' end,
    'recovering'::public.upload_state
  from public.document_upload_attempts a where a.id = v.current_upload_attempt_id;
end;
$$;

create function public.finish_upload_recovery(
  p_user_id uuid, p_version_id uuid, p_attempt_id uuid,
  p_operation_id uuid, p_object_absent boolean
) returns table (
  version_id uuid, upload_state public.upload_state, attempt_id uuid,
  can_open boolean, can_resume boolean, can_recover boolean
)
language plpgsql security invoker set search_path = '' as $$
declare
  actor_workspace_id uuid;
  v public.document_versions%rowtype;
  fresh_attempt_id uuid := gen_random_uuid();
begin
  actor_workspace_id := private.authorized_document_workspace(p_user_id);
  if p_object_absent is null then
    raise exception 'Recovery result is required' using errcode = '22023';
  end if;
  select x.* into v from public.document_versions x
  where x.id = p_version_id and x.workspace_id = actor_workspace_id for update;
  if not found then raise exception 'Upload version not found' using errcode = 'P0002'; end if;
  if v.current_upload_attempt_id is distinct from p_attempt_id
    or v.upload_operation_id is distinct from p_operation_id
    or v.upload_state <> 'recovering' or v.upload_lease_expires_at <= now() then
    raise exception 'Upload recovery lease is stale' using errcode = '40001';
  end if;
  update public.document_upload_attempts a set cleanup_checked_at = now(),
    cleanup_status = case when p_object_absent then 'absent'::public.upload_cleanup_status
      else 'failed'::public.upload_cleanup_status end
  where a.id = p_attempt_id and a.version_id = p_version_id and a.workspace_id = actor_workspace_id;
  if p_object_absent then
    perform private.insert_upload_attempt(v.workspace_id, v.document_id, v.id, fresh_attempt_id);
    update public.document_versions x set current_upload_attempt_id = fresh_attempt_id,
      upload_state = 'pending', upload_operation_id = null, upload_lease_expires_at = null,
      upload_confirmed_at = null
    where x.id = v.id and x.workspace_id = actor_workspace_id;
  else
    update public.document_versions x set upload_state = 'rejected', upload_operation_id = null,
      upload_lease_expires_at = null, upload_confirmed_at = null
    where x.id = v.id and x.workspace_id = actor_workspace_id;
  end if;
  return query select * from private.upload_snapshot(p_version_id, actor_workspace_id);
end;
$$;

create function public.bind_legacy_upload_reference(
  p_user_id uuid, p_version_id uuid, p_size_bytes bigint, p_expected_sha256 text
) returns table (
  version_id uuid, upload_state public.upload_state, attempt_id uuid,
  can_open boolean, can_resume boolean, can_recover boolean
)
language plpgsql security invoker set search_path = '' as $$
declare
  actor_workspace_id uuid;
  affected integer;
begin
  actor_workspace_id := private.authorized_document_workspace(p_user_id);
  if private.uploads_enabled() then
    raise exception 'Legacy upload maintenance requires paused mode' using errcode = '55000';
  end if;
  if p_size_bytes is null or p_size_bytes not between 1 and 10485760
    or p_expected_sha256 is null or p_expected_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid legacy upload reference' using errcode = '22023';
  end if;
  update public.document_versions v set size_bytes = coalesce(v.size_bytes, p_size_bytes),
    expected_sha256 = p_expected_sha256, hash_source = 'legacy_reconciled',
    reference_set_at = now(), reference_set_by = p_user_id
  where v.id = p_version_id and v.workspace_id = actor_workspace_id
    and v.upload_state is null and v.expected_sha256 is null and v.reference_set_at is null
    and (v.size_bytes is null or v.size_bytes = p_size_bytes);
  get diagnostics affected = row_count;
  if affected <> 1 then
    if not exists (select 1 from public.document_versions v
      where v.id = p_version_id and v.workspace_id = actor_workspace_id) then
      raise exception 'Upload version not found' using errcode = 'P0002';
    end if;
    raise exception 'Legacy upload reference was already set' using errcode = '40001';
  end if;
  return query select * from private.upload_snapshot(p_version_id, actor_workspace_id);
end;
$$;

revoke all on function public.reserve_document_upload(uuid,uuid,text,text,public.document_category,uuid,text,bigint,text),
  public.get_document_upload_state(uuid,uuid), public.claim_upload_verification(uuid,uuid,uuid),
  public.finish_upload_verification(uuid,uuid,uuid,uuid,public.upload_state),
  public.claim_upload_recovery(uuid,uuid), public.finish_upload_recovery(uuid,uuid,uuid,uuid,boolean),
  public.bind_legacy_upload_reference(uuid,uuid,bigint,text)
  from public, anon, authenticated;
grant execute on function public.reserve_document_upload(uuid,uuid,text,text,public.document_category,uuid,text,bigint,text),
  public.get_document_upload_state(uuid,uuid), public.claim_upload_verification(uuid,uuid,uuid),
  public.finish_upload_verification(uuid,uuid,uuid,uuid,public.upload_state),
  public.claim_upload_recovery(uuid,uuid), public.finish_upload_recovery(uuid,uuid,uuid,uuid,boolean),
  public.bind_legacy_upload_reference(uuid,uuid,bigint,text)
  to service_role;

comment on table public.document_upload_attempts is
  'Immutable temporary Storage identities for isolated, recoverable direct uploads.';
comment on column public.document_versions.expected_sha256 is
  'Expected byte digest; never exposed by the public module contract.';
comment on table private.upload_control is
  'Operator-only upload cutover gate. Expansion starts paused; app credentials cannot change it.';
