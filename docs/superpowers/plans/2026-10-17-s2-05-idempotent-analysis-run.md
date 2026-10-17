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
| `supabase/migrations/20261017190100_s2_05_estimate_commands.sql`; `supabase/tests/database/022_s2_05_estimate_commands.test.sql` | Snapshot/TTL de estimaciones, RPC y permisos | 2 |
| `tests/unit/analysis-execution-config.test.ts`, `analysis-estimate.test.ts`; `tests/integration/analysis-estimation.test.ts` | Configuración, autorización y estimación real | 2 |
| `supabase/migrations/20261017190200_s2_05_run_commands.sql`; `supabase/tests/database/023_s2_05_run_commands.test.sql` | Run/Retry en una transacción y replays | 3 |
| `tests/integration/analysis-run.test.ts`, `analysis-run-concurrency.test.ts`; `tests/support/analysis-fixtures.ts` | Casos SQL/HTTP y carreras con sesiones existentes | 3 |
| `src/modules/analysis/run-actions.ts`, `run-queries.ts`, `worker-trigger.ts`; `schemas.ts`, `index.ts` | Frontera Server Action, RPC y after | 4 |
| `tests/unit/analysis-run-action.test.ts`, `analysis-worker-trigger.test.ts`; `src/lib/observability/safe-event.ts` y pruebas de catálogo si procede | Errores controlados y telemetría permitida | 4 |
| `supabase/migrations/20261017190300_s2_05_worker_handoff.sql`; `supabase/tests/database/024_s2_05_worker_handoff.test.sql` | Continuación, intentos, fencing y deadlines | 5 |
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

- [ ] **Step 1: Escribir rojo de autorización/configuración.** Añadir SQL para negar EXECUTE a anon/authenticated e INSERT directo incluso a Admin. Probar manifiesto ausente, JSON inválido, modelos vacíos y versión desconocida; la estimación no existe. Probar Admin/QA y denegar Member/perfil ajeno. La consulta SQL fija `expires_at-created_at = interval '30 minutes'` y devuelve coste 2 para 20 chunks sin pares.
- [ ] **Step 2: Ejecutar rojo.** `npx pnpm@12.5.1 test:unit tests/unit/analysis-execution-config.test.ts tests/unit/analysis-estimate.test.ts`; `npx pnpm@12.5.1 test:db`. Esperar nueva operación ausente y INSERT aún permitido por el esquema anterior.
- [ ] **Step 3: Implementar snapshot y RPC.** La migración añade a `analysis_estimates` `execution_manifest jsonb` y `fingerprint_version text` para filas nuevas, sin fabricar configuración histórica. Un trigger impide cambiar/eliminar snapshots referenciados. Revalidar Profile, workspace, rol, IDs, unión 20, punteros y ready/active; calcular resumen con locks y fijar TTL SQL. Revocar INSERT directo, permitir únicamente la proyección pública necesaria y EXECUTE del RPC a service_role. No conceder EXECUTE de helpers privados al navegador.
- [ ] **Step 4: Conectar la Action existente.** Mantener la autorización y DTO públicos; sustituir descarga de pares/INSERT de sesión por el RPC autorizado. Leer configuración privada, mapear errores controlados y sanitizar telemetría. No insertar claves de proveedores en el manifiesto. Estimaciones antiguas sin v2 podrán leerse, pero Run nuevo debe exigir reestimar.
- [ ] **Step 5: Verificar verde.** Aplicar migración/regenerar tipos; SQL, unitarias anteriores y `node scripts/with-local-supabase.mjs integration tests/integration/analysis-estimation.test.ts tests/integration/analysis-retrieval-snapshot.test.ts`. Esperar DTO sin conteos/texto, TTL SQL, aislamiento y precio correcto; ejecutar `typecheck`.
- [ ] **Step 6: Checkpoint local.** Actualizar contrato S2-04 y nombres de env en documentación sin valores. La UI S2-03 sigue delegando en su misma firma; tests `analysis-estimate-action.test.ts` deben pasar.

### Task 3: Run/Retry y reserva en una transacción bajo concurrencia

**Files:** Grupo de tarea 3, tipos SQL regenerados y contrato S2-05.

