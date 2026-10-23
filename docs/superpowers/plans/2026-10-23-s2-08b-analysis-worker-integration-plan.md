# S2-08b Analysis Worker Integration — Terminal Failure, Locks and Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks 8b-6..8b-12 are strict TDD. Do NOT start any task until the user approves this plan. The executing agent does **not** commit or push; Diego commits after review.

**Goal:** Close S2-08 by making terminal failure atomic (`private.finalize_failed_analysis`), serializing every ledger-touching path with the canonical advisory → workspace → analysis lock order, replacing `complete_analysis` with a `P0001` trap, and landing the independent finalization/persistence flags plus the worker integration expectations for `Consumed`/`Released` and terminal events.

**Architecture:** One new migration file, `<ts>_s2_08b_analysis_worker_locks.sql`, appended in five parts: helper, `claim_analysis`, `fail_analysis`, `private.create_analysis_run`, and the `complete_analysis` trap. The helper is self-contained and always takes advisory by workspace, then `FOR UPDATE` on `workspaces`, then `FOR UPDATE` on `analyses`. `claim_analysis` keeps its global advisory, moves to a two-phase sweep (unlocked candidate selection, then per-candidate locks + helper), and raises `statement_timeout` to 45 s. `fail_analysis` removes the global advisory, takes the workspace advisory before row locks, and delegates both terminal paths to the helper. `create_analysis_run` gains the same workspace advisory before its existing workspace row lock. The Edge gate evaluates three independent component flags after the existing local gate. The finalization shim calls `finalize_analysis_success` with the exact reported finding count.

**Tech Stack:** PostgreSQL 15 (Supabase) + pgTAP, Next.js App Router + TypeScript strict, Supabase Edge Functions (Deno), Vitest, pnpm 12.5.1.

**Spec:** [`docs/superpowers/specs/2026-10-21-s2-08-analysis-finalization-spec.md`](../specs/2026-10-21-s2-08-analysis-finalization-spec.md) — read §7, §8, §9, §11, §12.1 and the new §13 before Task 8b-6. §13 is the binding correction for S2-08b; §7–§9 remain the behavioral source where they do not conflict. If this plan diverges from §13, STOP and report.

---

## Global Constraints

These apply to every task. Copy them verbatim; do not restate them per task.

**Toolchain and commands.** The repo pins `pnpm@12.5.1` (`package.json:62`). Run every command through it:

```bash
pnpm run test:unit
pnpm run typecheck
pnpm run lint
pnpm run test:db
pnpm run test:integration
pnpm run check:database-types
node scripts/check-analysis-upgrade.mjs
git diff --check
```

Never hand-edit `pnpm-lock.yaml`, `src/types/database.ts` (regenerate only), or `src/types/contracts.ts`.

**Strict TDD.** Every task writes failing tests first (red), pastes the red output into the task notes, implements minimally (green), then refactors. A task whose tests are written after the implementation is a failed task. No test may be skipped or `.only`'d. Integration tests are mandatory for tasks that change worker behavior.

**No commits.** The executing agent never runs `git commit`, `git push`, `git merge`, or `git rebase`. It reports `git status --short` and the diff for Diego.

**Migration ownership.** All new DDL for this slice goes into one file:

```text
supabase/migrations/<ts>_s2_08b_analysis_worker_locks.sql
```

Generate `<ts>` at the start of 8b-6 with:

```bash
pnpm exec supabase migration new s2_08b_analysis_worker_locks
```

The timestamp must be greater than `20261021181000`. The file is opened in 8b-6 and stays open through 8b-10. Do not create additional migration files. Do not rewrite historical migrations. Use `create or replace` for existing RPCs.

**Upgrade inventory.** Register the new migration in the same task that creates it:

- `scripts/analysis-upgrade-policy.mjs`: add `s208bNames`, `stageOrder.s2_08b = 7`, the `migrationStage` branch, and update the three JSDoc stage unions.
- `scripts/analysis-upgrade-policy.d.mts`: add `"s2_08b"` to `MigrationStage`.
- `tests/unit/analysis-upgrade-policy.test.ts`: add the exact filename to `s208bNames`, assert `migrationStage(...) === "s2_08b"`, assert `includeMigration(newFile, "s2_08a") === false`, `includeMigration(newFile, "s2_08b") === true`, and assert unknown migrations still throw.

**Canonical lock order.** Every path that touches the ledger takes:

1. `pg_advisory_xact_lock(hashtextextended(workspace_id::text, 0))`
2. `SELECT ... FROM public.workspaces WHERE id = workspace_id FOR UPDATE`
3. `SELECT ... FROM public.analyses WHERE id = analysis_id FOR UPDATE`

The helper is self-contained and performs all three. The caller must not pre-lock the analysis before the workspace. A caller that already holds the advisory may re-acquire it; PostgreSQL advisory transaction locks are reentrant within the same transaction.

