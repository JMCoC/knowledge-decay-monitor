# S2-05 — Run/Retry idempotentes: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. El usuario aprobó el diseño y el plan, eligió ejecución inline en la rama actual y autorizó crear un commit después de cada tarea solo cuando sus verificaciones pasen. No se autorizan push ni despliegues.

**Goal:** Entregar todo S2-05 y corregir sus prerrequisitos S2-04/S2-06: estimaciones completas, Run/Retry autorizados con reserva atómica, idempotencia y worker Edge recuperable cuya capacidad se evalúa en esta entrega.

**Architecture:** Monolito modular con Server Actions y RPC privilegiadas que reautorizan al actor y resuelven tenant/rol desde Profile. PostgreSQL conserva resumen completo, snapshots y reserva; el worker Edge lee pares por lotes y diferencia continuación de retry mediante handoff y fencing. Cron recupera trabajos sin actividad del navegador; el worker Node de ingesta permanece independiente.

**Tech Stack:** Node.js 24.11.0, pnpm 12.5.1, Next.js 16.3.5/React 19.2.8, TypeScript estricto, Zod 4.6.5, Supabase CLI 2.117.0/PostgreSQL/pgvector/pgTAP, Deno Edge, Vitest 5.0.2. Sin dependencias nuevas previstas.

**Spec:** [Diseño aprobado de S2-05](../specs/2026-10-17-s2-05-idempotent-analysis-run-design.md). Leerlo completo junto con [la revisión de dependencias](../../testing/2026-10-17-s2-05-dependency-review.md). Este plan elige detalles internos que el diseño dejó al implementador; no modifica el producto aprobado.

## Global Constraints

- Máximo 20 versiones distintas en la unión source/comparison; al menos una fuente; comparación vacía válida; Top K total 5 y umbral 0.75.
- Contar todos los chunks de la unión; `credits = ceil((100 + 5*chunkCount + 20*candidatePairCount)/100)`. Precio confirmado = coste persistido = reserva.
- TTL de estimaciones: 30 minutos desde reloj SQL. Key de 1–128 caracteres, sin espacios extremos y entradas Zod estrictas.
- Único análisis queued/processing por workspace; key scoped a workspace/actor; replay confirmado anterior a comprobaciones de TTL/vigencia.
- Retry manual: nueva ejecución, estimación, key y reserva; failed previo completamente Released, sin Consumed. Admin/QA del tenant pueden confirmar una nueva selección.
- Inicial más exactamente hasta dos retries automáticos; los lotes exitosos conservan attempt_count. Lease 180s, heartbeat 30s, lote 60s, intento 30min, análisis 90min como presupuestos iniciales medidos.
- Cron cada minuto; token `ANALYSIS_INTERNAL_TOKEN` independiente de ingesta; disparo web mediante after con timeout 2s, exclusivamente tras commit.
- S2-07 mantiene proveedor real; S2-08 mantiene staging/finalización/consumo/liberación/eventos; S2-09 mantiene UI. Factories productivas ausentes cierran readiness antes del claim.
- No modificar `C:\KDM\kdm-demo-worker`, módulos de ingesta/créditos ni migraciones históricas. Se pueden añadir triggers SQL que protejan el snapshot, con prueba de regresión de ingesta.
- Añadir migraciones nuevas, comprobar grants/RLS y regenerar `src/types/database.ts`; nunca editar tipos SQL manualmente. Preservar documentos y datos locales.
- Ejecutar desde la raíz con `npx pnpm@12.5.1` si pnpm no está disponible. No reset del entorno del usuario, seed remoto, `--linked`, secretos en artefactos ni cambios remotos sin autorización específica.
- Cada tarea termina con revisión local de diff y pruebas requeridas; si ambas pasan, crear un commit de alcance explícito conforme a la autorización del usuario. No hacer push ni despliegues.
- Consultar documentación instalada de Next.js y Context7 ante dudas de API; conservar imports `.ts` de todo el grafo Deno y barrels cliente/servidor separados.

## Review Focus

1. Replay con estimación caducada, manifiesto ausente o versión ya histórica: devolver el Run confirmado con autorización actual, sin otra reserva. Tareas 3/4.
2. Cambios concurrentes de chunks/puntero activo mientras se valida Run: serializar o rechazar, nunca cobrar un snapshot distinto. Tareas 1/3.
3. Más de 1.000 pares y empates de similitud entre fuentes solapadas: resumen y paginación completos y deterministas. Tareas 1/6.
4. Crash entre persistir un lote y ceder/finalizar, o dos continuaciones con el mismo cursor: fencing y checkpoint impiden retroceso/doble avance. Tareas 5/6.
5. Cron activo sin readiness, token/URL ausentes o caída del proveedor: no quemar intentos ni inventar liberaciones; declarar evidencia faltante. Tareas 7/8.

## Organización y autorización de ejecución

Es un solo plan porque los prerrequisitos comparten snapshot, cursor y RPC con
Run; no son proyectos independientes. Orden 1 → 2 → 3 → 4 y 1 → 5 → 6 → 7;
la tarea 8 integra ambos recorridos. Antes de implementar, comprobar estado,
HEAD, instrucciones y aislamiento con la skill de worktrees; conservar estos
documentos y cualquier cambio posterior del usuario. Ya existe una rama
específica. Nunca sustituir el worktree de ingesta. El usuario autorizó
commits de cada tarea completa en esta rama; esos commits no autorizan push.

