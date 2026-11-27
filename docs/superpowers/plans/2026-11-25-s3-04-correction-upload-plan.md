# S3-04 Correction Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementar la reserva, transferencia, verificación y confirmación idempotente de una versión corregida `vN` sobre un documento existente, sin cambiar la versión activa ni encolar preprocessing.

**Architecture:** RPCs nuevas de corrección sobre el pipeline S1 (`document_versions`, `document_upload_attempts`, `verification.ts`), autorización Member separada de `authorized_document_workspace`, policy Storage aditiva para el intento propio, y expiración perezosa con función SQL de barrido. La confirmación actualiza `correction_submissions`, cobertura de items y auditoría en una sola transacción.

**Tech Stack:** PostgreSQL/Supabase (RLS, GRANT, pgTAP), TypeScript estricto, Next.js server actions, Zod, Vitest, Storage local.

**Spec:** `docs/superpowers/specs/2026-11-25-s3-04-correction-upload-design.md`

## Global Constraints

- Prohibido `git commit`, `git add`, `git stash` y `git reset` durante este plan. Cada tarea termina en checkpoint, no en commit.
- No reescribir migraciones integradas de S1/S3-01/S3-02/S3-05; solo migraciones aditivas nuevas.
- No ampliar `private.authorized_document_workspace` ni las policies Storage S1.
- No duplicar `src/modules/ingestion/verification.ts`; importar `verifyAndPromote`.
- No aceptar `workspaceId`, `role`, `Actor`, paths, hashes ni revisiones de confianza desde el navegador; derivarlos del Profile verificado.
- No crear tablas nuevas ni columnas nuevas para S3-04; reutilizar el modelo S3-01.
- No encolar jobs, no consumir créditos, no cambiar `documents.active_version_id`, `findings`, severidad ni `version_status`.
- No exponer secretos, paths, hashes, leases, URLs firmadas ni contenido documental en logs/Sentry.
- pnpm 12.5.1; si no está disponible, `npx pnpm@12.5.1`.
- Gates obligatorios por tarea según la tabla; no declarar éxito sin salida verificada.
- Regenerar `src/types/database.ts` después de cada migración que cambie la API pública; no editarlo a mano.

## Review Focus

Estos son los cinco modos de fallo que más probablemente rompan S3-04 aunque los tests felices pasen. Cada uno tiene test en la tarea indicada:

1. **Member sube a un intento ajeno, confirmado o vencido** -> debe ser denegado por Storage, no solo por la UI (T4, T8).
2. **Reasignación entre reserva y finalización** -> no debe publicar con el permiso anterior; `CONFLICT` y reserva invalidada (T3, T6, T8).
3. **La versión activa cambió durante la transferencia** -> `CONFLICT`, sin rebase silencioso (T2, T3, T6, T8).
4. **Respuesta perdida o doble clic** -> misma key/payload devuelve la misma submission/versión; no crea `vN+1` ni duplica auditoría (T2, T3, T6, T8).
5. **Corrección numerada `v1`** -> dispararía el enqueue inicial S1; debe ser imposible y estar testeado (T1, T2, T6, T7).

---

## Pre-requisitos verificados

Antes de T1, verificar (no asumir):

- [ ] `git status --short` limpio o solo cambios autorizados del usuario.
- [ ] `pnpm install --frozen-lockfile` completa.
- [ ] `pnpm exec supabase start` levanta el stack local; Docker disponible.
- [ ] Migraciones S3-01/S3-02/S3-05 presentes: `20261108150000` a `20261108150500`, `20261114150000` a `20261114150600`, `20261116120000`, `20261117120000`, `20261117130000`, `20261121120000`, `20261121130000`.
- [ ] `public.correction_submissions`, `public.correction_submission_items`, `public.document_upload_attempts`, `public.document_versions.workflow_kind` existen.
- [ ] `private.upload_control` está en `paused` por defecto; las fixtures deben activarlo y restaurarlo.
- [ ] Baseline `pnpm test:db`, `pnpm test:unit`, `pnpm typecheck` y `pnpm lint` pasan antes de tocar código. Registrar salida en el checkpoint.
- [ ] `scripts/review-upgrade-policy.mjs`, `scripts/check-review-upgrade.mjs` y `scripts/review-integration-policy.mjs` son los vigentes; S3-04 debe integrarse sin romper sus allowlists.
- [ ] `src/types/database.ts` coincide con la base local (`pnpm check:database-types`).

