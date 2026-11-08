-- S2-01 establishes analysis persistence without implementing domain operations.
create type public.analysis_job_status as enum ('queued', 'processing', 'completed', 'failed');
create type public.analysis_scope_role as enum ('source', 'comparison');
create type public.finding_type as enum ('contradiction', 'obsolescence');
create type public.finding_severity as enum ('High', 'Medium', 'Low');
create type public.finding_status as enum ('pending_review');
create type public.credit_event_type as enum ('Promotional', 'Reserved', 'Consumed', 'Released');
create type public.notification_type as enum ('analysis_completed', 'analysis_failed');
create type public.notification_status as enum ('pending', 'sent', 'failed');
create type public.analysis_failure_code as enum (
  'RETRIEVAL_FAILED',
  'ESTIMATE_STALE',
  'PROVIDER_UNAVAILABLE',
  'INVALID_PROVIDER_OUTPUT',
  'PERSISTENCE_FAILED',
  'TIMEOUT',
  'ATTEMPTS_EXHAUSTED',
  'INTERNAL_ERROR'
);

create table public.analyses (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  initiator_id uuid not null,
  status public.analysis_job_status not null default 'queued',
  fixed_cost integer not null check (fixed_cost > 0),
  reserved_credits integer not null check (reserved_credits = fixed_cost),
  idempotency_key text not null check (char_length(btrim(idempotency_key)) > 0),
  request_fingerprint text not null check (char_length(btrim(request_fingerprint)) > 0),
  retry_of_analysis_id uuid,
  retrieval_config jsonb not null check (jsonb_typeof(retrieval_config) = 'object'),
  pricing_version text not null check (char_length(btrim(pricing_version)) > 0),
  prompt_version text not null check (char_length(btrim(prompt_version)) > 0),
  output_schema_version text not null check (char_length(btrim(output_schema_version)) > 0),
  provider_config jsonb not null check (jsonb_typeof(provider_config) = 'object'),
  provider_used text,
  model_used text,
  attempt_count integer not null default 0 check (attempt_count between 0 and 3),
  operation_id uuid,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  error_code public.analysis_failure_code,
  unique (id, workspace_id),
  unique (workspace_id, initiator_id, idempotency_key),
  check (retry_of_analysis_id is distinct from id),
  foreign key (initiator_id, workspace_id)
    references public.profiles(id, workspace_id) on delete restrict,
  foreign key (retry_of_analysis_id, workspace_id)
    references public.analyses(id, workspace_id) on delete restrict
);

create unique index analyses_one_active on public.analyses(workspace_id)
  where status in ('queued', 'processing');
create index analyses_workspace_created_idx on public.analyses(workspace_id, created_at desc, id);
create index analyses_initiator_workspace_idx on public.analyses(initiator_id, workspace_id);
create index analyses_retry_workspace_idx on public.analyses(retry_of_analysis_id, workspace_id);
create trigger analyses_updated before update on public.analyses
  for each row execute function private.touch_updated_at();

comment on column public.analyses.reserved_credits is
  'Historical amount originally reserved; current available/reserved balances are derived from credit_ledger.';

create table public.analysis_documents (
  analysis_id uuid not null,
  workspace_id uuid not null,
  document_id uuid not null,
  version_id uuid not null,
  role public.analysis_scope_role not null,
  primary key (analysis_id, version_id, role),
  foreign key (analysis_id, workspace_id)
    references public.analyses(id, workspace_id) on delete restrict,
  foreign key (version_id, document_id, workspace_id)
    references public.document_versions(id, document_id, workspace_id) on delete restrict
);
create index analysis_documents_version_document_workspace_idx
  on public.analysis_documents(version_id, document_id, workspace_id);

create table public.credit_ledger (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  event_type public.credit_event_type not null,
  amount integer not null check (amount > 0),
  analysis_id uuid,
  created_at timestamptz not null default now(),
  check (
    (event_type = 'Promotional' and analysis_id is null)
    or (event_type <> 'Promotional' and analysis_id is not null)
  ),
  foreign key (analysis_id, workspace_id)
    references public.analyses(id, workspace_id) on delete restrict
);
create unique index credit_ledger_one_promo_idx on public.credit_ledger(workspace_id)
  where event_type = 'Promotional';
