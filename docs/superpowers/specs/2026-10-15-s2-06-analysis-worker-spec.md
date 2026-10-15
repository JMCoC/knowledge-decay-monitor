# Spec S2-06 — Analysis Worker durable, leases y recuperación automática

- **Ticket:** S2-06 (SAA-18), responsable Diego Alejandro Tolosa Sanchez (`docs/Tickets/sprint-2-ai-analysis.md:30`).
- **Rama:** `feature/analysis_worker_durable` (creada desde `develop`).
- **Estado:** Diseño aprobado por bloques A–G; pendiente revisión escrita de este spec antes de implementar.
- **Fecha:** 2026-10-15.

> Este spec no contiene implementación. Cada afirmación cita su fuente como `archivo:línea` o referencia al ticket S2-06 (`docs/Tickets/sprint-2-ai-analysis.md:296-343`).
>
> Nota de estructura: el orden final es Trigger (§4) → RPCs (§5) → Worker (§6), con Seams (§7), Observabilidad (§8), Usuario (§9), Tests (§10), Cierre (§11) y Deuda (§12).

---

## 1. Contexto y objetivo

S2-06 es el worker que ejecuta un análisis ya encolado por S2-05: retrieval (S2-04), provider LLM (S2-07) y finalización (S2-08), con leases, fencing, retries y recuperación de jobs colgados (`sprint-2-ai-analysis.md:296-317`). Historia de usuario: el análisis termina aunque el usuario cierre sesión o falle un proceso (`:300-304`).

El monolito es modular por negocio (ADR-001) y el runtime de cada slice se decide con evidencia (`docs/architecture/adr/ADR-001-monolito-modular.md:25,52`). ADR-002 documentó el fallo real de Edge en ingesta (`HTTP 546/WORKER_LIMIT`, `docs/architecture/adr/ADR-002-durable-ingestion-worker.md:5`) y migró ingesta a Node; el ticket S2-06 declara que ADR-002 "corresponde a ingesta y no autoriza cambiar este runtime" y exige Edge Function según PRD §30 (`sprint-2-ai-analysis.md:308`), admitiendo checkpoints y, solo si no cabe, ADR revisado (`:316`).

---

## 2. Alcance y no-objetivos

**Incluye:** claim atómico `queued → processing` con lease renovable y fencing (`:309`); lectura de actor/tenant/scope/coste/configuración persistidos (`:310`); ejecución de retrieval S2-04 + proveedor S2-07 + finalización S2-08 (`:311`); recovery de queued sin disparo y processing con lease vencido con navegador cerrado (`:312`); inicial + exactamente 2 retries con backoff acotado, reserva conservada (`:313`); rechazo de workers con lease vencido (`:314`); cierre failed vía S2-08 con cero parciales, liberación y evento (`:315`); medición Edge con corpus grande y checkpoints (`:316`); pruebas de claim concurrente, crash, disparo perdido, salida obsoleta, agotamiento, readiness y runbook (`:317`).

**No incluye:** parsing/embeddings de documentos ni modificación de originales (`:311`); liquidación/liberación de créditos ni emisión de eventos en v1 — son `TODO(S2-08)` (§7); E2E con proveedores reales y Playwright — corresponde a S2-12 (`:613-621` en su bloque); checkout/paquetes (S2-02, fuera de alcance, `:138`); recorte del scope de 20 versiones — prohibido por el ticket (`:316`).

---

## 3. Runtime y Task 0 (medición antes de confirmar Edge)

Decisión A1=B: Edge Function con checkpoints y re-entrada. Task 0 mide límites reales de Edge (wall-clock, CPU) con un batch real contra el proveedor antes de confirmar que B cabe; si N=1 no cabe, se escala a C (Node worker) con ADR-003 (G1).

Task 0 reporta obligatoriamente: `limit_wall`, `limit_cpu`, `L_p99_par` (Cerebras y Groq reales), `T_overhead` (retrieval + claim + renew + complete/fail con 1 par), `cpu_por_par`; y verifica (a) que los imports resuelven (`supabase functions serve analyze` levanta con import real de `src/modules/analysis/retrieval.ts`) y (b) que N=10 pares con `analyzePair` fake de latencia realista no excede el límite Edge (E1).

