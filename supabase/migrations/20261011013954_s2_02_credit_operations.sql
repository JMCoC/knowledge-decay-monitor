create function private.credit_balances(p_workspace_id uuid)
returns table(available bigint, reserved bigint)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_available numeric;
  v_reserved numeric;
  v_invalid boolean;
begin
  if p_workspace_id is null then
    raise exception using errcode = '22023', message = 'Workspace is required.';
  end if;

  if not exists (select 1 from public.workspaces w where w.id = p_workspace_id) then
    raise exception using errcode = 'P0002', message = 'Workspace not found.';
  end if;

  select
    coalesce(sum(case l.event_type
      when 'Promotional' then l.amount::numeric
      when 'Reserved' then -l.amount::numeric
      when 'Released' then l.amount::numeric
      else 0::numeric
    end), 0::numeric),
    coalesce(sum(case l.event_type
      when 'Reserved' then l.amount::numeric
      when 'Consumed' then -l.amount::numeric
      when 'Released' then -l.amount::numeric
      else 0::numeric
    end), 0::numeric),
    coalesce(bool_or(
      (l.event_type = 'Promotional' and l.amount <> 50)
      or (l.event_type <> 'Promotional' and
          (a.id is null or l.amount <> a.fixed_cost or l.amount <> a.reserved_credits))
      or (l.event_type in ('Consumed', 'Released') and
          (r.id is null or r.workspace_id <> l.workspace_id or r.amount <> l.amount))
      or (l.event_type = 'Consumed' and a.status <> 'completed')
      or (l.event_type = 'Released' and a.status <> 'failed')
    ), false)
  into v_available, v_reserved, v_invalid
  from public.credit_ledger l
  left join public.analyses a
    on a.id = l.analysis_id and a.workspace_id = l.workspace_id
  left join public.credit_ledger r
    on r.analysis_id = l.analysis_id and r.event_type = 'Reserved'
  where l.workspace_id = p_workspace_id;

  if v_invalid
     or v_available < 0
     or v_reserved < 0
     or v_available > 9007199254740991::numeric
     or v_reserved > 9007199254740991::numeric then
    raise exception using errcode = 'P2003', message = 'Credit ledger is inconsistent.';
  end if;

  return query select v_available::bigint, v_reserved::bigint;
end;
$$;