**Comandos de referencia:** `pnpm test:db`, `pnpm test:unit`, `pnpm test:integration`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm check:database-types`, `node scripts/run-review-isolated-integration.mjs <archivos>`.

---

## Mapa de ficheros

**Migraciones nuevas**

- `supabase/migrations/20261126110000_s3_04_audit_enum.sql` (T1a)
- `supabase/migrations/20261126120000_s3_04_correction_upload.sql` (T1b)
- Migraciones posteriores de T2/T3/T4/T5: timestamps se fijan al implementar cada tarea.

**TypeScript**

- `src/modules/ingestion/correction-schemas.ts` — Zod y normalización de entrada.
- `src/modules/ingestion/correction-upload-store.ts` — RPCs, fingerprint, finalize/resume, mapeo de errores.
- `src/modules/ingestion/correction-actions.ts` — server actions con `requireActor`.
- `src/modules/ingestion/index.ts` — export público de acciones/tipos permitidos.
- `tests/unit/s3-04-reservation.test.ts`
- `tests/unit/s3-04-finalize.test.ts`
- `tests/unit/s3-04-idempotency.test.ts`

**pgTAP**

- `supabase/tests/database/s3_04_base_smoke.test.sql`
- `supabase/tests/database/s3_04_reservation.test.sql`
- `supabase/tests/database/s3_04_verification.test.sql`
- `supabase/tests/database/s3_04_expiry.test.sql`
- `supabase/tests/database/s3_04_guards.test.sql`
- `supabase/tests/database/s3_04_schema.test.sql`
- `supabase/tests/database/s3_04_security.test.sql`

**Integración real**

- `tests/integration/review-correction-upload.test.ts`
- `tests/integration/review-correction-upload-concurrency.test.ts`

**Scripts de política**

- `scripts/review-upgrade-policy.mjs`
- `scripts/review-upgrade-policy.d.mts`
- `scripts/check-review-upgrade.mjs`
- `scripts/review-integration-policy.mjs`
- `tests/unit/review-integration-policy.test.ts`

**Generado**

- `src/types/database.ts` (regenerar al final; no editar a mano).

---

## T1a — Audit enum

**Ficheros:**

- Crear: `supabase/migrations/20261126110000_s3_04_audit_enum.sql`

**Incluye:**

- Solo `alter type public.review_audit_action add value if not exists 'correction_submission_expired';`
- Sin tablas, columnas, funciones, policies ni tests pgTAP propios.
- El valor se prueba en T1b.

**Criterios de aceptación:**

- La migración aplica sobre una base con S3-01/S3-02/S3-05 sin errores.
- `review_audit_action` contiene `correction_submission_expired`.
- No cambia tipos públicos; `pnpm check:database-types` no requiere regenerar.

**Gates:**

- `pnpm test:db`

**Checkpoint esperado:**

- Migración aplicada.
- `pnpm test:db` verde.
- `git status --short` limitado al fichero de T1a.

---

## T1b — Migración base, helper `vN` y sweep

**Ficheros:**

- Crear: `supabase/migrations/20261126120000_s3_04_correction_upload.sql`
- Crear: `supabase/tests/database/s3_04_base_smoke.test.sql`
- Modificar: `scripts/analysis-upgrade-policy.mjs` y `scripts/review-upgrade-policy.mjs` para añadir T1a y T1b a `s3_04Names`.
- Modificar: tests unitarios que pinean los inventarios S3-04, si aplica.

**Incluye:**

- Helper `private.allocate_document_version_number(p_document_id uuid, p_workspace_id uuid) returns integer`:
  - asume lock del documento tomado;
  - `coalesce(max(version_number),0)+1`;
  - rechaza resultado `<= 1` con `23514`.
- `public.expire_stale_correction_reservations(p_limit integer default 100) returns table(submission_id uuid, outcome text)`:
  - selecciona `reserved` con `expires_at <= now()`, `for update skip locked`, límite 1..1000;
  - outcomes: `expired`, `invalidated`, `skipped_candidate_alive`, `skipped_not_confirmed`, `skipped_version_inconsistent`;
  - si procede: `state='expired'`; versión `upload_state='rejected'`; attempt `retired_at=now()`, `cleanup_status='pending'`;
  - `INSERT` directo en `public.audit_events` con `actor_id=submitter_id`, `action='correction_submission_expired'`, `entity_type='correction_submission'`, `entity_id=submission_id`, metadata `{round_id, reason:'ttl_expired'}`.
- Grants `service_role`; revoke `public`, `anon`, `authenticated`.
- No crear RPCs `reserve`/`claim`/`finish`/`resume` ni policies Storage Member; pertenecen a T2/T3/T4.

**Criterios de aceptación:**

- La migración aplica sobre S3-01/S3-02/S3-05 sin errores.
- `allocate_document_version_number` devuelve 2 con `v1`, 3 con `v2`, y no reutiliza números.
- El sweep devuelve los outcomes esperados y no toca submissions confirmadas.
- Se inserta una fila de auditoría por expiración con actor `submitter_id`.
- No se añaden tablas ni columnas nuevas.
- S1/S3-01/S3-02/S3-05 no tienen diffs.

**Tests de la tarea:**

- `s3_04_base_smoke.test.sql` (4-6 tests): numeración `vN`, rechazo de `v1`, expiración, auditoría, outcomes y grants.

**Gates:**

- `pnpm test:db`
- `pnpm check:database-types`
- `pnpm typecheck`
- `pnpm lint`

**Checkpoint esperado:**

- Migración aplicada y pgTAP en verde.
- Salida de `allocate_document_version_number` para `v1` -> 2.
- `git status --short` limitado a los ficheros de T1a/T1b.

---

## T2 — `reserve_correction_upload` + capa TypeScript de reserva

**Ficheros:**

- Crear: `supabase/migrations/20261125120100_s3_04_reserve_correction_upload.sql`
- Modificar (regenerado): `src/types/database.ts`
- Crear: `src/modules/ingestion/correction-schemas.ts`
- Crear: `src/modules/ingestion/correction-upload-store.ts`
- Crear: `src/modules/ingestion/correction-actions.ts`
- Modificar: `src/modules/ingestion/index.ts`
- Crear: `supabase/tests/database/s3_04_reservation.test.sql`
- Crear: `tests/unit/s3-04-reservation.test.ts`

**Incluye:**

- RPC `public.reserve_correction_upload` con la firma ampliada del spec 4.1:
  - `p_user_id`, `p_workspace_id`, `p_round_id`, `p_document_id`, `p_finding_ids[]`, `p_expected_revisions[]`, `p_base_version_id`, `p_expected_sha256`, `p_size_bytes`, `p_extension`, `p_idempotency_key`, `p_request_fingerprint`.
  - Devuelve `submission_id, version_id, attempt_id, storage_path, canonical_mime_type, upload_state, expires_at`.
- Validación de entrada y autorización:
  - Member del workspace; uploads activos;
  - ronda `assigned_findings`/`collecting`, documento/base;
  - findings asignados, `confirmed`/`update_planned`, con evidencia;
  - revisiones esperadas;
  - arrays no vacíos, sin duplicados, longitudes iguales;
  - extensión/tamaño/hash.
- Advisory lock por `workspace:user:key`.
- Replay por `correction_submissions(workspace_id, submitter_id, idempotency_key)`:
  - misma key/fingerprint -> misma submission/target;
  - fingerprint distinto -> `23505`;
  - `expired`/`invalidated` -> `23505`.
- Lock de documento, `vN > 1`, inserción de versión/intento/submission/items.
- `previous_submission_id` derivado server-side (ver pregunta pendiente 4 del spec); no aceptado del cliente.
- Grants solo `service_role`; comentarios de función/tabla.
- TypeScript:
  - `correction-schemas.ts`: Zod para `ReserveCorrectionInput`, normalización de `findingIds`/`expectedRevisions`, validación de archivo/key.
  - `correction-upload-store.ts`: `computeCorrectionFingerprint`, `reserveCorrectionUploadRecord`, mapeo de filas RPC y SQLSTATE.
  - `correction-actions.ts`: `reserveCorrection` con `requireActor`, deriva `workspaceId` del actor, no del input.
  - `index.ts`: exportar solo lo público permitido.

**Criterios de aceptación:**

- Member reserva sobre documento existente y obtiene `vN` (nunca `v1`).
- No cambia `documents.active_version_id`.
- No crea job durable.
- `expires_at = reserved_at + 24h`.
- Submission `reserved`, items con assignee/revisión.
- Replay no crea `vN+1`; payload distinto `CONFLICT`.
- Member ajeno, Admin/QA, tenant distinto, finding no asignado, base cambiada, ronda no `collecting` y uploads paused fallan con el código correcto.
- El action no acepta workspace/role/paths del navegador.

**Tests de la tarea:**

- pgTAP `s3_04_reservation.test.sql`: happy path, `vN`, base, ronda, finding status/evidencia, revisiones, arrays, archivo, replay/conflict, paused, no active change, no job.
- Unit `s3-04-reservation.test.ts`: schemas, fingerprint, store mapping, action authorization.

**Gates:**

- `pnpm test:db`
- `pnpm test:unit`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm check:database-types`