El baseline de la revisión anterior fue: 31 migraciones, SQL PASS con 641
pruebas declaradas y una omitida; fixtures/tipos/typecheck PASS; lint sin
errores y cuatro warnings; unitarias 579/581 con guard Windows y timeout del
parser; integración de estimación/worker 7/8 con crash no demostrado.
Actualizar el baseline al ejecutar; esos números son históricos.

## File Structure

| Archivos | Responsabilidad | Tarea |
|---|---|---|
| `src/types/analysis-internal.ts`; `src/modules/analysis/retrieval.ts`, `pricing.ts` | Manifiesto/cursor/resumen internos y fingerprint v2, sin cambiar firmas públicas | 1 |
| `supabase/migrations/20261017190000_s2_05_retrieval_snapshot.sql` | Retrieval determinista, resumen completo, página de pares y protección de snapshot | 1 |
| `supabase/tests/database/021_s2_05_retrieval_snapshot.test.sql`; `tests/integration/analysis-retrieval-snapshot.test.ts` | Conteo completo, 1.000+, empates, aislamiento y locks | 1 |
| `tests/unit/analysis-fingerprint.test.ts`, `analysis-pricing.test.ts`, `deno-import-extensions.test.ts` | Fingerprint y guard Windows reales | 1 |
| `src/modules/analysis/execution-config.ts`; `schemas.ts`, `actions.ts`, `queries.ts` | Manifiesto privado y estimación autorizada | 2 |
| `supabase/migrations/20261017190100_s2_05_estimate_commands.sql`, `20261017190110_s2_05_estimate_json_validation_fix.sql`, `20261017190120_s2_05_empty_comparison_normalization.sql`, `20261017190130_s2_05_empty_comparison_array_fix.sql`; `supabase/tests/database/022_s2_05_estimate_commands.test.sql` | Snapshot/TTL de estimaciones, RPC y permisos | 2 |
| `src/modules/analysis/execution-config.ts`; `tests/unit/analysis-execution-config.test.ts`, `analysis-estimate.test.ts`, `analysis-estimate-query.test.ts`; `tests/integration/analysis-estimation.test.ts` | Configuración privada, autorización y estimación real | 2 |
| `supabase/migrations/20261017190200_s2_05_run_commands.sql`, `20261017190210_s2_05_analysis_estimate_timeouts.sql`; `supabase/tests/database/023_s2_05_run_commands.test.sql` | Run/Retry en una transacción, replays y presupuestos SQL | 3 |
| `tests/integration/analysis-run.test.ts`, `analysis-run-concurrency.test.ts`; `docs/contracts/S2-05-run-and-worker-handoff.md` | Casos SQL/HTTP, carreras y contrato con el worker separado | 3 |
| `src/modules/analysis/run-actions.ts`, `run-queries.ts`, `worker-trigger.ts`; `schemas.ts`, `index.ts` | Frontera Server Action, RPC y after | 4 |
| `tests/unit/analysis-run-action.test.ts`, `analysis-worker-trigger.test.ts`; `src/lib/observability/safe-event.ts` y pruebas de catálogo si procede | Errores controlados y telemetría permitida | 4 |
| `supabase/migrations/20261017205245_s2_05_worker_handoff.sql`; `supabase/tests/database/024_s2_05_worker_handoff.test.sql`; `scripts/analysis-upgrade-policy.mjs`; `tests/unit/analysis-upgrade-policy.test.ts` | Continuación, intentos, fencing, deadlines e inventario de upgrades | 5 |
| `src/modules/analysis/worker/types.ts`, `claim.ts`, `context.ts`, `batch.ts`, `process-analysis.ts`, `constants.ts`; nuevo `batch-persistence.ts` | Carga por lote, heartbeat y puerto de staging | 6 |
| `supabase/functions/analyze/index.ts`, `_test_doubles/analysis-finalization.test-shim.ts`; nuevo `_test_doubles/analysis-batch-persistence.fake.ts` | Entrada asíncrona y dobles explícitos locales | 6 |
| `tests/unit/analysis-worker-{context,batch,process,readiness,seams}.test.ts`; `tests/integration/analysis-worker.test.ts`; `tests/support/analysis-edge.ts` | Continuidad, carreras y crash observados | 6 |
| `supabase/migrations/20261017190400_s2_05_analysis_recovery.sql`; `supabase/tests/database/025_s2_05_analysis_recovery.test.sql`; `supabase/config.toml` | Cron, Vault, sweep y autenticación de analyze | 7 |
| `tests/integration/analysis-recovery.test.ts` | Scheduler real local y disparo perdido | 7 |
| `scripts/measure-analysis-capacity.mjs`; `tests/unit/analysis-capacity-policy.test.ts`; `tests/support/analysis-capacity-fixtures.ts` | Mediciones seguras y estado del gate | 8 |
| `.github/workflows/s1-01.yml`; `scripts/analysis-upgrade-policy.mjs`; `tests/unit/analysis-upgrade-policy.test.ts` | Incorporar las migraciones y pruebas nuevas sin eliminar S1 | 8 |
| `src/types/database.ts` | Regenerado tras cada migración | 1–8 |
| `docs/contracts/S2-04-retrieval-estimation.md`; nuevo `docs/contracts/S2-05-run-and-worker-handoff.md`; `docs/testing/s2-06-analysis-worker-runbook.md`; nuevo `docs/testing/s2-05-acceptance.md` | Contratos, comandos y evidencia por responsabilidad | En su tarea propietaria |

