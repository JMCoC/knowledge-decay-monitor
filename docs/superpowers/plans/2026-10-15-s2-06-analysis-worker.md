# S2-06 Analysis Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Task 0 is a measurement gate and runs native (no commits); Tasks 1–7 are strict TDD with atomic commits. Do NOT start any task until the user approves this plan.

**Goal:** Deliver the durable Analysis Worker — Edge Function with checkpoints, atomic claim/lease/fencing RPCs, exactly 2 automatic retries, and recovery — per the frozen spec, with fakes standing in for the unmerged S2-07/S2-08.

**Architecture:** Runtime-agnostic logic in `src/modules/analysis/worker/` (injected Supabase client, only pure imports) driven by four `security definer` RPCs (`claim/renew/complete/fail_analysis`, verbatim spec §5.1–§5.4); a thin Deno entrypoint `supabase/functions/analyze/index.ts` (token check → readiness → sweep/claim); provider and finalization behind frozen seams with throwing factories until S2-07/S2-08 merge.

**Tech Stack:** Next.js App Router + TypeScript strict, Supabase PostgreSQL (plpgsql, pgTAP via Supabase CLI), Supabase Edge Functions (Deno), Vitest, `node:crypto` (fingerprint reuse, no new hashing).

**Spec:** [`docs/superpowers/specs/2026-10-15-s2-06-analysis-worker-spec.md`](../specs/2026-10-15-s2-06-analysis-worker-spec.md) — read it before Task 1. The spec's SQL (§5.1–§5.4) is verbatim source: copy it, do not restate it. Task 0 writes its measurement verdict before anything else proceeds.

---

## Global Constraints

These apply to every task. Copy them verbatim; do not restate them per task.

**Toolchain and commands.** The repo pins `pnpm@12.5.1`. Run every command through it (`package.json:6-27` para scripts; pin en `packageManager`, `package.json:60`):

```bash
pnpm run lint
pnpm run typecheck
pnpm run test:unit
pnpm run test:db
pnpm run test:integration
pnpm run check:database-types
```

`typecheck` is `next typegen && tsc --noEmit` (`package.json:11`). Never hand-edit the lockfile or `pnpm-lock.yaml`.

**Strict TDD.** Every task writes failing tests first (red), implements minimally (green), refactors. A task with tests written after the implementation is a failed task.

**Do not touch.** `src/types/contracts.ts` (frozen by S2-01), `src/modules/ingestion/**`, `src/modules/credits/**`, migrations older than this feature, hand-edits of `src/types/database.ts` (Dev 1 regenerates, per the S2-04 precedent `2026-10-12-s2-04-retrieval-estimation.md:106,313`), the spec file itself, or any file outside this plan's File Structure table.

**Fakes never reach `src/`.** Fakes live in `tests/fakes/` only (spec §7). The plan includes a test proving production rejects fakes (Task 4). A barrel resolving to a fake in production ships invented findings — this is the catastrophic scenario the spec forbids.

**Privilege.** `service_role` only server-side (Edge entrypoint, RPCs). The worker receives its Supabase client as a parameter (spec §6).

**Sentry whitelist (spec §8).** Allowed event fields only: `module ("analysis")`, `operation (claim|batch|renew|finalize|recover)`, `code`, `correlation_id`, `analysis_id?`, `workspace_id?`, `attempt_count?`, `batch_index?`, `duration_ms?`. Never: documents, chunks, snapshots, pairs, `ANALYSIS_INTERNAL_TOKEN`, signed URLs, checkpoint content (cursor ok), provider responses, prompts. Raw exceptions never go to the SDK.

**Import ban (spec §6 E1).** The worker in `src/modules/analysis/worker/` MUST NOT import `@/lib/supabase/server`, `next/*`, anything with `import "server-only"`, `queries.ts`, `actions.ts`, or `application/*`. Only types (`database.ts`, `analysis-internal.ts`) and pure modules (`retrieval.ts`, `pricing.ts`).

**SQL fidelity.** All SQL in the migration MUST match the spec §5.1–§5.4 verbatim. Do not rewrite it; copy it. Any deviation is a spec change requiring re-approval.

---

## Review Focus

Five failure modes the spec implies that need explicit pinning. Each has a test in the owning task.