create function private.grant_promotional_credits(p_workspace_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
  v_ledger_id uuid;
  v_amount integer;
begin
  if p_workspace_id is null then
    raise exception using errcode = '22023', message = 'Workspace is required.';
  end if;

  select w.id into v_workspace_id
  from public.workspaces w
  where w.id = p_workspace_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Workspace not found.';
  end if;

  select l.id, l.amount into v_ledger_id, v_amount
  from public.credit_ledger l
  where l.workspace_id = v_workspace_id and l.event_type = 'Promotional';
  if found then
    if v_amount <> 50 then
      raise exception using errcode = 'P2002', message = 'Credit operation conflicts.';
    end if;
    return v_ledger_id;
  end if;

  insert into public.credit_ledger(workspace_id, event_type, amount)
  values (v_workspace_id, 'Promotional', 50)
  returning id into v_ledger_id;
  return v_ledger_id;
end;
$$;

create function private.reserve_analysis_credits(p_analysis_id uuid, p_expected_cost integer)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
  v_analysis public.analyses%rowtype;
  v_reservation_id uuid;
  v_reservation_amount integer;
  v_settlement_id uuid;
  v_available bigint;
  v_reserved bigint;
begin
  if p_analysis_id is null or p_expected_cost is null or p_expected_cost <= 0 then
    raise exception using errcode = '22023', message = 'Analysis and positive cost are required.';
  end if;

  select a.workspace_id into v_workspace_id
  from public.analyses a
  where a.id = p_analysis_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Analysis not found.';
  end if;

  perform w.id from public.workspaces w where w.id = v_workspace_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Workspace not found.';
  end if;

  select a.* into v_analysis
  from public.analyses a
  where a.id = p_analysis_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Analysis not found.';
  end if;
  if v_analysis.workspace_id <> v_workspace_id
     or v_analysis.fixed_cost <> p_expected_cost
     or v_analysis.reserved_credits <> p_expected_cost then
    raise exception using errcode = 'P2002', message = 'Credit operation conflicts.';
  end if;

  select l.id, l.amount into v_reservation_id, v_reservation_amount
  from public.credit_ledger l
  where l.analysis_id = p_analysis_id
    and l.workspace_id = v_workspace_id
    and l.event_type = 'Reserved';

  select l.id into v_settlement_id
  from public.credit_ledger l
  where l.analysis_id = p_analysis_id
    and l.workspace_id = v_workspace_id
    and l.event_type in ('Consumed', 'Released');

  if found and v_reservation_id is null then
    raise exception using errcode = 'P2003', message = 'Credit ledger is inconsistent.';
  end if;

  if v_reservation_id is not null then
    if v_reservation_amount <> p_expected_cost then
      raise exception using errcode = 'P2003', message = 'Credit ledger is inconsistent.';
    end if;
    select b.available, b.reserved into v_available, v_reserved
    from private.credit_balances(v_workspace_id) b;
    return v_reservation_id;
  end if;

  if v_analysis.status <> 'queued' then
    raise exception using errcode = 'P2002', message = 'Credit operation conflicts.';
  end if;

  select b.available, b.reserved into v_available, v_reserved
  from private.credit_balances(v_workspace_id) b;
  if v_available < p_expected_cost then
    raise exception using errcode = 'P2001', message = 'Insufficient credits.';
  end if;

  insert into public.credit_ledger(workspace_id, event_type, amount, analysis_id)
  values (v_workspace_id, 'Reserved', p_expected_cost, p_analysis_id)
  returning id into v_reservation_id;
  return v_reservation_id;
end;
$$;

create function private.settle_analysis_credits(
  p_analysis_id uuid,
  p_expected_cost integer,
  p_event public.credit_event_type
) returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
  v_analysis public.analyses%rowtype;
  v_reservation_id uuid;
  v_reservation_amount integer;
  v_settlement_id uuid;
  v_settlement_event public.credit_event_type;
  v_settlement_amount integer;
  v_available bigint;
  v_reserved bigint;
begin
  if p_analysis_id is null or p_expected_cost is null or p_expected_cost <= 0
     or p_event is null or p_event not in ('Consumed', 'Released') then
    raise exception using errcode = '22023', message = 'Valid analysis, positive cost, and settlement type are required.';
  end if;

  select a.workspace_id into v_workspace_id
  from public.analyses a
  where a.id = p_analysis_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Analysis not found.';
  end if;

  perform w.id from public.workspaces w where w.id = v_workspace_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Workspace not found.';
  end if;

  select a.* into v_analysis
  from public.analyses a
  where a.id = p_analysis_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Analysis not found.';
  end if;
  if v_analysis.workspace_id <> v_workspace_id
     or v_analysis.fixed_cost <> p_expected_cost
     or v_analysis.reserved_credits <> p_expected_cost then
    raise exception using errcode = 'P2002', message = 'Credit operation conflicts.';
  end if;

  select l.id, l.amount into v_reservation_id, v_reservation_amount
  from public.credit_ledger l
  where l.analysis_id = p_analysis_id
    and l.workspace_id = v_workspace_id
    and l.event_type = 'Reserved';

  select l.id, l.event_type, l.amount
  into v_settlement_id, v_settlement_event, v_settlement_amount
  from public.credit_ledger l
  where l.analysis_id = p_analysis_id
    and l.workspace_id = v_workspace_id
    and l.event_type in ('Consumed', 'Released');

  if v_reservation_id is null then
    if v_settlement_id is not null then
      raise exception using errcode = 'P2003', message = 'Credit ledger is inconsistent.';
    end if;
    raise exception using errcode = 'P2002', message = 'Credit operation conflicts.';
  end if;
  if v_reservation_amount <> p_expected_cost then
    raise exception using errcode = 'P2003', message = 'Credit ledger is inconsistent.';
  end if;

  if v_settlement_id is not null then
    if v_settlement_amount <> v_reservation_amount then
      raise exception using errcode = 'P2003', message = 'Credit ledger is inconsistent.';
    end if;
    if v_settlement_event <> p_event then
      raise exception using errcode = 'P2002', message = 'Credit operation conflicts.';
    end if;
    if (p_event = 'Consumed' and v_analysis.status <> 'completed')
       or (p_event = 'Released' and v_analysis.status <> 'failed') then
      raise exception using errcode = 'P2002', message = 'Credit operation conflicts.';
    end if;
    select b.available, b.reserved into v_available, v_reserved
    from private.credit_balances(v_workspace_id) b;
    return v_settlement_id;
  end if;

  if (p_event = 'Consumed' and v_analysis.status <> 'completed')
     or (p_event = 'Released' and v_analysis.status <> 'failed') then
    raise exception using errcode = 'P2002', message = 'Credit operation conflicts.';
  end if;

  select b.available, b.reserved into v_available, v_reserved
  from private.credit_balances(v_workspace_id) b;
  if v_reserved < v_reservation_amount then
    raise exception using errcode = 'P2003', message = 'Credit ledger is inconsistent.';
  end if;

  insert into public.credit_ledger(workspace_id, event_type, amount, analysis_id)
  values (v_workspace_id, p_event, v_reservation_amount, p_analysis_id)
  returning id into v_settlement_id;
  return v_settlement_id;
end;
$$;

revoke insert on public.credit_ledger from service_role;
revoke execute on function private.credit_balances(uuid)
  from public, anon, authenticated, service_role;
revoke execute on function private.grant_promotional_credits(uuid)
  from public, anon, authenticated, service_role;
revoke execute on function private.reserve_analysis_credits(uuid, integer)
  from public, anon, authenticated, service_role;
revoke execute on function private.settle_analysis_credits(uuid, integer, public.credit_event_type)
  from public, anon, authenticated, service_role;
grant execute on function private.grant_promotional_credits(uuid),
  private.reserve_analysis_credits(uuid, integer),
  private.settle_analysis_credits(uuid, integer, public.credit_event_type) to service_role;