**Checkpoint esperado:**

- Reserva real devuelve target y `vN=2` sobre un fixture con `v1`.
- Replay con misma key devuelve la misma submission.
- `git status` limitado a T2.
- Reportar SQLSTATE observados y mapeo a `ActionResult`.

---

## T3 — `claim` + `finish` + `resume` + finalización TypeScript

**Ficheros:**

- Crear: `supabase/migrations/20261125120200_s3_04_correction_verification.sql`
- Modificar (regenerado): `src/types/database.ts`
- Modificar: `src/modules/ingestion/correction-upload-store.ts`
- Modificar: `src/modules/ingestion/correction-actions.ts`
- Modificar: `src/modules/ingestion/index.ts`
- Crear: `supabase/tests/database/s3_04_verification.test.sql`
- Crear: `tests/unit/s3-04-finalize.test.ts`

**Incluye:**

- RPC `claim_correction_verification`:
  - autoriza submitter, submission `reserved`, versión/attempt actuales, uploads activos;
  - revalida base y assignment;
  - lease 120 s y retorno con las mismas columnas que el claim S1 (`supabase/migrations/20261003044516_s1_02_upload_expand.sql:327-377`).
- RPC `finish_correction_verification`:
  - autoriza lease/operación/resultado;
  - actualiza versión con patrón S1 (`supabase/migrations/20261003044516_s1_02_upload_expand.sql:380-418`);
  - si `confirmed`: submission `confirmed`, `confirmed_at = upload_confirmed_at`, items `current_submission_id` + `coverage_revision+1`, ronda `coverage_revision+1` una vez, auditoría `correction_submission_confirmed`;
  - si `rejected`: versión `rejected`, submission sigue `reserved`;
  - si `pending`: versión `pending`;
  - no toca `version_status`, `processing_status`, `active_version_id`, findings ni créditos;
  - no encola.