1. **A fresh `queued` job with `next_attempt_at = NULL` is never claimed.** `NULL <= now()` is NULL, not TRUE (spec §5 B1). → Task 1: insert `queued` with NULL, claim with NULL arg, assert the row is returned with `attempt_count = 1`.
2. **A claim at `attempt_count = 3` violates the `0..3` CHECK with an uncontrolled `23514`.** The claim must refuse before incrementing (spec §5 B2). → Task 1: seed `processing` expired with `attempt_count = 3`, assert claim skips it and the terminal marking fires instead.
3. **`fail_analysis` secretly increments the counter, breaking the 50-batch analysis at batch 3.** Only `claim_analysis` increments (spec §5 C5, §4.4). → Task 2: fail a job twice retryable, assert `attempt_count` unchanged and `next_attempt_at` set with the 30s/2min backoff.
4. **A fake provider ships to production and invents findings.** (spec §7.) → Task 4: `createProvider()`/`createFinalization()` throw without S2-07/S2-08; a guard test asserts no `tests/fakes` import resolves under production resolution.
5. **A stale worker's `complete`/`fail` settles another worker's job.** Fencing must reject mismatched/expired `operation_id` (spec §5 C3). → Task 2 (pgTAP: wrong-op and expired-lease → `superseded`/`22023`) + Task 6 (integration: token-obsoleto scenario, ticket BDD `sprint-2-ai-analysis.md:326-329`).

---

## File Structure

| File | Responsibility | Owner | Task |
|---|---|---|---|
| `docs/superpowers/specs/2026-10-15-s2-06-analysis-worker-spec.md` | frozen source; Task 0 writes nothing into it (verdict lives in the plan report + runbook) | team | — |
| `supabase/migrations/<ts>_s2_06_analysis_leases.sql` | `checkpoint` + `next_attempt_at` columns + 4 RPCs verbatim spec §5.1–§5.4 + `service_role` grants | Dev 2 drafts, Dev 1 reserves timestamp | 1, 2 |
| `supabase/tests/database/020_s2_06_analysis_leases.test.sql` | pgTAP for columns/grants/claim/renew/complete/fail (spec §10) | Dev 2 | 1, 2 |
| `src/types/database.ts` | regenerate after migration | Dev 1 (REQUIERE COORDINACIÓN) | 7 |
| `src/modules/analysis/worker/constants.ts` | versioned N=10, lease 180s, heartbeat 30s, backoffs 30s/2min, caps 60s/30min/90min (spec §4.3) | Dev 2 | 3 |
| `src/modules/analysis/worker/types.ts` | internal worker types (claimed job, batch cursor, outcomes) | Dev 2 | 3 |
| `src/modules/analysis/worker/claim.ts` | claim argument/response types + FIFO ordering helpers | Dev 2 | 3 |
| `src/modules/analysis/worker/context.ts` | `loadAnalysisContext` (DB-only read, per-attempt fingerprint check, C4 mapping) (spec §6) | Dev 2 | 3 |
| `src/modules/analysis/worker/batch.ts` | N-pair batch loop + per-batch renew (spec §6) | Dev 2 | 3 |
| `src/modules/analysis/worker/provider.ts` | `createProvider()` — throws until S2-07 (spec §7) | Dev 2 | 4 |
| `src/modules/analysis/worker/finalization.ts` | `AnalysisFinalization` seam + `createFinalization()` — throws until S2-08 (spec §7) | Dev 2 | 4 |
| `src/modules/analysis/worker/process-analysis.ts` | orchestration: readiness already checked → claim → batches → finalize (spec §6) | Dev 2 | 4 |
| `src/modules/analysis/worker/telemetry.ts` | Deno-compatible `reportAnalysisFailure` + JSON stdout logger (spec §8) | Dev 2 | 5 |
| `supabase/functions/analyze/index.ts` | Deno entrypoint: token → readiness → sweep/claim → orchestrate (spec §6, §11) | Dev 2 | 5 |
| `tests/fakes/analysis-provider.fake.ts` | deterministic fake `AIProvider` (latency-injectable for Task 0 (b)) | Dev 2 | 0, 3 |
| `tests/fakes/analysis-finalization.fake.ts` | fake `AnalysisFinalization` recording calls | Dev 2 | 4 |
| `tests/unit/analysis-worker-*.test.ts` | Vitest per worker file (spec §10) | Dev 2 | 3, 4, 5 |
| `tests/integration/analysis-worker.test.ts` | local Edge + local DB + fake provider: lost trigger, crash/lease, stale token, exhaustion (spec §10) | Dev 2 | 6 |
| `docs/testing/s2-06-analysis-worker-runbook.md` | mandatory runbook: local boot, sweep verify, hung-job inspection, troubleshooting, env (spec §11) | Dev 2 | 6 |
| `docs/superpowers/plans/2026-10-15-s2-06-analysis-worker.md` | this plan; Task 0 appends its verdict here | Dev 2 | 0 |