Reglas numéricas (G1, razón del 0.9 = 10% para jitter, DNS, TLS, primeros bytes): si `T_overhead + L_p99_par > limit_wall × 0.9` → N=1 inviable → ADR-003 obligatorio; si `limit_cpu / cpu_por_par < 10` → N se reduce por CPU; si `T_overhead + L_p99_par × 10 > limit_wall × 0.9` → N=10 inviable → recalibrar N. Si (a) falla → Plan B: duplicar la lógica pura en `supabase/functions/analyze/lib/` + test de paridad Node-Deno que verifica el fingerprint byte a byte (E1). No redactar ADR-003 especulativamente; no recortar scope (G1).

---

## 4. Trigger, recovery e intervalos

### 4.1 Disparo inicial (B1=A)

La Server Action de S2-05 hace fetch firmado a la Edge con payload mínimo `{ analysisId }` tras el commit, fire-and-forget sin esperar respuesta; el worker relee todo de DB con `service_role` y hace su propio claim sin confiar en el caller; el sweep cubre el fallo de invocación (`:263` del bloque S2-05: invocación best-effort post-commit, job recuperable). Token interno: reusar el patrón `INGESTION_INTERNAL_TOKEN` (renombrar a `ANALYSIS_INTERNAL_TOKEN` o compartir — decidir con Dev 1, dueño de S2-05).

> Nota PRD-2 (discrepancia documentada): "El PRD §30 pide scheduled recovery. La v1 usa sweep oportunista (cada invocación barre stale jobs antes de reclamar) porque no hay pg_cron ni Scheduled Function en el repo. Task 0 evalúa migrar a scheduler si la ventana medida no alcanza (decisión diferida #3)."

### 4.2 Sweep oportunista v1 (B2=A)

Sin pg_cron en v1; cada invocación ejecuta primero el sweep y luego reclama (roles separados: self-fetch = happy path al siguiente batch, sweep = recovery; el fencing por `operation_id`, `supabase/migrations/20261010192119_s2_01_analysis_tables.sql:39`, garantiza que no se pisen). Regla FIFO explícita: si el payload trae `analysisId` → claim dirigido primero; si falla → sweep global por `created_at ASC, id ASC`. Firma: `claim_analysis(p_analysis_id uuid DEFAULT NULL)`. El sweep cubre "queued sin disparo" y "processing con lease vencido", con navegador cerrado (`:312`).

### 4.3 Intervalos y topes (B3=A+C, a calibrar en Task 0)

Base heredada de ingesta (lease 180s, heartbeat 30s, tope 15min/intento en `ADR-002:7` y `supabase/migrations/20261009120000_durable_ingestion_jobs.sql:88-91,100`) adaptada a proveedor remoto: lease 180s (init) → `3 × L_p99_batch + margen`; heartbeat 30s (init) → `lease / 6`; tope por batch 60s → `wall_clock Edge × 0.7`; backoff 1→2: 30s, 2→3: 2min (no 5s/15s de ingesta — ingesta falla por CPU/parse local, análisis por LLM remoto con caídas de minutos); tope por intento 30min; tope total 90min. N=10 pares por invocation, configurable y versionado en `constants.ts`, calibrado por `N = floor(limit × 0.7 / L_p99)` (A3). El ticket exige intervalos "medidos y documentados" (`:312`).

### 4.4 attempt_count y flujo de retry (precisiones B3)

`attempt_count` cuenta intentos del ANÁLISIS, no batches (columna `0..3` en `tables.sql:38`, compatible con inicial + 2 retries del DoD `:313`): un análisis de 50 batches en una pasada no sube el contador; el reintento sube el contador y continúa desde el checkpoint, no desde batch 0 (si contara batches, moriría en el batch 3). Convención α: empieza en 0, se incrementa al INICIAR cada intento (1º=1, 2º=2, 3º=3; falla al 4º). Flujo: (1) el worker persiste el fallo vía fail_analysis manteniendo el checkpoint; (2) fail_analysis evalúa attempt_count < 3 (NO incrementa — C5); (3) si queda margen → queued + next_attempt_at con backoff (30s si attempt_count = 1, 2min si = 2, §4.3); (4) si attempt_count == 3 → failed con el código recibido; (5) el siguiente claim_analysis que reclame el job incrementará attempt_count (a 2 o 3). NO usar `setTimeout` en Edge (sin timers confiables); el sweep o el próximo worker reclama. Esto exige agregar `next_attempt_at timestamptz` nullable a la migración (§5). El slot único (`analyses_one_active`, `tables.sql:55-56`) retiene el workspace hasta 90min en peor caso: restricción de PRD, documentada en runbook; N-activos/workspace fuera de scope.

---

## 5. Persistencia y RPCs SQL