**Helper contract.** `private.finalize_failed_analysis(uuid, uuid, public.analysis_failure_code, boolean) returns text` returning `'failed'` or `'superseded'`. `p_enforce_operation = true` is for `fail_analysis`; `false` is for `claim_analysis` sweeps. The helper preserves `operation_id` as the terminal acknowledgement token, sets `continuation_pending = false`, and clears `lease_expires_at` and `next_attempt_at`.

**complete_analysis trap.** Keep the function and the `service_role` grant; replace the body with `raise exception ... using errcode = 'P0001'`. Do not revoke the grant. `P0001` maps to `PERSISTENCE_FAILED` in the worker mapping and is intentionally retryable.

**Test migration ledger.** Only these existing tests may be changed for behavior:

| Test | Task | Change |
|---|---|---|
| `020:94-117` (terminal `claim_analysis` sweep) | 8b-7 | Add `Reserved`; expect `Released` + event |
| `020:304-332` (terminal `fail_analysis`) | 8b-8 | Add `Reserved`; expect `Released` + event |
| `020:334-354` (terminal `fail_analysis`, `fail_nr`) | 8b-8 | Add `Reserved`; expect `Released` + event |
| `024:206-230` (expired continuation terminal `claim`) | 8b-7 | Add `Reserved`; expect `Released` + event |
| `020:220-251` (`complete_analysis` success) | 8b-10 | Migrate to `finalize_analysis_success` with staging |
| `020:356-374` (`complete` on a live fenced row) | 8b-10 | Migrate to `finalize_analysis_success` |
| `s2_08_finalization.test.sql:618-640` (`complete_analysis` available) | 8b-10 | Change to `throws_ok(..., 'P0001', ...)` |
| `tests/integration/analysis-worker.test.ts:390` (direct complete) | 8b-10 | Migrate to `finalize_analysis_success` |
| `tests/integration/analysis-materialized-candidates.test.ts:146,184` | 8b-10 | Migrate to `finalize_analysis_success` |

`020:334-354` is the second terminal-failure block in the same `fail_analysis` path; it is included because the helper makes it fail otherwise. If any other test breaks, STOP and report. Do not “fix” it silently.

**No dblink.** The deadlock coverage is TypeScript with `openLocalSqlSession`; do not install or use `dblink`. Keep the existing `020:414` skip.

**No secrets / no raw data.** Never log tokens, prompts, chunks, snapshots, signed URLs or raw provider responses. Telemetry stays on the S2-06 allowlist.

**Types.** `src/types/database.ts` is regenerated only by Dev 1 after 8b-10, with `pnpm exec supabase gen types typescript --local --schema public > src/types/database.ts` and `pnpm run check:database-types`. No hand edits.

**Scope.** Do not touch `src/modules/ingestion/**`, `src/modules/credits/**`, `src/types/contracts.ts`, or files outside the File Structure. Do not rewrite S2-05 migrations; use `create or replace` in the new 8b migration.

---

## Review Focus

Five failure modes this slice must pin, each with a test in the owning task.

1. **Deadlock analysis→workspace vs workspace→analysis.** Every ledger path must take advisory → workspace → analysis. The helper is self-contained; `claim_analysis` phase 2 must not lock A before the workspace. → 8b-9 integration test with two `openLocalSqlSession` sessions.
2. **Double terminalization.** A terminal `fail_analysis` racing a sweep must not release twice or emit two events. The helper is idempotent by `(status='failed', operation_id)` and the event uses `on conflict do nothing`. → 8b-6 cases D–G and 8b-8 race test.
3. **Two-phase sweep without `SKIP LOCKED`.** Phase 2 must preserve `SKIP LOCKED` on the reclaim selection and skip a candidate that another worker locked. → 8b-7 pgTAP/integration.
4. **Gate override `"0"` in hosted.** A component flag of `"0"` must force the real implementation even in loopback; a flag of `"1"` in `*.supabase.co` must never enable a fake. → 8b-11 unit tests.
5. **Shim count.** The shim must call `finalize_analysis_success` with `p_reported_findings_count = outcome.findings.length`, not the batch count or a constant. → 8b-10 unit test.

---

## File Structure

Ownership follows the Day-Zero matrix. **Dev 2 (Diego)** owns the worker/Edge behavior and TS tests. **Dev 1** owns the S2-05 RPC review, the migration timestamp coordination, and the generated database types.

