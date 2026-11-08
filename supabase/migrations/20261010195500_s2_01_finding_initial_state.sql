-- Every S2 finding begins unassigned and with its original severity unchanged.
create function private.enforce_initial_finding_state() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.assignee_id is not null
     or new.severity_current is distinct from new.severity_original then
    raise exception using
      errcode = '23514',
      message = 'New findings must start unassigned with matching severity.';
  end if;
  return new;
end;
$$;

create trigger findings_initial_state
before insert on public.findings
for each row execute function private.enforce_initial_finding_state();

revoke all on function private.enforce_initial_finding_state()
  from public, anon, authenticated, service_role;
grant execute on function private.enforce_initial_finding_state() to service_role;
