-- Fence pre-cutover application instances that still perform a direct CAS
-- against document_versions instead of using the durable queue RPCs.
create function private.guard_durable_processing_claim()
returns trigger
language plpgsql
security definer
set search_path = ''
set lock_timeout = '1s'
set statement_timeout = '2s'
as $$
begin
  if not exists (
    select 1
    from private.ingestion_jobs j
    where j.version_id = new.id
      and j.workspace_id = new.workspace_id
      and j.status = 'running'
      and j.operation_id = new.processing_operation_id
      and j.lease_expires_at > clock_timestamp()
      and j.started_at + interval '15 minutes' > clock_timestamp()
  ) then
    raise exception 'Durable processing claim requires a live worker job'
      using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke all on function private.guard_durable_processing_claim()
  from public, anon, authenticated, service_role;

create trigger guard_durable_processing_claim
before update of processing_status, processing_operation_id on public.document_versions
for each row
when (
  new.processing_status = 'processing'
  and (
    old.processing_status is distinct from new.processing_status
    or old.processing_operation_id is distinct from new.processing_operation_id
  )
)
execute function private.guard_durable_processing_claim();

comment on function private.guard_durable_processing_claim() is
  'Requires a live, tenant-matched durable job whenever a processing version claim is created or replaced.';
