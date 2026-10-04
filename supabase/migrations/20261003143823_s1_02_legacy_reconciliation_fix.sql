-- Qualify the primary-key target because the RPC also declares an output
-- parameter named version_id in PL/pgSQL.
do $$
declare
  definition text;
  fixed_definition text;
begin
  definition := pg_get_functiondef(
    'public.reconcile_legacy_upload(uuid,uuid,text,bigint,text)'::regprocedure
  );
  fixed_definition := regexp_replace(
    definition,
    'on conflict[[:space:]]+\(version_id\)[[:space:]]+do update set',
    'ON CONFLICT ON CONSTRAINT legacy_upload_reconciliation_pkey DO UPDATE SET',
    'gi'
  );
  if fixed_definition = definition then
    raise exception 'Expected legacy reconciliation upsert was not found';
  end if;
  execute fixed_definition;
end;
$$;
