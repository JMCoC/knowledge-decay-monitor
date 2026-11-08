-- The public API accepts an empty comparison set. Normalize SQL NULL to the
-- empty UUID array before the trusted implementation validates its scope.

alter function public.create_analysis_estimate(uuid,uuid[],uuid[],jsonb)
  set schema private;
alter function private.create_analysis_estimate(uuid,uuid[],uuid[],jsonb)
  rename to create_analysis_estimate_impl;
revoke all on function private.create_analysis_estimate_impl(uuid,uuid[],uuid[],jsonb)
  from public, anon, authenticated, service_role;

create function public.create_analysis_estimate(
  p_actor_id uuid,
  p_source_version_ids uuid[],
  p_comparison_version_ids uuid[],
  p_manifest jsonb
) returns table (
  estimate_ref uuid,
  fixed_cost integer,
  expires_at timestamptz,
  source_version_ids uuid[],
  comparison_version_ids uuid[]
)
language sql volatile security definer set search_path = ''
set lock_timeout = '3s' set statement_timeout = '30s'
as $$
  select *
  from private.create_analysis_estimate_impl(
    p_actor_id,
    p_source_version_ids,
    coalesce(p_comparison_version_ids, '{}'::uuid[]),
    p_manifest
  );
$$;

revoke all on function public.create_analysis_estimate(uuid,uuid[],uuid[],jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.create_analysis_estimate(uuid,uuid[],uuid[],jsonb)
  to service_role;
notify pgrst, 'reload schema';
