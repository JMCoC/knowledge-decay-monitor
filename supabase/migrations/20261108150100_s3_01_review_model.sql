-- Additive persistence foundation for human review and correction workflows.
-- Business transitions and row-level capabilities are added by later migrations.

alter table public.findings
  add column review_revision bigint not null default 1
    constraint findings_review_revision_positive check (review_revision > 0),
  add constraint findings_id_workspace_key unique (id, workspace_id);

alter table public.document_versions
  add column workflow_kind text not null default 'initial'
    constraint document_versions_workflow_kind_check
      check (workflow_kind in ('initial', 'correction_submission', 'correction_candidate'));

create table public.correction_rounds (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  document_id uuid not null,
  mode public.correction_round_mode not null,
  base_version_id uuid not null,
  status public.correction_round_status not null default 'draft',
  revision bigint not null default 1 check (revision > 0),
  created_by uuid not null,
  opened_at timestamptz,
  active_candidate_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, document_id, workspace_id),
  unique (id, workspace_id),
  foreign key (document_id, workspace_id)
    references public.documents(id, workspace_id) on delete restrict,
  foreign key (base_version_id, document_id, workspace_id)
    references public.document_versions(id, document_id, workspace_id) on delete restrict,
  foreign key (created_by, workspace_id)
    references public.profiles(id, workspace_id) on delete restrict
);
create unique index correction_rounds_one_open_per_document_idx
  on public.correction_rounds(document_id)
  where status not in ('approved', 'cancelled');
create index correction_rounds_workspace_created_idx
  on public.correction_rounds(workspace_id, created_at desc, id);

create table public.correction_round_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  round_id uuid not null,
  document_id uuid not null,
  finding_id uuid not null,
  initial_assignee_id uuid,
  assignee_id uuid,
  revision bigint not null default 1 check (revision > 0),
  current_submission_id uuid,
  created_at timestamptz not null default now(),
  unique (round_id, finding_id),
  unique (id, round_id, document_id, workspace_id),
  foreign key (round_id, document_id, workspace_id)
    references public.correction_rounds(id, document_id, workspace_id) on delete restrict,
  foreign key (finding_id, workspace_id)
    references public.findings(id, workspace_id) on delete restrict,
  foreign key (initial_assignee_id, workspace_id)
    references public.profiles(id, workspace_id) on delete restrict,
  foreign key (assignee_id, workspace_id)
    references public.profiles(id, workspace_id) on delete restrict
);
create index correction_round_items_finding_workspace_idx
  on public.correction_round_items(finding_id, workspace_id);
create index correction_round_items_assignee_workspace_idx
  on public.correction_round_items(assignee_id, workspace_id);

create table public.correction_submissions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  round_id uuid not null,
  document_id uuid not null,
  base_version_id uuid not null,
  version_id uuid not null,
  submitter_id uuid not null,
  state public.correction_submission_state not null default 'reserved',
  idempotency_key text not null check (char_length(btrim(idempotency_key)) between 1 and 128),
  request_fingerprint text not null check (char_length(btrim(request_fingerprint)) between 1 and 256),
  reserved_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  confirmed_at timestamptz,
  previous_submission_id uuid,
  created_at timestamptz not null default now(),
  unique (id, round_id, document_id, workspace_id),
  unique (workspace_id, submitter_id, idempotency_key),
  unique (version_id),
  foreign key (round_id, document_id, workspace_id)
    references public.correction_rounds(id, document_id, workspace_id) on delete restrict,
  foreign key (base_version_id, document_id, workspace_id)
    references public.document_versions(id, document_id, workspace_id) on delete restrict,
  foreign key (version_id, document_id, workspace_id)
    references public.document_versions(id, document_id, workspace_id) on delete restrict,
  foreign key (submitter_id, workspace_id)
    references public.profiles(id, workspace_id) on delete restrict,
  foreign key (previous_submission_id, round_id, document_id, workspace_id)
    references public.correction_submissions(id, round_id, document_id, workspace_id) on delete restrict,
  check (state <> 'reserved' or confirmed_at is null)
);
create index correction_submissions_round_created_idx
  on public.correction_submissions(round_id, created_at, id);
create index correction_submissions_submitter_workspace_idx
  on public.correction_submissions(submitter_id, workspace_id, created_at desc);