**Interfaces:**
- Consume estimaciones inmutables/manifiesto de tarea 2 y `private.reserve_analysis_credits(uuid,integer)` de S2-02.
- Produce `public.run_analysis(p_actor_id uuid,p_estimate_ref uuid,p_idempotency_key text,p_current_manifest jsonb)` → `analysis_id uuid,status analysis_job_status`.
- Produce `public.retry_analysis(p_actor_id uuid,p_failed_analysis_id uuid,p_estimate_ref uuid,p_idempotency_key text,p_current_manifest jsonb)` → lo anterior y `retry_of_analysis_id uuid`.
- Ambas delegan en `private.create_analysis_run(p_actor_id uuid,p_estimate_ref uuid,p_idempotency_key text,p_retry_of_analysis_id uuid,p_current_manifest jsonb)`; NULL parent identifica Run. Estas funciones son transaccionales, no llamadas HTTP separadas.
- SQLSTATE: P0002→NOT_FOUND, P2001→INSUFFICIENT_CREDITS, P2002→CONFLICT (conservar S2-02); P2101→ESTIMATE_EXPIRED, P2102→ESTIMATE_STALE, 42501→FORBIDDEN, 22023→INVALID_INPUT. Inesperados/timeouts→INTERNAL_ERROR; no mapear cualquier 23505 a un replay exitoso.

- [ ] **Step 1: Escribir pruebas rojas de comandos y carreras.**

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

- [ ] **Step 2: Ejecutar rojo.** `npx pnpm@12.5.1 test:db` y `node scripts/with-local-supabase.mjs integration tests/integration/analysis-run.test.ts tests/integration/analysis-run-concurrency.test.ts`. Esperar funciones ausentes; nuevos tests usan fixtures aislados y limpian solo sus registros incluso al fallar.
- [ ] **Step 3: Implementar persistencia y orden.** Añadir `analyses.estimate_id uuid` con FK scoped a `(estimate_id,workspace_id,initiator_id)` de estimaciones y `command_fingerprint text` para comandos nuevos; no rellenar el historial con identidades inventadas. Hash de `{kind,estimateRef,failedAnalysisId}` separado de `request_fingerprint`. Reautorizar, lock workspace, lookup de key y replay; solo después validar manifiesto/TTL/scope/resumen/slot/crédito para un comando nuevo. Configuración actual NULL invalida únicamente comandos nuevos. Copiar snapshot técnico al analysis, insertar ambas relaciones para scope solapado y reservar dentro del mismo RPC. Fijar lock_timeout 3s y statement_timeout 30s en las entradas de estimación/Run; medirlos en el gate, sin aumentarlos automáticamente si no cabe el alcance.
- [ ] **Step 4: Implementar Retry dentro de la misma unidad SQL.** Exigir failed del tenant, Reserved y Released por el coste completo, ningún Consumed y slot disponible. Conservar padre; crear nueva ejecución con actor actual. El replay se resuelve antes de revalidar el estado/liberación del padre.
- [ ] **Step 5: Ejecutar carreras observables.** Reutilizar `openLocalSqlSession`/`waitForSqlLock`, dos transacciones y observador. Verificar misma key→mismo ID; keys/actores distintos del tenant→un activo; otro workspace progresa mientras el primero está bloqueado. Ejecutar la carrera de chunks/punteros de tarea 1 contra Run real: espera y revalida o falla, nunca commit con revisión distinta. Forzar fallo después del INSERT del análisis para demostrar rollback de todo el RPC.
- [ ] **Step 6: Verificar/checkpoint.** Aplicar migración/regenerar tipos, repetir SQL y los dos archivos de integración; esperar cero skips de estas carreras, una reserva y balances exactos. Actualizar `docs/contracts/S2-05-run-and-worker-handoff.md` con firmas/errores/replays y `check:database-types`.

### Task 4: Server Actions y disparo después del commit

**Files:** Grupo de tarea 4; no modificar la UI de S2-09.