Migración `2026101XXXXX_s2_06_analysis_leases.sql` (timestamp vía `supabase migration new` en Task 1, E2): `ALTER TABLE analyses ADD COLUMN checkpoint jsonb` + `ADD COLUMN next_attempt_at timestamptz` (ambas revocadas a `authenticated`, solo `service_role` — la proyección pública de `analyses` es lista cerrada sin columnas técnicas en `supabase/migrations/20261010194238_s2_01_analysis_security.sql:47-50`, con grants privilegiados en `:66-69`); `claim_analysis`, `renew_analysis_lease`,
  `complete_analysis`, `fail_analysis` implementando la semántica de C1–C3 (SQL verbatim en §5.1–§5.4); `GRANT EXECUTE ... TO service_role`; advisory lock + `statement_timeout 2s / lock_timeout 1s` (patrón `durable_ingestion_jobs.sql:67,96,112,141`).

No existe hoy ningún claim/complete/fail/renew de análisis (grep solo devuelve `claim_ingestion_job :65`, `heartbeat :95`, `fail_ingestion_job :111`); el patrón a replicar es S1-07: claim con capacidad acotada + marcado terminal del 3er intento vencido dentro del claim (`:73-79`), fencing por `operation_id` + lease vigente con `'superseded'` si no coincide (`:117-118`), heartbeat con tope `started + 15min` y mismatch → `22023` (`:95-109`), finalización atómica idempotente ante respuesta perdida (`20261006172303_finish_processing.sql:7-88` + versión durable `:137-171`).

- `claim_analysis(p_analysis_id uuid DEFAULT NULL)` → fila reclamada (B1/B2/C5): (1) marca `failed + ATTEMPTS_EXHAUSTED + finished_at` a processing vencidos con `attempt_count >= 3`, SIN liberar créditos ni emitir evento (`TODO(S2-08)` en la RPC; reserva intacta hasta S2-08, aceptado porque "cierre requiere S2-05/S2-07/S2-08", `:340`); (2) claim dirigido si elegible; (3) sweep FIFO; (4) `operation_id` nuevo, `lease now+180s`, `attempt_count+1`, `processing`, `started_at=coalesce(started_at, now())`, `next_attempt_at=NULL`. Condición de elegibilidad (B1): `(status='queued' AND (next_attempt_at IS NULL OR next_attempt_at <= now())) OR (status='processing' AND lease_expires_at < now() AND attempt_count < 3)` — el `IS NULL` es obligatorio porque `NULL <= now()` es NULL, no TRUE, y S2-05 crea queued con `next_attempt_at=NULL`. Todo el claim exige `attempt_count < 3` (B2): incrementar 3→4 violaría el CHECK `0..3` (`tables.sql:38`) con 23514 no controlado. Solo `claim_analysis` incrementa `attempt_count`; `fail_analysis` NO lo incrementa, solo evalúa `attempt_count < 3` para decidir queued vs failed (C5). `analyses_one_active` no protege el claim concurrente del mismo análisis (C1).
- `renew_analysis_lease(p_analysis_id, p_operation_id, p_checkpoint jsonb)` → `RETURNS TABLE(lease_expires_at timestamptz)`: verifica `processing + operation_id + lease vigente + started+30min`; actualiza `lease=least(now+180s, started+30min)` y checkpoint; fallo → `22023`; 1 renew por batch; si falla, el worker aborta sin complete/fail (C2).
- `complete_analysis(p_analysis_id, p_operation_id)` → `RETURNS void` (repetición idempotente de la operación completada = no-op; mismatch → `22023`): `completed + finished_at` (`TODO(S2-08)`: findings + consumo + evento); `fail_analysis(p_analysis_id, p_operation_id, p_retryable, p_error_code)` → `RETURNS text ('queued'|'failed'|'superseded')`: fencing (mismatch/lease vencido/terminal → `superseded`), `queued + next_attempt_at` o `failed + código + finished_at` (`TODO(S2-08)`: liberación + evento) (C3).
- Mapeo (C3/F1, enum congelado en `tables.sql:10-19` y `src/types/database.ts:1335-1343`): retryable = `RETRIEVAL_FAILED, PROVIDER_UNAVAILABLE, INVALID_PROVIDER_OUTPUT, PERSISTENCE_FAILED, TIMEOUT, INTERNAL_ERROR`; terminal directo = `ESTIMATE_STALE`; `ATTEMPTS_EXHAUSTED` solo marcado terminal. `INVALID_PROVIDER_OUTPUT` es retryable porque el fallback Cerebras→Groq es intra-intento (S2-07) y el worker solo ve el fallo cuando ambos caen. `TIMEOUT` cubre SOLO detección consciente del worker (batch > 60s): kill por runtime → queda `processing`, sweep reclama; lease perdido → aborta sin complete/fail (F1).

