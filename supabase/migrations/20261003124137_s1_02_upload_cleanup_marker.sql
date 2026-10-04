create function public.mark_upload_attempt_cleanup(
  p_version_id uuid,
  p_attempt_id uuid,
  p_object_absent boolean
) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare
  affected integer;
begin
  if p_object_absent is null then
    raise exception 'Cleanup result is required' using errcode = '22023';
  end if;

  update public.document_upload_attempts a
  set cleanup_checked_at = now(),
    cleanup_status = case when p_object_absent then 'absent'::public.upload_cleanup_status
      else 'failed'::public.upload_cleanup_status end
  where a.id = p_attempt_id and a.version_id = p_version_id and a.retired_at is not null;
  get diagnostics affected = row_count;
  if affected <> 1 then
    raise exception 'Only a retired upload attempt can be marked cleaned' using errcode = '40001';
  end if;
  return true;
end;
$$;

revoke all on function public.mark_upload_attempt_cleanup(uuid,uuid,boolean)
  from public, anon, authenticated;
grant execute on function public.mark_upload_attempt_cleanup(uuid,uuid,boolean) to service_role;