Los timestamps están reservados en este plan; antes de crear archivos,
confirmar que siguen libres y que ningún nuevo merge exige coordinarlos.
Las notaciones con llaves de la tabla representan archivos existentes,
no nuevos patrones de nombres en disco. Añadir solo los tests que ejerciten
comportamiento de riesgo, sin duplicar las aserciones de las otras tareas.

### Task 1: Resumen completo y lectura determinista por lotes

**Files:** Grupo de tarea 1 del mapa, tipos regenerados y contrato S2-04.

**Interfaces:**
- Produce `AnalysisExecutionManifest { fingerprintVersion: 's2-05-v2'; pricingVersion: 's2-04-v1'; promptVersion: string; outputSchemaVersion: string; providers: AnalysisConfiguration['providers'] }` en `analysis-internal.ts`; la tarifa numérica no cambia.
- Produce `AnalysisPairCursor { lowChunkId: string; highChunkId: string }` y `AnalysisRetrievalSummary { chunkCount: number; candidatePairCount: number; chunksRevision: string; fingerprint: string; fixedCost: number }`.
- Produce `private.analysis_retrieval_summary(p_workspace_id uuid,p_source_version_ids uuid[],p_comparison_version_ids uuid[],p_manifest jsonb)` → una fila de `chunk_count,candidate_pair_count,chunks_revision,request_fingerprint,fixed_cost`.
- Produce `private.analysis_candidate_pair_page(p_workspace_id uuid,p_source_version_ids uuid[],p_comparison_version_ids uuid[],p_after_low uuid,p_after_high uuid,p_limit integer)` → referencias/textos/similitud actuales y `pair_low_id,pair_high_id`; límite 1..10.
- `computeRequestFingerprint(input, overrides)` conserva el helper de paridad SQL/TS; se amplía para manifiesto/fingerprintVersion v2. Los callers de ejecución pasan a usar resumen SQL, no descargar todo para calcularlo.

- [x] **Step 1: Escribir pruebas rojas del resumen, páginas y guard.**

```ts
expect(price({chunks: 20, pairs: 0})).toBe(2);
expect(price({chunks: 10, pairs: 5})).toBe(3);
expect(summary.candidatePairCount).toBe(knownPairsAbove1000);
expect(new Set(allPages.map(pairKey)).size).toBe(knownPairsAbove1000);
expect(summaryAfterAddingUnpairedChunk.fingerprint).not.toBe(summary.fingerprint);
expect(sqlFingerprint).toBe(tsFingerprint);
```

Los nombres `price/summary/allPages` son valores de cada fixture: llamar al
helper existente y a las RPC privadas mediante la sesión SQL de pruebas.
Añadir empate A/B en fuentes solapadas y repetir consultas: mismo orden y
orientación; asegurar que una página no duplica ni omite la frontera del cursor.
Extender el guard Deno para que alcance al menos los 14 módulos en Windows
y rechace una importación relativa sin extensión dentro de un archivo hijo.

- [x] **Step 2: Ejecutar rojo.** Las pruebas unitarias fallaron inicialmente en manifiesto, recorrido Deno Windows y grafo hijo; el test DB falló por ausencia esperada de la RPC nueva, sin fallo de Docker.
- [x] **Step 3: Implementar la migración y los tipos internos.** Canonizar con `(least(chunk_a,chunk_b),greatest(...))` y desempatar además por source/comparison ID; no invertir una fuente externa por ordenar su ID. Corregir el ORDER BY de `public.retrieve_candidate_pairs` mediante CREATE OR REPLACE en la migración nueva, conservando firma, seguridad invoker y grants. Los helpers privados reutilizan ese retrieval dentro de SQL, donde no aplica el límite HTTP, para agregar el resumen o emitir la página. Sin tablas de candidatos. Hash SHA-256 de JSON canónico con claves ordenadas y sin espacios; incluir manifiesto y versión v2. `jsonb::text` sin canonicalización explícita no es compatible con el helper TS.
- [x] **Step 4: Proteger el snapshot.** Crear `private.lock_analysis_chunk_versions() returns trigger` sobre INSERT/UPDATE/DELETE de chunks, bloqueando las versiones old/new en orden UUID. La validación del scope toma locks de esas versiones en el mismo orden y revalida puntero/estados después de esperar; evitar un orden inverso versión/documento frente a `finish_processing`. Probar con dos sesiones que insertar un chunk/pasar a otra versión no puede cruzar el commit de Run con una revisión anterior. El cambio afecta al esquema, no al código de ingesta.
- [x] **Step 5: Aplicar/verificar localmente.** La migración se aplicó en Supabase local sin reset; types generados ya coinciden con el esquema. `test:db` PASS (22 archivos, 653 pruebas declaradas/observadas); integración de snapshot PASS (3/3); unitarias completas PASS (82 archivos, 583/583); `check:database-types`, `typecheck` y `lint` PASS. El lint conserva cuatro advertencias previas.
- [x] **Step 6: Checkpoint y commit de tarea.** `git diff --check` PASS. Se revisó el contrato S2-04; no se modificaron migraciones previas ni el código TypeScript de ingesta. Crear el commit de la tarea tras repetir `test:db` como verificación de cierre.

### Task 2: Estimaciones íntegras con configuración y reloj SQL