| File | Owner | Task | Responsibility |
|---|---|---|---|
| `supabase/migrations/<ts>_s2_08b_analysis_worker_locks.sql` | Dev 1 (timestamp) / Dev 2 (bodies) | 8b-6..8b-10 | Helper, claim, fail, create_analysis_run, complete trap |
| `scripts/analysis-upgrade-policy.mjs` | Dev 1 | 8b-6 | `s208bNames`, `stageOrder`, `migrationStage`, JSDoc |
| `scripts/analysis-upgrade-policy.d.mts` | Dev 1 | 8b-6 | `MigrationStage` union |
| `tests/unit/analysis-upgrade-policy.test.ts` | Dev 1 | 8b-6 | Classification + boundary tests |
| `supabase/tests/database/s2_08_terminal_failure.test.sql` | Dev 2 | 8b-6, 8b-7, 8b-8 | Direct helper cases A–L; claim/fail terminal wiring |
| `supabase/tests/database/020_s2_06_analysis_leases.test.sql` | Dev 2 | 8b-7, 8b-8, 8b-10 | Migrate terminal claim/fail/complete expectations |
| `supabase/tests/database/024_s2_05_worker_handoff.test.sql` | Dev 2 | 8b-7 | Expired continuation terminal expectation |
| `supabase/tests/database/s2_08_finalization.test.sql` | Dev 2 | 8b-10 | `complete_analysis` → `P0001` |
| `tests/integration/analysis-lock-order.test.ts` | Dev 2 | 8b-9 | Two-session lock-order/deadlock coverage |
| `supabase/functions/analyze/_test_doubles/analysis-finalization.test-shim.ts` | Dev 2 | 8b-10 | Shim calls `finalize_analysis_success` with count |
| `tests/integration/analysis-worker.test.ts` | Dev 2 | 8b-10, 8b-12 | Direct complete migration; `Consumed`/`Released`/events |
| `tests/integration/analysis-materialized-candidates.test.ts` | Dev 2 | 8b-10 | Direct complete migration |
| `tests/integration/analysis-recovery.test.ts` | Dev 2 | 8b-12 | `Consumed` expectations |
| `supabase/functions/analyze/index.ts` | Dev 2 | 8b-11 | Three flags + `AnalyzeEnv` |
| `tests/support/analysis-edge.ts` | Dev 2 | 8b-11 | Flag options + child env cleanup |
| `supabase/functions/analyze/_test_doubles/analysis-provider.fake.ts` | Dev 2 | 8b-11 | `_fake.findings` parsing |
| `tests/unit/analysis-worker-readiness.test.ts` | Dev 2 | 8b-11 | Factory and flag expectations |
| `tests/unit/analysis-provider-fake.test.ts` | Dev 2 | 8b-11 | Custom findings parser |
| `docs/testing/s2-06-analysis-worker-runbook.md` | Dev 2 | 8b-12 | Deterministic local S2-08 smoke |
| `src/types/database.ts` | Dev 1 | 8b-12 | Regenerated types |

---

## Execution Mode Recommendation

| Task | Mode | Rationale |
|---|---|---|
| 8b-6 | Subagent-driven | Helper is dense SQL with idempotency and ledger invariants. |
| 8b-7 | Subagent-driven | Two-phase sweep and lock ordering are highest-risk concurrency code. |
| 8b-8 | Subagent-driven | Terminal/retryable split and double-terminal race. |
| 8b-9 | Subagent-driven + Dev 1 review | `create_analysis_run` is S2-05-owned; two-session test. |
| 8b-10 | Subagent-driven | Trap + shim + test migration; must remove every caller. |
| 8b-11 | Native | Small, highly reviewable TS gate/parser change. |
| 8b-12 | Subagent-driven | Cross-file integration, runbook, type regen coordination. |

---

## Task 8b-6: `private.finalize_failed_analysis` + inventory

**Objective:** Add the self-contained terminal-failure transaction with the A–L idempotency contract and register the new migration in the upgrade inventory.

**Dependencies:** 8a merged; no 8b behavior exists yet.

**Files:**
- Create: `supabase/migrations/<ts>_s2_08b_analysis_worker_locks.sql` — **part 1 only** (helper + grants).
- Modify: `scripts/analysis-upgrade-policy.mjs`, `scripts/analysis-upgrade-policy.d.mts`, `tests/unit/analysis-upgrade-policy.test.ts`.
- Create: `supabase/tests/database/s2_08_terminal_failure.test.sql` — direct helper coverage only.

**Consume:** `public.analyses` (`status`, `operation_id`, `lease_expires_at`, `attempt_deadline_at`, `analysis_deadline_at`, `fixed_cost`, `initiator_id`), `private.settle_analysis_credits`, `public.notification_events`, both `private.analysis_*_staging` tables. **Produce:** `private.finalize_failed_analysis(uuid,uuid,public.analysis_failure_code,boolean) returns text`, granted only to `service_role`.

