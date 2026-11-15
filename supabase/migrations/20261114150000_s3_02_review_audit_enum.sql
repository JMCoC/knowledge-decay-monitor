-- New audit values are isolated because PostgreSQL cannot use a newly added
-- enum label until the transaction that adds it has committed.
alter type public.review_audit_action
  add value 'correction_round_draft_updated';