Shape de `checkpoint` (C1, objeto JSON pequeño — cursor y contadores, nunca textos): `{"processedPairs": number, "totalPairs": number, "findingsCount": number, "lastPairFingerprint": string|null, "startedAt": string}` donde `processedPairs` es el cursor del próximo batch, `totalPairs` el tamaño del retrieval verificado de este intento, `findingsCount` el acumulado validado en memoria, `lastPairFingerprint` el hash del último par procesado (trazabilidad sin contenido) y `startedAt` ISO del intento. `renew_analysis_lease` rechaza con `22023` todo `p_checkpoint` no-objeto.

Ciclo de vida de `next_attempt_at` (C2): (1) S2-05 crea `queued` con `next_attempt_at = NULL`; (2) `claim_analysis` reclama `queued` con `(next_attempt_at IS NULL OR next_attempt_at <= now())` y deja `next_attempt_at = NULL` al pasar a `processing`; (3) `fail_analysis` retryable deja `next_attempt_at = now() + backoff` (30s si `attempt_count = 1`, 2min si = 2, §4.3); (4) el sweep salta jobs con `next_attempt_at > now()`.

### 5.1 `claim_analysis` (B3)

Sigue `20261009120000_durable_ingestion_jobs.sql:65-93` (advisory lock propio `26061501`, distinto del `19091001` de ingesta en `:70`; `SELECT ... FOR UPDATE` + `SKIP LOCKED`; timeouts `:67`):

```sql
create function public.claim_analysis(p_analysis_id uuid default null)
returns table(
  id uuid, workspace_id uuid, initiator_id uuid, operation_id uuid,
  attempt_count integer, lease_expires_at timestamptz, next_attempt_at timestamptz
)
language plpgsql security definer set search_path = ''
set lock_timeout = '1s' set statement_timeout = '2s' as $$
declare
  v public.analyses%rowtype;
  claimed boolean := false;
  op uuid;
  ts timestamptz;
begin
  perform pg_catalog.pg_advisory_xact_lock(26061501);
  ts := clock_timestamp();
  -- Marcado terminal (C1): TODO(S2-08) liberar créditos + emitir evento.
  -- operation_id/lease_expires_at se preservan como token de acuse terminal (mismo patrón que complete_analysis §5.3).
  update public.analyses
     set status = 'failed', error_code = 'ATTEMPTS_EXHAUSTED',
         finished_at = ts, updated_at = ts
   where status = 'processing' and analyses.lease_expires_at < ts and analyses.attempt_count >= 3;
  -- Claim dirigido (B1/B2): frescos (NULL) o vencidos, siempre con margen de intento.
  if p_analysis_id is not null then
    select * into v from public.analyses
     where analyses.id = p_analysis_id and analyses.attempt_count < 3
       and ((status = 'queued' and (analyses.next_attempt_at is null or analyses.next_attempt_at <= ts))
         or (status = 'processing' and analyses.lease_expires_at < ts))
     for update;
    claimed := found;
  end if;
  -- Sweep FIFO (B2): NULL primero por created_at, sin bloquearse en filas tomadas.
  if not claimed then
    select * into v from public.analyses
     where analyses.attempt_count < 3
       and ((status = 'queued' and (analyses.next_attempt_at is null or analyses.next_attempt_at <= ts))
         or (status = 'processing' and analyses.lease_expires_at < ts))
     order by created_at, analyses.id for update skip locked limit 1;
    claimed := found;
  end if;
  if not claimed then return; end if;
  op := gen_random_uuid();
  update public.analyses
     set status = 'processing', operation_id = op,
         lease_expires_at = ts + interval '180 seconds',
         attempt_count = v.attempt_count + 1,
         started_at = coalesce(v.started_at, ts),
         next_attempt_at = null, updated_at = ts
   where analyses.id = v.id;
  return query select v.id, v.workspace_id, v.initiator_id, op,
    v.attempt_count + 1, ts + interval '180 seconds', null::timestamptz;
end;
$$;
```

### 5.2 `renew_analysis_lease` (B3)

Sigue `heartbeat_ingestion_job` (`durable_ingestion_jobs.sql:95-109`, tope `started + 30min` en vez de 15min, §4.3):