**Tests first (red):** `s2_08_terminal_failure.test.sql`, using `analysis-fixtures.psql`, direct calls to the helper (no `claim_analysis`/`fail_analysis`):
- **A:** `processing`, matching token, live lease/deadlines, `Reserved` ledger, staged finding + evidence → returns `'failed'`; status `failed`, `error_code` set, `finished_at` set, `lease_expires_at`/`next_attempt_at` null, `continuation_pending=false`, `operation_id` preserved; ledger `[Reserved, Released]`; one `analysis_failed` event to `initiator_id`; staging for the analysis is empty; no findings published; `document_versions.analysis_status` unchanged.
- **B:** `processing` + mismatched token → `'superseded'`, no writes.
- **C:** `processing` + matching token but expired lease/attempt deadline/analysis deadline → `'superseded'`.
- **D:** `failed` + matching token + `Released` + event + no staging → `'failed'`, no duplicate ledger/event.
- **E:** `failed` + matching token + `Released` + event + staging → `'failed'`, staging cleaned, no duplicate ledger/event.
- **F:** `failed` + matching token + `Consumed` → raises `P0001`, nothing changes.
- **G:** `failed` + matching token + `Reserved` but no `Released` → settle `Released`, insert event, clean staging, return `'failed'`.
- **H:** `failed` + mismatched token → `'superseded'`.
- **I:** `completed` + any token → `'superseded'`.
- **J:** `queued` + `p_enforce_operation=true` → `'superseded'`.
- **K:** `queued` + `p_enforce_operation=false` → `'failed'` with `Released` + event + cleanup.
- **L:** unknown analysis id → `'superseded'`.
- **Rollback:** a terminal call with no `Reserved` row raises from `settle_analysis_credits`; the analysis stays `processing`, staging survives, and no event is inserted.
- **Privileges:** `service_role` can execute; `anon`, `authenticated`, and `public` cannot.

**Steps:**

- [ ] Generate the migration file with `pnpm exec supabase migration new s2_08b_analysis_worker_locks`; confirm `<ts> > 20261021181000`.
- [ ] Write `s2_08_terminal_failure.test.sql` for A–L, rollback, and grants; run `pnpm run test:db` and paste the red output (function missing).
- [ ] Implement part 1:
  - `security definer`, `set search_path = ''`, `set lock_timeout = '1s'`; do **not** set `statement_timeout` in the helper, so it inherits the caller (2 s for `fail_analysis`, 45 s for `claim_analysis`).
  - Read `workspace_id` without lock; advisory by workspace; `FOR UPDATE` workspace; `FOR UPDATE` analysis.
  - Apply §13.1 mode checks and §13.4 cases A–L.
  - On the normal/partial path: update to `failed` preserving `operation_id`, settle `Released`, insert `analysis_failed` with `on conflict do nothing`, delete all staging by `analysis_id`, return `'failed'`.
  - `Consumed` on a `failed` row raises `P0001`; no silent cleanup.
  - `revoke all ... from public, anon, authenticated; grant execute ... to service_role;`.
- [ ] Register the exact migration filename in all three inventory files, including `stageOrder.s2_08b = 7` and the `migrationStage` branch.
- [ ] Run `pnpm run test:db` → green; paste the plan count.
- [ ] Run `pnpm exec vitest run --config vitest.config.mts tests/unit/analysis-upgrade-policy.test.ts` and `node scripts/check-analysis-upgrade.mjs` → green.
- [ ] Do **not** commit.

**Definition of Done:** helper returns `text`; A–L + rollback + grants green; three locks in canonical order; inventory classifies the new file as `s2_08b`; CI guard green.

**Risks / rollback:** `settle_analysis_credits` requires `status='failed'`; the helper must update status before settling. If the helper inherits a 45 s timeout, a direct `fail_analysis` caller still has its own 2 s ceiling. Rollback is deleting part 1 and the inventory entries.

**Coherence gate (spec §13.1, §13.2, §13.4):** re-read §13.1/§13.2/§13.4 before starting; if the helper shape diverges, STOP.

---

## Task 8b-7: `claim_analysis` 45 s + two-phase sweep

**Objective:** Replace `claim_analysis` with a 45 s, two-phase sweep that terminalizes expired rows through the helper and keeps the reclaim path `SKIP LOCKED`.

**Dependencies:** 8b-6 (helper).

**Files:**
- Append: `supabase/migrations/<ts>_s2_08b_analysis_worker_locks.sql` — **part 2** (`create or replace public.claim_analysis`).
- Modify: `supabase/tests/database/020_s2_06_analysis_leases.test.sql:94-117`.
- Modify: `supabase/tests/database/024_s2_05_worker_handoff.test.sql:206-230`.
- Extend: `supabase/tests/database/s2_08_terminal_failure.test.sql` with claim wiring cases.

**Consume:** helper from 8b-6; current `claim_analysis` body (`supabase/migrations/20261017205245_s2_05_worker_handoff.sql:28-148`); `analyses` status/deadline/lease columns. **Produce:** `public.claim_analysis(uuid)` with `statement_timeout='45s'`, `lock_timeout='1s'`, same return table.

