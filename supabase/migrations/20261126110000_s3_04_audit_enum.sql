-- S3-04: add audit action for correction submission expiration.
-- Must live in its own migration: PostgreSQL cannot use a new enum
-- value in the same transaction that adds it (see S3-02 pattern at
-- 20261114150000_s3_02_review_audit_enum.sql).
alter type public.review_audit_action add value if not exists 'correction_submission_expired';
