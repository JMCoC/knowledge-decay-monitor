# Spec S2-08 — Hallazgos, evidencia y cierre atómico

- **Ticket:** S2-08 (SAA-20), responsable Diego Alejandro Tolosa Sanchez (`docs/Tickets/sprint-2-ai-analysis.md:32`; `:398`).
- **Rama:** `feature/analysis_findings_finalization`.
- **Estado:** Diseño cerrado A–G; pendiente revisión escrita antes de implementar.
- **Fecha:** 2026-10-21.

> Este spec no contiene implementación. Cada afirmación técnica cita `archivo:línea`, el ticket o el PRD. Los pseudocódigos SQL y el algoritmo de fingerprint son contrato de diseño, no código de producción. La ejecución se divide en dos planes separados, 8a y 8b, que referencian secciones de este spec; el conteo de tasks vive en los planes, no acá.

> Convención: “A” designa la fila `public.analyses` del análisis en curso; “ledger” designa `public.credit_ledger`; “staging” designa las dos tablas privadas de este spec.

---

## 1. Contexto y objetivo

S2-08 cierra el vertical de análisis: convierte la salida validada de S2-07 en `findings` y `finding_evidence`, consume o libera la reserva exacta, emite el evento terminal y actualiza `analysis_status` de las fuentes analizadas. La historia del ticket es: *“Como QA Lead quiero recibir resultados completos y respaldados por evidencia para evaluar los hallazgos sabiendo que el análisis y su cargo finalizaron consistentemente”* (`docs/Tickets/sprint-2-ai-analysis.md:404-406`).

S2-08 se apoya en piezas ya mergeadas:

- **S2-01** define `findings`, `finding_evidence`, `credit_ledger`, `notification_events`, enums y RLS (`supabase/migrations/20261010192119_s2_01_analysis_tables.sql:1-195`; `supabase/migrations/20261010194238_s2_01_analysis_security.sql:1-152`).
- **S2-02** implementa `private.reserve_analysis_credits` y `private.settle_analysis_credits` con ledger append-only e idempotencia (`supabase/migrations/20261011013954_s2_02_credit_operations.sql:104-306`).
- **S2-05** crea el Run atómico, el scope exacto y `private.create_analysis_run` (`supabase/migrations/20261017190200_s2_05_run_commands.sql:23-358`); además entrega el handoff de worker con claim, renew, yield y fail con `TODO(S2-08)` (`supabase/migrations/20261017205245_s2_05_worker_handoff.sql:1-754`).
- **S2-06** implementa el worker durable y sus seams con `TODO(S2-08)` explícitos (`src/modules/analysis/worker/finalization.ts:1-30`; `src/modules/analysis/worker/batch-persistence.ts:1-14`).
- **S2-07** implementa el proveedor real y entrega `InternalFinding[]` validados contra el par autorizado (`docs/superpowers/specs/2026-10-20-s2-07-analysis-provider-spec.md:1-11`, `:196-302`).

S2-05 ya reservó la responsabilidad de S2-08: *“S2-08 debe hacer durable la salida válida de cada lote antes de confirmar su checkpoint, y protegerla con el mismo fencing”* (`docs/superpowers/specs/2026-10-17-s2-05-idempotent-analysis-run-design.md:236-242`). El worker cierra hoy `completed` sin findings, sin consumo, sin evento y sin `analysis_status`; los findings entregados se pierden entre invocaciones (`docs/testing/s2-06-analysis-worker-runbook.md:1-5`; `docs/superpowers/specs/2026-10-15-s2-06-analysis-worker-spec.md:60-72`).

**División 8a/8b.** 8a es aditivo y no cambia el comportamiento del worker: staging, fingerprint, `persist_analysis_batch`, `finalize_analysis_success`, regen de tipos y factories reales con test de éxito. 8b cambia comportamiento: helper de fallo, locking en `claim`/`fail`/`create_analysis_run`, revocación de `complete_analysis`, gate de tres flags y migración de expectativas de integración. 8a se mergea antes que 8b.

---

## 2. Alcance y no-objetivos

**Incluye:**

- Staging durable de findings y evidencia por lote, con fencing y CAS de checkpoint (`docs/Tickets/sprint-2-ai-analysis.md:411`, `:415`).
- Fingerprint determinista por `type` + IDs de versiones + evidencia normalizada; dedup solo dentro de `analysisId`; A/B invertidos no duplican (`docs/Tickets/sprint-2-ai-analysis.md:411`; `docs/PRD/knowledge-decay-monitor-prd-final.md:818-830`).
- Transacción de éxito `public.finalize_analysis_success`: findings + evidence + `completed` + `Consumed` + evento + `analysis_status` de fuentes (`docs/Tickets/sprint-2-ai-analysis.md:415`).
- Transacción de fallo `private.finalize_failed_analysis`: `failed` + `Released` + evento + cleanup, con rollback total (`docs/Tickets/sprint-2-ai-analysis.md:417`, `:415`).
- Cableado de los 5 caminos terminales que hoy marcan `failed` sin ledger ni evento.
- Gate de tres flags independientes y extensión del fake con findings custom.
- Regeneración de `src/types/database.ts` después de 8a.
- Cero findings como éxito válido con consumo (`docs/Tickets/sprint-2-ai-analysis.md:416`).
- `analysis_status` de versiones source exactas del análisis (`docs/Tickets/sprint-2-ai-analysis.md:415`).

**No incluye:**

