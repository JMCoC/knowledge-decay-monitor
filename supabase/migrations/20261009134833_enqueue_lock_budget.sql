-- Completion can retain the shared queue lock for its bounded two-second statement.
-- Give a concurrent confirmation/retry enough time to enqueue after that transaction commits.
alter function public.enqueue_ingestion_job(uuid, uuid, boolean)
  set lock_timeout = '3s';
alter function public.enqueue_ingestion_job(uuid, uuid, boolean)
  set statement_timeout = '5s';