**Files:** Grupo de tarea 2 del mapa; reutilizar el wrapper de selección S2-03.

**Interfaces:**
- Consume `AnalysisExecutionManifest` y `private.analysis_retrieval_summary` de tarea 1.
- Produce `readAnalysisExecutionManifest(raw: string | undefined): AnalysisExecutionManifest | null` en `execution-config.ts`, desde env privada `ANALYSIS_EXECUTION_MANIFEST` (JSON de versiones y referencias provider/model, sin prompts ni claves).
- Produce `public.create_analysis_estimate(p_actor_id uuid,p_source_version_ids uuid[],p_comparison_version_ids uuid[],p_manifest jsonb)` → una fila `estimate_ref,fixed_cost,expires_at,source_version_ids,comparison_version_ids`.
- Mantiene `estimateAnalysis(input: AnalysisSelectionInput): Promise<ActionResult<AnalysisEstimate>>`; `queries.ts` implementa `createAnalysisEstimate(actorId: string,input: AnalysisSelectionInput,manifest: AnalysisExecutionManifest): Promise<AnalysisEstimate>` con cliente de servicio.

- [x] **Step 1: Escribir rojo de autorización/configuración.** Se añadieron pruebas para manifiesto ausente/inválido/revisiones desconocidas/referencias vacías, autorización y datos no filtrados, permisos de RPC/tabla, Admin/QA/Member/tenant ajeno, TTL SQL y costo con 20 chunks sin pares.
- [x] **Step 2: Ejecutar rojo.** Unitarias fallaron por ausencia del lector, falta del adapter RPC y mapeo SQL; test DB falló al no existir la RPC y al comprobar el INSERT autenticado que S2-05 retira. Sin fallos funcionales de Docker.
- [x] **Step 3: Implementar snapshot y RPC.** Las migraciones añaden manifiesto/versiones nullable para filas históricas, snapshot inmutable, creación service-role-only, revalidación del Profile y alcance, resumen/precio con locks y TTL SQL. El INSERT directo quedó revocado; authenticated conserva solo columnas de proyección. Se añadieron migraciones correctivas incrementales para validar objetos JSON en PostgreSQL y preservar comparaciones vacías a través de SQL.
- [x] **Step 4: Conectar la Action existente.** La Action conserva autorización/DTO, lee `ANALYSIS_EXECUTION_MANIFEST` privado y delega el snapshot completo al adapter service-only. Configuración inválida falla cerrada; errores SQL conocidos se convierten a respuestas controladas y la telemetría no recibe payload ni mensaje crudo.
- [x] **Step 5: Verificar verde.** `test:db` PASS (23 archivos, 677 pruebas); integración de estimación + snapshot PASS (6/6); unitarias enfocadas PASS (53/53); `check:database-types`, `typecheck` y `lint` PASS. Lint conserva cuatro advertencias preexistentes.
- [x] **Step 6: Checkpoint y commit de tarea.** Contrato S2-04 y política de grants actualizados; la acción S2-03 mantiene su firma y `analysis-estimate-action.test.ts` pasó. El diff se revisa y se crea commit local tras repetir el control de cierre.

### Task 3: Run/Retry y reserva en una transacción bajo concurrencia

**Files:** Grupo de tarea 3, tipos SQL regenerados y contrato S2-05.

**Interfaces:**
- Consume estimaciones inmutables/manifiesto de tarea 2 y `private.reserve_analysis_credits(uuid,integer)` de S2-02.
- Produce `public.run_analysis(p_actor_id uuid,p_estimate_ref uuid,p_idempotency_key text,p_current_manifest jsonb)` → `analysis_id uuid,status analysis_job_status`.
- Produce `public.retry_analysis(p_actor_id uuid,p_failed_analysis_id uuid,p_estimate_ref uuid,p_idempotency_key text,p_current_manifest jsonb)` → lo anterior y `retry_of_analysis_id uuid`.
- Ambas delegan en `private.create_analysis_run(p_actor_id uuid,p_estimate_ref uuid,p_idempotency_key text,p_retry_of_analysis_id uuid,p_current_manifest jsonb)`; NULL parent identifica Run. Estas funciones son transaccionales, no llamadas HTTP separadas.
- SQLSTATE: P0002→NOT_FOUND, P2001→INSUFFICIENT_CREDITS, P2002→CONFLICT (conservar S2-02); P2101→ESTIMATE_EXPIRED, P2102→ESTIMATE_STALE, 42501→FORBIDDEN, 22023→INVALID_INPUT. Inesperados/timeouts→INTERNAL_ERROR; no mapear cualquier 23505 a un replay exitoso.

- [x] **Step 1: Escribir pruebas rojas de comandos y carreras.** Las pruebas cubren replay exacto, key/payload distinto, actor/tenant, expiración, configuración ausente, manifest/snapshot/coste alterados, scopes de 20/21, saldo insuficiente, Retry con Released o Consumed y dos Retry concurrentes.

```ts
expect([first.analysisId, replay.analysisId]).toEqual([first.analysisId, first.analysisId]);
expect(reservationsFor(first.analysisId)).toBe(1);
expect([analysesAfter, scopesAfter, ledgerAfter]).toEqual(before); // reserva fallida
expect(replayAfterExpiry.analysisId).toBe(first.analysisId);
expect(replayWithoutCurrentManifest.analysisId).toBe(first.analysisId);
expect(retry.retryOfAnalysisId).toBe(failedReleasedId);
```