- Proveedor real: S2-07, ya mergeado (`docs/Tickets/sprint-2-ai-analysis.md:359`).
- UI de estados, créditos y Retry Analysis: S2-09 (`docs/Tickets/sprint-2-ai-analysis.md:449-500`).
- Lista/detalle de findings: S2-10.
- Delivery real del evento (correo): S2-11; S2-08 solo crea `notification_events` (`docs/Tickets/sprint-2-ai-analysis.md:564`).
- E2E Playwright: S2-12.
- Purga de evidencia al eliminar originales: S5; la relación por versión/chunk ya la permite (`docs/Tickets/sprint-2-ai-analysis.md:444`).
- Backfill de análisis terminales previos a S2-08 (fila §12.1 #17).
- Reset de `analysis_status` en reprocesamiento de la misma versión (fila §12.1 #18).

---

## 3. Decisiones cerradas (índice A–G)

| Bloque | Decisión cerrada | Evidencia / sección |
|---|---|---|
| A | Staging en 2 tablas privadas normalizadas + RPC atómica de persistencia por lote | §5 |
| B | Fingerprint = `type` + IDs de versiones únicos/ordenados + evidencia ordenada por `(versionId, chunkId, normalizedSnapshot)`; normalización NFC + colapso de espacios + case-sensitive | §5.2 |
| C | `finalize_analysis_success` reemplaza el cierre; `complete_analysis` se revoca; orden 1–11; evento siempre; `analysis_status` solo source en `pending_reanalysis` | §6, §10 |
| D | `private.finalize_failed_analysis`; 5 caminos terminales; rollback total; telemetría `PERSISTENCE_FAILED` | §7 |
| E | Advisory por workspace antes del `FOR UPDATE` de `analyses`; quitar advisory global de `finalize`/`fail`; `claim` con `statement_timeout=45s` y sweep en 2 fases; advisory en `create_analysis_run`; gate de 3 flags; fake con findings custom | §8, §9 |
| F | Marcar `analysis_status='analyzed'` solo en versiones source históricas del análisis; sin evento por versión; S2-09 lee views | §10 |
| G | Readiness 503 como fallback; RLS en staging sin grants a `service_role`; regen después de 8a; fila §12.1 #17 ampliada a `completed` y `failed`; dos planes | §5.1, §12 |

---

## 4. Contrato — cambios de interface

### 4.1 `createFinalization(client)` (gap bloqueante)

La firma actual no permite el cierre real:

- `AnalyzeHandlerDeps.createFinalizationFn` no recibe cliente: `createFinalizationFn: () => AnalysisFinalization` (`supabase/functions/analyze/index.ts:52`).
- `createFinalization()` se exporta sin parámetros (`src/modules/analysis/worker/finalization.ts:28-30`).
- El fake sí recibe `AnalysisWorkerDb` (`supabase/functions/analyze/_test_doubles/analysis-finalization.test-shim.ts:26-29`).
- El handler invoca `deps.createFinalizationFn()` sin cliente (`supabase/functions/analyze/index.ts:229`).

**Cambio interno de seam, sin ADR:**

- `createFinalization(client: AnalysisWorkerDb): AnalysisFinalization` en `src/modules/analysis/worker/finalization.ts`.
- `createFinalizationFn: (client: AnalysisWorkerDb) => AnalysisFinalization` en `AnalyzeHandlerDeps` (`supabase/functions/analyze/index.ts:49-58`).
- El handler llama `deps.createFinalizationFn(client)` (`supabase/functions/analyze/index.ts:229`).
- La interfaz `AnalysisFinalization.finalize()` **no cambia**: sigue recibiendo `analysisId`, `operationId` y `outcome` (`src/modules/analysis/worker/finalization.ts:14-22`). El comentario de contrato congelado de `src/modules/analysis/worker/finalization.ts:1-13` protege la interfaz, no la factory.

**Migration path:** la fábrica real usa el cliente inyectado para invocar la RPC de cierre; el fake local conserva su firma. `createBatchPersistence(client)` ya recibe cliente (`src/modules/analysis/worker/batch-persistence.ts:10-14`), por lo que queda simétrico.

### 4.2 Gate del handler: tres flags independientes

Hoy un único `isLocalTestEnv` decide los tres doubles (`supabase/functions/analyze/index.ts:111-116`) y el handler elige por esa única condición (`supabase/functions/analyze/index.ts:220-231`). S2-08 separa la elección:

- `ANALYSIS_FAKE_PROVIDER` (existente) controla el provider fake.
- `ANALYSIS_FAKE_FINALIZATION` (nuevo) controla el finalize fake/shim.
- `ANALYSIS_FAKE_PERSISTENCE` (nuevo) controla la persistencia fake.
- `AnalyzeEnv` agrega `analysisFakeFinalization` y `analysisFakePersistence` (`supabase/functions/analyze/index.ts:38-47`).

Regla de compatibilidad:

- Si un flag nuevo está ausente, hereda el comportamiento legacy `isLocalTestEnv` (todos fake si el gate local está abierto).
- Un valor explícito `"1"` enciende el fake de ese componente; un valor explícito `"0"` lo apaga.
- Los nuevos flags solo pueden encender un fake si se cumple el gate local (`isLocalTestEnv`); nunca en hosted (`supabase/functions/analyze/index.ts:111-116`).
- Esto habilita el E2E local de S2-08: proveedor fake + finalize real + persistencia real, sin exponer fakes en producción.

### 4.3 Interface privada de staging

Las tablas y funciones de §5 son privadas: sin grants de tabla a ningún rol y sin `EXECUTE` para `anon`/`authenticated`; solo `service_role` ejecuta las RPCs públicas que las tocan (`supabase/migrations/20261018021500_s2_05_materialized_candidate_snapshots.sql:630-639`; `supabase/migrations/20261009120000_durable_ingestion_jobs.sql:16-17`).

---

## 5. Staging durable (8a)

### 5.1 Shape de las dos tablas

Pseudocódigo DDL ilustrativo, derivado de `public.findings` y `public.finding_evidence` (`supabase/migrations/20261010192119_s2_01_analysis_tables.sql:105-161`):

```sql
-- Staging por análisis (no por intento): la unicidad es por fingerprint, de modo
-- que un reintento que repita el hallazgo no lo reescribe (first-wins entre intentos).
create table private.analysis_finding_staging (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null,
  workspace_id uuid not null,
  operation_id uuid not null,  -- procedencia: intento que lo escribió primero
  batch_index integer not null check (batch_index >= 0),
  finding_ordinal integer not null check (finding_ordinal >= 0),
  type public.finding_type not null,
  severity public.finding_severity not null,
  confidence double precision not null check (confidence >= 0 and confidence <= 1),
  explanation text not null check (char_length(btrim(explanation)) > 0),
  fingerprint text not null check (char_length(btrim(fingerprint)) > 0),
  created_at timestamptz not null default now(),
  unique (analysis_id, fingerprint)
);

-- Evidencia asociada por ordinal de finding; snapshot máximo 2.000 caracteres.
create table private.analysis_finding_evidence_staging (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null,
  workspace_id uuid not null,
  operation_id uuid not null,
  batch_index integer not null,
  finding_ordinal integer not null,
  fingerprint text not null check (char_length(btrim(fingerprint)) > 0),
  evidence_ordinal integer not null check (evidence_ordinal >= 0),
  role public.analysis_scope_role not null,
  document_id uuid not null,
  version_id uuid not null,
  chunk_id uuid not null,
  page_number integer check (page_number > 0),
  section text,
  section_heading text,
  snapshot text not null check (
    char_length(snapshot) between 1 and 2000 and char_length(btrim(snapshot)) > 0
  ),
  created_at timestamptz not null default now(),
  unique (analysis_id, fingerprint, evidence_ordinal)
);

alter table private.analysis_finding_staging enable row level security;
alter table private.analysis_finding_evidence_staging enable row level security;
revoke all on table private.analysis_finding_staging,
  private.analysis_finding_evidence_staging
  from public, anon, authenticated, service_role;
```

`batch_index` se toma de `p_expected_processed_pairs` (monótono dentro del intento y del análisis) y sirve para ordenar la publicación; ya no forma parte de la clave. **La clave de staging es por análisis, no por intento:** `unique (analysis_id, fingerprint)` en findings y `unique (analysis_id, fingerprint, evidence_ordinal)` en evidencia, sin `operation_id` (P2). Esto da first-wins entre intentos: si el intento 1 stagea un fingerprint como `High` y el intento 2 lo reintenta como `Low`, el `insert ... on conflict (analysis_id, fingerprint) do nothing` conserva la fila del intento 1. `operation_id` queda como columna de procedencia (el primer intento que escribió el fingerprint), no de unicidad. El cleanup borra todo el staging del `analysis_id` al cerrar, sin filtrar por `operation_id` (§5.4). El límite de snapshot coincide con el CHECK existente (`supabase/migrations/20261010192119_s2_01_analysis_tables.sql:146-148`) y con PRD §22 (`docs/PRD/knowledge-decay-monitor-prd-final.md:794-816`).

### 5.2 Fingerprint determinista

**Entrada:** `type` y la lista de evidencia de un `InternalFinding` (`src/types/analysis-internal.ts:83-94`).

**Normalización de texto** (case-sensitive):

1. `NFC` Unicode.
2. `trim`.
3. Colapsar toda racha de whitespace (`\s+`) a un único espacio ASCII (`0x20`).
4. No cambiar mayúsculas/minúsculas, no traducir, no quitar puntuación.

**Algoritmo:**

```text
normalizedEvidence = evidence.map(e => {
  versionId: e.versionId,
  chunkId: e.chunkId,
  snapshot: normalizeEvidenceText(e.snapshot)
})
sortedEvidence = normalizedEvidence.sort(compare by versionId, then chunkId,
                                          then normalizedSnapshot, all ascending)
versionIds     = unique(evidence.map(e => e.versionId)).sort(ascending)
payload        = canonicalJson({ type, versionIds, evidence: sortedEvidence })
fingerprint    = sha256Hex(utf8(payload))
```

`private.canonical_jsonb` ya existe y ordena claves (`supabase/migrations/20261017190000_s2_05_retrieval_snapshot.sql:90-123`); la implementación Deno-safe replica esa canonicalización para pruebas de paridad. La autoridad es SQL: `persist_analysis_batch` recomputa el fingerprint desde el staging normalizado y no confía en un valor del cliente. La función Deno-only vive en `src/modules/analysis/worker/fingerprint.ts`, con imports `.ts` y cubierta por `tests/unit/deno-import-extensions.test.ts`.

**Ejemplos que colapsan (mismo fingerprint):**

- Par A/B invertido: `{(v1, c1, "A"), (v2, c2, "B")}` y `{(v2, c2, "B"), (v1, c1, "A")}`.
- Distinta composición Unicode: `"café"` NFC vs `"cafe\u0301"` NFD.
- Distinto espaciado: `"a\n b"`, `"a  b"`, `"a b"`.
- Par `source`/`comparison` con el mismo contenido textual en la misma versión/chunk.

**Ejemplos que no colapsan (distinto fingerprint):**

- Distinto `type` (`contradiction` vs `obsolescence`).
- Distinto `chunkId` aunque el `snapshot` sea igual.
- Distinto `versionId`.
- Diferencia de mayúsculas: `"Active"` vs `"active"`.
- Evidencia adicional o distinta cantidad de lados.
- Dos emparejamientos distintos de evidencia aunque el multiset de snapshots sea igual: se ordena la tupla completa `(versionId, chunkId, snapshot)`, no solo el snapshot.

**Dedup:** solo dentro de `analysisId` (`unique (analysis_id, fingerprint)` en `findings`, `supabase/migrations/20261010192119_s2_01_analysis_tables.sql:120`). No hay supresión histórica ni clustering semántico (`docs/PRD/knowledge-decay-monitor-prd-final.md:818-830`; `docs/Tickets/sprint-2-ai-analysis.md:411`).

### 5.3 `persist_analysis_batch` (RPC atómica)

Firma propuesta:

```sql
public.persist_analysis_batch(
  p_analysis_id uuid,
  p_operation_id uuid,
  p_expected_processed_pairs integer,
  p_checkpoint jsonb,
  p_findings jsonb,
  p_has_more boolean
) returns boolean
```

Semántica transaccional:

1. Validar argumentos y forma de `p_findings` (`jsonb_typeof = 'array'`, cada finding con `type`/`severity`/`confidence`/`explanation`/`evidence`; evidence de 2 lados, uno `source` y uno `comparison`; snapshot ≤ 2.000 caracteres). Forma inválida → `22023`.
2. Adquirir advisory por workspace (`pg_advisory_xact_lock(hashtextextended(workspace_id::text, 0))`) **antes** de bloquear la fila A.
3. `select * from public.analyses where id = p_analysis_id for update`; validar `processing`, `operation_id = p_operation_id`, lease y deadlines vigentes, y `checkpoint->>'processedPairs' = p_expected_processed_pairs` (CAS). Cualquier desalineación → `false`.
4. Recomputar el fingerprint de cada finding (§5.2) y validar que toda evidencia referencie `(analysis_id, workspace_id, document_id, version_id, chunk_id, role)` de `analysis_documents` del mismo análisis (`supabase/migrations/20261010192119_s2_01_analysis_tables.sql:66-79`). Referencia fuera de scope → `P0001`.
5. Insertar en `private.analysis_finding_staging` y `private.analysis_finding_evidence_staging` con `batch_index = p_expected_processed_pairs` y ordinales por posición del arreglo, usando `on conflict (analysis_id, fingerprint) do nothing` (finding) y `on conflict (analysis_id, fingerprint, evidence_ordinal) do nothing` (evidencia). Un fingerprint repetido entre lotes o entre intentos no se reescribe: gana la primera escritura (P2).
6. **No** reusar `yield_analysis_batch` ni `renew_analysis_lease`: ambas hacen CAS interno de `expected_processed_pairs` (yield en `supabase/migrations/20261017205245_s2_05_worker_handoff.sql:340-347`), y el doble CAS falla porque `persist_analysis_batch` ya validó al entrar (paso 3). Replicar la lógica dentro de `persist_analysis_batch`:
   - `p_has_more = true`: `update public.analyses set status='queued', operation_id=null, lease_expires_at=null, continuation_pending=true, checkpoint=p_checkpoint where id = p_analysis_id`.
   - `p_has_more = false`: `update public.analyses set lease_expires_at=least(now() + interval '180s', started_at + interval '30min'), checkpoint=p_checkpoint where id = p_analysis_id`.
   - Es el mismo patrón que `finalize_analysis_success` (§6.1), que también replica la lógica de `complete_analysis` en vez de reusarla.
7. Devolver `true`. La atomicidad es total: staging y checkpoint se confirman o revierten juntos; no puede existir checkpoint avanzado con staging incompleto ni al revés.

Notas:

- El doble CAS es un riesgo real del pseudocódigo original. La replicación interna (en vez de reuso) es coherente con el patrón S2-08 de “un RPC por operación de negocio”.
- El fingerprint recomputado en SQL es la única fuente de verdad; el worker no envía `fingerprint`.
- El `on conflict ... do nothing` de staging es seguro aun con evidencia distinta entre intentos: el fingerprint incluye la evidencia normalizada y ordenada (§5.2), así que un mismo fingerprint implica evidencia canónica idéntica.
- El grant es `EXECUTE` a `service_role`; `revoke all` a `public, anon, authenticated` (patrón de `supabase/migrations/20261015221607_s2_06_analysis_leases.sql:167-173`).

### 5.4 Cleanup semantics

| Evento | Staging | Quién limpia |
|---|---|---|
| `persist_analysis_batch` con `has_more=true` | Se conserva | — |
| `persist_analysis_batch` con `has_more=false` | Se conserva hasta el cierre | — |
| `finalize_analysis_success` | Se borra todo el staging del `analysis_id` en la misma transacción | §6 |
| Fallo terminal vía `private.finalize_failed_analysis` | Se borra todo el staging del `analysis_id` en la misma transacción | §7 |
| Reintento retryable (`queued`) | Se conserva para continuar (mismo `analysis_id`) | — |
| Crash/abort del worker | Se conserva lo staged de checkpoints confirmados | Próximo claim continúa |
| Análisis terminal por cualquier otro camino | Se borra por trigger `AFTER UPDATE OF status` | Trigger de seguridad |

El cleanup es siempre por `analysis_id`, sin filtrar por `operation_id` (P2): un reintento comparte el staging del análisis. El trigger de seguridad replica el patrón de snapshots de S2-05 (`supabase/migrations/20261018021500_s2_05_materialized_candidate_snapshots.sql:624-641`): al pasar `status` a `completed` o `failed`, borra las filas staging de ese `analysis_id`. Es una red de seguridad de cleanup, no reemplaza la liquidación/evento del helper.

### 5.5 Dedup `ON CONFLICT DO NOTHING` (first-wins)

Al publicar, se insertan los findings staged en orden `(batch_index, finding_ordinal)`:

```sql
insert into public.findings (
  workspace_id, analysis_id, type, severity_original, severity_current,
  confidence, explanation, status, assignee_id, fingerprint
)
select s.workspace_id, s.analysis_id, s.type, s.severity, s.severity,
       s.confidence, s.explanation, 'pending_review', null, s.fingerprint
from private.analysis_finding_staging s
where s.analysis_id = p_analysis_id
order by s.batch_index, s.finding_ordinal
on conflict (analysis_id, fingerprint) do nothing
returning id, fingerprint;
```

Reglas:

- `severity_original = severity_current` y `assignee_id = null`; el trigger existente lo exige (`supabase/migrations/20261010195500_s2_01_finding_initial_state.sql:6-19`).
- `confidence` se conserva tal cual, incluso < 0.3 (`docs/PRD/knowledge-decay-monitor-prd-final.md:754-760`).
- Solo se inserta evidencia para los findings efectivamente insertados; un fingerprint duplicado dentro del mismo análisis no duplica evidencia.
- El fingerprint incluye la evidencia normalizada, por lo que un conflicto implica la misma evidencia canónica; no se fusionan evidencias parciales.
- El `on conflict` de publicación es defensa en profundidad: la dedup real ya ocurrió en staging por `(analysis_id, fingerprint)` (§5.1, §5.3). La evidencia se inserta uniendo staging por `fingerprint` con los `findings` recién insertados, y solo para los fingerprints insertados.

---

## 6. Transacción de éxito (8a)

### 6.1 `finalize_analysis_success`

Firma propuesta:

```sql
public.finalize_analysis_success(
  p_analysis_id uuid,
  p_operation_id uuid,
  p_reported_findings_count integer
) returns void
```

Pasos 1–11 (pseudocódigo):

1. Validar `p_reported_findings_count >= 0`.
2. Leer `workspace_id` de A sin lock; adquirir advisory por workspace.
3. `select w.id from public.workspaces w where w.id = v_workspace_id for update`; luego `select * from public.analyses where id = p_analysis_id for update`.
4. Fencing idempotente: si `status = 'completed'` y `operation_id = p_operation_id` → `return` sin repetir cargo ni evento (patrón `finish_processing`, `supabase/migrations/20261006172303_finish_processing.sql:7-88`).
5. Si `status <> 'processing'` o `operation_id is distinct from p_operation_id` o lease/deadlines vencidos → `raise exception using errcode = '22023'`.
6. Invariante de conteo (P3): sea `staging_count = count(*) from private.analysis_finding_staging where analysis_id = p_analysis_id`. `p_reported_findings_count` es el acumulado en memoria del worker **para la invocación actual** (ver `src/modules/analysis/worker/process-analysis.ts:201-215`: `findings` es local a la invocación, no persiste entre intentos). El único invariante real: `P0001` si `staging_count = 0 and p_reported_findings_count > 0` (el worker reportó findings pero no se persistió nada → bug real). **No** es error: `staging_count < p_reported_findings_count` (dedup legítimo: A/B invertido, fingerprint repetido); `staging_count > p_reported_findings_count` (findings de intentos anteriores staged en esta invocación, con fingerprints distintos).
7. Insertar findings con dedup first-wins (§5.5) y evidencia asociada, validando FK tenant/scope (`supabase/migrations/20261010192119_s2_01_analysis_tables.sql:149-155`).
8. `update public.analyses set status='completed', finished_at=ts, updated_at=ts where id = p_analysis_id` preservando `operation_id`.
9. `perform private.settle_analysis_credits(p_analysis_id, fixed_cost, 'Consumed')`; `settle` exige `status='completed'` (`supabase/migrations/20261011013954_s2_02_credit_operations.sql:272-274`, `:281-284`).
10. `insert into public.notification_events (workspace_id, analysis_id, type, recipient_id) values (..., 'analysis_completed', initiator_id) on conflict (analysis_id, type, recipient_id) do nothing` (`supabase/migrations/20261010192119_s2_01_analysis_tables.sql:163-183`).
11. `update public.document_versions v set analysis_status='analyzed' where v.workspace_id = ... and v.analysis_status='pending_reanalysis' and v.id in (select version_id from public.analysis_documents where analysis_id = p_analysis_id and workspace_id = ... and role='source')`; borrar **todo** el staging del `analysis_id`, sin filtrar por `operation_id`.

Cualquier error en 6–11 revierte todo: no hay `completed` sin findings, sin consumo, sin evento ni con `analysis_status` movido (`docs/Tickets/sprint-2-ai-analysis.md:417`, `:415`).

### 6.2 Idempotencia y fencing

- Repetir el cierre con el mismo token retorna temprano; no vuelve a consumir ni a notificar (`docs/Tickets/sprint-2-ai-analysis.md:418`).
- Token distinto, lease vencido o estado terminal no `completed` → `22023`; el worker lo interpreta como `superseded` y no reintenta (`docs/superpowers/specs/2026-10-15-s2-06-analysis-worker-spec.md:71-72`).
- `p_reported_findings_count` es el acumulado en memoria del worker; el invariante de §6.1 paso 6 cierra la brecha de “completed sin resultados”: si el worker reportó findings pero el staging quedó vacío, el cierre falla (`docs/Tickets/sprint-2-ai-analysis.md:415-416`). Un staging menor al reportado es dedup legítimo y no bloquea.

### 6.3 Evento `analysis_completed`

- Se inserta para `initiator_id` del análisis, siempre, incluso con cero findings (`docs/PRD/knowledge-decay-monitor-prd-final.md:1206-1215`; `docs/Tickets/sprint-2-ai-analysis.md:415`).
- La unicidad `(analysis_id, type, recipient_id)` hace el insert idempotente (`supabase/migrations/20261010192119_s2_01_analysis_tables.sql:175`).
- S2-08 no envía correo; el delivery es S2-11 (`docs/Tickets/sprint-2-ai-analysis.md:564`).

### 6.4 `analysis_status` de sources

- Solo se actualizan versiones con `role='source'` en `analysis_documents` de ese análisis (`docs/Tickets/sprint-2-ai-analysis.md:415`).
- Solo `pending_reanalysis → analyzed`; el enum tiene dos valores (`supabase/migrations/00001_initial_schema.sql:12`, `:68`).
- No se tocan comparison ni nuevas versiones ajenas al análisis.
- La columna pertenece a `document_versions`; S2-08 no crea un análisis_status por análisis. El comentario SQL de ownership se agrega en la migración (`docs/Tickets/sprint-2-ai-analysis.md:415`; `supabase/tests/database/013_analysis_integrity.test.sql:120-122`).

### 6.5 Mapping SQLSTATE → código del seam

| SQLSTATE / origen | Resultado del seam | Efecto |
|---|---|---|
| `22023` (`superseded`, stale, token/mismatch, deadline) | `{ ok: false, code: "superseded" }` | No terminal; lease/sweep decide |
| `P0001` (staging incompleto o referencia fuera de scope) | `{ ok: false, code: "PERSISTENCE_FAILED" }` | No `completed`; telemetría; job queda `processing` |
| `P2002`/`P2003` (conflicto de ledger/integridad) | `{ ok: false, code: "PERSISTENCE_FAILED" }` | Rollback total; no `completed` |
| `55P03` (lock timeout) / `57014` (statement timeout) | `{ ok: false, code: "PERSISTENCE_FAILED" }` | Reintentable por sweep |
| Otro | `{ ok: false, code: "INTERNAL_ERROR" }` | Job queda `processing` |

Cuando el cierre devuelve `ok:false`, el worker no fuerza un terminal inmediato: `settle` en `src/modules/analysis/worker/process-analysis.ts:201-215` lo traga y el reclamo por lease/intentos decide el terminal. Esto mantiene la garantía del ticket (“fallo al guardar evidencia impide declarar completed”) sin publicar un `failed` sin liberación (`docs/Tickets/sprint-2-ai-analysis.md:417`).

---

## 7. Transacción de fallo (8b)

### 7.1 `private.finalize_failed_analysis`

Firma propuesta:

```sql
private.finalize_failed_analysis(
  p_analysis_id uuid,
  p_operation_id uuid,
  p_error_code public.analysis_failure_code
) returns boolean
```

Pseudocódigo:

1. Leer `workspace_id` sin lock; advisory por workspace; `select w.id ... for update`; `select * from public.analyses where id = ... for update`.
2. Idempotencia: si `status='failed'` y `operation_id = p_operation_id` → `return true` (ya liquidado/eventado); si ya hay `Consumed`/`Released` para el análisis, completar solo lo faltante y `return true`.
3. Si `status <> 'processing'`, token distinto o lease/deadlines vencidos → `return false` (`superseded`).
4. `update public.analyses set status='failed', error_code=p_error_code, finished_at=ts, lease_expires_at=null, next_attempt_at=null, continuation_pending=false, updated_at=ts where id = ...` preservando `operation_id` como token de acuse (`supabase/migrations/20261015221607_s2_06_analysis_leases.sql:157-163`).
5. `perform private.settle_analysis_credits(p_analysis_id, fixed_cost, 'Released')`; `settle` exige `status='failed'` (`supabase/migrations/20261011013954_s2_02_credit_operations.sql:272-274`, `:281-284`).
6. `insert into public.notification_events ... 'analysis_failed' ... initiator_id ... on conflict do nothing`.
7. Borrar **todo** el staging del `analysis_id`, sin filtrar por `operation_id`.
8. `return true`.

Si el paso 5 lanza, la transacción completa revierte: A vuelve a `processing`, no se libera parcialmente y no se emite evento. El worker reporta `PERSISTENCE_FAILED` en telemetría (Bloque D) y el sweep reintenta.

### 7.2 Los 5 caminos vivos + mapeo `archivo:línea`

| # | Camino | `archivo:línea` actual | Estado terminal | En 8b |
|---|---|---|---|---|
| 1 | `claim_analysis`: processing vencido con `attempt_count >= 3` | `supabase/migrations/20261017205245_s2_05_worker_handoff.sql:51-60` | `failed` + `ATTEMPTS_EXHAUSTED`/`TIMEOUT` | Llama al helper por fila |
| 2 | `claim_analysis`: queued vencido o continuación sin presupuesto | `supabase/migrations/20261017205245_s2_05_worker_handoff.sql:61-72` | `failed` + `TIMEOUT` | Llama al helper por fila |
| 3 | `claim_analysis`: guardia posterior a la selección (attempt/deadline) | `supabase/migrations/20261017205245_s2_05_worker_handoff.sql:124-134` | `failed` + `ATTEMPTS_EXHAUSTED`/`TIMEOUT` | Llama al helper por fila |
| 4 | `fail_analysis`: deadlines vencidos al fallar | `supabase/migrations/20261017205245_s2_05_worker_handoff.sql:714-720` | `failed` + `TIMEOUT` | Reemplaza update directo por helper |
| 5 | `fail_analysis`: terminal (no retryable o retryable sin intentos) | `supabase/migrations/20261017205245_s2_05_worker_handoff.sql:722-739` | `failed` + `p_error_code` | Reemplaza update directo por helper |

Los retornos `superseded` (`:702-706`) no son terminales y no llaman al helper. El `return 'queued'` (`:722-731`) tampoco: la reserva sigue viva y S2-05 la conserva (`docs/superpowers/specs/2026-10-17-s2-05-idempotent-analysis-run-design.md:168-186`).

### 7.3 Rollback total + telemetría

- El helper es una transacción única con A, ledger, evento y staging; cualquier fallo revierte todo (`docs/Tickets/sprint-2-ai-analysis.md:417`, `:415`).
- El worker no promete liberación en v1 (`docs/testing/s2-06-analysis-worker-runbook.md:1-5`); esta spec es la que introduce la promesa. S2-09 consume el estado `failed` y el release confirmado (`docs/Tickets/sprint-2-ai-analysis.md:467`).
- `PERSISTENCE_FAILED` se reporta con la whitelist existente de telemetría; nunca con documentos, chunks, snapshots ni tokens (`src/modules/analysis/worker/telemetry.ts:66-90`).

### 7.4 Evento `analysis_failed`

- Se inserta siempre a `initiator_id`, sin `error_code` adicional en el evento (`supabase/migrations/20261010192119_s2_01_analysis_tables.sql:163-183`).
- El `error_code` técnico vive en A y no se expone en la proyección pública (`supabase/migrations/20261010194238_s2_01_analysis_security.sql:47-50`, `:74-85`).
- La entrega real es S2-11.

---

## 8. Concurrencia, locks y deadlocks (8b)

### 8.1 Análisis de deadlock

El riesgo real es el orden de locks entre el cierre y `private.settle_analysis_credits`. `settle` toma `FOR UPDATE workspaces` y luego `FOR UPDATE analyses` (`supabase/migrations/20261011013954_s2_02_credit_operations.sql:224-232`). Si el cierre toma A y luego el workspace, y otro settle toma workspace y luego A, hay ciclo. El advisory global actual `26061501` (`supabase/migrations/20261015221607_s2_06_analysis_leases.sql:113`, `:139`) serializa hoy todos los análisis, pero S2-08 lo retira de finalize/fail para no serializar workspaces distintos.

**Orden canónico de S2-08:**

1. Advisory por workspace: `pg_advisory_xact_lock(hashtextextended(workspace_id::text, 0))`.
2. `FOR UPDATE` de `workspaces`.
3. `FOR UPDATE` de `analyses`.

Con ese orden, dos operaciones del mismo workspace se serializan en el advisory antes de tomar filas; dos operaciones de workspaces distintos no comparten advisory ni filas. El advisory no bloquea a `reserve`/`settle` que solo usan filas; pero como el cierre toma workspace antes que A, coincide con el orden de `settle` y no hay ciclo.

### 8.2 Advisory por workspace

- `finalize_analysis_success`, `private.finalize_failed_analysis` y `private.create_analysis_run` toman el advisory de §8.1.
- Los sweeps de `claim_analysis` lo toman por candidato en la fase 2 (§8.4).
- `renew_analysis_lease` y `yield_analysis_batch` conservan su advisory global actual (`supabase/migrations/20261017205245_s2_05_worker_handoff.sql:166`, `:350`); no introducen el advisory de workspace porque no liquidan ni tocan ledger.

### 8.3 Quitar el advisory global de `finalize`/`fail`

- `finalize_analysis_success` no ejecuta `pg_advisory_xact_lock(26061501)`.
- `private.finalize_failed_analysis` no lo ejecuta.
- `claim_analysis` lo conserva en su forma actual (`supabase/migrations/20261017205245_s2_05_worker_handoff.sql:47`), junto con el advisory de workspace del sweep; el lock global no crea ciclo con finalize/fail porque ellos ya no lo toman.
- El resultado es que un cierre de workspace A no espera a un cierre de workspace B.

### 8.4 `claim_analysis` con 45 s y sweep en 2 fases

Cambios:

- `set statement_timeout = '45s'` (hoy `2s`, `supabase/migrations/20261017205245_s2_05_worker_handoff.sql:34`); `lock_timeout` se mantiene en `1s`. El valor es **techo, no objetivo** (P4): el sweep normal debe cerrar muy por debajo; acercarse a 45 s es señal de bug, no de carga esperada.
- Sweep en dos fases:
  - **Fase 1:** `SELECT` de IDs y `workspace_id` candidatos sin locks, con el `LIMIT` acotado.
  - **Fase 2:** por candidato, advisory por workspace, `SELECT ... FOR UPDATE` de A; si ya no es elegible, continuar; si es terminal (caminos 1–3), llamar al helper y continuar; si es reclamable, reclamar como hoy.
- El `SKIP LOCKED` se conserva dentro de la fase 2 después del advisory (`supabase/migrations/20261017205245_s2_05_worker_handoff.sql:103`).
- Justificación: el helper de fallo toma advisory y luego filas; el claim debe tomarlos en el mismo orden antes de tocar A para no invertir el orden (§8.1).
- `claim_analysis` sigue devolviendo la misma tabla (`supabase/migrations/20261015221607_s2_06_analysis_leases.sql:13-17`), por lo que `process-analysis.ts` no cambia (`src/modules/analysis/worker/process-analysis.ts:244-260`).

### 8.5 Worker race A vs B

- `persist_analysis_batch` valida `operation_id` y CAS de checkpoint; un worker viejo no puede stagear ni avanzar (`§5.3`).
- `finalize_analysis_success` valida token y lease; un cierre viejo devuelve `22023` → `superseded` sin efecto (`§6.2`).
- El reclamo del sweep es el único que rota `operation_id`; la fila A bloqueada impide doble claim (`supabase/migrations/20261017205245_s2_05_worker_handoff.sql:74-105`).

---

## 9. Gate refactor (8b)

### 9.1 Tres flags independientes

- `ANALYSIS_FAKE_PROVIDER`: proveedor fake (`supabase/functions/analyze/_test_doubles/analysis-provider.fake.ts:62-74`).
- `ANALYSIS_FAKE_FINALIZATION`: finalize shim local (`supabase/functions/analyze/_test_doubles/analysis-finalization.test-shim.ts:26-58`).
- `ANALYSIS_FAKE_PERSISTENCE`: persistencia fake local (`supabase/functions/analyze/_test_doubles/analysis-batch-persistence.fake.ts:11-42`).
- Override `"0"` apaga el fake de ese componente aun con el gate local abierto; ausente hereda `isLocalTestEnv` (`supabase/functions/analyze/index.ts:111-116`).
- Los tres flags se evalúan después del gate local: un flag `"1"` en hosted no enciende nada.

**Gate base (P1).** El gate base actual es `ANALYSIS_FAKE_PROVIDER=1` + loopback + `!hosted` (`supabase/functions/analyze/index.ts:111-116`); S2-08 lo mantiene como llave de entrada y no lo relaja. Consecuencia: el smoke "provider fake + finalize/persistencia reales" ya cumple el gate, porque `ANALYSIS_FAKE_PROVIDER=1` sigue encendido. Futuro (S2-12): si se necesita provider real en loopback, agregar un flag base desacoplado `ANALYSIS_LOCAL_TEST=1` y colgar `isLocalTestEnv` de él, dejando los tres flags de componente como hasta ahora.

### 9.2 `AnalyzeEnv`

Se agregan `analysisFakeFinalization` y `analysisFakePersistence` a `AnalyzeEnv` (`supabase/functions/analyze/index.ts:38-47`). El handler elige cada double por separado (`supabase/functions/analyze/index.ts:220-231`). `tests/support/analysis-edge.ts` agrega las opciones y limpia las variables del child env (`tests/support/analysis-edge.ts:80-114`).

### 9.3 `FakeProviderBehavior` extendido con findings custom

- `FakeProviderBehavior.findings?: InternalFinding[]` ya existe (`supabase/functions/analyze/_test_doubles/analysis-provider.fake.ts:11-22`), pero `createFakeProvider` no lo copia (`:62-74`) y `parseFakeBehaviorSafe` no lo parsea (`:81-108`).
- S2-08 lo conecta: validar array de findings con la misma forma del wire (type, severity, confidence, explanation, evidence de 2 lados) y descartar silenciosamente los inválidos, como el resto del parser.
- Los overrides por request `_fake.findings` se honran solo con el gate local abierto (`supabase/functions/analyze/index.ts:220-226`).

### 9.4 Tests de gate

- `tests/unit/analysis-worker-readiness.test.ts:297-310` pasa de “ambas factories lanzan” a “ambas construyen y exponen sus métodos”.
- Se agregan casos: flag `"0"` fuerza real aun en local; flag `"1"` en `*.supabase.co` no enciende; credenciales faltantes siguen devolviendo 503 sin claim (`tests/unit/analysis-worker-readiness.test.ts:316-337`).

---

## 10. `analysis_status` (8a + 8b)

### 10.1 Solo source, solo `pending_reanalysis → analyzed`

- Se actualizan únicamente versiones con `role='source'` en `analysis_documents` del análisis (`§6.4`).
- El enum solo tiene `pending_reanalysis` y `analyzed` (`supabase/migrations/00001_initial_schema.sql:12`).
- La elegibilidad de S2-03 depende de `processing_status=ready` y `version_status=active`, no de `analysis_status` (`supabase/migrations/20261011030000_s2_03_eligible_documents_projection.sql:1-20`; `supabase/tests/database/s2_03_eligible_documents_projection.test.sql:22-29`).

### 10.2 Sin evento por versión

- El único evento es el terminal del análisis (`analysis_completed`/`analysis_failed`); no se emite un evento por `document_version` (`supabase/migrations/20261010192119_s2_01_analysis_tables.sql:163-183`).

### 10.3 No reset en fallo ni reprocesamiento

- En fallo terminal no se toca `analysis_status`.
- El reprocesamiento de la misma versión no resetea `analysis_status`; es deuda §12.1 #18, dueño ingestion (`docs/Tickets/sprint-2-ai-analysis.md:444`).

### 10.4 S2-09 lee views

- S2-09 debe leer `public.analysis_runs`, `public.analysis_scope`, `public.analysis_findings` y `public.analysis_finding_evidence`, no tablas ni columnas técnicas (`supabase/migrations/20261010194238_s2_01_analysis_security.sql:74-146`; `docs/Tickets/sprint-2-ai-analysis.md:449-500`).
- Las views ya filtran `completed` (`:113-146`), por lo que findings de un análisis no completado no se exponen.

---

## 11. Tests y criterios de aceptación

### 11.1 SQL nuevos (3 archivos)

| Archivo | Cubre |
|---|---|
| `supabase/tests/database/s2_08_staging.test.sql` | Tablas, RLS, ausencia de grants, fingerprint determinista, CAS, avance de checkpoint (has_more true/false), rollback a mitad de batch, dedup first-wins dentro de un lote y **first-wins entre intentos** (intento 1 stagea el fingerprint como `High`, intento 2 lo reintenta como `Low` → al publicar gana `High`; la clave es `(analysis_id, fingerprint)` sin `operation_id`, P2). Test de trigger de cleanup: `UPDATE analyses SET status='failed'` sin pasar por el helper → staging se borra por el trigger (red de seguridad). |
| `supabase/tests/database/s2_08_finalization.test.sql` | Éxito, cero findings, idempotencia, invariante P3 (`staging_count = 0` con `reported > 0` → `P0001`; `staging_count < reported` no es error), `analysis_status` solo source, fallo no marca, ledger `Consumed`/`Released`, evento, `superseded`, límites de snapshot, cleanup total por `analysis_id` sin filtrar por `operation_id`. |
| `supabase/tests/database/s2_08_locks.test.sql` | `claim` 45 s, advisory por workspace, sweep en dos fases, `fail`/`create_analysis_run` con advisory, revocación de `complete_analysis` con `P0001`, deadlock con `dblink`. |

### 11.2 Unit nuevos y a reescribir

`tests/unit/analysis-fingerprint.test.ts` ya existe y cubre el fingerprint de *retrieval* (`computeRequestFingerprint`, `@/modules/analysis/retrieval`); no se reutiliza para el fingerprint de findings.

| Archivo | Estado | Cubre |
|---|---|---|
| `tests/unit/analysis-finding-fingerprint.test.ts` | Nuevo | Algoritmo §5.2, ejemplos que colapsan/no colapsan, paridad con `private.canonical_jsonb`. |
| `tests/unit/analysis-worker-batch-persistence.test.ts` | Reescribir | Hoy exige que el seam lance (`:38-40`); pasa a cubrir fencing, CAS, staging atómico, rollback y `has_more`. |
| `tests/unit/analysis-finalization.test.ts` | Nuevo | Factory real con cliente, mapping SQLSTATE §6.5, idempotencia, `PERSISTENCE_FAILED`. |
| `tests/unit/analysis-provider-fake.test.ts` | Nuevo | `parseFakeBehaviorSafe` con findings custom, descarte de malformados, flags de gate. |

### 11.3 Integración a actualizar (8–10 sitios)

- `tests/integration/analysis-worker.test.ts`: ledger pasa de `[Reserved]` a `[Reserved, Consumed]` y eventos de 0 a 1 en `:278-287`; el uso directo de `complete_analysis` en `:390` se migra al cierre nuevo; el camino de fallo en `:456-459` espera `Released` + `analysis_failed`.
- `tests/integration/analysis-recovery.test.ts`: ledger `Consumed` en `:398`, `:485`, `:549`.
- `tests/integration/analysis-materialized-candidates.test.ts`: `complete_analysis` en `:146`, `:184`; expectativa de `fail_analysis` terminal en `:238`.
- `supabase/functions/analyze/_test_doubles/analysis-finalization.test-shim.ts`: nuevo RPC y mapping `P0001` → `PERSISTENCE_FAILED`.
- `tests/support/analysis-edge.ts`: tres flags y limpieza de env.
- `tests/support/analysis-fixtures.ts`: fixtures de findings custom si el helper no los expone.
- `tests/unit/analysis-worker-readiness.test.ts`: factories reales y flags (`:297-310`).
- `tests/unit/analysis-worker-seams.test.ts`: `createFinalization` y `createBatchPersistence` dejan de lanzar; se ajusta la expectativa de `:28-48`.
- `tests/unit/analysis-worker-batch-persistence.test.ts`: pasa de exigir throw a ejercitar el puerto real.
- `tests/unit/deno-import-extensions.test.ts`: nuevos módulos Deno-safe (`fingerprint.ts`).

No cambian `supabase/tests/database/s2_03_eligible_documents_projection.test.sql` ni `supabase/tests/database/013_analysis_integrity.test.sql`.

### 11.4 Smoke local determinístico (runbook)

Agregar a `docs/testing/s2-06-analysis-worker-runbook.md` una sección S2-08:

- provider fake con findings custom;
- persistencia y finalize reales (flags `ANALYSIS_FAKE_FINALIZATION=0`, `ANALYSIS_FAKE_PERSISTENCE=0`);
- verificación de findings/evidence, `Consumed`, `analysis_completed` y `analysis_status`;
- caso cero findings;
- caso fallo terminal con `Released` + `analysis_failed`.
- No reemplaza el E2E real con proveedor; eso queda en S2-12 (`docs/PRD/sprint-2-ai-analysis-slice.md:83`).

### 11.5 Criterios de aceptación del ticket

| DoD del ticket | Sección |
|---|---|
| Persistir solo findings/evidence validados con relaciones exactas de scope/tenant | §5.3, §5.5, §6.1 |
| Fingerprint determinista y dedup intra-análisis; A/B invertidos no duplican | §5.2 |
| Un análisis nuevo puede repetir el hallazgo; sin supresión histórica | §5.2 |
| `pending_review`, assignee nulo, `severity_original = severity_current`, confidence interna | §5.5 |
| Snapshot ≤ 2.000, ubicación disponible, sin fabricar ubicaciones | §5.1, §5.3 |
| Cierre atómico con lease/fencing y `analysis_status` de fuentes exactas | §6 |
| Cero hallazgos finaliza `completed` y consume | §1, §6 |
| Fallo terminal revierte salida provisional, libera y emite evento | §7 |
| Consumo/liberación solo vía S2-02; repetir es idempotente | §6.2, §7.1 |
| Fallo al guardar evidencia impide `completed` | §6.5 |
| Pruebas de fingerprint, snapshots, FKs, rollback, carrera, cero y publicación única | §11 |

---

## 12. Deuda, riesgos, §12.1

### 12.1 Filas nuevas y actualizaciones

No se duplica la tabla §12.1 de S2-06 (`docs/superpowers/specs/2026-10-15-s2-06-analysis-worker-spec.md:310-329`). Cambios:

| # | Ítem | Dueño | Reapertura | Impacto |
|---|---|---|---|---|
| 17 | Terminales pre-S2-08 sin cierre coherente: `failed` sin `Released`/evento y `completed` sin `Consumed`/evento/findings/`analysis_status` | S2-08 (documenta) | Backfill solicitado o auditoría histórica | Ledger/eventos/`analysis_status` históricos incompletos |
| 18 | Reprocesamiento de la misma versión no resetea `analysis_status` | Ingestion / ticket futuro | Se permita reprocesar una versión `analyzed` o cambien sus chunks | Versión `analyzed` con contenido distinto |
| 19 | `persist_analysis_batch` duplicada en migración original + correctiva (`20261021181000`). Cambios futuros deben tocar ambas o consolidar. | S2-08b / plataforma | Próximo cambio a `persist_analysis_batch` | Drift entre migraciones |
| 20 | Analysis upgrade inventory es un allowlist manual (`analysis-upgrade-policy.mjs`). Cada migración nueva requiere: set, `stageOrder`, rama en `migrationStage`, unión en `.d.mts`, JSDoc, y tests. | Plataforma | Próximo CI fix por inventory | 1-2hs por slice; riesgo de CI rojo si se olvida |

**Actualizadas:** fila 13 (`provider_used`/`model_used`) y fila 16 (telemetría de proveedor efectivo) pasan a dueño S2-10/S2-11 si S2-08 no las implementa (`docs/superpowers/specs/2026-10-15-s2-06-analysis-worker-spec.md:326`, `:329`).
**Cerradas por S2-08:** filas 5, 6, 7 y 8 (`docs/superpowers/specs/2026-10-15-s2-06-analysis-worker-spec.md:318-321`).
**Verificar:** fila 3 (Sentry remoto) sigue abierta salvo que se cablee en el mismo PR (`docs/superpowers/specs/2026-10-15-s2-06-analysis-worker-spec.md:316`).

### 12.2 Riesgos residuales

| Riesgo | Severidad | Mitigación |
|---|---|---|
| `createFinalization()` sin cliente | Bloqueante | Cambio de factory a `createFinalization(client)` antes de 8a (§4.1) |
| Terminales pre-S2-08 `completed`/`failed` | Alta | Fila 17; no backfill en S2-08 |
| Staging contaminado por worker viejo | Alta | Fencing `operation_id` + CAS en `persist_analysis_batch` (§5.3) |
| Deadlock si un camino que llama `settle` no toma advisory workspace | Alta | Orden §8.1 en `finalize`, `fail`, sweeps de `claim` y `create_analysis_run` |
| `create_analysis_run` es owner Dev 1/S2-05 | Alta | Coordinación de timestamp y revisión de Dev 1 (§8.2) |
| `provider_used`/`model_used` quedan NULL | Media | Filas 13/16 reasignadas a S2-10/S2-11 |
| Reprocesamiento no resetea `analysis_status` | Media | Fila 18, dueño ingestion |
| E2E real con proveedor no corre en CI | Media | Smoke determinístico S2-08; real en S2-12 |
| Sentry remoto no cableado | Media | Verificar fila 3 |
| Flake de `test:integration` ya conocido | Media | Monitorear; no atribuir a S2-08 sin evidencia (`docs/superpowers/specs/2026-10-15-s2-06-analysis-worker-spec.md:324`) |
| `claim_analysis` con sweep de análisis bajo 45 s | Media | Timeout 45 s (techo) + dos fases + tests de carga |
| Trigger de cleanup `AFTER UPDATE OF status` puede borrar staging antes de diagnóstico forense | Baja | Si se necesita preservar staging, revisar si el trigger debe ser condicional (solo failed) o deshabilitarse en entornos de diagnóstico |

---

## 13. Apéndice — decisiones para S2-08b

Esta sección corrige contradicciones/vacíos de §7-§9 detectados al
preparar el plan de 8b. Es aditivo, no cambia §7-§9.

### 13.1 Helper finalize_failed_analysis — modos y estados

(Corrección a §7.1 paso 3, que decía `status <> 'processing' → false`.)

Firma actualizada:

```sql
private.finalize_failed_analysis(
  p_analysis_id uuid,
  p_operation_id uuid,
  p_error_code public.analysis_failure_code,
  p_enforce_operation boolean
) returns text
-- 'failed' | 'superseded' (alineado con fail_analysis, que
-- retorna 'queued'|'failed'|'superseded')
```

El helper tiene dos modos:

- **p_enforce_operation = true** (invocado por `fail_analysis` directo):
  - Requiere `status='processing'`, `operation_id = p_operation_id`,
    `lease_expires_at > now`, `attempt_deadline_at > now`,
    `analysis_deadline_at > now`.
  - Cualquier desajuste → `return 'superseded'` sin efectos.

- **p_enforce_operation = false** (invocado por los sweeps de
  `claim_analysis`):
  - Acepta `status IN ('processing', 'queued')`.
  - NO re-valida la condición terminal (`attempt_count >= 3`, deadlines
    vencidos, etc.) — el caller ya decidió bajo advisory + `SKIP LOCKED`.
  - El helper solo ejecuta la transacción atómica.

Pseudocódigo:

```text
if p_enforce_operation then
  if v.status <> 'processing'
     or v.operation_id is distinct from p_operation_id
     or v.lease_expires_at <= ts
     or v.attempt_deadline_at <= ts
     or v.analysis_deadline_at <= ts then
    return 'superseded';
  end if;
else
  if v.status not in ('processing', 'queued') then
    return 'superseded';
  end if;
end if;
```

Los retornos del helper son `text`: `return 'failed'` / `return 'superseded'`.

### 13.2 Orden canónico de locks

(Corrección a §8.4 fase 2.)

Cualquier camino que toque ledger (`finalize`, `fail`, sweeps de `claim`,
`create_analysis_run`) toma los locks en este orden:

1. `pg_advisory_xact_lock(hashtextextended(workspace_id::text, 0))`
2. `SELECT ... FROM public.workspaces WHERE id = workspace_id FOR UPDATE`
3. `SELECT ... FROM public.analyses WHERE id = analysis_id FOR UPDATE`

El caller NO pre-bloquea el análisis. El helper es self-contained: hace
los 3 locks internamente. Si el caller ya tomó el advisory, PG permite
re-adquirirlo (mismo lock, reentrante).

Fase 2 del sweep de `claim_analysis`:

1. Iterar candidatos de la fase 1 (`SELECT` sin locks).
2. Llamar helper (hace los 3 locks).
3. Si retorna `'superseded'` → skip (otro worker lo tomó).
4. Si retorna `'failed'` → continuar.

Precondición para no deadlockear: TODOS los caminos usan este orden.
Se verifica con:

- Review estático del plan (cada task declara el orden).
- Test de integración TS con 2 sesiones concurrentes (ver 13.5).

### 13.3 complete_analysis — trap P0001, no revocación

(Corrección a §11.1 y §6.)

`complete_analysis` se reemplaza por un trap que lanza `P0001` con grant
conservado:

```sql
create or replace function public.complete_analysis(...) returns void
language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'complete_analysis is deprecated, use finalize_analysis_success'
    using errcode = 'P0001';
end;
$$;
```

NO se revoca el grant de `service_role`. Justificación:

- `42501` (permission denied) es un error de infra.
- `P0001` es intencional (deprecated) y el mapping §6.5 lo convierte a
  `PERSISTENCE_FAILED` retryable.
- El worker nunca lo llama (usa `finalize_analysis_success`).

Test `s2_08_finalization.test.sql:618-640` se actualiza en 8b-10 a
`throws_ok(..., 'P0001', ...)`.

### 13.4 Idempotencia del helper — tabla de casos

(Corrección a §7.1 paso 2.)

| Caso | Estado | Token | Settlement | Acción |
|---|---|---|---|---|
| A | processing | match + lease OK | ninguno | Normal: UPDATE failed + Released + evento + cleanup → `'failed'` |
| B | processing | mismatch | — | `'superseded'` |
| C | processing | match pero lease/deadline vencido | — | `'superseded'` |
| D | failed | match | Released + evento + sin staging | No-op → `'failed'` (idempotente) |
| E | failed | match | Released + evento + staging pendiente | Cleanup staging → `'failed'` |
| F | failed | match | Consumed (inconsistente) | raise `P0001` (no silenciar corrupción) |
| G | failed | match | Released ausente | Settle Released + evento + cleanup → `'failed'` |
| H | failed | mismatch | — | `'superseded'` |
| I | completed | cualquier | — | `'superseded'` |
| J | queued | `p_enforce_operation=true` | — | `'superseded'` |
| K | queued | `p_enforce_operation=false` | caller confirmó terminal | Normal: UPDATE failed + Released + evento + cleanup → `'failed'` |
| L | no existe | — | — | `'superseded'` |

Reglas:

- Solo completa cuando `status='failed'` + token match (o estado
  terminal ya consistente).
- `Consumed` en `failed` → `P0001` (no silenciar).
- Re-ejecutar sobre `failed` consistente → no-op.
- Completar lo que falte si el estado es `failed` con settlement/evento
  parciales.

### 13.5 Test de deadlock — 2 sesiones TS, no dblink

(Corrección a §8.5.)

El test de deadlock NO usa `dblink`. Usa el patrón `openLocalSqlSession`
del repo (`tests/integration/analysis-recovery.test.ts`).

Test en `tests/integration/analysis-lock-order.test.ts`:

1. Fixture: análisis A + B en el mismo workspace.
2. Session 1: `BEGIN; advisory(ws); FOR UPDATE workspaces;` (pausa)
3. Session 2: `BEGIN; advisory(ws)` — debe BLOQUEAR
4. Session 1: `FOR UPDATE analyses; COMMIT`
5. Session 2: procede sin deadlock; `COMMIT`
6. Assert: ambas sesiones completan; no deadlock; no timeout.

El `skip` actual en `020_s2_06_analysis_leases.test.sql:414` ("dblink no
disponible") se mantiene; el test TS lo reemplaza.

### 13.6 §12.1 fila 20 — inventory manual

| # | Ítem | Dueño | Reapertura | Impacto |
|---|---|---|---|---|
| 20 | Analysis upgrade inventory es un allowlist manual (`analysis-upgrade-policy.mjs`). Cada migración nueva requiere: set, `stageOrder`, rama en `migrationStage`, unión en `.d.mts`, JSDoc, y tests. | Plataforma | Próximo CI fix por inventory | 1-2hs por slice; riesgo de CI rojo si se olvida |

### 13.7 Tests pgTAP existentes a migrar (Gap 4)

Los tests identificados por el agente se migran dentro de las tasks
de 8b:

| Test | Task | Cambio |
|---|---|---|
| `020:94-117` (terminal `claim_analysis` sweep) | 8b-7 | Agregar `Reserved` + esperar `Released` + evento |
| `020:304-332` (terminal `fail_analysis`) | 8b-8 | Agregar `Reserved` + esperar `Released` + evento |
| `020:334-354` (terminal `fail_analysis`, `fail_nr`) | 8b-8 | Add `Reserved`; expect `Released` + event |
| `024:206-230` (continuación vencida terminal `claim`) | 8b-7 | Agregar `Reserved` + esperar `Released` + evento |
| `020:220-251` (`complete_analysis` success) | 8b-10 | Migrar a `finalize_analysis_success` con staging |
| `020:356-374` (`complete` sobre fila viva) | 8b-10 | Migrar a `finalize_analysis_success` |
| `s2_08_finalization.test.sql:618-640` (`complete_analysis` disponible) | 8b-10 | Cambiar a `throws_ok(..., 'P0001', ...)` |

Regla: si un test rompe y NO está en esta lista, PARÁ y reportá.

---

## Referencias

- Ticket S2-08 completo y BDD: `docs/Tickets/sprint-2-ai-analysis.md:398-448`.
- Ticket S2-07 (proveedor, mergeado): `docs/Tickets/sprint-2-ai-analysis.md:347-397`.
- Ticket S2-09 (consumidor del estado y release): `docs/Tickets/sprint-2-ai-analysis.md:449-500`.
- PRD: §12.3 (`docs/PRD/knowledge-decay-monitor-prd-final.md:468-488`), §17–23 (`:641-830`), §30–32 (`:940-1075`), §42–43 (`:1285-1325`), §66 (`:1990-2040`).
- Spec S2-05: `docs/superpowers/specs/2026-10-17-s2-05-idempotent-analysis-run-design.md:131-270`.
- Spec S2-06: `docs/superpowers/specs/2026-10-15-s2-06-analysis-worker-spec.md:60-355`.
- Spec S2-07: `docs/superpowers/specs/2026-10-20-s2-07-analysis-provider-spec.md:1-302`.
- Runbook S2-06: `docs/testing/s2-06-analysis-worker-runbook.md:1-145`.
- Esquema y seguridad: `supabase/migrations/20261010192119_s2_01_analysis_tables.sql:1-195`; `supabase/migrations/20261010194238_s2_01_analysis_security.sql:1-152`; `supabase/migrations/20261011013954_s2_02_credit_operations.sql:104-306`; `supabase/migrations/20261017190200_s2_05_run_commands.sql:23-358`; `supabase/migrations/20261017205245_s2_05_worker_handoff.sql:28-754`; `supabase/migrations/20261015221607_s2_06_analysis_leases.sql:13-174`; `supabase/migrations/20261018021500_s2_05_materialized_candidate_snapshots.sql:500-641`.
- Tipos y seams: `src/types/analysis-internal.ts:13-106`; `src/modules/analysis/worker/finalization.ts:1-30`; `src/modules/analysis/worker/batch-persistence.ts:1-14`; `src/modules/analysis/worker/batch.ts:65-242`; `src/modules/analysis/worker/process-analysis.ts:201-341`; `supabase/functions/analyze/index.ts:33-231`.
