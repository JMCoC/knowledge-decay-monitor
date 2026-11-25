-- T1 (20261116120000) and T2 (20261117120000) both CREATE OR REPLACE
-- enqueue_ingestion_job, resetting the lock budget to 1s/2s (originally
-- set to 3s/5s by 20261009134833). This migration runs after T2 and
-- restores the intended budget without rewriting the pushed commits.
alter function public.enqueue_ingestion_job(uuid, uuid, boolean) set lock_timeout = '3s';
alter function public.enqueue_ingestion_job(uuid, uuid, boolean) set statement_timeout = '5s';