create table public.correction_submission_items (
  submission_id uuid not null,
  round_item_id uuid not null,
  workspace_id uuid not null,
  round_id uuid not null,
  document_id uuid not null,
  assignee_at_submit_id uuid not null,
  expected_revision bigint not null check (expected_revision > 0),
  created_at timestamptz not null default now(),
  primary key (submission_id, round_item_id),
  unique (submission_id, round_item_id, round_id, document_id, workspace_id),
  foreign key (submission_id, round_id, document_id, workspace_id)
    references public.correction_submissions(id, round_id, document_id, workspace_id) on delete restrict,
  foreign key (round_item_id, round_id, document_id, workspace_id)
    references public.correction_round_items(id, round_id, document_id, workspace_id) on delete restrict,
  foreign key (assignee_at_submit_id, workspace_id)
    references public.profiles(id, workspace_id) on delete restrict
);
create index correction_submission_items_item_round_idx
  on public.correction_submission_items(round_item_id, round_id, document_id, workspace_id);

create table public.correction_candidates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  round_id uuid not null,
  document_id uuid not null,
  base_version_id uuid not null,
  version_id uuid not null,
  source_submission_id uuid,
  selected_by uuid not null,
  selection_kind public.correction_selection_kind not null,
  status public.correction_candidate_status not null default 'reserved',
  coverage_revision bigint not null default 1 check (coverage_revision > 0),
  revision bigint not null default 1 check (revision > 0),
  idempotency_key text not null check (char_length(btrim(idempotency_key)) between 1 and 128),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, round_id, document_id, workspace_id),
  unique (version_id),
  unique (workspace_id, round_id, selected_by, idempotency_key),
  foreign key (round_id, document_id, workspace_id)
    references public.correction_rounds(id, document_id, workspace_id) on delete restrict,
  foreign key (base_version_id, document_id, workspace_id)
    references public.document_versions(id, document_id, workspace_id) on delete restrict,
  foreign key (version_id, document_id, workspace_id)
    references public.document_versions(id, document_id, workspace_id) on delete restrict,
  foreign key (source_submission_id, round_id, document_id, workspace_id)
    references public.correction_submissions(id, round_id, document_id, workspace_id) on delete restrict,
  foreign key (selected_by, workspace_id)
    references public.profiles(id, workspace_id) on delete restrict,
  check (
    (selection_kind = 'direct' and source_submission_id is not null)
    or (selection_kind = 'consolidated' and source_submission_id is null)
  )
);
create unique index correction_candidates_one_live_per_round_idx
  on public.correction_candidates(round_id)
  where status not in ('approved', 'rejected', 'invalidated');
create index correction_candidates_workspace_created_idx
  on public.correction_candidates(workspace_id, created_at desc, id);

create table public.correction_candidate_items (
  candidate_id uuid not null,
  round_item_id uuid not null,
  submission_id uuid not null,
  workspace_id uuid not null,
  round_id uuid not null,
  document_id uuid not null,
  item_revision bigint not null check (item_revision > 0),
  created_at timestamptz not null default now(),
  primary key (candidate_id, round_item_id),
  foreign key (candidate_id, round_id, document_id, workspace_id)
    references public.correction_candidates(id, round_id, document_id, workspace_id) on delete restrict,
  foreign key (round_item_id, round_id, document_id, workspace_id)
    references public.correction_round_items(id, round_id, document_id, workspace_id) on delete restrict,
  foreign key (submission_id, round_item_id, round_id, document_id, workspace_id)
    references public.correction_submission_items(submission_id, round_item_id, round_id, document_id, workspace_id)
    on delete restrict
);
create index correction_candidate_items_contribution_idx
  on public.correction_candidate_items(submission_id, round_item_id, workspace_id);

create table public.correction_returns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  round_id uuid not null,
  document_id uuid not null,
  candidate_id uuid,
  actor_id uuid not null,
  idempotency_key text not null check (char_length(btrim(idempotency_key)) between 1 and 128),
  created_at timestamptz not null default now(),
  unique (id, round_id, document_id, workspace_id),
  unique (workspace_id, actor_id, idempotency_key),
  foreign key (round_id, document_id, workspace_id)
    references public.correction_rounds(id, document_id, workspace_id) on delete restrict,
  foreign key (candidate_id, round_id, document_id, workspace_id)
    references public.correction_candidates(id, round_id, document_id, workspace_id) on delete restrict,
  foreign key (actor_id, workspace_id)
    references public.profiles(id, workspace_id) on delete restrict
);

create table public.correction_return_items (
  return_id uuid not null,
  round_item_id uuid not null,
  previous_submission_id uuid not null,
  workspace_id uuid not null,
  round_id uuid not null,
  document_id uuid not null,
  recipient_id uuid not null,
  reason text not null check (char_length(btrim(reason)) between 1 and 2000),
  created_at timestamptz not null default now(),
  primary key (return_id, round_item_id),
  foreign key (return_id, round_id, document_id, workspace_id)
    references public.correction_returns(id, round_id, document_id, workspace_id) on delete restrict,
  foreign key (round_item_id, round_id, document_id, workspace_id)
    references public.correction_round_items(id, round_id, document_id, workspace_id) on delete restrict,
  foreign key (previous_submission_id, round_id, document_id, workspace_id)
    references public.correction_submissions(id, round_id, document_id, workspace_id) on delete restrict,
  foreign key (recipient_id, workspace_id)
    references public.profiles(id, workspace_id) on delete restrict
);

