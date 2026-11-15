# S3-02 human review workflow verification

Date: 2026-11-14 (America/Bogota)

## Revision and scope

- Branch: `feat/s3-02-state-machine`.
- Base revision: `2950c6638cea3cd556fd60f19e57f83b22fb1afb` (Task 7).
- The verified tree consisted of that base plus the Task 8 changes in this branch, before the Task 8 commit.
- Verification used the existing local Supabase stack for `test:db` and the repository's runner-owned temporary projects for review integration and populated upgrade checks. No shared stack reset or remote migration was run.

## Results

| Command | Result |
| --- | --- |
| `pnpm test:unit` | PASS — 125 files, 1,065 tests. |
| `pnpm lint` | PASS — 0 errors; 3 existing unused-variable warnings in upload unit tests. |
| `pnpm typecheck` | PASS — Next route types and TypeScript. Sentry printed its existing router-transition instrumentation notice. |
| `pnpm check:database-types` | PASS — generated database types match the local schema. |
| `pnpm test:db` | PASS — 43 SQL test files, 1,803 assertions. |
| `pnpm test:integration` | PARTIAL — 33 files passed (83 tests passed, 4 skipped); `analysis-recovery.test.ts` refused to alter a pre-existing local `kdm-analysis-recovery` cron job. The guarded job was left untouched. |
| `pnpm test:integration -- tests/integration/analysis-isolation.test.ts` | PASS — 1 file, 3 tests, including the updated S3-02 assignment projection expectation. |
| `pnpm test:integration -- tests/integration/review-foundation-isolation.test.ts tests/integration/review-commands-isolation.test.ts tests/integration/review-command-concurrency.test.ts` | PASS — 3 files, 8 tests, disposable project cleanup confirmed. |
| `node scripts/check-review-upgrade.mjs --disposable-local` | PASS — S2 → S3-01 → S3-02 preserved bytes for a private Storage original, S2 and S3-01 review data; first reassignment retained candidate coverage; reapply and clean S3-02 install with pgTAP passed. |
| `node scripts/with-local-supabase.mjs build` | PASS — optimized production build and route generation. Sentry printed its existing router-transition instrumentation notice. |
| `git diff --check` | PASS — no whitespace errors in the Task 8 diff. |

The integration wrapper always emits one Vitest `--exclude` flag per review suite, including when options are forwarded. A single flag followed by all three paths was parsed as a positional test filter, which selected review suites on the shared stack. Regression tests check the exact argument pairs and verify `--reporter=dot` still retains the isolated review runner.

The upgrade runner uploads a synthetic original through the real Storage API in its temporary S2 project, then downloads and compares its bytes after S3-01 and its reapply, S3-02 and its reapply. It also hashes `storage.objects` metadata with the S2 history rows. The local service-role key is read from the disposable project's status, sent only over loopback, and never printed or persisted.

The populated upgrade exposed PostgreSQL's pending-deferred-trigger restriction during the S3-02 backfill. The migration now installs the composite opened-assignee FK before its backfill and flushes candidate integrity events before re-enabling the guard. The disposable upgrade runner passed with this ordering.

## Consumer handoff

- **Dev 2:** the review contract separates `round.revision`, each item's authorization `revision`, and candidate `coverage_revision`. Candidate reassignment or invalidation must preserve the independent worker fence; do not infer worker ownership from `round.revision`. Confirmed submissions and their immutable item snapshots remain the source for coverage. Reservation invalidation must not silently complete a round.
- **Dev 3:** the public server-only `@/modules/review` surface exports `changeFinding`, `assignFinding`, `listAssignees`, `getFindingReview`, `getRoundDraft`, `prepareRound`, `updateRoundDraft`, `openRound`, and `cancelRound`. Inputs use revision plus idempotency key for mutations; reads return current snapshots/capabilities. UI should edit/recover drafts through the draft API and refresh on `CONFLICT`, without calling internal RPCs directly.
- Human consumer review is still pending. This records a local implementation handoff only: no Linear state was changed and no messages were sent.

## Limits

GitHub Actions was not run. This evidence does not certify email delivery, the future correction upload/worker path, final approval/active-version switching, or end-to-end behavior of downstream S3-03 through S3-12. The full integration gate remains limited by the pre-existing local cron entry noted above.