**Tests first (red):**
- `proconfig` contains `statement_timeout=45s` and `lock_timeout=1s`.
- Expired third attempt (`attempt_count >= 3`) with `Reserved` → claim returns empty, status `failed`, `ATTEMPTS_EXHAUSTED`/`TIMEOUT`, ledger `[Reserved, Released]`, one `analysis_failed` event, staging cleaned.
- Expired queued continuation with `Reserved` → same terminal result with `TIMEOUT`.
- Expired queued non-continuation with attempts left → reclaimed normally; operation rotated; reservation stays `Reserved`; no event.
- Live queued/processing candidate → reclaimed normally.
- Candidate locked by another session → skipped, not blocked; `SKIP LOCKED` preserved.
- `020:94-117`: add `Reserved`, expect `Released` + event instead of “no credits”.
- `024:206-230`: add `Reserved`, expect `Released` + event.

**Steps:**

- [ ] Extend the tests and migrate the two pgTAP blocks; run `pnpm run test:db` → red.
- [ ] Implement part 2:
  - Keep `pg_advisory_xact_lock(26061501)` at entry (spec §8.3).
  - Set `statement_timeout = '45s'`; keep `lock_timeout = '1s'`.
  - **Phase 1:** select candidate `id` + `workspace_id` without `FOR UPDATE`, including the directed id and FIFO candidates; use a bounded `LIMIT` (25) so terminal cleanup cannot scan unboundedly.
  - **Phase 2:** per candidate, take workspace advisory, `FOR UPDATE` workspace, read A without pre-locking; if terminal, call `private.finalize_failed_analysis(..., false)` and continue on `'failed'`/`'superseded'`; if reclaimable, `SELECT ... FOR UPDATE SKIP LOCKED` and claim as today.
  - Preserve the exact return table and all attempt/deadline/continuation calculations.
  - Do not rotate `operation_id` for terminal rows; the helper preserves it.
- [ ] Run `pnpm run test:db` → green; paste plan count.
- [ ] Run the integration worker suite for the claim paths: `pnpm run test:integration -- tests/integration/analysis-worker.test.ts tests/integration/analysis-recovery.test.ts` (or the repo’s supported filtered form).
- [ ] Do **not** commit.

**Definition of Done:** 45 s ceiling; two-phase sweep; helper used for all three terminal claim paths; reclaim remains `SKIP LOCKED`; 020/024 migrated; no double release.

**Risks / rollback:** helper lock acquisition can block on a candidate held by another session; the 1 s `lock_timeout` must surface as a skipped candidate, not a failed sweep. If a terminal candidate cannot be made skippable without pre-locking A, STOP and report rather than inventing a lock order.

**Coherence gate (spec §8.4, §13.2):** re-read §8.4 and §13.2 before starting.

---

## Task 8b-8: `fail_analysis` advisory + helper wiring

**Objective:** Move `fail_analysis` to the canonical workspace advisory order and delegate both terminal paths to the helper, leaving retryable requeue untouched.

**Dependencies:** 8b-6 (helper), 8b-7 (lock-order test harness can be reused).

**Files:**
- Append: `supabase/migrations/<ts>_s2_08b_analysis_worker_locks.sql` — **part 3** (`create or replace public.fail_analysis`).
- Modify: `supabase/tests/database/020_s2_06_analysis_leases.test.sql:304-332` and `:334-354`.
- Extend: `supabase/tests/database/s2_08_terminal_failure.test.sql` with fail wiring cases.

**Consume:** helper; current `fail_analysis` (`supabase/migrations/20261017205245_s2_05_worker_handoff.sql:686-741`); `RETRYABLE` backoff semantics. **Produce:** `public.fail_analysis(uuid,uuid,boolean,public.analysis_failure_code) returns text` with workspace advisory, no global advisory.

**Tests first (red):**
- Advisory is taken before `FOR UPDATE workspaces` and before A (source assertion plus concurrency test in 8b-9).
- Expired analysis/attempt deadline + matching token → helper → `failed`, `TIMEOUT`, `Released`, event, cleanup.
- Terminal non-retryable code → helper → `failed`, requested code, `Released`, event, cleanup.
- Retryable with `attempt_count < 3` → `queued`, reservation stays `Reserved`, no event, no cleanup, backoff 30 s/2 min unchanged.
- Retryable at attempt 3 → helper terminal.
- Mismatched token, non-processing, expired lease, unknown id → `superseded`, no writes.
- `020:304-332` and `020:334-354`: add `Reserved`, expect `Released` + event instead of zero credits/events.

**Steps:**

