# Runbook — S2-06 Analysis Worker (local + troubleshooting)

Scope: S2-06 worker (`queued → processing → completed | failed`, leases,
checkpoints, sweep) plus S2-05's optional durable recovery schedule. The
schedule is installed but disabled until its local/hosted Vault configuration
is supplied and explicitly enabled. v1 ends at state transitions; S2-08 owns
findings, credits and events. All commands run from the repo root with
`packageManager`-pinned pnpm 12.5.1.

## 1. Arranque local

```bash
pnpm exec supabase start
pnpm exec supabase functions serve analyze --no-verify-jwt \
  --env-file /tmp/kdm-edge/analyze.env
```

Minimal env file (`analyze.env`, values are local-only examples):

```bash
ANALYSIS_SUPABASE_URL=http://127.0.0.1:54321
ANALYSIS_SUPABASE_SERVICE_ROLE_KEY=<local service_role key>
ANALYSIS_INTERNAL_TOKEN=<random uuid>
ANALYSIS_FAKE_PROVIDER=1
ANALYSIS_FAKE_LATENCY_MS=400
```

The handler accepts POST only. A missing or wrong internal token is rejected
before a job can be claimed:

```bash
curl -i -X POST http://127.0.0.1:54321/functions/v1/analyze \
  -H "content-type: application/json" \
  -H "authorization: Bearer wrong-local-token" \
  -d '{}'
# → 401; no job is claimed
```

Trigger one analysis (fire-and-forget; the response acknowledges that the
bounded background run was accepted, not that analysis completed):

```bash
curl -sS -X POST http://127.0.0.1:54321/functions/v1/analyze \
  -H "content-type: application/json" \
  -H "authorization: Bearer <ANALYSIS_INTERNAL_TOKEN>" \
  -d '{"analysisId": "<uuid>"}'
# → 202 {"ok":true,"accepted":true}; inspect the database for progress
```

## 2. Verificación del sweep

A queued job with no trigger must be claimed through the FIFO sweep
(spec §4.2). Direct it at an unknown id so the directed claim misses:

```bash
curl -sS -X POST http://127.0.0.1:54321/functions/v1/analyze \
  -H "content-type: application/json" \
  -H "authorization: Bearer <token>" \
  -d '{"analysisId": "00000000-0000-4000-8000-000000000000"}'
```

With ready local test doubles or product adapters, expect
`202 {"ok":true,"accepted":true}`. This is only an acknowledgement; check
the job row for the actual `status`, `attempt_count` and checkpoint. If the
provider/finalization seams are not ready, the handler returns 503 before
claiming, so the row stays queued and `attempt_count` stays unchanged.

### Durable recovery (S2-05)

Run the local scheduler integration without calling the recovery endpoint from
the test. It creates a queued analysis, enables the one-minute `pg_cron` job,
then observes the real `pg_cron → pg_net → analyze` path and cleans up only the
cron job and temporary Vault secrets it created:

```bash
node scripts/with-local-supabase.mjs integration tests/integration/analysis-recovery.test.ts
```

The integration verifies that readiness and bad-token failures do not claim,
that a lost continuation is recovered without incrementing the attempt, and
that a killed worker is reclaimed only after its real lease expires. It uses
local fake-provider behavior; it does not prove hosted scheduling or real
provider/finalization acceptance.

To inspect local scheduler state without exposing Vault values:

```sql
select jobid, jobname, schedule, active, username
from cron.job where jobname = 'kdm-analysis-recovery';

select jobid, status, start_time, end_time
from cron.job_run_details
where jobid in (select jobid from cron.job where jobname = 'kdm-analysis-recovery')
order by start_time desc limit 10;

select id as request_id, status_code
from net._http_response order by id desc limit 10;

select public.configure_analysis_recovery(false);
```

The migration installs extensions and the disabled-by-default configuration
function; it does not enable a schedule. Enabling requires Vault entries named
`analysis_function_url` and `analysis_internal_token`, scoped to this project.
The only allowed URL is this project's `.../functions/v1/analyze` endpoint;
local PostgreSQL must use its Docker/Kong address such as
`http://api.supabase.internal:8000/functions/v1/analyze`, not host loopback.
Keep the token in Vault and the worker's local env file only; do not select,
print or check it in.

## 3. Inspección de jobs colgados