**Interfaces:**
- Consume RPC de tarea 3 y `readAnalysisExecutionManifest` (puede devolver NULL para replay).
- Produce exports públicos `runAnalysis(input: RunAnalysisInput): Promise<ActionResult<RunAnalysisResult>>` y `retryAnalysis(input: RetryAnalysisInput): Promise<ActionResult<RetryAnalysisResult>>` en `run-actions.ts`, reexportados por `index.ts` servidor.
- `run-queries.ts`: `submitRunCommand(actorId: string,input: RunAnalysisInput,manifest: AnalysisExecutionManifest|null): Promise<RunAnalysisResult>` y `submitRetryCommand(actorId: string,input: RetryAnalysisInput,manifest: AnalysisExecutionManifest|null): Promise<RetryAnalysisResult>`.
- `worker-trigger.ts`: `scheduleAnalysisTrigger(analysisId: string): void`, que registra `after(async () => ...)`; ninguna RPC ocurre dentro del callback.

- [ ] **Step 1: Escribir rojo.** Inputs UUID/key vacíos, key 129, espacios extremos y campos extra; Member/sin sesión nunca llegan al RPC. RPC exitoso agenda after una vez; errores de reserva no lo agendan. Replay sin manifiesto sigue llegando al RPC. Trigger timeout/401/503/red caída no cambia el resultado ya confirmado ni registra token/payload sensible. Afirmar cuerpo HTTP exacto `{analysisId}` y timeout 2000ms.
- [ ] **Step 2: Ejecutar rojo.** `npx pnpm@12.5.1 test:unit tests/unit/analysis-run-action.test.ts tests/unit/analysis-worker-trigger.test.ts`.
- [ ] **Step 3: Implementar la frontera mínima.** Reutilizar identidad, cliente de servicio, mapeo seguro de errores y catálogo de eventos; ampliar el catálogo cerrado solo con las operaciones necesarias `run/retry/trigger`. URL fija derivada del Supabase configurado y token privado de análisis, nunca URL del input. En Action, llamar RPC, comprobar éxito de commit y después registrar after. Falla de registro del trigger no vuelve fallido un commit confirmado: capturar y devolver su ID.
- [ ] **Step 4: Verificar verde.** Unitarias anteriores, schema, catálogo/telemetría, `typecheck` y `lint`; pruebas de contratos comprueban que no aparecieron campos públicos nuevos. No abrir Postman workspace ni crear REST adicional para Server Actions.
- [ ] **Step 5: Checkpoint local.** Actualizar contrato de S2-09: firmas reales Run/Retry, errores y obligación de conservar key al reintentar una petición con respuesta perdida.

### Task 5: Handoff SQL, intentos y deadlines reales

**Files:** Migración/pruebas SQL de tarea 5, tipos regenerados y contrato de handoff.

**Interfaces:**
- `analyses`: nuevas columnas técnicas `continuation_pending boolean not null default false`, `attempt_started_at timestamptz`, `attempt_deadline_at timestamptz`, `analysis_deadline_at timestamptz`.
- Conserva `claim_analysis(p_analysis_id uuid default null)` y sus campos; cola de continuación se distingue internamente de retry.
- Produce `public.yield_analysis_batch(p_analysis_id uuid,p_operation_id uuid,p_expected_processed_pairs integer,p_checkpoint jsonb) returns boolean`.
- Produce `public.read_analysis_retrieval_summary(p_analysis_id uuid,p_operation_id uuid)` → resumen tarea 1 y `public.read_analysis_pair_batch(p_analysis_id uuid,p_operation_id uuid,p_after_low uuid,p_after_high uuid,p_limit integer)` → página tarea 1. Solo service_role; scope/config siempre desde analysis persistido.
- Amplía `renew_analysis_lease` con sobrecarga CAS de cursor y checkpoint, manteniendo la firma anterior como compatibilidad para S2-08; ninguna variante permite cambiar scope ni exceder deadlines.

