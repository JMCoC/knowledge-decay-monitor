-- Separate reviewer authorization revisions from the content covered by a
-- correction submission. Existing snapshots are backfilled without rewriting
-- audit or contribution history.
alter table public.correction_rounds
  add column coverage_revision bigint not null default 1
    constraint correction_rounds_coverage_revision_positive check (coverage_revision > 0);

alter table public.correction_round_items
  add column coverage_revision bigint not null default 1
    constraint correction_round_items_coverage_revision_positive check (coverage_revision > 0),
  add column opened_assignee_id uuid;

update public.correction_rounds
set coverage_revision = revision;

update public.correction_round_items i
set coverage_revision = i.revision,
    opened_assignee_id = case when r.opened_at is not null then i.initial_assignee_id end
from public.correction_rounds r
where r.id = i.round_id and r.workspace_id = i.workspace_id;

alter table public.correction_round_items
  add constraint correction_round_items_opened_assignee_workspace_fkey
    foreign key (opened_assignee_id, workspace_id)
    references public.profiles(id, workspace_id) on delete restrict;

create table private.review_round_cancellations (
  round_id uuid primary key,
  workspace_id uuid not null,
  actor_id uuid not null,
  reason text not null check (char_length(btrim(reason)) between 1 and 2000),
  created_at timestamptz not null default now(),
  foreign key (round_id, workspace_id)
    references public.correction_rounds(id, workspace_id) on delete restrict,
  foreign key (actor_id, workspace_id)
    references public.profiles(id, workspace_id) on delete restrict
);
alter table private.review_round_cancellations enable row level security;
revoke all on private.review_round_cancellations from public, anon, authenticated, service_role;
comment on table private.review_round_cancellations is
  'Private cancellation reasons; readable only by the owning server-side review command.';

alter table private.review_commands
  drop constraint review_commands_operation_check,
  add constraint review_commands_operation_check check (operation in (
    'changeFinding', 'assignFinding', 'prepareRound', 'updateRoundDraft', 'openRound', 'cancelRound',
    'reserveCorrection', 'finalizeCorrection', 'resumeCorrection', 'selectFinalCandidate',
    'reserveConsolidatedFile', 'finalizeConsolidatedFile', 'retryCorrectionCandidate',
    'returnRoundItems', 'rejectAdministrativeCandidate', 'approveCorrection'
  ));

-- In S3-01 a live candidate stored the round's general revision as its coverage
-- fence. No coverage could change while such a candidate was live, so translate
-- that legacy snapshot to the equivalent new coverage clock during the upgrade.
alter table public.correction_candidates disable trigger correction_candidates_integrity_guard;
update public.correction_candidates c
set coverage_revision = r.coverage_revision
from public.correction_rounds r
where r.id = c.round_id and r.active_candidate_id = c.id
  and c.status in ('selected', 'processing', 'failed', 'pending_approval', 'approved');
alter table public.correction_candidates enable trigger correction_candidates_integrity_guard;
