-- Stop legacy callers before the new Storage and RPC flow is enabled.
revoke execute on function public.reserve_document(uuid,uuid,text,public.document_category,uuid,text,bigint)
  from public, anon, authenticated;
revoke insert on public.documents, public.document_versions from public, anon, authenticated;
drop policy if exists document_insert on public.documents;
drop policy if exists version_reserve on public.document_versions;

-- Do not expose hashes, idempotency keys, leases, operation ids, or storage
-- paths through the authenticated Data API. Repository reads an allowlisted
-- projection; privileged upload actions resolve paths on the server.
revoke select on public.document_versions from public, anon, authenticated;
grant select (
  id, workspace_id, document_id, version_number, processing_status,
  version_status, analysis_status, created_at, updated_at, upload_state
) on public.document_versions to authenticated;

drop policy if exists document_original_read on storage.objects;
drop policy if exists document_original_upload on storage.objects;

create function private.current_canonical_original_allowed(p_storage_path text) returns boolean
language sql stable security definer set search_path = '' set row_security = off
as $$
  select exists (
    select 1 from public.document_versions v
    where v.storage_path = p_storage_path
      and v.workspace_id = (select private.current_workspace_id())
      and v.upload_state = 'confirmed'
      and (select private.current_workspace_role()) in ('Admin', 'QA Lead')
  )
$$;
revoke all on function private.current_canonical_original_allowed(text) from public, anon, authenticated, service_role;
grant execute on function private.current_canonical_original_allowed(text) to authenticated, service_role;

create function private.current_upload_attempt_allowed(p_storage_path text) returns boolean
language sql stable security definer set search_path = '' set row_security = off
as $$
  select coalesce((select private.uploads_enabled()
    and private.current_workspace_id() is not null
    and (select private.current_workspace_role()) in ('Admin', 'QA Lead')
    and exists (
      select 1
      from public.document_upload_attempts a
      join public.document_versions v
        on v.id = a.version_id and v.workspace_id = a.workspace_id
      where a.storage_path = p_storage_path
        and a.workspace_id = (select private.current_workspace_id())
        and a.id = v.current_upload_attempt_id
        and a.retired_at is null
        and a.cleanup_status = 'pending'
        and v.upload_state = 'pending'
    )), false)
$$;
revoke all on function private.current_upload_attempt_allowed(text) from public, anon, authenticated, service_role;
grant execute on function private.current_upload_attempt_allowed(text) to authenticated, service_role;

create policy document_original_read on storage.objects for select to authenticated
  using (bucket_id = 'documents'
    and (select private.current_canonical_original_allowed(name)));

-- Storage's INSERT response may perform a metadata SELECT. Permit that narrow
-- operation only for the same current attempt; browsing/signing remains denied.
create policy document_upload_attempt_returning on storage.objects for select to authenticated
  using (bucket_id = 'documents'
    and (select storage.allow_only_operation('object.upload'))
    and (select private.current_upload_attempt_allowed(name)));
create policy document_upload_attempt_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'documents'
    and (select private.current_upload_attempt_allowed(name)));

comment on policy document_original_read on storage.objects is
  'Only confirmed canonical originals are readable by Admin or QA Lead in their workspace.';
comment on policy document_upload_attempt_returning on storage.objects is
  'Allows only Storage upload metadata RETURNING for a pending current attempt; it does not allow listing or download.';