- [ ] **Step 1: Escribir rojo.** Cuatro lotes exitosos siguen en intento 1; cada cesión rota/invalida operación al siguiente claim; dos sesiones con mismo cursor solo ceden una vez. Expiración/fencing rechazan lecturas/escrituras obsoletas. Verificar que renovar o continuar no mueve deadlines de intento/análisis.
- [ ] **Step 2: Ejecutar rojo.** `npx pnpm@12.5.1 test:db`; añadir carrera a `analysis-run-concurrency.test.ts` o a la integración de worker según fixture reutilizable, sin dblink obligatorio ni skip.
- [ ] **Step 3: Implementar máquina SQL.** Claim inicial/retry incrementa intento y fija deadline de intento; continuación queued vigente conserva intento/deadline y genera nueva operación. Cesión valida lease, expected cursor y avance; actualiza checkpoint, queued, continuation_pending=true, next_attempt_at=NULL y libera la operación anterior atómicamente. El índice activo no se libera. Fallo recuperable borra continuation_pending, conserva checkpoint/reserva y fija backoff; crash processing con lease vencido inicia retry. No continuar un intento vencido por la marca continuation_pending.
- [ ] **Step 4: Fijar locks y expiraciones.** Operaciones de worker conservan el lock técnico corto existente y row locks; Run usa workspace sin tomar lock global del worker. No introducir en este ticket llamadas a settlement desde claim que inviertan workspace/analysis; documentar para S2-08 el orden al añadir settlement. Todas las terminales productivas siguen detrás de readiness hasta integración atómica real. Expiración total/max intentos es terminal y no se convierte en otro retry por continuar.
- [ ] **Step 5: Verificar verde/checkpoint.** Aplicar migración/regenerar tipos, SQL y concurrencia real; EXPECT attempt_count=1 después de 40+ pares simulados, tres intentos solo ante errores/crash y rechazo del cuarto. Nuevas columnas sin grants técnicos a authenticated. Documentar el handoff y alcance del puerto de staging S2-08.

### Task 6: Worker paginado, persistencia por lote y entrada asíncrona

**Files:** Grupo de tarea 6; conservar `createProvider` y finalización real cerrados.

**Interfaces:**
- Consume RPC de lectura/handoff/deadlines de tarea 5.
- `LoadedContext` conserva identidad/scope/resumen y pasa a `pairs` del lote actual más `cursor: AnalysisPairCursor|null`; no significa todos los pares del análisis. `CheckpointState` añade `cursor: AnalysisPairCursor|null`; processedPairs sigue siendo global, comparado con candidatePairCount para decidir EOF/hasMore. Actualizar todos los callers/tests juntos y tratar un checkpoint histórico sin cursor como reanudación desde cero dentro del mismo scope verificado.
- Nuevo `AnalysisBatchPersistence.persist(input: {analysisId:string;operationId:string;expectedProcessedPairs:number;checkpoint:CheckpointState;findings:InternalFinding[];hasMore:boolean}): Promise<{ok:true}|{ok:false;code:string}>` y `createBatchPersistence(client: AnalysisWorkerDb): AnalysisBatchPersistence` en `worker/batch-persistence.ts`.
- Factory productiva lanza hasta S2-08. Doble local persiste checkpoint/handoff sin findings de negocio y lo declara en su nombre/test; no sustituye al proveedor ni a finalización productiva.
- `handleAnalyzeRequest`: POST autenticado dirigido `{analysisId}` o sweep `{}`; acepta `continuationBudget` interno entero 0..10 para cadena inmediata acotada. Devuelve 202 `{ok:true,accepted:true}` al registrar `EdgeRuntime.waitUntil`, sin afirmar completed; invalid input 400, token 401, readiness 503 antes del claim.