create table public.correction_candidate_decisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  round_id uuid not null,
  document_id uuid not null,
  candidate_id uuid not null,
  actor_id uuid not null,
  outcome public.correction_decision_outcome not null,
  private_reason text,
  retention text check (retention in ('retain', 'delete')),
  created_at timestamptz not null default now(),
  unique (candidate_id),
  unique (id, document_id, workspace_id),
  foreign key (candidate_id, round_id, document_id, workspace_id)
    references public.correction_candidates(id, round_id, document_id, workspace_id) on delete restrict,
  foreign key (actor_id, workspace_id)
    references public.profiles(id, workspace_id) on delete restrict,
  check ((outcome = 'approved') = (retention is not null)),
  check (
    outcome = 'approved'
    or char_length(btrim(coalesce(private_reason, ''))) between 1 and 2000
  )
);

create table public.correction_approval_contributions (
  approval_id uuid not null,
  document_id uuid not null,
  workspace_id uuid not null,
  contributor_id uuid not null,
  own_item_count integer not null check (own_item_count > 0),
  approved_at timestamptz not null default now(),
  primary key (approval_id, contributor_id),
  foreign key (approval_id, document_id, workspace_id)
    references public.correction_candidate_decisions(id, document_id, workspace_id) on delete restrict,
  foreign key (document_id, workspace_id)
    references public.documents(id, workspace_id) on delete restrict,
  foreign key (contributor_id, workspace_id)
    references public.profiles(id, workspace_id) on delete restrict
);

-- The candidate/round and submission/item pointers are cyclic by design. They
-- permit atomic updates of the current pointers without mutable historical rows.
alter table public.correction_rounds
  add constraint correction_rounds_active_candidate_fk
  foreign key (active_candidate_id, id, document_id, workspace_id)
  references public.correction_candidates(id, round_id, document_id, workspace_id)
  on delete restrict deferrable initially deferred;
alter table public.correction_round_items
  add constraint correction_round_items_current_submission_fk
  foreign key (current_submission_id, round_id, document_id, workspace_id)
  references public.correction_submissions(id, round_id, document_id, workspace_id)
  on delete restrict deferrable initially deferred;

create table private.review_commands (
  workspace_id uuid not null,
  actor_id uuid not null,
  operation text not null check (operation in (
    'changeFinding', 'assignFinding', 'prepareRound', 'openRound', 'cancelRound',
    'reserveCorrection', 'finalizeCorrection', 'resumeCorrection', 'selectFinalCandidate',
    'reserveConsolidatedFile', 'finalizeConsolidatedFile', 'retryCorrectionCandidate',
    'returnRoundItems', 'rejectAdministrativeCandidate', 'approveCorrection'
  )),
  idempotency_key text not null check (char_length(btrim(idempotency_key)) between 1 and 128),
  fingerprint text not null check (char_length(btrim(fingerprint)) between 1 and 256),
  result_id uuid,
  result_revision bigint check (result_revision is null or result_revision > 0),
  result_status text check (result_status is null or char_length(result_status) <= 60),
  created_at timestamptz not null default now(),
  primary key (workspace_id, actor_id, operation, idempotency_key),
  foreign key (workspace_id) references public.workspaces(id) on delete restrict,
  foreign key (actor_id, workspace_id)
    references public.profiles(id, workspace_id) on delete restrict
);

alter table public.correction_rounds enable row level security;
alter table public.correction_round_items enable row level security;
alter table public.correction_submissions enable row level security;
alter table public.correction_submission_items enable row level security;
alter table public.correction_candidates enable row level security;
alter table public.correction_candidate_items enable row level security;
alter table public.correction_returns enable row level security;
alter table public.correction_return_items enable row level security;
alter table public.correction_candidate_decisions enable row level security;
alter table public.correction_approval_contributions enable row level security;
alter table private.review_commands enable row level security;

revoke all on public.correction_rounds, public.correction_round_items,
  public.correction_submissions, public.correction_submission_items,
  public.correction_candidates, public.correction_candidate_items,
  public.correction_returns, public.correction_return_items,
  public.correction_candidate_decisions, public.correction_approval_contributions
  from public, anon, authenticated, service_role;
revoke all on private.review_commands from public, anon, authenticated, service_role;

comment on table public.correction_approval_contributions is
  'S3-10 cleanup may remove finding/evidence references as a complete set; this table preserves own approval history.';
comment on table private.review_commands is
  'Private idempotency receipts store only a fingerprint and minimal result identifiers, never request bodies or reasons.';