- [ ] Extend tests and migrate both 020 terminal blocks; run `pnpm run test:db` → red.
- [ ] Implement part 3:
  - Read `workspace_id` without lock; advisory by workspace; `FOR UPDATE` workspace; `FOR UPDATE` A.
  - Keep the existing token/lease/deadline checks.
  - Remove `pg_advisory_xact_lock(26061501)`.
  - For deadline-expired or terminal (non-retryable or attempt 3), call `private.finalize_failed_analysis(..., true)` and return its text.
  - For retryable with attempts left, keep the current queued update; do not call the helper.
  - Preserve signature and grants.
- [ ] Run `pnpm run test:db` → green; paste plan count.
- [ ] Run the worker integration suite for failure paths.
- [ ] Do **not** commit.

**Definition of Done:** all five terminal paths audited; helper used for fail paths 4–5; retryable path leaves the reservation; 020 terminal blocks green; no global advisory in `fail_analysis`.

**Risks / rollback:** calling the helper after already holding A is reentrant and order-safe; do not move the helper before the workspace lock. Rollback is reverting part 3 only.

**Coherence gate (spec §7.2, §13.1):** re-read §7.2 and §13.1.

---

## Task 8b-9: `create_analysis_run` advisory + deadlock test

**Objective:** Add the workspace advisory before the existing workspace row lock in `private.create_analysis_run` and prove the canonical order with two real sessions.

**Dependencies:** 8b-6 (helper), 8b-7 (claim locks), 8b-8 (fail locks). Coordinate with Dev 1 because `create_analysis_run` is S2-05-owned.

**Files:**
- Append: `supabase/migrations/<ts>_s2_08b_analysis_worker_locks.sql` — **part 4** (`create or replace private.create_analysis_run`).
- Create: `tests/integration/analysis-lock-order.test.ts`.

**Consume:** `private.create_analysis_run` (`supabase/migrations/20261017190200_s2_05_run_commands.sql:23-294`), `openLocalSqlSession` (`tests/support/local-sql-session.ts`), `createAnalysisFixture`. **Produce:** same signature/behavior plus advisory; TS deadlock coverage.

**Tests first (red):**
- Two sessions on the same workspace: session 1 holds advisory + workspace row; session 2 `create_analysis_run` blocks on advisory; after commit, session 2 proceeds; no deadlock/timeout.
- Two sessions on different workspaces do not block each other.
- A `create_analysis_run` racing a helper/finalize call on the same workspace completes in canonical order; no `40P01`.
- The migration changes only the lock preamble; the command/idempotency/estimate behavior is unchanged (regression assertion on a successful run and a replay).

**Steps:**

- [ ] Write `analysis-lock-order.test.ts` with `openLocalSqlSession`; run `pnpm run test:integration -- tests/integration/analysis-lock-order.test.ts` → red (no advisory or test fixture missing).
- [ ] Implement part 4: add `perform pg_catalog.pg_advisory_xact_lock(hashtextextended(v_workspace_id::text, 0));` immediately before the `perform w.id ... for update` block at `run_commands.sql:81-89`. Do not reorder existing logic.
- [ ] Run the new integration test → green; run the existing run-command integration tests → green.
- [ ] Request Dev 1 review of the exact diff; no merge until reviewed.
- [ ] Do **not** commit.

**Definition of Done:** advisory present before workspace row lock; two-session test green; no behavior drift in run/retry; Dev 1 review recorded.

**Risks / rollback:** `create_analysis_run` already takes the workspace row lock; adding advisory only serializes same-workspace commands earlier. If the test exposes a pre-existing unrelated deadlock, STOP and report.

**Coherence gate (spec §8.2, §13.2):** re-read §8.2 and §13.2.

---

## Task 8b-10: `complete_analysis` trap + shim + test migration

**Objective:** Replace `complete_analysis` with a `P0001` trap, migrate the finalization shim to `finalize_analysis_success` with the exact count, and remove every production-test caller of the old success path.

**Dependencies:** 8b-6..8b-9.

**Files:**
- Append: `supabase/migrations/<ts>_s2_08b_analysis_worker_locks.sql` — **part 5** (`create or replace public.complete_analysis`).
- Modify: `supabase/functions/analyze/_test_doubles/analysis-finalization.test-shim.ts`.
- Modify: `supabase/tests/database/s2_08_finalization.test.sql:618-640`.
- Modify: `supabase/tests/database/020_s2_06_analysis_leases.test.sql:220-251` and `:356-374`.
- Modify: `tests/integration/analysis-worker.test.ts:390`.
- Modify: `tests/integration/analysis-materialized-candidates.test.ts:146,184`.
- Modify only the immediately affected integration expectations that the shim change makes stale (success `Consumed`/event); the full integration sweep remains 8b-12.

**Consume:** `complete_analysis` (`20261015221607_s2_06_analysis_leases.sql:108-128`), its grants (`:167-174`), `finalize_analysis_success` (`20261021164507_s2_08a_analysis_finalization.sql:441`), shim contract. **Produce:** trap `P0001`; shim with `p_reported_findings_count = outcome.findings.length`.

