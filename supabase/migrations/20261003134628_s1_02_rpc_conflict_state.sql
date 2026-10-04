-- SQLSTATE 40001 is reserved for serialization failures and may be retried by
-- clients/gateways. These RPCs use it for expected application conflicts,
-- which can leave a PostgREST request waiting instead of returning CONFLICT.
-- Keep the same authorization and CAS logic while reporting those conflicts
-- with object_not_in_prerequisite_state (55000), already mapped by ingestion.
do $$
declare
  routine regprocedure;
  definition text;
begin
  foreach routine in array array[
    'public.claim_upload_verification(uuid,uuid,uuid)'::regprocedure,
    'public.finish_upload_verification(uuid,uuid,uuid,uuid,public.upload_state)'::regprocedure,
    'public.claim_upload_recovery(uuid,uuid)'::regprocedure,
    'public.finish_upload_recovery(uuid,uuid,uuid,uuid,boolean)'::regprocedure,
    'public.get_upload_resume_target(uuid,uuid)'::regprocedure,
    'public.bind_legacy_upload_reference(uuid,uuid,bigint,text)'::regprocedure
  ] loop
    definition := pg_get_functiondef(routine::oid);
    if position('40001' in definition) = 0 then
      raise exception 'Expected application conflict SQLSTATE missing from %', routine;
    end if;
    execute replace(definition, '40001', '55000');
  end loop;
end;
$$;
