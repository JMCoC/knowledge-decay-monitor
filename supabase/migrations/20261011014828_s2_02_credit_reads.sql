create function private.credit_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
  v_available bigint;
  v_reserved bigint;
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '42501', message = 'A verified workspace profile is required.';
  end if;

  select p.workspace_id into v_workspace_id
  from public.profiles p
  where p.id = (select auth.uid());
  if not found then
    raise exception using errcode = '42501', message = 'A verified workspace profile is required.';
  end if;

  select b.available, b.reserved into v_available, v_reserved
  from private.credit_balances(v_workspace_id) b;
  return pg_catalog.jsonb_build_object('available', v_available, 'reserved', v_reserved);
end;
$$;

create function public.get_credit_snapshot()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.credit_snapshot()
$$;

create function public.list_credit_ledger(
  p_page bigint default 1,
  p_page_size integer default 25
) returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_workspace uuid;
  v_role public.workspace_role;
  v_result jsonb;
begin
  if p_page is null or p_page < 1 or p_page > 9007199254740991
     or p_page_size is null or p_page_size < 1 or p_page_size > 100 then
    raise exception using errcode = '22023', message = 'Invalid credit ledger page.';
  end if;

  if (select auth.uid()) is null then
    raise exception using errcode = '42501', message = 'A verified workspace profile is required.';
  end if;

  select p.workspace_id, p.role into v_workspace, v_role
  from public.profiles p
  where p.id = (select auth.uid());
  if not found or v_role not in ('Admin', 'QA Lead') then
    raise exception using errcode = '42501', message = 'Credit ledger access is not permitted.';
  end if;

  with page_items as (
    select l.id, l.event_type, l.amount, l.analysis_id, l.created_at
    from public.credit_ledger l
    where l.workspace_id = v_workspace
    order by l.created_at desc, l.id asc
    limit p_page_size
    offset (p_page - 1) * p_page_size::bigint
  )
  select pg_catalog.jsonb_build_object(
    'items', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', p.id,
        'type', p.event_type,
        'amount', p.amount,
        'analysisId', p.analysis_id,
        'createdAt', p.created_at
      ) order by p.created_at desc, p.id asc)
      from page_items p
    ), '[]'::jsonb),
    'total', (
      select count(*)
      from public.credit_ledger l
      where l.workspace_id = v_workspace
    ),
    'page', p_page,
    'pageSize', p_page_size
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function private.credit_snapshot()
  from public, anon, service_role;
revoke execute on function public.get_credit_snapshot()
  from public, anon, service_role;
revoke execute on function public.list_credit_ledger(bigint, integer)
  from public, anon, service_role;
grant execute on function private.credit_snapshot() to authenticated;
grant execute on function public.get_credit_snapshot() to authenticated;
grant execute on function public.list_credit_ledger(bigint, integer) to authenticated;