Añadir key distinta/otro payload, actor o tenant distinto, inputs 20/21,
versión histórica/puntero cambiado, coste/snapshot alterados, insuficiencia,
failed sin Released/con Consumed y dos Retry concurrentes. Otro Admin/QA
del tenant puede usar su propia estimación y cambiar scope en Retry.
Un mismo actor no reutiliza la key literal del failed para Retry.

- [x] **Step 2: Ejecutar rojo.** `test:db` falló por columnas y RPC ausentes; integración observó `PGRST202`/`42883` antes de la migración. No hubo falla de Docker ni de creación de fixtures.
- [x] **Step 3: Implementar persistencia y orden.** Se añadieron `estimate_id` con FK scoped a `(estimate_id,workspace_id,initiator_id)` y `command_fingerprint` nullable para historial. La huella SHA-256 de `{kind,estimateRef,failedAnalysisId}` se mantiene separada de `request_fingerprint`. Run reautoriza Profile, bloquea el workspace, resuelve replay y solo después valida estimación, manifiesto, TTL, scope, resumen y coste; copia el snapshot, crea roles source/comparison y reserva en la misma transacción. El replay admite `p_current_manifest = NULL`; los comandos nuevos no. Entradas de estimación, Run y Retry tienen lock timeout 3s y statement timeout 30s.
- [x] **Step 4: Implementar Retry dentro de la misma unidad SQL.** Requiere padre `failed` del workspace, una reserva y una liberación completa, ningún consumo y slot libre. Conserva el padre, usa la estimación del actor actual (incluido otro QA/Admin del tenant) y permite scope nuevo. Reproduce por identidad antes de revisar de nuevo al padre; key reutilizada o failed sin liberación/consumido devuelve `P2002`.
- [x] **Step 5: Ejecutar carreras observables.** Integración con bloqueos PostgreSQL verificó replay concurrente de Run, dos Retry concurrentes con una sola reserva, progreso de otro workspace mientras el primero espera, y cambios concurrentes de chunks/puntero seguidos por `P2102`. Las cuatro carreras pasaron sin skips; el fallo de saldo verifica rollback de análisis y ledger. El test de replay cambia la versión y el puntero de forma compatible con `check_active_version`.
- [x] **Step 6: Verificar/checkpoint.** Supabase local aplicó ambas migraciones sin reset; `migration list --local` confirma todas aplicadas. `test:db` PASS (24 archivos/712 tests); integración Run + Retry y carreras PASS (6/6); `check:database-types` y `typecheck` PASS. `lint` PASS con cuatro advertencias previas; `git diff --check` se ejecuta antes del commit. `docs/contracts/S2-05-run-and-worker-handoff.md` registra firmas, errores y replays, y confirma que el worker sigue en su repositorio separado.

### Task 4: Server Actions y disparo después del commit

**Files:** Grupo de tarea 4; no modificar la UI de S2-09.

**Interfaces:**
- Consume RPC de tarea 3 y `readAnalysisExecutionManifest` (puede devolver NULL para replay).
- Produce exports públicos `runAnalysis(input: RunAnalysisInput): Promise<ActionResult<RunAnalysisResult>>` y `retryAnalysis(input: RetryAnalysisInput): Promise<ActionResult<RetryAnalysisResult>>` en `run-actions.ts`, reexportados por `index.ts` servidor.
- `run-queries.ts`: `submitRunCommand(actorId: string,input: RunAnalysisInput,manifest: AnalysisExecutionManifest|null): Promise<RunAnalysisResult>` y `submitRetryCommand(actorId: string,input: RetryAnalysisInput,manifest: AnalysisExecutionManifest|null): Promise<RetryAnalysisResult>`.
- `worker-trigger.ts`: `scheduleAnalysisTrigger(analysisId: string): void`, que registra `after(async () => ...)`; ninguna RPC ocurre dentro del callback.

- [x] **Step 1: Escribir rojo.** Las unitarias nuevas cubren UUID/key inválidos, key vacía/129/espacios extremos, campos extra, Member/anon, replay sin manifiesto, reserva fallida, Retry y reintento del trigger. La primera corrida falló al faltar los módulos de la frontera, antes de implementarlos.
- [x] **Step 2: Ejecutar rojo.** `npx pnpm@12.5.1 test:unit tests/unit/analysis-run-action.test.ts tests/unit/analysis-worker-trigger.test.ts` confirmó los imports faltantes de `run-actions.ts` y `worker-trigger.ts`; luego 47/47 pruebas enfocadas de Actions, RPC, trigger y catálogo pasaron.
- [x] **Step 3: Implementar la frontera mínima.** Las Actions reautorizan actor, validan DTOs estrictos, pasan manifiesto nullable y mapean solo SQLSTATE conocidos. La query usa el cliente service-only. Después del RPC exitoso se registra `after()` para POST de `{analysisId}` a la Edge desde la URL Supabase configurada, con `ANALYSIS_INTERNAL_TOKEN` separado y timeout 2s. Los fallos HTTP/registro no cambian el resultado confirmado ni serializan payloads sensibles.
- [x] **Step 4: Verificar verde.** Pruebas enfocadas 47/47; suite completa 87 archivos/629 tests PASS; `typecheck`, `check:database-types`, `lint` y `build` PASS. `lint` conserva cuatro advertencias previas. La primera corrida completa tuvo un timeout transitorio del parser DOCX/PDF; pasó aislado 17/17 y la segunda corrida completa pasó 629/629. Los DTO públicos permanecen intactos; no se creó REST ni Postman workspace.
- [x] **Step 5: Checkpoint local.** El contrato de S2-05 y el ticket S2-09 documentan las firmas reales, errores controlados y reutilización de la misma key/payload tras respuesta perdida. Runbook y nota de S2-06 resuelven que `ANALYSIS_INTERNAL_TOKEN` es un secreto separado de ingesta y se configura en Next.js y Edge.