```sql
create function public.renew_analysis_lease(
  p_analysis_id uuid, p_operation_id uuid, p_checkpoint jsonb
)
returns table(lease_expires_at timestamptz)
language plpgsql security definer set search_path = ''
set lock_timeout = '1s' set statement_timeout = '2s' as $$
declare expires timestamptz;
begin
  perform pg_catalog.pg_advisory_xact_lock(26061501);
  if p_checkpoint is not null and jsonb_typeof(p_checkpoint) <> 'object' then
    raise exception 'Invalid checkpoint shape' using errcode = '22023';
  end if;
  update public.analyses
     set lease_expires_at = least(
           clock_timestamp() + interval '180 seconds',
           started_at + interval '30 minutes'),
         checkpoint = p_checkpoint, updated_at = clock_timestamp()
   where id = p_analysis_id and status = 'processing'
     and operation_id = p_operation_id
     and analyses.lease_expires_at > clock_timestamp()
     and started_at + interval '30 minutes' > clock_timestamp()
  returning analyses.lease_expires_at into expires;
  if not found then
    raise exception 'Analysis lease expired' using errcode = '22023';
  end if;
  return query select expires;
end;
$$;
```

### 5.3 `complete_analysis` (B3)

Repetición idempotente de la operación completada = no-op (patrón `finish_processing`, `durable_ingestion_jobs.sql:146-147`); estados terminales conservan `operation_id` como token de acuse, igual que ingesta (`:174-178`):

```sql
create function public.complete_analysis(p_analysis_id uuid, p_operation_id uuid)
returns void
language plpgsql security definer set search_path = ''
set lock_timeout = '1s' set statement_timeout = '2s' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(26061501);
  update public.analyses set updated_at = clock_timestamp()
   where id = p_analysis_id and status = 'completed' and operation_id = p_operation_id;
  if found then return; end if;
  update public.analyses
     set status = 'completed', finished_at = clock_timestamp(),
         updated_at = clock_timestamp()
   where id = p_analysis_id and status = 'processing'
     and operation_id = p_operation_id
     and lease_expires_at > clock_timestamp();
  if not found then
    raise exception 'Stale analysis operation' using errcode = '22023';
  end if;
  -- TODO(S2-08): findings + evidence + consumir reserva + evento analysis_completed.
end;
$$;
```

### 5.4 `fail_analysis` (B3)

Sigue `fail_ingestion_job` (`durable_ingestion_jobs.sql:111-128`: `'superseded'` ante mismatch/lease vencido; backoff 30s/2min de §4.3 en vez de 5s/15s):

```sql
create function public.fail_analysis(
  p_analysis_id uuid, p_operation_id uuid,
  p_retryable boolean, p_error_code public.analysis_failure_code
)
returns text
language plpgsql security definer set search_path = ''
set lock_timeout = '1s' set statement_timeout = '2s' as $$
declare j public.analyses%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(26061501);
  select * into j from public.analyses where id = p_analysis_id for update;
  if not found or j.status <> 'processing'
      or j.operation_id is distinct from p_operation_id then
    return 'superseded';
  end if;
  if j.lease_expires_at <= clock_timestamp() then return 'superseded'; end if;
  -- C5: no incrementa attempt_count; solo evalúa si queda margen.
  if p_retryable and j.attempt_count < 3 then
    update public.analyses
       set status = 'queued', operation_id = null, lease_expires_at = null,
           next_attempt_at = clock_timestamp() + case
             when j.attempt_count = 1 then interval '30 seconds'
             else interval '2 minutes' end,
           error_code = p_error_code, updated_at = clock_timestamp()
     where id = j.id;
    return 'queued';
  end if;
  update public.analyses
     set status = 'failed', lease_expires_at = null, next_attempt_at = null,
         error_code = p_error_code, finished_at = clock_timestamp(),
         updated_at = clock_timestamp()
   where id = j.id;
  -- TODO(S2-08): liberar reserva + evento analysis_failed.
  return 'failed';
end;
$$;
```

Grants (patrón `:130-134`, `service_role` only; las columnas nuevas quedan fuera del `GRANT SELECT` por lista de `security.sql:47-50` sin necesidad de `REVOKE` adicional):

```sql
revoke all on function public.claim_analysis(uuid),
  public.renew_analysis_lease(uuid, uuid, jsonb),
  public.complete_analysis(uuid, uuid),
  public.fail_analysis(uuid, uuid, boolean, public.analysis_failure_code)
  from public, anon, authenticated;
grant execute on function public.claim_analysis(uuid),
  public.renew_analysis_lease(uuid, uuid, jsonb),
  public.complete_analysis(uuid, uuid),
  public.fail_analysis(uuid, uuid, boolean, public.analysis_failure_code)
  to service_role;
```

