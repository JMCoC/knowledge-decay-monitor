-- The security-invoker Repository view needs this one additional source column.
-- RLS still limits visible rows to Admin and QA Lead in the caller's workspace.
grant select (processing_started_at)
  on public.document_versions to authenticated;
