# Durable ingestion implementation plan

> **For agentic workers:** Use superpowers:executing-plans inline, as requested by the user. Use test-driven-development and verification-before-completion.

**Goal:** Complete local first-vertical acceptance and prepare reviewable PR/remote cutover artifacts.

**Architecture:** A private PostgreSQL job table with transactional enqueue, fenced renewable leases and global capacity; a standalone Node worker runs the existing ingestion parsers with local ONNX embeddings.

**Tech Stack:** PostgreSQL/Supabase, Next.js, TypeScript, Transformers.js, Vitest, Playwright, Docker.

**Spec:** `docs/superpowers/specs/2026-10-09-durable-ingestion-design.md`.

## Global constraints

Preserve unrelated dirty files and local data. Add migrations; generate SQL types. Keep 384 dimensions, one globally active job, 180-second renewable lease, 30-second heartbeat, 15-minute attempt limit, three automatic attempts. No remote write/push/merge. Keep session-derived authorization and atomic activation. No sensitive artifacts.

## Review focus

Commit succeeded but response disappeared; crash after upload commit; live job older than old UI timeout; multiple worker instances; shutdown during native inference. Task 1 tests SQL fencing/idempotence and capacity; Task 2 tests abort/reconciliation; Task 3 tests UI/action authorization; Task 4 exercises real runtime and crash recovery.

### Task 1: Durable SQL jobs and atomic finalization

Files: new migration, `supabase/tests/database/011_ingestion_jobs.test.sql`, existing `010_processing.test.sql`, generated `src/types/database.ts`.

Interfaces: service-only enqueue(workspace,version,retry) returns queued/conflict/not_found; claim() returns job IDs/operation/start; heartbeat(version,operation) returns boolean; fail(version,operation,retryable) returns status. Repository adds job state and lease expiry.

- [x] Write SQL tests for automatic enqueue, privileges, claim capacity, heartbeat, expired reclaim, stale finalization and bounded attempts; run them before schema changes (expected failure).
- [x] Implement private job table, service-only functions, enqueue trigger and lease-aware completion. Keep existing completion signature and transaction. Apply only locally without reset.
- [x] Adapt old guard tests to explicit job leases. Run `pnpm test:db` (all pass), regenerate types using local CLI, run `pnpm check:database-types`.
- [x] Commit explicit SQL/test/type files.

### Task 2: Standalone inference and worker

Files: `src/modules/ingestion/worker/*.ts`, `scripts/ingestion-worker.ts`, worker Dockerfile, package/lockfile, unit/integration tests.

Interfaces: worker calls Task 1 RPCs; reuses chunking. `processJob` accepts typed service/client/embed dependencies and signal; embeddings return one pgvector per input.

- [x] Write failing tests for malformed embeddings, abort, job attempt errors and completion reconciliation.
- [x] Add pinned inference runtime, model warming, poll/heartbeat loop, controlled logging and readiness. Package independent of Next server-only imports.
- [x] Run focused tests, real inference smoke and worker with local Supabase (expected finite384 vectors and ready+active with matching chunks).
- [x] Commit worker and runtime files.

### Task 3: App commands and recovery projection

Files: ingestion actions/dispatch/retry/route, Repository projection/contracts/recovery UI and focused tests.

Interfaces: upload transaction owns enqueue; retry action calls authorized queue RPC; Repository reads safe projection columns through RLS.

- [x] Replace tests tied to obsolete HTTP execution with tests proving upload needs no dispatch and retry only queues authorized work.
- [x] Remove HTTP inference path, adapt UI to Queued and renewable lease expiry. Keep originals available for all confirmed versions.
- [x] Run unit/typecheck/lint/build and integration isolation/retry checks; expected all pass.
- [x] Commit scoped app changes.

### Task 4: Acceptance, CI and remote preparation

Files: existing dirty Task 6 tests/parser fix, E2E worker fixture, workflow, local worker runner, acceptance/cutover runbook, ADR and PR body.

- [x] Run full local unit, SQL, integration, fixture, recovery and 33-case E2E suites with the real worker/model; strengthen batch and boundary coverage. Failures are diagnosed, not hidden by retries or mocks.
- [ ] Replace CI Edge warmup with worker lifecycle; build/test image, safe model cache and health checks. The workflow gate is configured, but local image build timed out fetching an npm package and the image smoke remains pending.
- [x] Document exact worker deployment/config, migration order, pause/rollback/recovery and remaining remote acceptance. Prepare PR text for final branch behavior.
- [ ] Run diff/secret/file-scope review and fresh whole-branch review; fix significant findings and reverify before final commits.