No other files. In particular: no `contracts.ts` edits, no ingestion/credits touches, no LLM SDK in `src/`, no scheduler.

---

### Task 0: Edge measurement gate (native, no commit) — SEPARADA Y PRIMERA

**Objetivo en una línea:** Producir el reporte de medición del spec §3 y un veredicto escrito B-cabe / B-no-cabe que desbloquea o detiene todo el plan.

**Dependencias:** Ninguna (primera). **Bloquea a:** TODAS las tasks posteriores — "Task 1 depende de Task 0 con veredicto B-cabe. Si Task 0 devuelve B-no-cabe, el plan se detiene y se redacta ADR-003." (gate impuesto; contenido ADR-003 en spec §3/G1: números Task 0, por qué B falla, propuesta Node worker adaptado sin ONNX con concurrencia por-workspace, token vigente, alternativas descartadas).

- [ ] **Step 1: Levantar el stack local y la función esqueleto**

  ```bash
  pnpm exec supabase start
  pnpm exec supabase functions serve analyze --no-verify-jwt
  ```

  Esqueleto mínimo en `supabase/functions/analyze/index.ts` que importa `src/modules/analysis/retrieval.ts` y expone `/health`. Verificación (a) del spec §3: el serve levanta SIN error de resolución de imports. Si (a) falla → activar Plan B del spec §3 (duplicar en `supabase/functions/analyze/lib/` + test de paridad) y registrarlo en el veredicto; la medición (b) continúa contra el Plan B.

- [ ] **Step 2: Medir latencias reales del proveedor (L_p99_par)**

  Con credenciales privadas locales (nunca en el repo ni en el reporte — solo agregados): 20 llamadas HTTP directas al endpoint de cada proveedor (Cerebras y Groq) con un prompt sintético fijo — no vía el seam AIProvider, que no existe hasta S2-07; registrar p50/p99 de cada uno. `L_p99_par` = peor de ambos p99.

- [ ] **Step 3: Medir overhead y CPU (T_overhead, cpu_por_par, límites)**

  `T_overhead` = claim + retrieval (1 par) + renew + complete/fail medianos contra Supabase local (n=10). `cpu_por_par` y límites: `limit_wall` / `limit_cpu` observados del runtime Edge local (documentar fuente: logs de `supabase functions serve` o dashboard). Fake con latencia inyectada (`tests/fakes/analysis-provider.fake.ts`, latencia = `L_p99_par`) para la prueba (b): 10 pares secuenciales end-to-end (sin LLM real, con sleep calibrado) deben completar bajo `limit_wall × 0.7` (spec §4.3, A3: `N = floor(limit × 0.7 / L_p99)` desde N=10).