create unique index credit_ledger_one_reservation_idx on public.credit_ledger(analysis_id)
  where event_type = 'Reserved';
create unique index credit_ledger_one_settlement_idx on public.credit_ledger(analysis_id)
  where event_type in ('Consumed', 'Released');
create index credit_ledger_workspace_created_idx
  on public.credit_ledger(workspace_id, created_at desc, id);
create index credit_ledger_analysis_workspace_idx on public.credit_ledger(analysis_id, workspace_id);

create table public.findings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  analysis_id uuid not null,
  type public.finding_type not null,
  severity_original public.finding_severity not null,
  severity_current public.finding_severity not null,
  confidence double precision not null check (confidence >= 0 and confidence <= 1),
  explanation text not null check (char_length(btrim(explanation)) > 0),
  status public.finding_status not null default 'pending_review',
  assignee_id uuid,
  fingerprint text not null check (char_length(btrim(fingerprint)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, analysis_id, workspace_id),
  unique (analysis_id, fingerprint),
  foreign key (analysis_id, workspace_id)
    references public.analyses(id, workspace_id) on delete restrict,
  foreign key (assignee_id, workspace_id)
    references public.profiles(id, workspace_id) on delete restrict
);
create index findings_workspace_analysis_severity_idx
  on public.findings(workspace_id, analysis_id, severity_current, id);
create index findings_assignee_workspace_idx on public.findings(assignee_id, workspace_id);
create trigger findings_updated before update on public.findings
  for each row execute function private.touch_updated_at();

alter table public.document_chunks
  add constraint document_chunks_s2_identity unique (id, version_id, workspace_id);

create table public.finding_evidence (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  analysis_id uuid not null,
  finding_id uuid not null,
  document_id uuid not null,
  version_id uuid not null,
  chunk_id uuid not null,
  page_number integer check (page_number > 0),
  section text,
  section_heading text,
  snapshot text not null check (
    char_length(snapshot) between 1 and 2000 and char_length(btrim(snapshot)) > 0
  ),
  foreign key (finding_id, analysis_id, workspace_id)
    references public.findings(id, analysis_id, workspace_id) on delete restrict,
  foreign key (version_id, document_id, workspace_id)
    references public.document_versions(id, document_id, workspace_id) on delete restrict,
  foreign key (chunk_id, version_id, workspace_id)
    references public.document_chunks(id, version_id, workspace_id) on delete restrict
);
create index finding_evidence_finding_analysis_workspace_idx
  on public.finding_evidence(finding_id, analysis_id, workspace_id);
create index finding_evidence_version_document_workspace_idx
  on public.finding_evidence(version_id, document_id, workspace_id);
create index finding_evidence_chunk_version_workspace_idx
  on public.finding_evidence(chunk_id, version_id, workspace_id);

create table public.notification_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  analysis_id uuid not null,
  type public.notification_type not null,
  recipient_id uuid not null,
  status public.notification_status not null default 'pending',
  attempt_count integer not null default 0 check (attempt_count between 0 and 3),
  next_attempt_at timestamptz,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  error_code text check (error_code in ('DELIVERY_FAILED', 'RECIPIENT_UNAVAILABLE', 'INTERNAL_ERROR')),
  unique (analysis_id, type, recipient_id),
  foreign key (analysis_id, workspace_id)
    references public.analyses(id, workspace_id) on delete restrict,
  foreign key (recipient_id, workspace_id)
    references public.profiles(id, workspace_id) on delete restrict
);
create index notification_events_workspace_analysis_idx
  on public.notification_events(workspace_id, analysis_id);
create index notification_events_recipient_workspace_idx
  on public.notification_events(recipient_id, workspace_id);

alter table public.analyses enable row level security;
alter table public.analysis_documents enable row level security;
alter table public.credit_ledger enable row level security;
alter table public.findings enable row level security;
alter table public.finding_evidence enable row level security;
alter table public.notification_events enable row level security;

revoke all on public.analyses, public.analysis_documents, public.credit_ledger,
  public.findings, public.finding_evidence, public.notification_events
  from public, anon, authenticated, service_role;