---

## 6. Worker: estructura y loop

`src/modules/analysis/worker/` (E2, archivo `process-analysis.ts` en vez de `worker.ts`): `process-analysis.ts` (orquestación) · `claim.ts` (firma + FIFO) · `context.ts` (`loadAnalysisContext`) · `batch.ts` (N pares + renew) · `provider.ts` (`createProvider` que lanza) · `finalization.ts` (`createFinalization` que lanza) · `constants.ts` (N, lease, heartbeat, backoffs, topes — versionados) · `types.ts` · `telemetry.ts` (§8).

Restricciones E1: el worker NO importa `@/lib/supabase/server` (server-only + cookies), `next/*`, nada con `import "server-only"`, ni `queries.ts`, `actions.ts`, `application/*`; solo tipos (`database.ts`, `analysis-internal.ts`) y puros (`retrieval.ts`, `pricing.ts`); cliente por parámetro; entrypoint Deno con `npm:@supabase/supabase-js`.

`loadAnalysisContext(analysisId, service)` (D1): relee `analyses + analysis_documents`, regenera retrieval con la config fijada vía la RPC existente (`src/modules/analysis/queries.ts:67-82`, `retrieve_candidate_pairs` tipada en `database.ts:1313-1332`), verifica fingerprint canónico (`src/modules/analysis/retrieval.ts:11-16,107-147`) contra `request_fingerprint` EN CADA intento (divergencia → `ESTIMATE_STALE` terminal, garantía S2-04 en su DoD `:214-215` de regenerar el mismo conjunto); retrieval envuelto en `AbortSignal.timeout(60_000)` → `RETRIEVAL_FAILED`; nunca lee del payload. Loop por batch: `analyzePair` secuencial por par (firma intacta, D2; 3-way solo si Task 0 demuestra que 10 secuenciales exceden wall-clock — Groq ~10-15s/par — sin reducir N) → 1 renew con cursor → `finalize(...)`. Sin HTTP entre módulos del núcleo (`:308`).

Mapeo retrieval→pares (C4): el worker divide `analysis_documents` por `role` (`source`/`comparison`, enum `analysis_scope_role` en `tables.sql:3` y filas `:66-77`) en `sourceVersionIds` + `comparisonVersionIds` y llama `retrieve_candidate_pairs` con `p_top_k=5, p_threshold=0.75` (llamada existente en `queries.ts:73-79`, params congelados en `retrieval.ts:29-32`). Las 9 columnas devueltas (`database.ts:1321-1331`: `source_chunk_id, source_version_id, source_document_id, source_text, comparison_chunk_id, comparison_version_id, comparison_document_id, comparison_text, similarity`) se mapean a `AnalysisCandidatePair` (`analysis-internal.ts:45-48`): `source ← {documentId: source_document_id, versionId: source_version_id, chunkId: source_chunk_id, role: "source", text: source_text}`, `comparison ← {..., role: "comparison", text: comparison_text}` (en modo interno el rol se toma de la fila `analysis_documents` de cada versión).

---

## 7. Seams con S2-07/S2-08 y estrategia de fakes

`AIProvider.analyzePair({pair, configuration}) → AIProviderResult` ya existe (`src/types/analysis-internal.ts:76-81`, con `InternalFinding :59-70` y `AnalysisFailureCode :3-11`) y NO cambia. Seam nuevo congelado antes de que S2-08 empiece (D3): `AnalysisFinalization.finalize({analysisId, operationId, outcome: completed(findings) | failed(errorCode)}) → {ok:true} | {ok:false, code}`; implementación v1 = `complete/fail_analysis` de estado; S2-08 la reemplaza por la transacción real sin cambiar al worker (dedupe intra-analysis por fingerprint, consumo exacto, evento — DoD S2-08 `:410-419`). Compromiso: no cambian sin ADR o coordinación explícita.

Fakes (D3, crítico anti-catástrofe): viven en `tests/fakes/`, NUNCA en `src/` (un barrel que resolviera a fake publicaría findings sintéticos como reales); worker recibe provider + finalization por DI; `createProvider()` lanza `"S2-07 not merged: AIProvider unavailable."` y `createFinalization()` idem; producción rechaza fakes. Avance sin bloqueo pero "un mock no demuestra cierre real" (`:343`).