- RPC `resume_correction_upload`:
  - `pending` -> target;
  - `confirmed` -> snapshot;
  - `rejected`/lease vencido -> recuperación S1 (`supabase/migrations/20261003051326_s1_02_upload_rpc_fix.sql:58-150`);
  - `expired`/`invalidated` -> `CONFLICT`.
- TypeScript:
  - `finalizeCorrectionUpload` importa `verifyAndPromote` (`src/modules/ingestion/verification.ts:109-140`), no duplica hashing;
  - usa `removeStorageObject` y `mark_upload_attempt_cleanup`;
  - `resumeCorrectionUpload`;
  - mapea snapshots a `CorrectionSubmissionSnapshot`/`UploadTarget`/`UploadSnapshot`.

**Criterios de aceptación:**

- `claim` deja `verifying` con lease.
- `finish(confirmed)` confirma en una transacción: versión, submission, items, ronda y auditoría.
- `confirmed_at` coincide exactamente con `upload_confirmed_at`.
- No hay job durable ni cambio de activa.
- `finish(rejected)` permite `resume`; `finish(pending)` permite reintento.
- Reasignación/base cambiada/candidata viva -> `CONFLICT`.
- Replay de `finish(confirmed)` no duplica auditoría/cobertura.
- Fallo de limpieza no invalida la confirmación.

