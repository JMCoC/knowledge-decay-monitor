-- Serialize mutations that could invalidate a run's exact document references.
create function private.lock_analysis_references() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_old uuid;
  v_new uuid;
begin
  if tg_op <> 'INSERT' then
    v_old := old.analysis_id;
  end if;
  if tg_op <> 'DELETE' then
    v_new := new.analysis_id;
  end if;

  perform a.id
  from public.analyses a
  where a.id = any(pg_catalog.array_remove(array[v_old, v_new], null::uuid))
  order by a.id
  for update;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger analysis_scope_lock
before insert or update or delete on public.analysis_documents
for each row execute function private.lock_analysis_references();

create trigger analysis_evidence_lock
before insert or update or delete on public.finding_evidence
for each row execute function private.lock_analysis_references();

create function private.validate_analysis_integrity(p_analysis_id uuid) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_versions bigint;
  v_sources bigint;
begin
  perform a.id from public.analyses a where a.id = p_analysis_id for update;
  if not found then
    return;
  end if;

  select count(distinct s.version_id), count(*) filter (where s.role = 'source')
    into v_versions, v_sources
  from public.analysis_documents s
  where s.analysis_id = p_analysis_id;

  if v_sources < 1 or v_versions > 20 then
    raise exception using errcode = '23514', message = 'Invalid analysis scope.';
  end if;

  if exists (
    select 1
    from public.finding_evidence e
    where e.analysis_id = p_analysis_id
      and not exists (
        select 1
        from public.analysis_documents s
        where s.analysis_id = e.analysis_id
          and s.workspace_id = e.workspace_id
          and s.document_id = e.document_id
          and s.version_id = e.version_id
      )
  ) then
    raise exception using errcode = '23514', message = 'Evidence is outside the analysis scope.';
  end if;
end;
$$;

create function private.check_analysis_integrity() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_id uuid;
begin
  if tg_table_name = 'analyses' then
    if tg_op = 'INSERT' then
      v_ids := array[new.id];
    else
      v_ids := array[old.id, new.id];
    end if;
  elsif tg_op = 'INSERT' then
    v_ids := array[new.analysis_id];
  elsif tg_op = 'DELETE' then
    v_ids := array[old.analysis_id];
  else
    v_ids := array[old.analysis_id, new.analysis_id];
  end if;

  for v_id in
    select distinct u.id
    from pg_catalog.unnest(v_ids) as u(id)
    where u.id is not null
    order by u.id
  loop
    perform private.validate_analysis_integrity(v_id);
  end loop;
  return null;
end;
$$;

create constraint trigger analysis_requires_scope
after insert or update on public.analyses
deferrable initially deferred
for each row execute function private.check_analysis_integrity();

create constraint trigger analysis_scope_integrity
after insert or update or delete on public.analysis_documents
deferrable initially deferred
for each row execute function private.check_analysis_integrity();

create constraint trigger analysis_evidence_integrity
after insert or update or delete on public.finding_evidence
deferrable initially deferred
for each row execute function private.check_analysis_integrity();

revoke execute on function private.lock_analysis_references() from public, anon, authenticated;
revoke execute on function private.validate_analysis_integrity(uuid) from public, anon, authenticated;
revoke execute on function private.check_analysis_integrity() from public, anon, authenticated;