- [ ] **Step 1: Escribir rojo del flujo.** Preparar 40+ pares y comprobar final técnico con intento 1 sin backdating. Página <=10, resumen/fingerprint completo y 1.000+ sin materializar todos los textos. Heartbeat durante proveedor lento, timeout de lote, rotación de op, fencing, cursor no decreciente y reanudación desde EOF persistido sin reiniciar desde cero.
- [ ] **Step 2: Escribir rojo de persistencia y HTTP.** Llamar persist antes de ceder cursor; si falla, no adelantarlo. Handoff duplicado no procesa otro lote. Factory de staging ausente devuelve 503 sin claim también cuando provider/finalization existen. Test local de entrada registra waitUntil y responde 202 antes de terminar el lote; no usar 202 como prueba del resultado.
- [ ] **Step 3: Ejecutar rojo.** `npx pnpm@12.5.1 test:unit tests/unit/analysis-worker-context.test.ts tests/unit/analysis-worker-batch.test.ts tests/unit/analysis-worker-process.test.ts tests/unit/analysis-worker-readiness.test.ts tests/unit/analysis-worker-seams.test.ts`; `node scripts/with-local-supabase.mjs integration tests/integration/analysis-worker.test.ts`.
- [ ] **Step 4: Implementar lote real y puerto.** Leer resumen desde SQL y compararlo con snapshot antes de llamar al proveedor; recuperar solo página pendiente con cursor low/high. Llevar processedPairs global y cursor en checkpoint. Heartbeat con RPC protegida a 30s, AbortSignal/timeout aplicados realmente, cleanup de timers en finally. Persist devuelve control solo tras progreso durable; con EOF persistido reintentar finalización idempotente de S2-08, sin reprocesar todos los pares. La finalización real carga sus staged findings previos; no depender únicamente de los findings en memoria del último lote.
- [ ] **Step 5: Adaptar Edge y harness.** Usar waitUntil para todo el trabajo posterior al ACK. Self-fetch con presupuesto decreciente máximo 10 y timeout corto; agotarlo deja continuación queued para cron, sin quemar intento. Tests locales conservan gate anti-hosted para dobles. `analysis-edge.ts` espera readiness, luego el test espera SQL status=processing y cursor esperado antes de matar Docker; observar el PID/contenedor correcto y comprobar reanudación, no un HTTP 502 concreto.
- [ ] **Step 6: Verificar verde/checkpoint.** Ejecutar unitarias e integración anteriores, guard Deno, `typecheck` y build local. Antes de tests con sweep/crash confirmar que no hay jobs ajenos activos; no matar un worker que atienda al usuario. Readiness incompleta permanece 503; anotar que esta fase verifica mecanismos con dobles y no publica hallazgos reales.

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
- [ ] **Step 5: Integrar regresión/CI.** Registrar cinco migraciones nuevas en `analysis-upgrade-policy.mjs` con tests; preservar stages que reconstruyen S1/S2-01 sin importar funciones S2 prematuramente. Mantener checks previos y añadir coverage de nuevos SQL/worker/recovery en `.github/workflows/s1-01.yml`. Harness destructivo solo en CI disposable; no forzar CI=true sobre la base del usuario.
- [ ] **Step 6: Ejecutar cierre local.** `npx pnpm@12.5.1 test:db`, `test:fixtures`, `check:database-types`, `test:unit`, `test:integration`, `typecheck`, `lint` y `node scripts/with-local-supabase.mjs build`; después `git diff --check` y comparar datos ajenos. Un fallo previo del parser real se diagnostica/reportará si reaparece; no tocar ingesta ni subir globalmente timeouts para ocultarlo. No repetir suites verdes salvo cambios/fallos nuevos.
- [ ] **Step 7: Acta y checkpoint final.** Completar `docs/testing/s2-05-acceptance.md` con evidencia de todos los DoD, matriz del gate y límites S2-07/S2-08/S2-09. Comparar `git status`, diff y trabajo previo. No afirmar cierre conjunto si falta gate; no convertir un ACK, build, factory o configuración en E2E. Tras validar, crear el commit de la tarea 8; dejar los cambios en la rama local sin push.

## Self-review del plan

- Cobertura: diseño §§3–4→tareas 1–2; §§5–6→3; §7→4; §8→5–6; §9→7; §10→8; §§2/11/12→restricciones y acta. Todos los criterios de S2-05 tienen prueba propia en 3/4 y regresión en 8.
- Tipos: mismo manifiesto/resumen/cursor entre SQL y TS; mismo command_fingerprint separado del retrieval; nullable current manifest solo para replay. DTO públicos y firma de finalización conservados.
- Riesgos: las cinco líneas de Review Focus tienen tests asignados. La carrera de chunks/punteros se prueba contra Run real, no solo un helper.
- Alcance: no finalizador/proveedor/UI productivos añadidos; su ausencia mantiene readiness cerrada y no se llama cumplido al gate pendiente. Los timestamps se verifican antes de uso.
- Ejecución: commits locales autorizados al completar cada tarea con sus verificaciones aprobadas; sin push, escritura remota, reset del usuario ni cambios al worktree de ingesta. Aprobados: rama actual, ejecución inline, plan y diseño.