```sql
-- Processing with an expired lease: reclaimable by the next sweep.
select id, workspace_id, attempt_count, lease_expires_at, started_at,
       attempt_started_at, attempt_deadline_at, analysis_deadline_at
from public.analyses
where status = 'processing' and lease_expires_at < now()
order by lease_expires_at;

-- Queued past their backoff: next to be swept.
select id, workspace_id, attempt_count, continuation_pending,
       next_attempt_at, attempt_deadline_at, analysis_deadline_at
from public.analyses
where status = 'queued'
  and (next_attempt_at is null or next_attempt_at <= now())
order by created_at, id;
```

A job that stays `processing` with a fresh lease is healthy (a worker
owns it). A job stuck `processing` with an expired lease and
`attempt_count >= 3` is marked `failed/ATTEMPTS_EXHAUSTED` by the next
claim. A queued continuation is identified by `continuation_pending=true`:
claiming it rotates `operation_id` but preserves the attempt count, checkpoint,
attempt deadline and 90-minute total deadline. It occupies the same active
workspace slot and does not use backoff. A recoverable error clears the marker
and applies the existing 30-second / 2-minute retry backoff; an expired
continuation is terminal `failed/TIMEOUT`, not another attempt. The first
claim starts a 30-minute attempt deadline and a 90-minute total deadline;
renewal and continuation never extend either one. Terminal marking still does
not move credits or emit events in v1 — TODO S2-08.

## 4. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `401 {"error":"unauthorized"}` | Missing/wrong `Authorization: Bearer` (spec §11 G2) | Use the exact `ANALYSIS_INTERNAL_TOKEN` value |
| `503 {"error":"not ready"}` | `createProvider()`/`createFinalization()` throw (S2-07/S2-08 unmerged) or client init failed | Expected until S2-07/S2-08 merge; jobs stay `queued` |
| `400 {"error":"invalid analysisId"}` | Missing/empty `analysisId` in body | Send `{ "analysisId": "<uuid>" }` |
| `worker boot error: Module not found "..." ` (no `.ts`) | Relative import without extension in the Edge graph | Add `.ts` (rule 9 below); the guard test fails first |
| `Env name cannot start with SUPABASE_, skipping` | `--env-file` values with reserved prefix are dropped | Use `ANALYSIS_*` names (section 5) |
| `No such container: supabase_edge_runtime_*` loops | Runtime container removed out-of-band | Never `docker rm` it; restart the serve and let the CLI own it |
| Kong `401 UNAUTHORIZED_*` on every request | Transient Kong config churn after stack restart | Wait ~30s / re-run; requests must carry `Authorization` |

## 5. Variables de entorno

| Variable | Source | Purpose |
|---|---|---|
| `ANALYSIS_INTERNAL_TOKEN` | Next.js app + Edge, secret | Dedicated Bearer token for Run/Retry dispatch and Edge self-fetch; separate from ingestion |
| `ANALYSIS_SUPABASE_URL` | harness (`http://127.0.0.1:54321`) | Gate URL (loopback proof) + DB fallback |
| `ANALYSIS_SUPABASE_SERVICE_ROLE_KEY` | local stack | DB fallback key |
| `SUPABASE_URL` | **runtime-injected** (`http://kong:8000`) | Real DB connectivity inside workers |
| `SUPABASE_SERVICE_ROLE_KEY` | **runtime-injected** | Real DB key inside workers |
| `ANALYSIS_FAKE_PROVIDER=1` | tests only | Enables the test doubles branch |
| `ANALYSIS_FAKE_LATENCY_MS` / `_FAIL_AT_CALL_INDEX` / `_FAIL_CODE` / `_THROW_CODE` | tests only | Fake behavior (env defaults) |
| Request body `_fake: {...}` | tests only, per request | Overrides env fake behavior; honored only with the gate open |

`SUPABASE_*` values in `--env-file` are silently skipped (reserved
prefix); never rely on setting them from files.

Configure the same `ANALYSIS_INTERNAL_TOKEN` secret in the Next.js server
environment and the Edge Function. Never expose it as a `NEXT_PUBLIC_*`
variable or reuse `INGESTION_INTERNAL_TOKEN`.

## 6. Gate isLocalTestEnv: modelo de amenaza

The fake provider and the v1 test finalization load only when ALL hold:
(a) `ANALYSIS_FAKE_PROVIDER === "1"`, (b) `ANALYSIS_SUPABASE_URL`
parses to loopback, (c) runtime `SUPABASE_URL` is NOT hosted
(`*.supabase.co` / `*.supabase.in` fail closed). Rationale: env-write
already equals project compromise, but the hosted check removes the
remaining hole where a loopback-looking harness URL could be spoofed
next to a production runtime URL. Unit-pinned in
`tests/unit/analysis-worker-readiness.test.ts` (flag/url matrix +
hosted-spoof case). Production will never satisfy (b)+(c) together.