> Nota PRD-1 (discrepancia documentada): "El PRD §30 describe el worker como quien persiste findings y consume créditos. El ticket S2-06 delega esos pasos a S2-08 vía AnalysisFinalization.finalize(...). Cuando S2-08 se implemente, el comportamiento final coincide con el PRD — la división es de tickets, no de comportamiento. TODO(S2-08) marca los puntos."

---

## 8. Observabilidad y telemetría

Solo eventos manuales sanitizados (patrón `src/modules/ingestion/worker/telemetry.ts:20-25` y regla `process-job.ts:11`): whitelist — `module ("analysis"), operation (claim|batch|renew|finalize|recover), code, correlation_id, analysis_id?, workspace_id?, attempt_count?, batch_index?, duration_ms?`; prohibidos documentos, chunks, snapshots, pares, token, URLs firmadas, contenido del checkpoint (cursor sí), respuestas y prompts (regla S2-07 `:365-366`, exigencia `:315`) (F2). El worker NO importa `@/lib/observability/operation-events` (trae `@sentry/nextjs`/`server-only`, incompatible Deno): `telemetry.ts` propio con `reportAnalysisFailure(...)` manual, nunca `captureException`; runtime Sentry (`@sentry/deno` vs `npm:@sentry/node` vs POST) se verifica en Task 0; test de paridad de shape con S1-08 + test de whitelist. Stdout JSON one-line con los mismos campos (`supabase functions logs analyze`). Cada `fail_analysis` persiste exactamente un código (§5); `TIMEOUT` agrupa causas por enum congelado — runbook + Sentry distinguen (F1).

---

## 9. Superficie de usuario y errores controlados

El usuario ve solo estados + mensaje único; nunca `error_code`, `attempt_count`, `lease_expires_at` ni `operation_id` (columnas no granteadas, `security.sql:47-50`; mensajes controlados en `contracts.ts:45-50`; vista pública mapea todo failed a `ANALYSIS_FAILED`, `security.sql:85`). v1: "Analysis failed. Retry creates a new run." — SIN mencionar créditos (reserva intacta por C1/C3); post S2-08: "Analysis failed. Your credits were released. Retry creates a new run." (`TODO(S2-08)`, F3). `canRetry = failed/completed AND NOT EXISTS(otro activo del workspace)` — calculado en S2-05 (dependencia documentada aquí para S2-05/S2-09; `analyses_one_active` rechazaría el retry con 23505). Polling acotado de S2-09 sobre `getAnalysis/getActiveAnalysis` (`contracts.ts:325-326`); salir/cerrar no detiene el job (bloque S2-09).

---

## 10. Tests y criterios de aceptación

Tabla obligatoria (E3, exigencia `:317`; E2E real + Playwright diferidos a S2-12, `:613-621`): pgTAP — claim concurrente, FIFO, renew con checkpoint, fencing `operation_id`, idempotencia complete/fail, marcado terminal; Vitest — batch-loop con fakes, fingerprint por intento, backoff/`next_attempt_at`, abort si renew falla, DI rechaza fakes en prod, `ESTIMATE_STALE`; integración local (Edge servida + DB local + provider fake) — disparo perdido (`:321-324` del BDD S2-06), crash/lease vencido, token obsoleto (`:326-329`), agotamiento de retries (`:331-334`). Cada test con fakes marcado explícitamente para que S2-12 no lo confunda con validación real (`:343`).

---

## 11. Readiness, runbook y checklist de cierre

Readiness ANTES del claim (G2, crítico — sin esto el worker quema jobs: reclamaría, `createProvider()` lanzaría `INTERNAL_ERROR` retryable ×3 y cada análisis caería en `ATTEMPTS_EXHAUSTED`): el handler verifica (1) token (401 si falta), (2) `createProvider()/createFinalization()` no lanzan + cliente `service_role` inicializado (si falla → 503 sin reclamar; jobs quedan `queued` hasta que S2-07/08 mergeen y el primer sweep procese). Runbook obligatorio `docs/testing/s2-06-analysis-worker-runbook.md`: arranque local, verificación de sweep, inspección de colgados, troubleshooting, variables de entorno (E3).

S2-06 queda "completo pendiente de integración" (G2=A; cerrar solo con fakes contradice `:343`; bloquearlo todo contradice `:340`). Checklist con dueño y condición: `createProvider()` real (S2-07, test integración) · `createFinalization()` real (S2-08, test integración) · texto F3 con liberación (S2-08) · `TODO(S2-08)` en claim/complete/fail (S2-08) · `canRetry` con `analyses_one_active` (S2-05, en Run).