**Tests first (red):**
- `complete_analysis` with any args raises `P0001`; `service_role` still has `EXECUTE`; `anon`/`authenticated`/`public` do not.
- Shim unit test: `finalize_analysis_success` receives the exact `p_analysis_id`, `p_operation_id`, and `p_reported_findings_count = findings.length`; `P0001` maps to `PERSISTENCE_FAILED`; `22023` maps to `superseded`.
- `020:220-251`: migrate the success case to `finalize_analysis_success` with a staged finding (or zero findings with `reported = 0`) and `Reserved`; assert `completed` + `Consumed`.
- `020:356-374`: migrate the live-row case to `finalize_analysis_success`; the foreign-token path must still be fenced.
- `s2_08_finalization.test.sql:618-640`: replace the “remains available” assertion with `throws_ok(..., 'P0001', ...)`; keep the privilege assertions.
- Integration direct calls at `analysis-worker.test.ts:390` and `analysis-materialized-candidates.test.ts:146,184` use `finalize_analysis_success` with the correct reported count.
- No `complete_analysis` caller remains in tests or `src/` (grep gate).

**Steps:**

- [ ] Write the unit/shim tests and migrate the listed pgTAP/integration blocks; run the focused tests → red.
- [ ] Implement part 5: `create or replace function public.complete_analysis(...) returns void language plpgsql security definer set search_path = '' as $$ begin raise exception 'complete_analysis is deprecated, use finalize_analysis_success' using errcode = 'P0001'; end; $$;`. Keep grants.
- [ ] Migrate the shim:
  - On `completed`, call `finalize_analysis_success` with `p_reported_findings_count: outcome.findings.length`.
  - Map `P0001`/`P2002`/`P2003`/`55P03`/`57014` to `PERSISTENCE_FAILED`; `22023` to `superseded`.
  - Keep the failure branch on `fail_analysis`.
- [ ] Run focused pgTAP + unit + integration tests → green.
- [ ] `grep -RIn "complete_analysis(" src tests supabase/functions supabase/tests` → only the deprecated function definition/grant test and the trap test remain.
- [ ] Do **not** commit.

**Definition of Done:** trap `P0001` with grant preserved; shim count correct; all listed tests migrated; zero production-test callers of the old success path; no stale “complete remains available” assertion.

**Risks / rollback:** the shim change makes worker success runs consume credits; update only the expectations directly affected, and leave the comprehensive ledger/event sweep to 8b-12. If any unlisted test fails, STOP and report.

**Coherence gate (spec §13.3, §13.7):** re-read §13.3 and §13.7.

---

## Task 8b-11: Three independent flags + custom fake findings

**Objective:** Refactor the Edge local gate into three independent component flags and connect `_fake.findings` to the fake provider without weakening the hosted gate.

**Dependencies:** 8b-10 (shim exists), though the flag code can be developed in parallel after the shim contract is fixed.

**Files:**
- Modify: `supabase/functions/analyze/index.ts` (`AnalyzeEnv`, `isLocalTestEnv`, handler double selection).
- Modify: `tests/support/analysis-edge.ts` (options + child env cleanup).
- Modify: `supabase/functions/analyze/_test_doubles/analysis-provider.fake.ts` (`createFakeProvider` copies findings; `parseFakeBehaviorSafe` parses them).
- Modify: `tests/unit/analysis-worker-readiness.test.ts`.
- Create/modify: `tests/unit/analysis-provider-fake.test.ts`.

**Consume:** current gate (`index.ts:79-116`, `:220-231`), `FakeProviderBehavior` (`analysis-provider.fake.ts:11-22`), parser (`:81-108`). **Produce:** `analysisFakeFinalization` and `analysisFakePersistence` in `AnalyzeEnv`; independent `"0"` overrides; custom findings.

**Tests first (red):**
- `ANALYSIS_FAKE_PROVIDER=1` + loopback + `ANALYSIS_FAKE_FINALIZATION=0` → real finalization; absent → fake; `"1"` → fake.
- Flag semantics: `"0"` → off; `"1"` → on (only if base gate open); **any other value** (undefined, "", "true", "yes", etc.) → inherit `isLocalTestEnv(env)`. Fail-closed would break existing tests that do not set the new flags.
- Same for `ANALYSIS_FAKE_PERSISTENCE`.
- `"1"` on a `*.supabase.co` host → all real, never fake.
- `"0"` for one component does not disable the other two.
- `_fake.findings` with valid findings is parsed; malformed findings are silently dropped; findings survive `createFakeProvider`; findings only honored under the local gate.
- Readiness tests change from “both factories throw” to “both factories build” as already done in 8a; this task only adds the flag matrix.

**Steps:**

