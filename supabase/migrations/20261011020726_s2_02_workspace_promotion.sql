-- Bootstrap and the historical backfill share the idempotent promotion owner.
create or replace function public.bootstrap_workspace(workspace_name text, full_name text) returns uuid
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
  perform private.grant_promotional_credits(new_workspace_id);
  return new_workspace_id;
end;
$$;

-- Keep valid history unchanged. Any non-50 legacy grant aborts this whole block.
do $credit_workspace_backfill$
declare
  v_workspace_id uuid;
begin
  for v_workspace_id in
    select w.id from public.workspaces w order by w.id
  loop
    perform private.grant_promotional_credits(v_workspace_id);
  end loop;
end;
$credit_workspace_backfill$;