---

## 12. Deuda y decisiones diferidas

### 12.1 Deuda (dueño + condición de reapertura + impacto)

| # | Ítem | Dueño | Reapertura | Impacto si no se resuelve |
|---|------|-------|-----------|---------------------------|
| 1 | Slot único retiene workspace ≤90min peor caso | S2-06 (documenta) | Demanda de concurrencia | Throughput 1 análisis/vez por workspace |
| 2 | Plan B duplicación `lib/` + paridad | S2-06 | Task 0 (a) falla | Divergencia fingerprint Edge↔Node |
| 3 | Runtime Sentry en Deno | S2-06 | Task 0 | Sin telemetría remota del worker |
| 4 | Recalibrar N/backoffs/lease | S2-06 | Task 0 mide | Timeouts o reclaim lento |
| 5 | `TODO(S2-08)` claim (liberación terminal) | S2-08 | S2-08 merge | Reserva intacta tras `ATTEMPTS_EXHAUSTED` |
| 6 | `TODO(S2-08)` complete (findings+consumo+evento) | S2-08 | S2-08 merge | `completed` sin resultados ni cargo |
| 7 | `TODO(S2-08)` fail (liberación+evento) + texto F3 | S2-08 | S2-08 merge | Mensaje v1 sin promesa de liberación |

### 12.2 Decisiones diferidas ("decidido no decidir hasta X; criterio = Y")

1. Paralelizar 3-way — hasta Task 0; criterio = 10 secuenciales exceden wall-clock (D2).
2. Sentry runtime — hasta Task 0; criterio = qué SDK funciona en Edge (F2).
3. pg_cron vs Scheduled vs sweep — hasta Task 0; criterio = disponibilidad local y ventana medida (A2, Nota PRD-2).

---

## Referencias

- Ticket S2-06 completo y BDD: `docs/Tickets/sprint-2-ai-analysis.md:296-343`; S2-05 `:245-292`; S2-07 `:347-394`; S2-08 `:398-445`; S2-12 `:602-648`.
- PRD §30 literal (`docs/PRD/knowledge-decay-monitor-prd-final.md:940-976`): "Supabase Edge Function — Analysis Worker. Flow: 1. Claim queued job atomically. 2. Move to processing. 3. Apply lease/lock. 4. Execute retrieval. 5. Evaluate candidates through AI provider abstraction. 6. Validate outputs with Zod. 7. Deduplicate. 8. Persist findings/evidence. 9. Mark completed. 10. Convert credit reservation to consumption. Worker recovery: backend tries to invoke worker immediately; scheduled recovery checks stranded queued/processing jobs; stale lease can return job for retry. Retries: 2 automatic retries. After final failure: mark analysis failed; release all reserved credits; log to Sentry; allow Retry Analysis. No partial successful result is accepted."
- Slice/coordinación: `docs/PRD/sprint-2-ai-analysis-slice.md:21,35,77` (Edge exigido para análisis, S2-08 protege finalización/liberación).
- ADR-001 (`docs/architecture/adr/ADR-001-monolito-modular.md:25,52`), ADR-002 (`docs/architecture/adr/ADR-002-durable-ingestion-worker.md:5,7`).
- Esquema: `supabase/migrations/20261010192119_s2_01_analysis_tables.sql:21-56`; integridad `:129` en `20261010193514_s2_01_analysis_integrity.sql:30-36,51-74,112-125`; RLS `20261010194238_s2_01_analysis_security.sql:3-50,66-89`; patrón S1-07 `20261009120000_durable_ingestion_jobs.sql:65-134` y `20261006172303_finish_processing.sql:7-88`.
- Tipos: `src/types/analysis-internal.ts:3-99`; `src/types/contracts.ts:241-272,320-327`; `src/types/database.ts:37-65,1130-1188,1313-1343`.
- Implementado S2-04: `src/modules/analysis/retrieval.ts:1-147`, `pricing.ts:10-26`, `actions.ts:77-203`, `queries.ts:48-112`; S2-03: `application/analysis.service.ts`, `application/analysis.actions.ts`, `infrastructure/analysis.repository.ts`.
- Patrón worker ingesta: `src/modules/ingestion/worker/process-job.ts:11-70`, `attempt-watchdog.ts:1-14`, `telemetry.ts:1-30`, `embeddings.ts:1-24`; Edge `supabase/functions/embed/index.ts:39-67`.
