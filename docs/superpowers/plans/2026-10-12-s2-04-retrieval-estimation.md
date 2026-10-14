# S2-04 Retrieval + Estimation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Task 0 is a spike and runs native (no commits); Tasks 1–5 are TDD with atomic commits. Do NOT start Task 0 until the user approves this plan.

**Goal:** Deliver `estimateAnalysis` — semantic retrieval bounded to Top-5 pairs at cosine similarity ≥ 0.75 through a single `retrieve_candidate_pairs` RPC (`language sql stable security invoker`) over the existing 384d embeddings, plus an exact integer credit estimate via the frozen formula `floor((100 + 5*chunks + 20*pairs + 99)/100)`, persisted in the new `analysis_estimates` table (TTL 30 min, `estimateRef` = row UUID, SHA-256 canonical fingerprint per contract §7) — with no credit reservation, no LLM calls, and no UI.

**Architecture:** New server-only module `src/modules/analysis/` (`schemas → actions → queries → retrieval/pricing → index`, importing only `identity`'s public interface and `@/types/*`). `estimateAnalysis` resolves the Actor via `requireDocumentActor` (tenant/role from the verified Profile, never the client), validates with Zod (caps 1..20/0..20, D4a intra-list reject, D4b cross-list allow), checks eligibility (ready/active, same workspace, session RLS), calls the invoker RPC with the actor's workspace (RLS `chunk_read` enforces isolation — no `service_role` anywhere), computes the exact fixed cost + fingerprint in pure TS, inserts the estimate under the insert policy (`initiator_id = auth.uid()`), and returns `AnalysisEstimate`. Retrieved pairs are counted and discarded — the only effect is the INSERT (contract §8).

**Tech Stack:** Next.js 16 App Router (Server Actions, `server-only`), TypeScript strict, Zod, `@supabase/supabase-js` 2.117.2 + `@supabase/ssr` 0.12.7, PostgreSQL + pgvector (`extensions.vector(384)`, HNSW cosine `m = 16, ef_construction = 64`) with pgTAP via Supabase CLI, Vitest, `@sentry/nextjs` 10 via `captureOperationFailure` only, Node `crypto` for SHA-256.

**Spec:** [`docs/superpowers/specs/2026-10-12-s2-04-retrieval-estimation-spec.md`](../specs/2026-10-12-s2-04-retrieval-estimation-spec.md) — read it before Task 1. **Contract (prevails):** [`docs/contracts/S2-04-retrieval-estimation.md`](../../contracts/S2-04-retrieval-estimation.md) §§1–12. Task 0 writes its latency verdict into spec §2/§7 before anything else proceeds. The spec is the source of truth; this plan argues from it.

---

## Global Constraints

These apply to every task. Copy them verbatim; do not restate them per task.

**Toolchain and commands.** The repo pins `pnpm@12.5.1` with `pnpm-lock.yaml`. Run every command through it:

```bash
npx pnpm@12.5.1 run lint
npx pnpm@12.5.1 run typecheck
npx pnpm@12.5.1 run test:unit
npx pnpm@12.5.1 run test:db
npx pnpm@12.5.1 run test:integration
npx pnpm@12.5.1 run test:fixtures
```

`typecheck` is `next typegen && tsc --noEmit`. Never add `--frozen-lockfile` bypasses and never hand-edit the lockfile or `pnpm-lock.yaml`.

**Exact limits.** Similarity threshold 0.75 (filter before Top-K), Top-K 5 per source chunk, TTL 30 min, scope caps 1–20 sources / 0–20 comparisons (Zod-enforced per contract §2.1), embeddings `extensions.vector(384)`, HNSW `m = 16, ef_construction = 64`. Pricing formula verbatim contract §6; fingerprint shape verbatim contract §7.

**Do not touch.** `src/types/contracts.ts` (frozen by S2-01), `src/modules/ingestion/**` (S1-04), `src/modules/credits/**` (S2-02), old migrations, hand-edits of `src/types/database.ts` (Dev 1 regenerates), `docs/contracts/S2-04-retrieval-estimation.md` (team-owned; residue cleanup is the team's call per spec §2.9). No credit reservation (S2-05), no LLM calls (S2-06), no UI (S2-09).

**Session-scoped privilege, no service_role.** Reads, the invoker RPC, and the estimate INSERT all run on the session client under RLS/policies (contract §§4.3, 5.1). Never introduce `service_role` into `src/modules/analysis/`. Tenant/role come from `requireDocumentActor()`; the client sends only version-id lists.

**Integer-only pricing.** `computeFixedCost` is the verbatim contract §6 formula over integer counts. Cosine `similarity` (double) filters/orders inside SQL and never enters the formula. Tests pin the three reference cases (10+5 → 3, 0+0 → 1, 100+0 → 6).

**Observability discipline.** Only `captureOperationFailure({ module: "analysis", operation: "estimate", code })`. Never raw `Sentry.captureException`. Never log chunk text (even though the RPC returns `source_text`/`comparison_text` per contract §5.1 — hash them into `pairHashes`, then discard), embeddings, storage paths, cross-tenant ids, URLs, or tokens. Product messages in English.

**Imports.** Use the `@/*` alias (`./src/*`). Between modules import only another module's `index.ts` and `@/types/*`. The analysis module is server-only (`server-only`, no client barrel).

---

## Review Focus

Six inputs and failure modes the spec implies that no task's tests would otherwise catch. Each has a test pinned to the task that owns the code.

1. **An intra-list duplicate is silently normalized instead of rejected.** D4a requires `INVALID_INPUT` for repeats inside one list, while cross-list membership stays legal (D4b, contract §2.1). → Task 4: same id twice in sources → `INVALID_INPUT`; same id in both lists → `ok`.
2. **A foreign/ineligible version leaks existence.** Eligibility must collapse nonexistent, foreign, and non-ready/active ids into one `NOT_FOUND` with session-RLS reads (contract §9). → Task 4: tenant-B id and garbage UUID return the identical message.
3. **The formula drifts from the contract.** Any restatement of §6 risks a wrong coefficient; the three reference cases pin it byte-exact. → Task 3: 10+5 → 3, 0+0 → 1, 100+0 → 6, verbatim formula snapshot.
4. **A stale estimate passes as fresh after config change.** The fingerprint must cover counts, pairHashes, versions, and retrieval params (contract §7) so S2-05/S2-06 detect `ESTIMATE_STALE`. → Task 3: hash changes on any covered field; identical on reordered input.
5. **A Member (or logged-out user) gets an estimate.** Auth from the persisted Profile via `requireDocumentActor` + insert policy + RLS (contract §§4.3, 9). → Task 4 (action rejects) + Task 1 (pgTAP: tenant-B JWT reads 0 rows, foreign insert → `42501`).
6. **Temporary pairs get persisted or logged.** Only the estimate row persists (contract §8); pairs are counted, hashed into `pairHashes`, and discarded. → Task 4: assert no pair/text columns written and no chunk text in telemetry mocks; schema test in Task 1 asserts the contract §4.1 column set.

---

## File Structure

| File | Responsibility | Owner | Task |
|---|---|---|---|
| `docs/superpowers/specs/2026-10-12-s2-04-retrieval-estimation-spec.md` | §2/§7 verdict (HNSW latency, corpus size, `EXPLAIN` note) | Dev 2 writes, team approves | 0 |
| `supabase/migrations/<ts>_s2_04_retrieval_estimation.sql` | `analysis_estimates` + HNSW + `retrieve_candidate_pairs` + RLS + GRANTs (incl. derived EXECUTE, spec §6) | Dev 2 drafts, Dev 1 reserves timestamp | 1 |
| `supabase/tests/database/019_s2_04_retrieval.test.sql` | pgTAP assertions for table/index/RPC/RLS (§11.2) | Dev 2 | 1 |
| `src/types/database.ts` | regenerate after the migration | Dev 1 (REQUIERE COORDINACIÓN) | 1/5 |
| `src/modules/analysis/pricing.ts` | `computeFixedCost` verbatim contract §6 | Dev 2 | 3 |
| `src/modules/analysis/retrieval.ts` | `computeRequestFingerprint` (contract §7 shape) + D7 mirror | Dev 2 | 3 |
| `tests/unit/analysis-pricing.test.ts` | Vitest for reference cases + formula snapshot | Dev 2 | 3 |
| `tests/unit/analysis-fingerprint.test.ts` | Vitest for hash stability/discrimination | Dev 2 | 3 |
| `tests/unit/analysis-retrieval.test.ts` | Vitest for D7 canonicalization mirror | Dev 2 | 3 |
| `src/modules/analysis/schemas.ts` | Zod: UUID lists, caps 1–20/0–20, intra-list uniqueness (D4a), cross-list allowed (D4b) | Dev 2 | 4 |
| `src/modules/analysis/queries.ts` | eligibility read (session RLS) + RPC call + estimate insert (session, insert policy) | Dev 2 | 4 |
| `src/modules/analysis/actions.ts` | `estimateAnalysis` Server Action (auth → validate → RPC → price → persist → return) | Dev 2 | 4 |
| `src/modules/analysis/index.ts` | re-export `estimateAnalysis` (server-only) | Dev 2 | 4 |
| `tests/unit/analysis-estimate.test.ts` | Vitest for auth/validation/mapping with mocked DB | Dev 2 | 4 |
| `tests/integration/analysis-estimation.test.ts` | end-to-end estimate flow + ticket case + expiry + cross-tenant | Dev 2 authors, Dev 1 integrates | 4/5 |
| `docs/architecture/arquitectura-base.md` | touch only if the retrieval path changes a documented invariant | Dev 2 drafts, Dev 1 approves | 5 |

No other files (contract §10 file list, plus this plan's pgTAP/spec/verdict rows). In particular: no changes to `contracts.ts`, no second RPC, no queue/cron, no LLM provider, no UI routes, no `service_role` in analysis.

---

### Task 0: Blocking verification spike (native, no commit)

Spike, not implementation. No commits from this task. Output is measured evidence written into spec §2/§7. If HNSW on `extensions.vector(384)` with `(m = 16, ef_construction = 64)` misbehaves locally, raise the blocker and stop — do not proceed to Task 1.

- [ ] **Step 1: Prove HNSW works with the contract's parameters**

  Build a scratch database (local Supabase only): create a synthetic `document_chunks`-like table with `extensions.vector(384)`, insert ~1k–5k random 384d vectors, create the HNSW cosine index verbatim (`using hnsw (embedding extensions.vector_cosine_ops) with (m = 16, ef_construction = 64)`), and run `<=>` Top-5 queries with a 0.75 similarity filter plus the `ORDER BY similarity DESC, chunk_id ASC` tie-break. Record: extension version (`select extversion from pg_extension where extname = 'vector'`), index build time, p50 query latency (n=20), and `EXPLAIN` (index used vs seq scan at this corpus size). Suggested commands: `npx pnpm@12.5.1 exec supabase start`, then `psql` via the local connection string. Never touch shared/remote projects; never `--linked`.

- [ ] **Step 2: Freeze the retrieval numbers and record versions**

  Confirm `vector_cosine_ops` matches the `1 - (a <=> b)` similarity used in §5.2, confirm tie-break determinism (re-run identical query twice, byte-identical order), and confirm dims ≠ 384 still rejects (record the exact SQLSTATE for Task 1). Record pgvector version, corpus size, latencies, and the verdict: HNSW usable as specced, or fallback note with justification.

- [ ] **Step 3: Write the verdict into spec §2/§7 and stop**

  Update `docs/superpowers/specs/2026-10-12-s2-04-retrieval-estimation-spec.md` §§2.3/7 only (measured numbers + date). No code, no migration in this task. Do NOT commit (repo rule for this ticket: no commits from any task until review).

  Done when: §§2.3/7 name the pgvector version, corpus size, build time, p50 latency, `EXPLAIN` outcome, and the dims-mismatch SQLSTATE — or record the blocker.

---

### Task 1: Migration + RPC + pgTAP 019

Dev 2 drafts the migration and the pgTAP file. Dev 1 reserves the timestamp and regenerates `database.ts` — Dev 2 never hand-edits it.

> **REQUIERE COORDINACIÓN (Dev 1).** Ask Dev 1 for the UTC timestamp over chat **before** creating the migration file (must be after `20261011020726`). Dev 1 reserves the name, reviews order, and regenerates `src/types/database.ts` after applying.

**Files:**
- Create: `supabase/migrations/<timestamp>_s2_04_retrieval_estimation.sql`
- Create: `supabase/tests/database/019_s2_04_retrieval.test.sql` (contract §10 name; `001`–`018` exist; `019` is the verified next slot)
- Modify (Dev 1): `src/types/database.ts` — regenerated, never hand-edited

**Interfaces:**
- Consumes: `document_chunks` (+ `document_versions` eligibility join), `workspaces`, `profiles`, session RLS (`chunk_read`).
- Produces: `public.analysis_estimates` (verbatim contract §4.1) + three indexes (verbatim §4.2) + `public.retrieve_candidate_pairs(uuid,uuid[],uuid[],integer,double precision)` (`language sql stable security invoker`, verbatim §5.1) + select/insert policies (verbatim §4.3) + `grant select, insert … to authenticated` (verbatim §4.3) + derived `grant execute … to authenticated` (spec §6, team confirms in review).

- [ ] **Step 1: Reserve the migration timestamp with Dev 1**

  Do NOT create the migration file yet.

  ```bash
  # NOT run by Dev 2. Dev 1 runs this (or equivalent) and replies with the filename:
  npx pnpm@12.5.1 exec supabase migration new s2_04_retrieval_estimation
  ```

- [ ] **Step 2: Write the failing pgTAP assertions first**

  `supabase/tests/database/019_s2_04_retrieval.test.sql` per spec §11.2: HNSW indexdef check (cosine, m/ef params); table columns/checks/FK verbatim §4.1 via `information_schema` + probe inserts; RPC happy-path with synthetic orthogonal/parallel/boundary (0.749/0.751) vectors — internos + externos ≥ 0.75 in, < 0.75 out, Top-K per source, self-pairs out, `DISTINCT ON (least, greatest)` unique; tie determinism (two calls byte-identical via `similarity DESC, chunk_id ASC`); `not has_function_privilege('anon', … 'EXECUTE')` vs `has_function_privilege('authenticated', … 'EXECUTE')` (pattern `006_upload_authorization.test.sql:39-45`); RLS cross-tenant read → 0 rows, foreign insert → `42501`; `fixed_cost < 1` and empty sources → `23514`.

- [ ] **Step 3: Run to verify they fail**

  ```bash
  npx pnpm@12.5.1 run test:db
  ```

  Expected: FAIL — table/function/index do not exist. That is the correct red.

- [ ] **Step 4: Write the migration (contract §§4–5 verbatim + derived EXECUTE grant)**

  Table + checks (§4.1), three indexes (§4.2), RLS + GRANTs (§4.3), RPC §5.1–5.2 verbatim (parameter order `p_top_k` then `p_threshold`; internos + externos; `ORDER BY similarity DESC, chunk_id ASC`; `DISTINCT ON (least, greatest)`; read-only). Plus the derived `grant execute … to authenticated` flagged in spec §6. Never rewrite old migrations.

- [ ] **Step 5: Run to verify green + types + lint**

  ```bash
  npx pnpm@12.5.1 run test:db
  npx pnpm@12.5.1 run typecheck
  npx pnpm@12.5.1 run lint
  ```

  Expected: `019` passes alongside existing suites; typecheck/lint clean. Then ask Dev 1 to regenerate `src/types/database.ts` and verify with `check:database-types`.

- [ ] **Step 6: Stage (no commit — repo rule for this ticket)**

  ```bash
  git status --short
  git diff --check
  ```

  Leave the migration + pgTAP staged-or-unstaged per the team's flow, but do NOT commit (user gate: "No commitear").

---

### Task 2: `retrieve_candidate_pairs` hardening (pgTAP only, no TS)

This task owns the RPC's edge behavior end-to-end in SQL. If Task 1's happy-path already covers an edge, extend — do not duplicate for coverage theater.

**Files:**
- Extend: `supabase/tests/database/019_s2_04_retrieval.test.sql`
- Modify (only if an edge forces it): `supabase/migrations/<timestamp>_s2_04_retrieval_estimation.sql` (same file, pre-review — still uncommitted)

**Interfaces:**
- Consumes: synthetic fixtures with known cosine similarities (parallel = 1.0, orthogonal ≈ 0.0, crafted 0.749/0.751 boundary vectors).
- Produces: pinned behavior for threshold boundary, empty comparison, single-chunk versions, and D4b self-version overlap.

- [ ] **Step 1: Write the failing edge assertions**

  Similarity exactly at/around 0.75 (boundary in/out); empty `p_comparison_version_ids` → internos only, no error; source version with 1 chunk → no self-pair, internos empty for it; same version in both lists (D4b) → its chunks pair cross-role but never self-pair; `p_top_k` larger than available candidates → returns all qualifying without padding; `NULL` arrays reject; `p_workspace_id` of another tenant → 0 rows (invoker RLS).

- [ ] **Step 2: Run to verify they fail**

  ```bash
  npx pnpm@12.5.1 run test:db
  ```

  Expected: FAIL on the new assertions only; Task 1's assertions stay green.

- [ ] **Step 3: Harden the RPC body**

  Adjust only the function body (guards + internos/externos branches + ordering + `DISTINCT ON`). No signature change (the TS layer in Task 4 pins the contract §5.1 signature). No writes added — the function stays read-only, `stable`.

- [ ] **Step 4: Verify green + lint the SQL**

  ```bash
  npx pnpm@12.5.1 run test:db
  git diff --check
  ```

---

### Task 3: Formula + fingerprint (pure TS, no DB)

Pure logic. No Supabase client, no `server-only` side effects beyond the module's own purity — importable by tests without credentials.

**Files:**
- Create: `src/modules/analysis/pricing.ts`
- Create: `src/modules/analysis/retrieval.ts`
- Test: `tests/unit/analysis-pricing.test.ts`
- Test: `tests/unit/analysis-fingerprint.test.ts`
- Test: `tests/unit/analysis-retrieval.test.ts`

**Interfaces:**
- Consumes: `{ chunkCount, candidatePairCount }`; the contract §7 fingerprint inputs (sorted ids, counts, versions, retrieval params, pairHashes).
- Produces:
  - `computeFixedCost(chunkCount, candidatePairCount): number` — verbatim contract §6 (`Math.floor((100 + 5*chunks + 20*pairs + 99)/100)`), always `>= 1` for non-negative inputs.
  - `ANALYSIS_PRICING = { version: "s2-04-v1", … } as const` + formula snapshot test.
  - `computeRequestFingerprint(input): string` — contract §7 shape verbatim (sorted keys, zero whitespace), SHA-256 hex (64 chars); `embeddingRevision: "gte-small-384-v1"`, `similarityThreshold: 0.75`, `topK: 5`.
  - `canonicalizePair(a, b): [string, string] | null` — D7 mirror (`null` on self-pair).

- [ ] **Step 1: Write the failing tests**

  Pricing: reference cases verbatim (10+5 → 3, 0+0 → 1, 100+0 → 6); 50 randomized non-negative counts → integer `>= 1`; formula snapshot pins the exact arithmetic. Fingerprint: reordered input → identical hash; one id changed → different hash; threshold/topK/pricing/prompt/output-schema/counts/pairHashes change → different hash; output matches `/^[0-9a-f]{64}$/`; `pairHashes` ordered by `(source, comparison)`; `chunksRevision` from sorted ids. D7 mirror: `(a,b)` and `(b,a)` collapse; `(a,a)` → `null`.

- [ ] **Step 2: Run to verify they fail**

  ```bash
  npx pnpm@12.5.1 run test:unit
  ```

  Expected: FAIL with `Failed to resolve import "@/modules/analysis/pricing"` (or `./pricing`).

- [ ] **Step 3: Implement `pricing.ts` + `retrieval.ts`**

  Verbatim §6 formula; `node:crypto` SHA-256; canonical JSON with sorted keys and zero whitespace (document the exact canonicalization in JSDoc — S2-05/S2-06 must reproduce it byte-identically per contract §12). Frozen version strings as `as const`; `<valor>` placeholders for prompt/output-schema/pricing resolved per spec §8 and recorded in review pending (c).

- [ ] **Step 4: Verify green + types + lint**

  ```bash
  npx pnpm@12.5.1 run test:unit
  npx pnpm@12.5.1 run typecheck
  npx pnpm@12.5.1 run lint
  ```

- [ ] **Step 5: Stage (no commit)**

  ```bash
  git add src/modules/analysis/pricing.ts src/modules/analysis/retrieval.ts tests/unit/analysis-pricing.test.ts tests/unit/analysis-fingerprint.test.ts tests/unit/analysis-retrieval.test.ts
  git status --short
  ```

---

### Task 4: Server Action `estimateAnalysis` (+ schemas, queries, index)

The session-scoped path. Mirrors `credits/queries.ts` (session RLS reads) and `ingestion/actions.ts` (`requireDocumentActor` + controlled English messages + `captureOperationFailure`). No `service_role` — the insert rides the contract §4.3 policy.

**Files:**
- Create: `src/modules/analysis/schemas.ts`
- Create: `src/modules/analysis/queries.ts`
- Create: `src/modules/analysis/actions.ts`
- Create: `src/modules/analysis/index.ts`
- Test: `tests/unit/analysis-estimate.test.ts`
- Test: `tests/integration/analysis-estimation.test.ts`

**Interfaces:**
- Consumes: `AnalysisSelectionInput` (client), `Actor` (server-derived), Task 3 functions, Task 1 RPC + table.
- Produces: `estimateAnalysis(input): Promise<ActionResult<AnalysisEstimate>>` — exact `contracts.ts:322` signature; `index.ts` re-exports only `estimateAnalysis` (server-only, like `credits/index.ts`).

- [ ] **Step 1: Write the failing unit tests (mocked DB/identity)**

  Zod: malformed UUID, empty sources, > 20 ids, intra-list duplicate (D4a) → invalid; empty comparison + cross-list membership (D4b) → valid. Action: anonymous → `UNAUTHENTICATED`; Member → `FORBIDDEN`; foreign/garbage version → identical `NOT_FOUND` message (Review Focus #2); RPC throws → `INTERNAL_ERROR` + `correlationId` + `captureOperationFailure` called once with `{ module: "analysis", operation: "estimate" }`; success → normalized lists + `fixedCost` matching the §6 reference arithmetic + UUID `estimateRef` + `expiresAt ≈ now+30min`; telemetry mock asserts no chunk text/embedding in the payload (Review Focus #6: `source_text` hashed into `pairHashes`, then discarded).

- [ ] **Step 2: Run to verify they fail**

  ```bash
  npx pnpm@12.5.1 run test:unit
  ```

  Expected: FAIL with missing `@/modules/analysis` imports.

- [ ] **Step 3: Implement `schemas.ts` → `retrieval.ts` reuse → `queries.ts` → `actions.ts` → `index.ts`**

  `schemas.ts`: `selectionSchema` (UUID arrays, 1–20/0–20 caps, intra-list uniqueness refinement — cross-list overlap explicitly allowed). `queries.ts` (session client only): `getEligibleVersions` (RLS, `processing_status = 'ready' AND version_status = 'active'`, workspace-scoped) + `callRetrieveCandidatePairs` (param order `p_top_k, p_threshold` per §5.1, values `5, 0.75`) + `insertEstimate` (insert policy `initiator_id = auth.uid()` enforced by DB; assert single row returned). `actions.ts`: `requireDocumentActor` → parse → D4a check → eligibility (missing/foreign/ineligible → single `NOT_FOUND`) → RPC → Task 3 pricing + fingerprint → insert → return. `index.ts`: `export { estimateAnalysis }` only.

- [ ] **Step 4: Write the integration test (local Supabase, real fixtures)**

  Flow: reserve → upload → `finalize` → process (reuse S1-04 fixtures/scenario) → `estimateAnalysis` as workspace Admin → `ok` with integer cost `>= 1` + UUID ref + 30-min expiry; ticket case shape (10 chunks + 5 pairs → 3) asserted at unit level, spot-checked here if fixtures allow; tenant-B actor → `NOT_FOUND`; Member → `FORBIDDEN`; intra-list dup → `INVALID_INPUT`; empty comparison → `ok`, `candidatePairCount = 0`. Run with:

  ```bash
  npx pnpm@12.5.1 run test:integration
  ```

- [ ] **Step 5: Verify green + types + lint**

  ```bash
  npx pnpm@12.5.1 run test:unit
  npx pnpm@12.5.1 run typecheck
  npx pnpm@12.5.1 run lint
  ```

- [ ] **Step 6: Stage (no commit)**

  ```bash
  git add src/modules/analysis tests/unit/analysis-estimate.test.ts tests/integration/analysis-estimation.test.ts
  git diff --check
  ```

---

### Task 5: Closure — types, gates, docs (no new behavior)

> **REQUIERE COORDINACIÓN (Dev 1).** `database.ts` regeneration and any `arquitectura-base.md` touch belong to Dev 1 review. Dev 2 verifies; Dev 1 approves.

**Files:**
- Modify (Dev 1): `src/types/database.ts` — regenerated after Task 1 migration
- Modify (only if an invariant changed): `docs/architecture/arquitectura-base.md`
- No code changes in this task unless a gate fails (then fix in the owning task's files, not here).

- [ ] **Step 1: Confirm regenerated types**

  ```bash
  npx pnpm@12.5.1 run check:database-types
  npx pnpm@12.5.1 run typecheck
  ```

  Expected: generated `Tables.analysis_estimates` + `Functions.retrieve_candidate_pairs` (9-column table return) present; no hand-edits (`git diff --stat src/types/database.ts` reviewed by Dev 1).

- [ ] **Step 2: Full gates**

  ```bash
  npx pnpm@12.5.1 run test:unit
  npx pnpm@12.5.1 run test:db
  npx pnpm@12.5.1 run typecheck
  npx pnpm@12.5.1 run lint
  ```

  Plus `git diff --check`, a no-LLM-import grep over `src/modules/analysis/` (must be empty), a no-`service_role` grep over `src/modules/analysis/` (must be empty — session-only per Global Constraints), and a no-`contracts.ts`-diff check (`git diff --stat src/types/contracts.ts` must be empty).

- [ ] **Step 3: Handoff checklist for S2-05/S2-06 (contract §12)**

  Confirm in the spec §12: estimate row readable by ref + workspace; `ESTIMATE_EXPIRED`/`ESTIMATE_STALE` mapping owned by S2-05; fingerprint shape sufficient for S2-06's re-run comparison (counts + pairHashes + chunksRevision); canonical-JSON JSDoc referenced. Update the four team pendings (spec §12 a–d) status. Stop — do NOT start S2-05 work.

---

## Execution Mode Recommendation

- **Task 0: native.** Measurement spike against local Supabase (psql, `EXPLAIN`, latency runs) with judgment calls on HNSW viability at `(m = 16, ef_construction = 64)`. A subagent adds handoff cost to an interactive probe; run it in-session. Do not start it until the user approves spec + plan.
- **Task 1: subagent-driven.** Migration + invoker RPC + pgTAP with RLS/policy/`security invoker` interplay (no `service_role` anywhere — the failure modes are subtler than S2-01's definer pattern). An isolated worker with the contract §§4–5 SQL pinned reduces blast radius and forces the red/green pgTAP loop.
- **Task 2: native.** SQL edge-hardening in the same uncommitted migration/test files — fast psql-test cycles, no TS, no cross-module coordination.
- **Task 3: native.** Pure logic, pure TDD (`pricing.ts` verbatim formula, `retrieval.ts` §7 shape). Fast edit-test cycles, no privileged clients — subagent handoff would cost more than it saves.
- **Task 4: subagent-driven.** The session-scoped Server Action touches RLS-gated reads, the invoker RPC, the insert policy, and failure mapping. Worth the isolated worker + independent test verification, mirroring the S1-02 pattern for auth-sensitive paths.
- **Task 5: native.** Verification-only closure (types coordination, gates, grep checks). The context is already loaded; finish in-session.

If Task 0 reports HNSW unusable, stop the whole plan after Task 0 regardless of mode — Tasks 1–5 stay blocked until the team resolves the retrieval path.
