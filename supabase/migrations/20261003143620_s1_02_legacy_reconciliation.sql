create table private.legacy_upload_reconciliation (
  version_id uuid primary key,
  workspace_id uuid not null,
  outcome text not null check (outcome in (
    'confirmed', 'missing_unprocessed', 'missing_processed',
    'invalid_unprocessed', 'invalid_processed'
  )),
  inspected_at timestamptz not null default now(),
  inspected_by uuid not null,
  foreign key (version_id, workspace_id)
    references public.document_versions(id, workspace_id) on delete cascade,
  foreign key (inspected_by, workspace_id)
    references public.profiles(id, workspace_id)
);
revoke all on private.legacy_upload_reconciliation from public, anon, authenticated, service_role;
grant select, insert, update on private.legacy_upload_reconciliation to service_role;

create function public.reconcile_legacy_upload(
  p_user_id uuid,
  p_version_id uuid,
  p_observation text,
  p_observed_size_bytes bigint,
  p_observed_sha256 text
) returns table (
  version_id uuid,
  outcome text,
  upload_state public.upload_state,
  attempt_id uuid
)
language plpgsql security invoker set search_path = '' as $$
declare
  actor_workspace_id uuid;
  v public.document_versions%rowtype;
  active_version_id uuid;
  is_processed boolean;
  result_outcome text;
  new_attempt_id uuid;
begin
  actor_workspace_id := private.authorized_document_workspace(p_user_id);
  if private.uploads_enabled() then
    raise exception 'Legacy reconciliation requires uploads to be paused' using errcode = '55000';
  end if;
  if p_observation is null or p_observation not in ('missing', 'valid', 'invalid') then
    raise exception 'Invalid legacy observation' using errcode = '22023';
  end if;
  if p_observation = 'valid' and (
    p_observed_size_bytes is null or p_observed_size_bytes not between 1 and 10485760
    or p_observed_sha256 is null or p_observed_sha256 !~ '^[0-9a-f]{64}$'
  ) then
    raise exception 'Invalid verified legacy reference' using errcode = '22023';
  end if;

  select x.* into v
  from public.document_versions x
  where x.id = p_version_id and x.workspace_id = actor_workspace_id
  for update;
  if not found then raise exception 'Legacy version not found' using errcode = 'P0002'; end if;

  if v.upload_state = 'confirmed' and v.hash_source = 'legacy_reconciled' then
    return query select v.id, 'confirmed'::text, v.upload_state, v.current_upload_attempt_id;
    return;
  end if;
  if v.upload_state is not null or v.current_upload_attempt_id is not null then
    raise exception 'Version is not eligible for legacy reconciliation' using errcode = '55000';
  end if;

  select d.active_version_id into active_version_id
  from public.documents d
  where d.id = v.document_id and d.workspace_id = v.workspace_id;
  is_processed := v.processing_status <> 'uploaded'
    or v.version_status is not null
    or active_version_id = v.id;

  if p_observation = 'valid'
    and (v.size_bytes is null or v.size_bytes = p_observed_size_bytes) then
    new_attempt_id := gen_random_uuid();
    perform private.insert_upload_attempt(v.workspace_id, v.document_id, v.id, new_attempt_id);
    update public.document_upload_attempts a set
      retired_at = now(), cleanup_checked_at = now(), cleanup_status = 'absent'
    where a.id = new_attempt_id and a.version_id = v.id and a.workspace_id = v.workspace_id;
    update public.document_versions x set
      size_bytes = p_observed_size_bytes,
      expected_sha256 = p_observed_sha256,
      hash_source = 'legacy_reconciled',
      upload_state = 'confirmed',
      current_upload_attempt_id = new_attempt_id,
      upload_confirmed_at = now(),
      reference_set_at = now(),
      reference_set_by = p_user_id
    where x.id = v.id and x.workspace_id = actor_workspace_id;
    result_outcome := 'confirmed';
  elsif is_processed then
    result_outcome := case when p_observation = 'missing'
      then 'missing_processed' else 'invalid_processed' end;
  else
    result_outcome := case when p_observation = 'missing'
      then 'missing_unprocessed' else 'invalid_unprocessed' end;
  end if;

  insert into private.legacy_upload_reconciliation(
    version_id, workspace_id, outcome, inspected_at, inspected_by
  ) values (v.id, v.workspace_id, result_outcome, now(), p_user_id)
  on conflict (version_id) do update set
    workspace_id = excluded.workspace_id,
    outcome = excluded.outcome,
    inspected_at = excluded.inspected_at,
    inspected_by = excluded.inspected_by;

  return query select v.id, result_outcome,
    case when result_outcome = 'confirmed' then 'confirmed'::public.upload_state else null end,
    case when result_outcome = 'confirmed' then new_attempt_id else null end;
end;
$$;
revoke all on function public.reconcile_legacy_upload(uuid,uuid,text,bigint,text)
  from public, anon, authenticated;
grant execute on function public.reconcile_legacy_upload(uuid,uuid,text,bigint,text) to service_role;