## 7. Ventana de sweep medida

Task 0 numbers (local Edge, `supabase-edge-runtime-1.74.3`):
`limit_wall=150s`, `L_p99_par=5092ms` (Cerebras `qwen-3.8-27b`),
`T_overhead≈22ms` (ingestion-RPC proxy), batch `N=10` ≈ 51s worst case
against a 105s budget (`150s × 0.7`). Integration timings (5-run
median): single-batch invoke ≈ 1–6s, checkpoint resume ≈ 2 invocations,
full 30-pair analysis ≈ 3 claims. That timing predates the durable continuation
state: it is not evidence that the current worker paginates successfully or
that batches preserve attempt_count. The database handoff and Task 6 worker
pagination are covered by SQL, unit and concurrent-session tests. S2-05 Task 7
adds an optional one-minute pg_cron schedule that invokes the same Edge sweep
through pg_net. The schedule remains disabled until explicitly configured; an
expired lease is reclaimed by a scheduled run after expiry. The local
integration above demonstrates this with fake-provider behavior only.

## 8. Deuda (S2-08 y bundle Edge)

- TODO(S2-08): `complete/fail_analysis` move no credits and emit no
  events in v1 (spec §12.1 filas 5–7). The `failed`/`completed`
  statuses are real; the ledger, findings and notifications are not.
- TODO(S2-08): findings cross-invocation are lost until S2-08 staging
  (spec §12.1 fila 8): the `completed` close of the last invocation
  carries only its own batch findings. RLS already hides findings of
  non-completed analyses, which is what makes per-batch staging safe
  to add later.
- TODO(S2-06 Task 7): the deployable bundle includes `_test_doubles/`
  (statically imported so Deno preloads them; the gate decides use).
  Task 7 evaluates a separate entrypoint to exclude them from deploy.
- TODO(Task 0 gap): the real Deno import graph was not verified until
  Task 6 (the Task-0 skeleton imported a single module). Regression
  guard: `tests/unit/deno-import-extensions.test.ts` fails if any
  relative import in the Edge graph loses its `.ts` extension.

## 9. Reglas de imports en este repo

- `src/**` y `app/**`: imports SIN extensión (convención Next.js /
  bundler; `moduleResolution: bundler`).
- `supabase/functions/**` y todo su grafo Deno (`src/modules/analysis/worker/**`,
  `src/modules/analysis/retrieval.ts`, `src/types/**`,
  `supabase/functions/analyze/_test_doubles/**`): imports CON extensión
  `.ts` explícita — requerido por el Deno Edge Runtime, que resuelve
  hasta los `import type` al construir el grafo.
- El flag `allowImportingTsExtensions` en `tsconfig.json` habilita lo
  segundo sin afectar lo primero (verificado: `typecheck` + `build`
  verdes con ambas convenciones conviviendo).

## 10. Checklist de cierre S2-06 (estado: completo pendiente de integración)

| # | Ítem | Dueño | Condición de cierre | Estado |
|---|------|-------|---------------------|--------|
| 1 | createProvider() real (S2-07) | S2-07 | Test de integración con proveedor real | Pendiente S2-07 |
| 2 | createFinalization() real (S2-08) | S2-08 | Test integración findings + ledger + eventos | Pendiente S2-08 |
| 3 | Texto F3 con liberación ("Analysis failed. Your credits were released. Retry creates a new run.") | S2-08 | S2-08 merge | Pendiente S2-08 |
| 4 | TODO(S2-08) en claim/complete/fail (liberación + evento) | S2-08 | S2-08 merge | Pendiente S2-08 |
| 5 | Retry bloquea otro run activo; `AnalysisSnapshot.canRetry` refleja estado/ledger/slot | S2-05 / S2-09 | SQL Retry y contrato de lectura S2-09 | RPC S2-05 implementada y probada localmente; proyección `canRetry` pendiente S2-09 |
| 6 | Slot único retiene workspace ≤90min | S2-06 | Documentado (fila 1 §12.1) | Documentado |
| 7 | Sentry remoto del worker | S2-08 | Fila 3 §12.1 | Documentado (stdout-only v1) |
| 8 | Bundle deployable incluye _test_doubles | Task 7 | Fila 10 §12.1 | Documentado (opción A) |
| 9 | Flake test:integration | S2-06 / CI | Fila 11 §12.1 | Bajo observación |

Estado del ticket: completo pendiente de integración (G2=A). Cerrar
sólo cuando S2-07 y S2-08 estén mergeados y sus tests de integración
verdes.
