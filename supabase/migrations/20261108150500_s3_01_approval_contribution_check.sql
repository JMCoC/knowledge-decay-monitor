-- Resolve approval contribution history through its owning decision instead of
-- assuming the contribution row carries candidate_id and round_id columns.
create or replace function private.assert_review_candidate_trigger() returns trigger
language plpgsql security definer
set search_path = '' set row_security = off
as $$
declare
  candidate_key uuid;
  round_key uuid;
begin
  if tg_table_name = 'correction_candidate_items' then
    if tg_op = 'DELETE' then
      candidate_key := old.candidate_id;
      round_key := old.round_id;
    else
      candidate_key := new.candidate_id;
      round_key := new.round_id;
    end if;
  elsif tg_table_name = 'correction_candidate_decisions' then
    if tg_op = 'DELETE' then
      candidate_key := old.candidate_id;
      round_key := old.round_id;
    else
      candidate_key := new.candidate_id;
      round_key := new.round_id;
    end if;
  elsif tg_table_name = 'correction_approval_contributions' then
    if tg_op = 'DELETE' then
      select d.candidate_id, d.round_id into candidate_key, round_key
      from public.correction_candidate_decisions d where d.id = old.approval_id;
    else
      select d.candidate_id, d.round_id into candidate_key, round_key
      from public.correction_candidate_decisions d where d.id = new.approval_id;
    end if;
  elsif tg_table_name = 'correction_candidates' then
    if tg_op = 'DELETE' then
      candidate_key := old.id;
      round_key := old.round_id;
    else
      candidate_key := new.id;
      round_key := new.round_id;
    end if;
  else
    raise exception 'Unexpected review candidate integrity trigger table' using errcode = '22023';
  end if;

  perform private.assert_review_candidate(candidate_key);
  perform private.assert_review_round(round_key);
  return null;
end;
$$;

revoke all on function private.assert_review_candidate_trigger()
  from public, anon, authenticated, service_role;