### Task 5: Handoff SQL, intentos y deadlines reales

**Files:** Migración/pruebas SQL de tarea 5, tipos regenerados y contrato de handoff.

**Interfaces:**
- `analyses`: nuevas columnas técnicas `continuation_pending boolean not null default false`, `attempt_started_at timestamptz`, `attempt_deadline_at timestamptz`, `analysis_deadline_at timestamptz`.
- Conserva `claim_analysis(p_analysis_id uuid default null)` y sus campos; cola de continuación se distingue internamente de retry.
- Produce `public.yield_analysis_batch(p_analysis_id uuid,p_operation_id uuid,p_expected_processed_pairs integer,p_checkpoint jsonb) returns boolean`.
- Produce `public.read_analysis_retrieval_summary(p_analysis_id uuid,p_operation_id uuid)` → resumen tarea 1 y `public.read_analysis_pair_batch(p_analysis_id uuid,p_operation_id uuid,p_after_low uuid,p_after_high uuid,p_limit integer)` → página tarea 1. Solo service_role; scope/config siempre desde analysis persistido.
- Amplía `renew_analysis_lease` con sobrecarga CAS de cursor y checkpoint, manteniendo la firma anterior como compatibilidad para S2-08; ninguna variante permite cambiar scope ni exceder deadlines.

- [x] **Step 1: Escribir rojo.** `024_s2_05_worker_handoff.test.sql` falló al inicio en sus 8 expectativas estructurales porque las columnas y RPC todavía no existían. La prueba de integración añade una carrera de handoff concurrente con cursor compartido.
- [x] **Step 2: Ejecutar rojo/verde.** `npx pnpm@12.5.1 test:db` primero confirmó el estado rojo; después de implementar pasó 25 archivos/755 assertions. `analysis-run.test.ts` + `analysis-run-concurrency.test.ts` pasaron 8/8, incluida la carrera PostgreSQL de dos sesiones sin skips.
- [x] **Step 3: Implementar máquina SQL.** Claim inicial/retry/crash incrementa intento y fija deadline; continuación queued vigente conserva contador y deadlines y rota operation_id. Yield exige lease, deadline, operación y avance CAS; persiste checkpoint y mantiene el slot activo. Fallo recuperable limpia `continuation_pending`, mantiene checkpoint/reserva y aplica el backoff existente.
- [x] **Step 4: Fijar locks y expiraciones.** Worker SQL conserva advisory lock `26061501` y row locks; Run mantiene serialización por workspace. Lease 180s ≤ intento 30m ≤ análisis 90m. Continuación vencida/total expirado es terminal; el intento 3 vencido no se reclama por cuarta vez. No se añadió settlement ni evento: ambos siguen bloqueados hasta S2-08.
- [x] **Step 5: Verificar verde/checkpoint.** Aplicada migración local con `migration up --local`, sin reset; `migration list --local` confirma todas aplicadas. Tipos regenerados y `check:database-types`, `typecheck`, `lint` (0 errores, 4 warnings preexistentes), build y `git diff --check` PASS. SQL PASS (25 archivos/755 assertions); integración de readers y carrera PASS (8/8). Inventario de upgrade reconoce las migraciones S2-05 junto al stage S2-06 que provee claim/leases, y los stages anteriores las excluyen. `docs/contracts/S2-05-run-and-worker-handoff.md` y runbook S2-06 registran RPC, deadlines y límite S2-08; no se modificó `KDM/kdm-demo-worker`. Commit local de tarea 5 tras el staging explícito.

### Task 6: Worker paginado, persistencia por lote y entrada asíncrona

**Files:** Grupo de tarea 6; conservar `createProvider` y finalización real cerrados.

**Interfaces:**
- Consume RPC de lectura/handoff/deadlines de tarea 5.
- `LoadedContext` conserva identidad/scope/resumen y pasa a `pairs` del lote actual más `cursor: AnalysisPairCursor|null`; no significa todos los pares del análisis. `CheckpointState` añade `cursor: AnalysisPairCursor|null`; processedPairs sigue siendo global, comparado con candidatePairCount para decidir EOF/hasMore. Actualizar todos los callers/tests juntos y tratar un checkpoint histórico sin cursor como reanudación desde cero dentro del mismo scope verificado.
- Nuevo `AnalysisBatchPersistence.persist(input: {analysisId:string;operationId:string;expectedProcessedPairs:number;checkpoint:CheckpointState;findings:InternalFinding[];hasMore:boolean}): Promise<{ok:true}|{ok:false;code:string}>` y `createBatchPersistence(client: AnalysisWorkerDb): AnalysisBatchPersistence` en `worker/batch-persistence.ts`.
- Factory productiva lanza hasta S2-08. Doble local persiste checkpoint/handoff sin findings de negocio y lo declara en su nombre/test; no sustituye al proveedor ni a finalización productiva.
- `handleAnalyzeRequest`: POST autenticado dirigido `{analysisId}` o sweep `{}`; acepta `continuationBudget` interno entero 0..10 para cadena inmediata acotada. Devuelve 202 `{ok:true,accepted:true}` al registrar `EdgeRuntime.waitUntil`, sin afirmar completed; invalid input 400, token 401, readiness 503 antes del claim.

