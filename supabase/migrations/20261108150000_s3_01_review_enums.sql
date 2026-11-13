-- S3-01 review states are added here so PostgreSQL can commit the enum values
-- before a later migration uses them in table defaults, constraints, or data.
alter type public.finding_status add value if not exists 'confirmed' after 'pending_review';
alter type public.finding_status add value if not exists 'false_positive' after 'confirmed';
alter type public.finding_status add value if not exists 'update_planned' after 'false_positive';
alter type public.finding_status add value if not exists 'resolved' after 'update_planned';

create type public.correction_round_mode as enum ('assigned_findings', 'administrative');
create type public.correction_round_status as enum (
  'draft', 'collecting', 'consolidating', 'candidate_processing',
  'candidate_failed', 'pending_approval', 'approved', 'cancelled'
);
create type public.correction_submission_state as enum ('reserved', 'confirmed', 'expired', 'invalidated');
create type public.correction_selection_kind as enum ('direct', 'consolidated');
create type public.correction_candidate_status as enum (
  'reserved', 'selected', 'processing', 'failed', 'pending_approval',
  'approved', 'rejected', 'invalidated'
);
create type public.correction_decision_outcome as enum ('approved', 'rejected', 'invalidated');