- [ ] Write the unit tests and extend the edge harness; run `pnpm exec vitest run --config vitest.config.mts tests/unit/analysis-worker-readiness.test.ts tests/unit/analysis-provider-fake.test.ts` → red.
- [ ] Add `analysisFakeFinalization` and `analysisFakePersistence` to `AnalyzeEnv`; read the env vars in the Deno entrypoint.
- [ ] Implement a component-flag helper: `"0"` → false, `"1"` → true, absent → `isLocalTestEnv(env)`; then apply `isLocalTestEnv(env) && flag` so hosted can never enable a fake. Keep `ANALYSIS_FAKE_PROVIDER=1` + loopback + `!hosted` as the base gate.
- [ ] Select provider/finalization/persistence independently in the handler.
- [ ] Extend `parseFakeBehaviorSafe` with `findings`: validate the wire shape (type, severity, confidence, explanation, two-sided evidence); drop invalid entries; copy through `createFakeProvider`.
- [ ] Extend `tests/support/analysis-edge.ts` with the two new options and delete the new vars from the child env before spawn.
- [ ] Run unit + typecheck + lint → green.
- [ ] Do **not** commit.

**Definition of Done:** three independent flags; `"0"` override works in loopback; `"1"` never works hosted; custom findings parse and are honored only locally; harness cleans env.

**Risks / rollback:** do not decouple the base gate from `ANALYSIS_FAKE_PROVIDER` in this slice; that is S2-12. A malformed `_fake.findings` must not throw or leak into production.

**Coherence gate (spec §9, §13):** re-read §9 and §13.

---

## Task 8b-12: Final integration, runbook, types and close

**Objective:** Close the slice with the complete integration expectations, local smoke runbook, generated types, and a clean full-suite run.

**Dependencies:** 8b-6..8b-11.

**Files:**
- Modify: `tests/integration/analysis-worker.test.ts` (success/failure `Consumed`/`Released` + events).
- Modify: `tests/integration/analysis-recovery.test.ts` (`Consumed` at `:398`, `:485`, `:549`).
- Modify: `docs/testing/s2-06-analysis-worker-runbook.md` (S2-08 deterministic smoke).
- Verify/update: `docs/superpowers/specs/2026-10-21-s2-08-analysis-finalization-spec.md` §12.1 rows 5–8 closed and row 20 present (row 20 was added with §13; do not re-add).
- Regenerate: `src/types/database.ts` with Dev 1.
- Update the Hotfix log in this plan with any deviation.

**Tests first (red):**
- Worker success: ledger `[Reserved, Consumed]`, one `analysis_completed`, findings/evidence published, source `analysis_status='analyzed'`.
- Worker terminal failure: ledger `[Reserved, Released]`, one `analysis_failed`, no findings, staging cleaned.
- Recovery success paths: `Consumed` at the three cited assertions.
- Zero findings: `Consumed` + event.
- Superseded/stale path: no second ledger/event.
- Runbook smoke steps are executable locally with flags `ANALYSIS_FAKE_FINALIZATION=0` and `ANALYSIS_FAKE_PERSISTENCE=0`; provider fake with custom findings.

**Steps:**

- [ ] Update the integration expectations and runbook; run `pnpm run test:integration` → red where the old ledger/event assertions remain.
- [ ] Confirm the shim/gate behavior matches 8b-10/8b-11; do not change production code unless a red test proves a bug.
- [ ] Run the full gate:
  ```bash
  pnpm run test:unit
  pnpm run typecheck
  pnpm run lint
  pnpm run test:db
  pnpm run test:integration
  node scripts/check-analysis-upgrade.mjs
  git diff --check
  ```
- [ ] Ask Dev 1 to regenerate types:
  ```bash
  pnpm exec supabase gen types typescript --local --schema public > src/types/database.ts
  pnpm run check:database-types
  pnpm run typecheck
  ```
- [ ] Verify §12.1 rows 5–8 are closed and row 20 is present; do not duplicate row 20.
- [ ] Record the final plan counts and any hotfix in the Hotfix log.
- [ ] Do **not** commit.

**Definition of Done:** full suite green; `Consumed`/`Released` and events correct; runbook smoke documented; types regenerated/checked; §12.1 correct; Hotfix log current.

**Risks / rollback:** integration is the flakiest gate; re-run once on a known flake, but never mask a new failure. If type regeneration changes unrelated RPCs, STOP and report.

**Coherence gate (spec §11, §12.1, §13):** re-read §11, §12.1 and §13.

---

## Hotfix log

_Empty at plan start. Record every corrective migration, test-only correction, or deviation here with trigger, fix, coverage, and red-first evidence._

---

## Appendix — 8b baseline (fill during 8b-6)

- Branch:
- `HEAD`:
- `pnpm run test:unit`:
- `pnpm run typecheck`:
- `pnpm run lint`:
- `pnpm run test:db`:
- `pnpm run test:integration`:
- Generated migration `<ts>`:
- Dev 1 coordination:
