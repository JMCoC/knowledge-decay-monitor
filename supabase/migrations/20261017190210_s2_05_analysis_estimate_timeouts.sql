-- Apply the same bounded lock and statement budgets at the estimate RPC entry.
alter function public.create_analysis_estimate(uuid, uuid[], uuid[], jsonb)
  set lock_timeout = '3s';
alter function public.create_analysis_estimate(uuid, uuid[], uuid[], jsonb)
  set statement_timeout = '30s';