- [x] **Step 1: Escribir rojo del flujo.** Pruebas de worker cubren 40+ pares, una página de máximo 10 y un resumen de 1.001 pares sin materializar más de diez textos; también verifican heartbeat, timeout, fencing, cursor y reanudación desde EOF persistido.
- [x] **Step 2: Escribir rojo de persistencia y HTTP.** Las pruebas confirman persistencia antes del handoff, cursor sin avance al perder CAS, readiness 503 sin claim si falta staging, y ACK 202 vía waitUntil antes del resultado. El doble local no persiste findings de negocio.
- [x] **Step 3: Ejecutar rojo.** Las pruebas unitarias de contexto/lote/proceso/readiness/seams y la integración del worker guiaron la implementación y detectaron el cleanup de temporizadores y el error de lectura del checkpoint, ambos corregidos antes del cierre.
- [x] **Step 4: Implementar lote real y puerto.** Lee el resumen SQL verificado y solo la página pendiente con cursor low/high; mantiene processedPairs global, heartbeat cercado a 30s, timeout/AbortSignal de lote y cleanup en finally. El puerto persiste el checkpoint antes de ceder; la factory productiva permanece cerrada hasta S2-08, cuyo staging/finalización debe cargar hallazgos previos.
- [x] **Step 5: Adaptar Edge y harness.** Edge registra todo el trabajo con waitUntil, responde 202 como ACK, limita self-fetch a diez continuaciones con timeout corto, y conserva el gate anti-hosted. La integración confirma status processing y checkpoint antes de matar exclusivamente el runtime Edge local; después observa recuperación desde la página pendiente.
- [x] **Step 6: Verificar verde/checkpoint.** `test:unit` PASS (88 archivos/636 pruebas), integración Edge PASS (5/5), guard Deno incluido en unitarias, `typecheck` PASS, lint PASS (cuatro warnings preexistentes) y build PASS. Supabase local conserva las migraciones hasta Task 5; Task 6 no añade migraciones ni publica findings. El proveedor, staging y finalización productivos siguen cerrados hasta S2-07/S2-08.

### Task 7: Cron local real y recuperación sin navegador

**Files:** Grupo de tarea 7 y runbook S2-06.

**Interfaces:**
- Produce `private.invoke_analysis_recovery() returns bigint` que resuelve Vault y usa pg_net para POST `{}` al analyze; devuelve request_id seguro, no token/URL.
- Produce `public.configure_analysis_recovery(p_enabled boolean) returns void`, EXECUTE solo service_role: valida secretos existentes de Vault `analysis_function_url` y `analysis_internal_token`, agenda/retira idempotentemente cron `kdm-analysis-recovery` cada minuto. No acepta secretos como parámetros públicos.
- Los secretos los instala el harness local con valores locales temporales por su sesión SQL; producción necesita configuración/despliegue autorizados. La migración por sí sola no habilita cron.

- [ ] **Step 1: Escribir rojo SQL e integración.** Faltan secretos→configuración falla sin job; disable repetido es seguro; enable repetido deja un cron. Token incorrecto/URL no autorizada no reclama. En local, crear queued y no invocar Edge desde el test: observar que cron reclama dentro de 75s. La prueba debe demostrar el run de cron/pg_net, no emitir el POST ella misma.
- [ ] **Step 2: Ejecutar rojo.** `npx pnpm@12.5.1 test:db` y `node scripts/with-local-supabase.mjs integration tests/integration/analysis-recovery.test.ts`. Timeout específico 90s para queued/siguiente cron y 300s para crash (lease 180s + ciclo 60s + margen), nunca timeout global inflado para el resto.
- [ ] **Step 3: Implementar instalación/configuración.** Comprobar extensiones pg_cron, pg_net y Vault disponibles en el stack actual; instalarlas por migración donde corresponda y sin nombres de secretos con valores. Configurar solo `[functions.analyze] verify_jwt=false` para que su token interno se valide en el handler; no alterar otras funciones. URL debe ser el analyze del mismo proyecto: en local resolver red Docker/Kong, no usar 127.0.0.1 desde PostgreSQL como si fuera el host.
- [ ] **Step 4: Verificar escenarios reales.** Readiness 503 conserva queued/intentos; luego habilitar únicamente dobles locales y observar recovery. Perder continuación inmediata y ver cron; matar un proceso tras confirmar processing y esperar lease real hasta recuperar (sin backdating en esta prueba). Validar que backoff aún vigente impide claim. Conservar ID/coste/reserva; cerrar cron y restaurar solo la configuración propia en finally. Esperas del orquestador en tramos <=60s con actualizaciones al usuario.
- [ ] **Step 5: Checkpoint.** Documentar comandos para comprobar cron.job/cron.job_run_details y request_id, así como cómo deshabilitarlo. No imprimir tablas/cuerpos que contengan tokens. Registrar por separado scheduler instalado, configurado y ejecutado; ninguno implica los otros.

### Task 8: Gate de capacidad, regresión y entrega verificable

**Files:** Grupo de tarea 8, fixtures sintéticos y acta de aceptación S2-05.