- [ ] **Step 4: Aplicar las reglas G1 y escribir el veredicto (sin commit)**

  Reglas verbatim spec §3 (0.9 = 10% jitter/DNS/TLS): `T_overhead + L_p99_par > limit_wall × 0.9` → N=1 inviable → ADR-003; `limit_cpu / cpu_por_par < 10` → reducir N por CPU; `T_overhead + L_p99_par × 10 > limit_wall × 0.9` → recalibrar N. Escribir el reporte (5 valores + veredicto "B cabe, continuar" o "B no cabe, detener y redactar ADR-003" + N calibrada + decisión 3-way/paralelismo diferida #1 + decisión Sentry diferida #2 + decisión scheduler diferida #3) como apéndice fechado al final de ESTE plan (no tocar el spec). No commitear nada de esta task.

**DoD verificable:** el apéndice existe con los 5 valores, las verificaciones (a)/(b) con PASS/FAIL explícito, y una línea `Veredicto: B-cabe | B-no-cabe` + fecha. Sin esta línea de veredicto, Task 1 no arranca. El veredicto lo valida el usuario (Diego) contra los umbrales del spec §3 antes de autorizar Task 1.

**Riesgos/rollback:** credenciales reales solo en entorno local del ejecutor; si Cerebras/Groq caen durante la medición, reprogramar Step 2 (no estimar a ojo). Si el runtime local difiere del remoto, anotarlo como amenaza en el veredicto (el ticket advierte que el despliegue no queda validado: `sprint-2-ai-analysis.md:342`). Si el runtime local no expone cpu_por_par directamente, documentarlo como amenaza en el veredicto y usar la heurística del spec §3 (limit_cpu / cpu_por_par < 10) como cota inferior conservadora.

---

### Task 1: Migración + `claim_analysis` + pgTAP 020 (primera mitad SQL)

**Objetivo en una línea:** Columnas + `claim_analysis` verbatim spec §5.1 con pgTAP que prueba NULL-reclamo, FIFO, `attempt<3` y marcado terminal.

**Dependencias:** Task 0 con veredicto `B-cabe` escrito. Si `B-no-cabe`, esta task no existe: se redacta ADR-003.

**Files:**
- Create: `supabase/migrations/<timestamp>_s2_06_analysis_leases.sql` (solo columnas + `claim_analysis` + sus grants en esta task; `renew/complete/fail` llegan en Task 2, mismo archivo aún sin commitear)
- Create: `supabase/tests/database/020_s2_06_analysis_leases.test.sql`

**Interfaces:**
- Consumes: `public.analyses` + `analysis_failure_code` (`20261010192119_s2_01_analysis_tables.sql:10-56`).
- Produces: `checkpoint jsonb`, `next_attempt_at timestamptz` (server-only: fuera del `GRANT SELECT` por lista de `20261010194238_s2_01_analysis_security.sql:47-50`) + `claim_analysis(uuid)` verbatim spec §5.1 + grants `service_role`.

- [ ] **Step 1: Reservar el timestamp con Dev 1 (sin crear archivos aún)**

  Dev 1 ejecuta `pnpm exec supabase migration new s2_06_analysis_leases` y devuelve el nombre (debe ser posterior a `019_s2_04`). Dev 2 no inventa el timestamp.

- [ ] **Step 2: Escribir el pgTAP que falla (claim primero)**

  `020_s2_06_analysis_leases.test.sql`: columnas existen y son nulables; `authenticated` no puede seleccionarlas (lista cerrada spec §5); `claim_analysis(NULL)` sobre `queued` fresco (`next_attempt_at = NULL`) → 1 fila, `attempt_count = 1`, `operation_id` not null, `next_attempt_at` vuelto a NULL (Review Focus #1); segundo `queued` con `created_at` anterior → FIFO lo devuelve primero; `processing` vencido con `attempt_count = 3` → NO reclamado + marcado `failed/ATTEMPTS_EXHAUSTED` (Review Focus #2); claim dirigido con UUID elegible → ese; dirigido inelegible → cae a FIFO; doble claim concurrente (dos sesiones, `SKIP LOCKED`) → una sola fila reclamada; `authenticated` sin `EXECUTE` en la función.

- [ ] **Step 3: Correr para verificar rojo**

  ```bash
  pnpm run test:db
  ```

  Expected: FAIL — columnas/función no existen. Ese es el rojo correcto.

- [ ] **Step 4: Implementar columnas + `claim_analysis` copiando spec §5.1 verbatim**

  Copiar el bloque SQL de spec §5.1 (advisory `26061501`, timeouts, terminal + dirigido + FIFO + grants de esa función). No reescribir ni una coma; cualquier divergencia es cambio de spec.

- [ ] **Step 5: Verde + stage sin commit**

  ```bash
  pnpm run test:db
  git diff --check
  ```

  Expected: `020` verde junto a las suites existentes. No commitear (la migración crece en Task 2).

**Riesgos/rollback:** si `test:db` exige Docker no disponible, la task se bloquea (no simular pgTAP con mocks). Si Dev 1 no reserva timestamp, no crear el archivo.

---

### Task 2: `renew/complete/fail_analysis` + pgTAP (segunda mitad SQL)

**Objetivo en una línea:** Las 3 RPCs restantes verbatim spec §5.2–§5.4 con pgTAP de fencing, backoff, idempotencia y `superseded`.

**Dependencias:** Task 1 verde (mismo archivo de migración aún sin commitear).

**Files:**
- Modify: `supabase/migrations/<timestamp>_s2_06_analysis_leases.sql` (agregar §5.2–§5.4 + grants restantes)
- Extend: `supabase/tests/database/020_s2_06_analysis_leases.test.sql`

**Interfaces:**
- Consumes: Task 1 (columnas + claim).
- Produces: `renew_analysis_lease` → `TABLE(lease_expires_at)` / `complete_analysis` → `void` / `fail_analysis` → `text`, verbatim spec.

- [ ] **Step 1: Escribir el pgTAP que falla (fencing primero)**

  `renew` con `operation_id` ajeno → `22023`; con lease vencido → `22023`; con checkpoint no-objeto → `22023`; renew válido actualiza lease + checkpoint (shape spec §5 C1). `complete` válido → `completed`; repetición misma operación → no-op sin error; operación ajena → `22023`. `fail` con op ajena/lease vencido/ya-terminal → `'superseded'` (Review Focus #5); retryable con `attempt = 1` → `'queued'` + `next_attempt_at ≈ now()+30s` y `attempt_count` INALTERADO (Review Focus #3); con `attempt = 2` → `+2min`; con `attempt = 3` o no-retryable → `'failed'` + código + `finished_at`; `TODO(S2-08)` visibles como comentarios (sin efecto contable: ninguna fila en `credit_ledger`).

- [ ] **Step 2: Rojo**

  ```bash
  pnpm run test:db
  ```

  Expected: FAIL solo en las nuevas aserciones; Task 1 sigue verde.

- [ ] **Step 3: Copiar spec §5.2–§5.4 + grants verbatim**

  Tres bloques + bloque de grants, sin reescritura.

- [ ] **Step 4: Verde + diff-check**

  ```bash
  pnpm run test:db
  git diff --check
  ```

**Riesgos/rollback:** si un edge fuerza cambio de cuerpo, el cambio va al mismo archivo pre-commit y el test lo pinnea; cambio de firma = cambio de spec (re-aprobar).

---

### Task 3: Worker core puro (`constants/types/claim/context/batch`) + fakes + Vitest

**Objetivo en una línea:** Lógica runtime-agnóstica testeable con `tests/fakes/` como únicos dobles.

**Dependencias:** Task 1 (firmas RPC que `claim.ts`/`context.ts` consumen). No requiere Task 0 más allá del gate global.

**Files:**
- Create: `src/modules/analysis/worker/constants.ts`, `types.ts`, `claim.ts`, `context.ts`, `batch.ts`
- Create: `tests/fakes/analysis-provider.fake.ts`
- Test: `tests/unit/analysis-worker-constants.test.ts`, `analysis-worker-context.test.ts`, `analysis-worker-batch.test.ts`, `analysis-worker-claim.test.ts`

**Interfaces:**
- Consumes: `AIProvider` (`src/types/analysis-internal.ts:76-81`), `AnalysisCandidatePair` (`:45-48`), `computeRequestFingerprint` (`retrieval.ts:107-147`), Task 1–2 RPCs (vía cliente inyectado, nunca importado).
- Produces: constantes versionadas (N=10 de Task 0 si recalibró); tipos internos; `loadAnalysisContext` (spec §6 D1 + mapeo C4); batch-loop con 1 renew por batch (spec §6); fake con latencia inyectable.

- [ ] **Step 1: Tests rojos (fakes + contexto + batch + claim)**

  Constantes: N/lease/heartbeat/backoffs/topes iguales a Task 0 calibrada. `claim.ts`: orden FIFO por `(created_at, id)` sobre filas candidatas. `context.ts` (cliente Supabase mockeado): divide `analysis_documents` por `role` → llama RPC con `p_top_k=5, p_threshold=0.75` (`queries.ts:73-79`); mapea las 9 columnas a `AnalysisCandidatePair` (spec §6 C4); fingerprint por intento verificado contra `request_fingerprint`, divergencia → `ESTIMATE_STALE`; timeout 60s → `RETRIEVAL_FAILED`; payload con campos extra → ignorados (solo `analysisId` entra, spec §6 D1). `batch.ts`: procesa N pares secuenciales con el fake, 1 renew al cerrar, aborta sin complete/fail si renew falla (spec §5 C2). Fake: determinista + latencia inyectable.

- [ ] **Step 2: Rojo**

  ```bash
  pnpm run test:unit
  ```

  Expected: FAIL con imports `@/modules/analysis/worker/*` irresolubles.

- [ ] **Step 3: Implementar los 5 archivos + fake**

  Sin `server-only`, sin clientes, sin `queries.ts`/`actions.ts`/`application/*` (Global Constraints). `context.ts` recibe el cliente por parámetro.

- [ ] **Step 4: Verde + typecheck + lint + ban-check**

  ```bash
  pnpm run test:unit
  pnpm run typecheck
  pnpm run lint
  ```

  Más grep de prohibición sobre `src/modules/analysis/worker/` (debe dar vacío): `server-only`, `next/`, `queries`, `actions`, `application/`, `service_role`.

**Riesgos/rollback:** si `AbortSignal.timeout` no existe en el target, polyfill local en `batch.ts` (no dependencia nueva).

---

### Task 4: Orquestación + seams que lanzan + test anti-fake en prod

**Objetivo en una línea:** `process-analysis.ts` + `provider.ts`/`finalization.ts` con DI y el guard que impide fakes en producción.

**Dependencias:** Task 3 (core + fakes). S2-07/S2-08 ausentes por hipótesis: las factories DEBEN lanzar.

**Files:**
- Create: `src/modules/analysis/worker/process-analysis.ts`, `provider.ts`, `finalization.ts`
- Create: `tests/fakes/analysis-finalization.fake.ts`
- Test: `tests/unit/analysis-worker-process.test.ts`, `analysis-worker-seams.test.ts`

**Interfaces:**
- Consumes: Task 3 (core, fakes).
- Produces: `runAnalysisJob({ client, provider, finalization, analysisId })` (nombres exactos que Task 5 importa); `createProvider()` → throw `"S2-07 not merged: AIProvider unavailable."`; `createFinalization()` → throw análogo S2-08; seam `finalize({analysisId, operationId, outcome})` congelado (spec §7).

- [ ] **Step 1: Tests rojos (orquestación + seams + anti-fake)**

  Flujo con fakes: claim → batches hasta cursor total → `finalize(completed)`; fallo provider ambos intentos → `fail_analysis` con `PROVIDER_UNAVAILABLE`; renew caído → aborto sin complete/fail; kill simulado (sin llamada terminal) → job sigue `processing` (spec §8 F1: solo el worker que decide fallar persiste código). Seams: ambas factories lanzan; el orquestador NUNCA las llama en tests (siempre DI explícita). Anti-fake (Review Focus #4): con `NODE_ENV=production`, resolver provider/finalization por defecto lanza en vez de devolver fakes; grep-test: ningún archivo bajo `src/` importa `tests/fakes`.

- [ ] **Step 2: Rojo**

  ```bash
  pnpm run test:unit
  ```

- [ ] **Step 3: Implementar los 3 archivos + fake de finalización**

  `process-analysis.ts` no decide contabilidad: delega estado a `complete/fail_analysis` vía el seam v1 (spec §7, Nota PRD-1). Sin texto de usuario aquí (spec §9 vive en S2-09).

- [ ] **Step 4: Verde + gates**

  ```bash
  pnpm run test:unit
  pnpm run typecheck
  pnpm run lint
  ```

**Riesgos/rollback:** si la firma del orquestador choca con Task 5, se ajusta aquí (pre-commit de Task 5).

---

### Task 5: Entrypoint Deno + telemetry propia + readiness (503 sin claim)

**Objetivo en una línea:** La Edge arranca, autentica, verifica readiness ANTES del claim y emite telemetría sanitizada.

**Dependencias:** Task 4 (orquestación + seams). Decisión Sentry diferida #2 de Task 0 (qué SDK corre en Edge).

**Files:**
- Create: `supabase/functions/analyze/index.ts`, `src/modules/analysis/worker/telemetry.ts`
- Test: `tests/unit/analysis-worker-telemetry.test.ts`, `analysis-worker-readiness.test.ts`

**Interfaces:**
- Consumes: Task 4 (`runAnalysisJob`, factories).
- Produces: handler Deno (token 401 → readiness 503-sin-claim → sweep/claim → orquesta); `reportAnalysisFailure` manual + stdout JSON (spec §8).

- [ ] **Step 1: Tests rojos (telemetry + readiness)**

  Telemetry: evento construido con solo campos whitelist (spec §8); par con texto real → el evento NO contiene el texto; excepción cruda → nunca llega al SDK (inyectar SDK mock y assert cero llamadas con `Error`); paridad de shape con S1-08 (`operation-events`): mismo input → mismo shape (spec §8 F2). Readiness (spec §11 G2): sin token → 401 y cero RPCs; factories lanzando → 503 y cero claims (el job queda `queued`); todo ok → procede al claim. stdout: línea JSON parseable con campos ⊆ whitelist.

- [ ] **Step 2: Rojo**

  ```bash
  pnpm run test:unit
  ```

- [ ] **Step 3: Implementar entrypoint + telemetry**

  Deno con `npm:@supabase/supabase-js`, cliente con `service_role` desde env (nunca al cliente). Orden del handler: token → readiness → claim/sweep → orquestar → self-fetch al siguiente batch (happy path, spec §4.2) con el mismo token. Sin `setTimeout` para backoff (spec §4.4: el sweep reclama por `next_attempt_at`).

- [ ] **Step 4: Verde + serve local del entrypoint**

  ```bash
  pnpm run test:unit
  pnpm exec supabase functions serve analyze --no-verify-jwt
  ```

  Expected: `/health` (o equivalente) responde; readiness sin S2-07/08 → 503 y ningún claim en DB local.

**Riesgos/rollback:** si ningún SDK Sentry corre en Deno, telemetry degrada a stdout-only y se registra como deuda (spec §12.1 fila 3). Token: nombre a coordinar con Dev 1 (spec §4.1).

---

### Task 6: Runbook + integración local (Edge servida + DB local + fake)

**Objetivo en una línea:** Probar los 4 escenarios BDD del ticket contra la Edge real servida localmente y entregar el runbook obligatorio.

**Dependencias:** Tasks 1–5 verdes. Requiere Docker/Supabase local.

**Files:**
- Create: `tests/integration/analysis-worker.test.ts`
- Create: `docs/testing/s2-06-analysis-worker-runbook.md`

**Interfaces:**
- Consumes: todo lo anterior + fixtures SQL de análisis (job `queued` fresco, `processing` vencido, workspace ajeno).
- Produces: escenarios verdes + runbook (arranque, sweep, colgados, troubleshooting, env — spec §11).

- [ ] **Step 1: Tests de integración rojos (4 escenarios BDD)**

  Disparo perdido (`sprint-2-ai-analysis.md:321-324`): commit `queued` sin invoke → sweep lo reclama sin nuevo cargo (sin fila extra en `credit_ledger`). Crash/lease: matar la Edge a mitad de batches → `processing` con lease → expira → siguiente claim continúa desde `checkpoint` (cursor avanzó, no reprocesa batch 0). Token obsoleto (`:326-329`): worker A con lease vencido intenta `complete` → rechazado (`22023`/`superseded`), sin findings ni movimiento contable (Review Focus #5). Agotamiento (`:331-334`): provider fake siempre-falla ×3 intentos → `failed`, cero parciales visibles, `TODO(S2-08)` marcados como pendientes (reserva intacta en v1 — assert explícito, spec §5 C1/C3). Cada test etiquetado `FAKE-PROVIDER` para S2-12 (ticket `:343`).

- [ ] **Step 2: Rojo**

  ```bash
  pnpm run test:integration
  ```

- [ ] **Step 3: Cablear integración + escribir el runbook**

  Fixtures + harness (Edge servida + DB local). Runbook con comandos reales ejecutados, ventana de sweep medida, cómo inspeccionar colgados (`status='processing' AND lease_expires_at < now()`), tabla fallo→código (spec §8 F1), variables (`ANALYSIS_INTERNAL_TOKEN`, `service_role`, proveedor futuro).

- [ ] **Step 4: Verde de punta a punta local**

  ```bash
  pnpm run test:integration
  pnpm run test:db
  ```

**Riesgos/rollback:** timings flaky (lease 180s real es largo para tests): la integración puede usar leases cortos SOLO vía RPCs con parámetros de test si el diseño lo permite — si no, documentar la espera y no acortar el SQL productivo. Nunca `--linked`, nunca seed remoto (regla del repo).

---

### Task 7: Cierre — tipos, gates, checklist §11 (sin comportamiento nuevo)

**Objetivo en una línea:** Dejar la rama con tipos regenerados, gates verdes y la checklist de integración explícita.

**Dependencias:** Tasks 0–6. Coordinación Dev 1 (tipos) y visibilidad Dev 3 (S2-09/S2-12).

**Files:**
- Modify (Dev 1): `src/types/database.ts` — regenerado, nunca a mano
- Ningún otro cambio salvo fixes que un gate exija (el fix va en la task dueña, no aquí)

- [ ] **Step 1: Tipos regenerados**

  ```bash
  pnpm run check:database-types
  pnpm run typecheck
  ```

  Expected: `Tables.analyses` con `checkpoint`/`next_attempt_at` + funciones `claim/renew/complete/fail_analysis`; Dev 1 aprueba el diff.

- [ ] **Step 2: Gates completos + prohibiciones**

  ```bash
  pnpm run test:unit
  pnpm run test:db
  pnpm run typecheck
  pnpm run lint
  git diff --check
  ```

  Más: `git diff --stat src/types/contracts.ts` vacío; grep `service_role` en `src/modules/analysis/worker/` vacío (solo Edge/RPCs); grep `tests/fakes` en `src/` vacío; grep de pares/chunks en `telemetry.ts` vacío.

- [ ] **Step 3: Checklist §11 publicada y estado "completo pendiente de integración"**

  Verificar cada ítem con dueño/condición (spec §11: provider real S2-07, finalization real S2-08, texto F3 S2-08, 3×TODO S2-08, `canRetry` S2-05) marcado pendiente con su dueño; confirmar en el spec §12 que deuda/diferidas siguen vigentes. Stop — no empezar S2-07/S2-08 ni el plan siguiente. No commitear (gate del usuario).

**Riesgos/rollback:** ninguno (solo verificación). Si un gate falla, volver a la task dueña.

---

## Execution Mode Recommendation

- **Task 0: native.** Medición interactiva contra Supabase local y proveedores reales (psql, `serve`, latencias) con juicio sobre B-cabe/B-no-cabe; un subagente añade costo de handoff a un probe con criterio.
- **Tasks 1–2: subagent-driven.** SQL privilegiado con fencing/RLS/grants donde el loop rojo-verde pgTAP se beneficia de un worker aislado y revisión independiente.
- **Tasks 3–4: native.** TypeScript puro con TDD rápido y contexto ya cargado; el handoff costaría más de lo que ahorra.
- **Task 5: subagent-driven.** Entrypoint Deno + readiness + telemetría: runtime distinto, riesgo de importar lo prohibido — vale revisión independiente.
- **Tasks 6–7: native.** Integración local y cierre verificador con el contexto completo ya en sesión.

If Task 0 returns B-no-cabe, the whole plan stops after Task 0 regardless of mode — Tasks 1–7 stay blocked until ADR-003 lands.

---

## Apéndice Task 0 — reporte de medición (lo escribe Task 0, no ahora)

`limit_wall:` · `limit_cpu:` · `L_p99_par (Cerebras):` · `L_p99_par (Groq):` · `T_overhead:` · `cpu_por_par:` · `(a) imports:` PASS|FAIL · `(b) N=10:` PASS|FAIL · `N calibrada:` · `Veredicto: B-cabe | B-no-cabe` · fecha. Sin esta línea de veredicto, Task 1 no arranca.