**Tests de la tarea:**

- pgTAP `s3_04_verification.test.sql`: transiciones, lease, confirmación atómica, auditoría, coverage, rejected/pending, replay, stale assignment, base, candidata viva.
- Unit `s3-04-finalize.test.ts`: orquestación claim -> verifyAndPromote -> finish, replay, errores, limpieza tolerante.

**Gates:**

- `pnpm test:db`
- `pnpm test:unit`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm check:database-types`

**Checkpoint esperado:**

- Una reserva confirmada produce exactamente una submission `confirmed`, items cubiertos y un `audit_events`.
- El job durable no existe para esa versión.
- `git status` limitado a T3.

---

## T4 — Policy Storage Member

**Ficheros:**

- Crear: `supabase/migrations/20261125120300_s3_04_correction_storage_member.sql`
- Crear: `tests/integration/review-correction-upload.test.ts`
- Modificar: `scripts/review-integration-policy.mjs`
- Modificar: `tests/unit/review-integration-policy.test.ts`

**Incluye:**

- Helper `private.current_correction_upload_attempt_allowed(p_storage_path text)`:
  - `uploads_enabled()`, workspace/role Member desde sesión;
  - attempt actual, no retirado, `cleanup_status='pending'`;
  - versión `pending`, `workflow_kind='correction_submission'`;
  - submission `reserved`, submitter `auth.uid()`, no vencida;
  - igualdad exacta de path.
- Policy `document_correction_upload_insert` (solo `INSERT`).
- Policy `document_correction_upload_returning` (solo `SELECT` con `storage.allow_only_operation('object.upload')`).
- No tocar policies S1 ni `document_upload_attempt_read`.
- Añadir `tests/integration/review-correction-upload.test.ts` a `REVIEW_INTEGRATION_FILES` y actualizar la expectativa del test unitario.
- Integración inicial: Member A sube a su target; Member B/Admin/otro workspace/confirmado/retirado denegado; listado/firma denegados.

**Criterios de aceptación:**

- Member solo sube al intento de su submission `reserved` no vencida.
- No puede listar, firmar, actualizar ni borrar objetos.
- Un intento confirmado/retirado o de otro Member/workspace no es accesible.
- La suite aparece en la allowlist y el test de política espera el nuevo total.

**Tests de la tarea:**

- Integración `review-correction-upload.test.ts` (casos permitidos/denegados).
- Unit `review-integration-policy.test.ts` actualizado.

**Gates:**

- `node scripts/run-review-isolated-integration.mjs tests/integration/review-correction-upload.test.ts`
- `pnpm test:unit -- review-integration-policy`

**Checkpoint esperado:**

- Evidencia de subida Member permitida y denegaciones negativas.
- `git status` limitado a T4.
- Reportar si el runner aislado requiere ajustes de puertos/allowlist.

---

## T5 — Sweep de expiración

**Ficheros:**

- Crear: `supabase/migrations/20261125120400_s3_04_correction_expiry.sql`
- Modificar (regenerado): `src/types/database.ts`
- Crear: `supabase/tests/database/s3_04_expiry.test.sql`

**Incluye:**

- Función `public.expire_stale_correction_reservations(p_limit integer default 100) returns table(submission_id uuid, outcome text)`.
- `security definer`, `set search_path=''`, `row_security=off`, `for update skip locked`.
- Límite 1..1000.
- Outcomes: `expired`, `invalidated`, `skipped_candidate_alive`, `skipped_not_confirmed`, `skipped_version_inconsistent`.
- Expira submission, marca versión `rejected`, retira attempt (`cleanup_status='pending'`).
- No borra filas/objetos; no toca números; no programa cron.
- Grants solo `service_role`.

**Criterios de aceptación:**

- Expira solo reservas vencidas y elegibles.
- Es idempotente.
- Respeta `p_limit` y no bloquea filas en uso.
- No deja una versión confirmada sin submission confirmada.
- No crea `cron.job`.

**Tests de la tarea:**

- pgTAP `s3_04_expiry.test.sql`: expiración, skip active lease, skip confirmed, límite, idempotencia, attempt retirado, sin cron, grants.

**Gates:**

- `pnpm test:db`
- `pnpm check:database-types`

**Checkpoint esperado:**

- Salida de la función con `outcome` por fila.
- `select count(*) from cron.job where jobname like '%correction%'` = 0.
- `git status` limitado a T5.

---

## T6 — Tests de idempotencia, reasignación y base cambiada

**Ficheros:**

- Crear: `supabase/tests/database/s3_04_guards.test.sql`
- Crear: `tests/unit/s3-04-idempotency.test.ts`
- Modificar (si hace falta): `tests/integration/review-correction-upload.test.ts`

**Incluye:**

- pgTAP:
  - replay misma key/payload;
  - key distinta tras `expired` -> `CONFLICT`;
  - fingerprint distinto -> `CONFLICT`;
  - reasignación entre reserve y finish -> `CONFLICT` y submission invalidada por S3-02;
  - base activa cambiada -> `CONFLICT` en reserve/claim/finish;
  - candidata viva -> `CONFLICT` al reemplazar cobertura;
  - replay de finish no duplica auditoría/cobertura;
  - `vN` no se reutiliza tras rejected/expired.
- Unit:
  - fingerprint determinista y ordenado;
  - payload distinto con misma key;
  - mapeo de errores;
  - action no confía en workspace del input.

**Criterios de aceptación:**

- Todos los escenarios de la sección Review Focus tienen un test que falla si se elimina la mitigación.
- No hay rutas de doble confirmación.

**Tests de la tarea:**

- `s3_04_guards.test.sql`
- `s3-04-idempotency.test.ts`

**Gates:**

- `pnpm test:db`
- `pnpm test:unit`

**Checkpoint esperado:**

- Matriz de escenarios -> resultado.
- `git status` limitado a T6.

---

## T7 — Suite pgTAP completa

**Ficheros:**

- Crear: `supabase/tests/database/s3_04_schema.test.sql`
- Crear: `supabase/tests/database/s3_04_security.test.sql`
- Completar: `s3_04_base_smoke.test.sql`, `s3_04_reservation.test.sql`, `s3_04_verification.test.sql`, `s3_04_expiry.test.sql`, `s3_04_guards.test.sql`

**Incluye:**

- Schema: índice, ausencia de columnas nuevas, tipos, grants.
- Seguridad: Member propio/ajeno, Admin/QA, tenant, RPCs no ejecutables por `authenticated`, `expire` solo `service_role`.
- Reserva/verificación/expiración/guards completos.
- Casos de `uploads_enabled` paused/active con restauración del gate.
- Cobertura de `vN > 1` y ausencia de job durable.

**Criterios de aceptación:**

- Toda la suite S3-04 pasa junto con las suites S1/S2/S3 existentes.
- No hay tests skipped sin justificación.
- La matriz de la sección 11.1 del spec está cubierta.

**Tests de la tarea:**

- Todos los `s3_04_*.test.sql`.

**Gates:**

- `pnpm test:db`

**Checkpoint esperado:**

- Número de tests y plan de pgTAP.
- Lista de requisitos del spec -> test que lo cubre.
- `git status` limitado a T7.

---

## T8 — Integración real completa y concurrencia

**Ficheros:**

- Modificar: `tests/integration/review-correction-upload.test.ts`
- Crear: `tests/integration/review-correction-upload-concurrency.test.ts`
- Modificar: `scripts/review-integration-policy.mjs`
- Modificar: `tests/unit/review-integration-policy.test.ts`

**Incluye:**

- Formatos PDF/DOCX/Markdown válidos; contenido falso/hash/firma/MIME inválidos; 10 MiB y exceso.
- Auth/Storage reales: Member A/B, Admin, tenant distinto, path ajeno, intento confirmado/retirado, listado/firma denegados.
- Respuesta perdida/doble clic: misma submission, sin `vN+1`.
- Dos Members en paralelo; dos reservas concurrentes mismo documento -> `vN` distintos.
- Reasignación durante transferencia -> no publica.
- Base activa cambió -> `CONFLICT`.
- Expiración -> submission `expired`, versión `rejected`, attempt retirado.
- Compensación: temporal eliminado tras confirmar; canónico inmutable; finish reintentable.
- No job, no cambio de activa, no créditos.
- Añadir ambas suites a `REVIEW_INTEGRATION_FILES`; actualizar expectativa unitaria.

**Criterios de aceptación:**

- Todas las suites pasan en el runner aislado con proyecto descartable.
- Las fixtures limpian Storage y filas; no dejan `upload_control` activo.
- La allowlist contiene exactamente las suites revisadas.

**Tests de la tarea:**

- `review-correction-upload.test.ts`
- `review-correction-upload-concurrency.test.ts`
- `review-integration-policy.test.ts`

**Gates:**

- `node scripts/run-review-isolated-integration.mjs tests/integration/review-correction-upload.test.ts tests/integration/review-correction-upload-concurrency.test.ts`
- `pnpm test:unit -- review-integration-policy`

**Checkpoint esperado:**

- Evidencia de cada escenario de integración.
- Tiempos de ejecución y cualquier flake observado.
- `git status` limitado a T8.

---

## T9 — Gates finales, tipos y acta de verificación

**Ficheros:**

- Modificar: `src/types/database.ts` (regenerado, no editado a mano).
- Modificar si hace falta: `scripts/check-review-upgrade.mjs`.
- Completar la sección **Acta de verificación** de este plan.

**Incluye:**

- Regenerar tipos con `supabase gen types typescript --local --schema public` y guardar UTF-8.
- Revisar diff de tipos: solo RPCs/índice esperados; no cambios accidentales.
- Ejecutar todos los gates.
- Revisar `git diff --check`, secretos y logs.
- Completar acta con comandos, resultados, pendientes y límites.
- No hacer commit.

**Criterios de aceptación:**

- `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test:db`, `pnpm test:unit`, integración aislada y `pnpm check:database-types` pasan.
- `git diff --check` sin errores.
- No hay secretos, paths, hashes ni contenido en logs/artefactos.
- El acta distingue lo verificado de lo no verificado (por ejemplo, E2E UI diferido a S3-08/S3-12).
- Las preguntas pendientes del spec están resueltas o registradas como bloqueo.

**Tests de la tarea:**

- Repetición completa de todos los gates.

**Gates:**

- `pnpm typecheck`
- `pnpm lint`
- `pnpm build`
- `pnpm test:db`
- `pnpm test:unit`
- `node scripts/run-review-isolated-integration.mjs tests/integration/review-correction-upload.test.ts tests/integration/review-correction-upload-concurrency.test.ts`
- `pnpm check:database-types`
- `git diff --check`

**Checkpoint esperado:**

- Acta completa con salidas.
- `git status` final y lista de archivos.
- Confirmación de que no se ejecutó `git commit/add/stash/reset`.

---

## Tests por tarea (resumen)

| Tarea | pgTAP | Unit | Integración |
| -- | -- | -- | -- |
| T1a/T1b | `s3_04_audit_enum`, `s3_04_base_smoke` | política de upgrade si aplica | — |
| T2 | `s3_04_reservation` | `s3-04-reservation` | — |
| T3 | `s3_04_verification` | `s3-04-finalize` | — |
| T4 | — | `review-integration-policy` | `review-correction-upload` (básico) |
| T5 | `s3_04_expiry` | — | — |
| T6 | `s3_04_guards` | `s3-04-idempotency` | refuerzo si aplica |
| T7 | `s3_04_schema`, `s3_04_security` + suite completa | — | — |
| T8 | — | `review-integration-policy` | `review-correction-upload`, `review-correction-upload-concurrency` |
| T9 | repetición | repetición | repetición |

---

## Mapa de riesgos -> tarea que lo mitiga

| Riesgo | Mitigación | Tarea |
| -- | -- | -- |
| R1 `vN=1` encola job inicial | `vN > 1` en helper/RPC + test de no-job | T1, T2, T6, T7 |
| R2 tocar `version_status`/`processing_status` | finish solo `upload_*` + guards | T2, T3, T7 |
| R3 candidata viva bloquea cobertura | mapeo `CONFLICT` + test | T3, T6, T7 |
| R4 reasignación durante transferencia | revalidación en claim/finish + test | T3, T6, T8 |
| R5 base activa cambió | comparación en reserve/claim/finish + test | T2, T3, T6, T8 |
| R6 policy Storage amplia | helper exacto + tests negativos | T4, T8 |
| R7 regresión S1 | migraciones aditivas + gates S1 | T1, T4, T9 |
| R8 scripts de upgrade clasifican S3-04 como S2 | etapa `s3_04` + allowlists | T1, T9 |
| R9 duplicar verificación | importar `verifyAndPromote` | T3 |
| R10 sweep toca lease/confirmada | skip locked/active/confirmed + tests | T5, T7 |
| R11 `coverage_revision` de ronda no avanza | avance único al confirmar + test | T3, T6, T7 |
| R12 uploads paused por defecto | fixture activa/restaura + test | T7, T8 |
| R13 key text vs uuid | idempotencia en submission | T2, T6 |
| R14 fallo parcial Storage/DB | finish atómico + replay | T3, T6, T8 |
| R15 suite no corre por allowlist | actualizar política + test unitario | T8, T9 |

---

## Acta de verificación (completar en T9)

**Entorno:** local, fecha, commit base, rama.
**Migraciones aplicadas:** lista y orden.
**Comandos ejecutados y resultado:** copiar salida resumida, no pegar secretos.
**Cobertura de requisitos:** enlazar cada DoD del ticket S3-04 con test.
**No verificado:** E2E UI (S3-08/S3-12), cron (S3-10), procesamiento (S3-05), consolidado (S3-06).
**Incidencias:** flakiness, límites de Docker, tiempos.
**Regla de git:** confirmar que no se ejecutó `git commit/add/stash/reset`.

---

## Checklist final pre-PR

- [ ] Spec y plan enlazados en el PR.
- [ ] Migraciones nuevas en orden y sin reescribir integradas.
- [ ] `vN > 1` y ausencia de job durable comprobadas.
- [ ] `active_version_id` intacta.
- [ ] `version_status`/`processing_status` intactos.
- [ ] Submission/items/cobertura/auditoría atómicas.
- [ ] Replay idempotente sin duplicar versión/auditoría.
- [ ] Reasignación y base cambiada devuelven `CONFLICT`.
- [ ] Policy Storage Member solo `object.upload`, sin listar/firmar.
- [ ] Expiración no toca leases activos ni confirmadas; sin cron.
- [ ] Tests pgTAP/unit/integración en verde.
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm check:database-types`.
- [ ] `src/types/database.ts` regenerado y diff revisado.
- [ ] Sin secretos, paths, hashes ni contenido en logs.
- [ ] `git diff --check` limpio.
- [ ] Preguntas pendientes del spec resueltas o bloqueo documentado.
- [ ] No se ejecutó `git commit/add/stash/reset`.