**Interfaces:**
- `node scripts/measure-analysis-capacity.mjs --target local --scenario <name>`; local es el default seguro, rechaza destinos no locales salvo modo hosted explícito y sin ejecutar despliegue.
- Escenarios `zero-pairs`, `multi-batch`, `over-1000`, `twenty-versions`, `max-chunks`, `multi-workspace`, con tamaños registrados. `max-chunks` incluye 20×500; si no cabe no sustituirlo por veinte chunks.
- Resultado seguro: `{scenario,sha,runtime,limits,sampleCount,chunkCount,candidatePairCount,wallMs,cpuMs,memoryBytes,source,gate,reasonCodes}`; `source: {environment:'local'|'hosted',provider:'fake'|'real',method:'measured'|'extrapolated'}`. Valores no observables son NULL y producen gate pendiente, no cero.
- Gates `passed|failed|pending`; exit 0/1/2 respectivamente. No imprimir documentos, prompts, respuestas, configuración secreta ni URLs.

- [ ] **Step 1: Escribir rojo de política.** Métricas de CPU/memoria ausentes no pasan; percentiles con muestras pequeñas quedan señalados; carga >30 pares/1.000 no se trunca para pasar; hosted sin proveedor/staging reales permanece pending. Rechazar producción accidental desde el comando local y rechazar que un JSON de fakes sea prueba de calidad IA.
- [ ] **Step 2: Implementar runner y fixtures aislados.** Reutilizar preflight local y sesiones SQL; no añadir un SDK/proveedor para medir. El fixture técnico de capacidad puede crear jobs sintéticos aislados para medir el worker sin financiar un alcance >50 créditos: declararlo como prueba técnica, nunca como Run/reserva exitosos. No inventar Promotional, Purchased o grants productivos. El recorrido contable real se prueba por separado dentro del saldo disponible.
- [ ] **Step 3: Ejecutar matriz y registrar costes temporales antes de una corrida larga.** Medir resumen/retrieval/tamaño transferido y lote con latencia controlada; observar deadline total, CPU/memoria y demanda del proveedor. Con 30% de margen: invocación <=70% del wall-clock efectivo; lote p99 observado <=60s; CPU/memoria <=70% de su límite. No declarar passed con solo extrapolación o cambiar los 20/500/90min para conseguirlo. Un fallo lleva a propuesta/ADR, no migración automática a Node.
- [ ] **Step 4: Preparar evidencia alojada como acción revisable.** Entregar candidato, manifiesto privado requerido, comandos/diff de configuración y resultados locales antes de solicitar autorización de despliegue/pruebas remotas. Sin autorización/capacidades externas, marcar gate pending y explicar qué falta en esta misma entrega. No habilitar fakes en hosted ni desarrollar S2-07/S2-08 para simular una capacidad ausente. Al integrar sus adaptadores/configuración, ejecutar el mismo gate contra el worker real y medir latencias/calidad por separado.
- [ ] **Step 5: Integrar regresión/CI.** Mantener inventario exacto de las migraciones S2-05/S2-06 nuevas y sus stages con tests; preservar stages que reconstruyen S1/S2-01 sin importar funciones S2 prematuramente. Mantener checks previos y añadir coverage de SQL/worker/recovery aún pendientes en `.github/workflows/s1-01.yml`. Harness destructivo solo en CI disposable; no forzar CI=true sobre la base del usuario.
- [ ] **Step 6: Ejecutar cierre local.** `npx pnpm@12.5.1 test:db`, `test:fixtures`, `check:database-types`, `test:unit`, `test:integration`, `typecheck`, `lint` y `node scripts/with-local-supabase.mjs build`; después `git diff --check` y comparar datos ajenos. Un fallo previo del parser real se diagnostica/reportará si reaparece; no tocar ingesta ni subir globalmente timeouts para ocultarlo. No repetir suites verdes salvo cambios/fallos nuevos.
- [ ] **Step 7: Acta y checkpoint final.** Completar `docs/testing/s2-05-acceptance.md` con evidencia de todos los DoD, matriz del gate y límites S2-07/S2-08/S2-09. Comparar `git status`, diff y trabajo previo. No afirmar cierre conjunto si falta gate; no convertir un ACK, build, factory o configuración en E2E. Tras validar, crear el commit de la tarea 8; dejar los cambios en la rama local sin push.

## Self-review del plan

- Cobertura: diseño §§3–4→tareas 1–2; §§5–6→3; §7→4; §8→5–6; §9→7; §10→8; §§2/11/12→restricciones y acta. Todos los criterios de S2-05 tienen prueba propia en 3/4 y regresión en 8.
- Tipos: mismo manifiesto/resumen/cursor entre SQL y TS; mismo command_fingerprint separado del retrieval; nullable current manifest solo para replay. DTO públicos y firma de finalización conservados.
- Riesgos: las cinco líneas de Review Focus tienen tests asignados. La carrera de chunks/punteros se prueba contra Run real, no solo un helper.
- Alcance: no finalizador/proveedor/UI productivos añadidos; su ausencia mantiene readiness cerrada y no se llama cumplido al gate pendiente. Los timestamps se verifican antes de uso.
- Ejecución: commits locales autorizados al completar cada tarea con sus verificaciones aprobadas; sin push, escritura remota, reset del usuario ni cambios al worktree de ingesta. Aprobados: rama actual, ejecución inline, plan y diseño.
