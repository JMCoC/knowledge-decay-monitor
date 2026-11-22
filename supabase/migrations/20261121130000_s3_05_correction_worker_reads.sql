-- The ingestion worker reads correction state only to verify an uncertain
-- completion, mirroring the existing service_role reads on document_versions
-- and analyses. This grants SELECT only and adds no write privileges.
grant select on public.correction_candidates, public.correction_rounds
  to service_role;
