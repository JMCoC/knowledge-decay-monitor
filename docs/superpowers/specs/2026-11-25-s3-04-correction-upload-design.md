# S3-04 — Carga segura e idempotente de versiones corregidas sobre documentos asignados

**Fecha:** 2026-11-25
**Ticket:** S3-04 / SAA-28
**Estado:** Diseño aprobado para implementación
**Depende de:** S3-01, S3-02 y S3-05 mergeados
**Consumidores:** S3-05 (procesamiento durable), S3-06 (selección/consolidación), S3-07 (lecturas Member), S3-08 (UI)

---

## 1. Objetivo y alcance

Permitir que un Member reserve, transfiera y finalice un archivo completo de corrección sobre un documento lógico existente, creando una versión `vN` inmutable sin cambiar `documents.active_version_id`, sin sustituir la versión activa y sin encolar preprocessing individual. La entrega queda vinculada a una ronda abierta y a uno o varios findings asignados al Member, con cobertura persistida por finding.

**Dentro de S3-04:**

- Reserva idempotente de una entrega Member sobre documento/ronda existentes.
- Asignación atómica y monotónica de `document_versions.version_number`.
- Reutilización real de transferencia temporal, verificación de bytes, hash, publicación canónica y limpieza S1.
- Confirmación transaccional de `correction_submissions`, cobertura de items y auditoría mínima.
- Reanudación/recuperación de una reserva.
- Expiración perezosa y función SQL de barrido de reservas vencidas.
- Policy Storage acotada para que el Member suba solo su intento vigente.
- Contratos TypeScript, schemas Zod, server actions y pruebas.

**Fuera de S3-04:** ver sección 10.

---

## 2. Decisiones de diseño aprobadas

### D1 — Reutilizar `document_upload_attempts`

**Decisión:** no crear tabla de intentos propia.

**Justificación:** el diseño S3-01 ya fija reutilizar `document_versions` y `document_upload_attempts` para archivos inmutables y verificación S1 (`docs/superpowers/specs/2026-11-08-s3-01-human-review-foundation-design.md:80-84`). La tabla existente ya contiene identidad, path, retiro y estado de limpieza (`supabase/migrations/20261003044516_s1_02_upload_expand.sql:70-84`), y la limpieza S1 opera por `version_id` (`scripts/upload-maintenance.mjs:293-331`).

**Consecuencias:**

- Se reutilizan `private.insert_upload_attempt` (`supabase/migrations/20261003044516_s1_02_upload_expand.sql:167-186`) y `private.upload_snapshot` (`:188-201`).
- Se reutiliza `scripts/upload-maintenance.mjs` para borrar objetos temporales retirados.
- No se duplican hashing, leases ni policies de intento.

### D2 — Reutilizar S1 con capa de corrección

**Decisión:** crear RPCs de corrección con autorización Member propia, sin ampliar `private.authorized_document_workspace` y sin duplicar `verification.ts`.

**Justificación:** todos los RPCs S1 exigen Admin/QA mediante `private.authorized_document_workspace` (`supabase/migrations/20261003044516_s1_02_upload_expand.sql:148-164`), y la policy Storage S1 exige Admin/QA (`supabase/migrations/20261003045927_s1_02_upload_cutover.sql:34-57`). Ampliar ese helper abriría S1 a Member y rompería la regresión Admin/QA.

**Consecuencias:**

- Nuevos RPCs `reserve_correction_upload`, `claim_correction_verification`, `finish_correction_verification`, `resume_correction_upload`.
- `src/modules/ingestion/verification.ts` se importa tal cual; no se copia `verifyAndPromote`.
- Se reutiliza `mark_upload_attempt_cleanup` (`supabase/migrations/20261003124137_s1_02_upload_cleanup_marker.sql:1`) para marcar limpieza.
- La transferencia sigue siendo directa del navegador a Storage, sin pasar bytes por una route/server action.

### D3 — Expiración perezosa + función de barrido; cron diferido a S3-10

**Decisión:** S3-04 entrega `expire_stale_correction_reservations()` lista y testeada; no crea `cron.schedule`.

**Justificación:** la reserva de negocio dura 24 h y debe invalidarse antes de bloquear cobertura (`docs/Tickets/sprint-3-human-review-correction.md:314-365`). El patrón de cron configurable existe (`supabase/migrations/20261017230309_s2_05_analysis_recovery.sql:113-125`), pero el scheduler de limpieza corresponde a S3-10.

**Consecuencias:**

- La reserva se expira perezosamente en `reserve_correction_upload`/`resume_correction_upload` y mediante la función de barrido.
- La función no borra objetos de Storage; retira el intento y deja `cleanup_status='pending'` para el mantenimiento S1/S3-10.
- Los números de versión de reservas vencidas no se reutilizan.

---

## 3. Modelo de datos

### 3.1 Tablas reutilizadas

| Tabla | Uso en S3-04 | Evidencia |
| -- | -- | -- |
| `documents` | Documento lógico existente; lock para asignar `vN`; `active_version_id` nunca cambia. | `supabase/migrations/00001_initial_schema.sql:42-55,89-91` |
| `document_versions` | Nueva versión inmutable `vN` con `workflow_kind='correction_submission'`. | `supabase/migrations/20261108150100_s3_01_review_model.sql:9-13`; columnas S1 en `20261003044516_s1_02_upload_expand.sql:12-24` |
| `document_upload_attempts` | Intento temporal del Member; se retira al confirmar o al expirar. | `supabase/migrations/20261003044516_s1_02_upload_expand.sql:70-84` |
| `correction_submissions` | Reserva/confirmación de la entrega; `version_id` único. | `supabase/migrations/20261108150100_s3_01_review_model.sql:69-104` |
| `correction_submission_items` | Cobertura por item con assignee y revisión al enviar; inmutable. | `supabase/migrations/20261108150100_s3_01_review_model.sql:105-124` |
| `correction_round_items` | Assignee vigente, revisión y `current_submission_id` que se actualiza al confirmar. | `supabase/migrations/20261108150100_s3_01_review_model.sql:42-68` |
| `correction_rounds` | Estado `collecting`, base fija y `coverage_revision` de ronda. | `supabase/migrations/20261108150100_s3_01_review_model.sql:15-40` |
| `audit_events` | Evento `correction_submission_confirmed`. | `supabase/migrations/20261108150400_s3_01_review_audit_outbox.sql:4-16` |
| `findings` / `finding_evidence` | Autorización por finding asignado y evidencia sobre el documento. | `supabase/migrations/20261108150100_s3_01_review_model.sql:4-7`; `supabase/migrations/20261114150200_s3_02_review_coverage_guards.sql:143-158` |

### 3.2 Columnas e índices nuevos

**Columnas nuevas: ninguna.** El modelo S3-01 ya contiene todo lo necesario: estado de submission, expiración, procedencia, cobertura e idempotencia (`supabase/migrations/20261108150100_s3_01_review_model.sql:69-124`).

**Índice nuevo justificado:**

```sql
create index correction_submissions_reserved_expiry_idx
  on public.correction_submissions(expires_at)
  where state = 'reserved';
```

Motivo: el barrido consulta exactamente `state='reserved' and expires_at <= now()`; los índices existentes son `(round_id, created_at, id)` y `(submitter_id, workspace_id, created_at)` (`supabase/migrations/20261108150100_s3_01_review_model.sql:99-103`) y no cubren la expiración. El índice parcial evita escanear submissions históricas confirmadas.

No se crea índice único por item: el ticket permite varias entregas concurrentes por ronda/documento y solo una cobertura vigente por finding; la exclusión se resuelve con lock/CAS, no con unicidad de reservas.

### 3.3 Máquina de estados

#### Submission

```text
                 finish_correction_verification(confirmed)
reserved -------------------------------------------------> confirmed
   |                                                            |
   | expire_stale_correction_reservations / S3-02 reassignment   | S3-06 invalidation
   v                                                            v
expired                                                     invalidated
   ^
   | S3-02 reassignment/resolved (invalidated, no expired)
invalidated
```

Transiciones permitidas por el guard existente: `reserved -> confirmed|expired|invalidated` y `confirmed -> invalidated` (`supabase/migrations/20261108150200_s3_01_review_integrity.sql:263-297`). S3-04 solo ejecuta `reserved -> confirmed` y `reserved -> expired`; S3-02 ejecuta `reserved -> invalidated` por reasignación/resolved (`supabase/migrations/20261114150400_s3_02_finding_commands.sql:249-258,385-392`).

`correction_submission_state` no incluye `verifying`: sus valores son `reserved`, `confirmed`, `expired` e `invalidated`. El lease técnico de 120 s vive en `document_versions.upload_state='verifying'` (S1); `document_upload_attempts` no tiene columna `state`.

#### Versión de entrega

```text
reserve            claim                  finish(confirmed)
pending ---------> verifying -------------------------------------> confirmed
   ^                  |                                                |
   |                  | finish(rejected) / lease expirada              | (terminal para la entrega)
   |                  v                                                |
   +--------------- rejected <----------------------------------------+
   |                  |
   | resume/recovery  | resume/recovery(object absent)
   +------------------+--> recovering --> pending (nuevo attempt)
```

Invariantes durante toda la vida de la entrega:

- `processing_status='uploaded'`.
- `version_status IS NULL`.
- `workflow_kind='correction_submission'`.
- `active_version_id` no cambia.
- No se crea job durable.

Evidencia de los guards: `private.guard_review_workflow_version` exige `processing_status='uploaded'` y `version_status NULL` para una versión de corrección no procesada (`supabase/migrations/20261108150200_s3_01_review_integrity.sql:574-600`), y `private.assert_review_version_trigger` rechaza procesar/activar una versión sin candidata (`:1036-1055`).

#### Attempt

```text
created (retired_at NULL, cleanup_status='pending')
   |
   | confirm / recovery con objeto ausente
   v
retired_at = now(), cleanup_status='pending'
   |
   | scripts/upload-maintenance.mjs + mark_upload_attempt_cleanup
   v
cleanup_status='absent' | 'failed'
```

El path del intento se deriva del canónico: `<workspace>/<document>/<version>/attempts/<attempt>/original.<ext>` (`supabase/migrations/20261003044516_s1_02_upload_expand.sql:167-186`). La ruta canónica sigue `<workspace>/<document>/<version>/original.<ext>` (`supabase/migrations/00001_initial_schema.sql:77-83`).

### 3.4 Algoritmo de asignación atómica `vN`

No existe helper de numeración en el repo. T1b crea `private.allocate_document_version_number(p_document_id uuid, p_workspace_id uuid) returns integer`, que asume el lock del documento. Restricciones existentes: `version_number > 0` y `unique(document_id, version_number)` (`supabase/migrations/00001_initial_schema.sql:64,71`).

```text
BEGIN
  -- Orden de locks acordado: documento -> ronda -> items -> versión/candidata.
  SELECT d.* INTO v_document
  FROM public.documents d
  WHERE d.id = p_document_id AND d.workspace_id = p_workspace_id
  FOR UPDATE;

  -- Validar ronda collecting, base fija y active_version_id sin cambios.
  SELECT r.* INTO v_round
  FROM public.correction_rounds r
  WHERE r.id = p_round_id AND r.document_id = p_document_id
    AND r.workspace_id = p_workspace_id
  FOR UPDATE;

  v_next := private.allocate_document_version_number(p_document_id, p_workspace_id);

  -- v_next > 1 obligatorio para una corrección; v1 queda reservado a S1.
  INSERT INTO public.document_versions(..., version_number, ...)
  VALUES (..., v_next, ...);

  PERFORM private.insert_upload_attempt(...);
  INSERT INTO public.correction_submissions(...);
  INSERT INTO public.correction_submission_items(...);
COMMIT;
```

El lock de `documents` serializa reservas concurrentes del mismo documento; el índice único es la red de seguridad. Una versión rechazada, vencida o fallida conserva su número; la siguiente reserva usa `max + 1`.

---

## 4. Contratos públicos (RPCs nuevas)

Todas las RPCs se ejecutan con `service_role` desde server actions; `p_user_id` y `p_workspace_id` se derivan del Profile verificado, nunca del navegador. Se revocan de `public`, `anon` y `authenticated`, y se conceden solo a `service_role`, siguiendo el patrón S1 (`supabase/migrations/20261003044516_s1_02_upload_expand.sql:545-557`).

### 4.1 `reserve_correction_upload`

**Firma mínima del brief:**

```sql
public.reserve_correction_upload(
  p_workspace_id uuid,
  p_round_id uuid,
  p_document_id uuid,
  p_finding_ids uuid[],
  p_base_version_id uuid,
  p_idempotency_key text
) returns record
```

**Firma técnica propuesta (la que se implementa):** la firma mínima no permite autorizar al actor, verificar el archivo ni proteger la revisión de cada item. Se amplía:

```sql
public.reserve_correction_upload(
  p_user_id uuid,
  p_workspace_id uuid,
  p_round_id uuid,
  p_document_id uuid,
  p_finding_ids uuid[],
  p_expected_revisions bigint[],
  p_base_version_id uuid,
  p_expected_sha256 text,
  p_size_bytes bigint,
  p_extension text,
  p_idempotency_key text,
  p_request_fingerprint text
) returns table (
  submission_id uuid,
  version_id uuid,
  attempt_id uuid,
  storage_path text,
  canonical_mime_type text,
  upload_state public.upload_state,
  expires_at timestamptz
)
```

**Autorización:**

- `p_user_id` debe existir en `profiles` con `role='Member'` y `workspace_id = p_workspace_id`; reutilizar `private.review_profile_has_role` (`supabase/migrations/20261108150200_s3_01_review_integrity.sql:4-17`).
- `private.uploads_enabled()` debe ser verdadero (`supabase/migrations/20261003044516_s1_02_upload_expand.sql:144-146`).
- Ronda `mode='assigned_findings'`, `status='collecting'`, `document_id` y `base_version_id` coincidentes (`supabase/migrations/20261108150200_s3_01_review_integrity.sql:228-233`).
- `documents.active_version_id = p_base_version_id`; si cambió, `CONFLICT` sin rebase.
- Cada finding debe:
  - pertenecer a un `correction_round_items` de la ronda y documento;
  - tener `findings.assignee_id = p_user_id`;
  - estar en `confirmed` o `update_planned`;
  - tener evidencia sobre el documento (`supabase/migrations/20261114150200_s3_02_review_coverage_guards.sql:143-158`);
  - coincidir con `expected_revisions[i]` y la revisión actual del item.
- `p_finding_ids` no vacío, sin duplicados; longitudes de arrays iguales.
- Archivo: extensión `pdf|docx|md`, `1 <= size_bytes <= 10485760`, SHA-256 de 64 hex; validación de contenido real ocurre en `finish`.

**Efectos:**

1. Advisory lock por `workspace:user:idempotency_key` para serializar replay.
2. Buscar `correction_submissions` por `(workspace_id, submitter_id, idempotency_key)` (`supabase/migrations/20261108150100_s3_01_review_model.sql:84`).
   - Misma key y mismo `request_fingerprint`: devolver la misma submission/target.
   - Misma key y fingerprint distinto: `23505` -> `CONFLICT`.
   - Submission `expired`/`invalidated`: `23505` -> `CONFLICT`; se exige nueva key.
3. Lock de `documents`, cálculo de `vN`, inserción de `document_versions` con:
   - `workflow_kind='correction_submission'`;
   - `processing_status='uploaded'`, `version_status NULL`;
   - `upload_state='pending'`, `expected_sha256`, `hash_source='client_declared'`;
   - `upload_initiator_id=p_user_id`, `current_upload_attempt_id`, `reference_set_at/by`;
   - `idempotency_key`/`request_fingerprint` de versión en `NULL` (la idempotencia de negocio vive en `correction_submissions`).
4. `private.insert_upload_attempt`.
5. Insertar `correction_submissions` con `state='reserved'`, `reserved_at=now()`, `expires_at=now()+interval '24 hours'`, `previous_submission_id` derivado.
6. Insertar `correction_submission_items` con `assignee_at_submit_id=p_user_id` y `expected_revision`.
7. Devolver target.

**Errores:** `42501` (FORBIDDEN), `22023` (INVALID_INPUT), `P0002` (NOT_FOUND), `23505`/`23514` (CONFLICT), `55000` (CONFLICT: uploads paused).

**Grants:** `revoke all ... from public, anon, authenticated; grant execute ... to service_role`.

### 4.2 `claim_correction_verification`

```sql
public.claim_correction_verification(
  p_user_id uuid,
  p_submission_id uuid,
  p_version_id uuid,
  p_attempt_id uuid
) returns table (
  version_id uuid,
  attempt_id uuid,
  operation_id uuid,
  workspace_id uuid,
  temporary_path text,
  canonical_path text,
  expected_sha256 text,
  expected_size_bytes bigint,
  canonical_mime_type text,
  upload_state public.upload_state
)
```

**Autorización:** submission `reserved`, `submitter_id=p_user_id`, versión/attempt actuales, `uploads_enabled()`. Revalidar base activa y assignment/revisión antes de emitir el lease; si están obsoletos, `CONFLICT`.

**Efectos:** mismo lease de 120 s que S1 (`supabase/migrations/20261003044516_s1_02_upload_expand.sql:327-377`): `upload_state='verifying'`, `upload_operation_id`, `upload_lease_expires_at=now()+120s`. Si ya está `confirmed`, devolver el claim confirmado para replay.

**Errores:** `42501`, `P0002`, `40001` (CONFLICT: lease/estado), `55000`.

### 4.3 `finish_correction_verification`

```sql
public.finish_correction_verification(
  p_user_id uuid,
  p_submission_id uuid,
  p_version_id uuid,
  p_attempt_id uuid,
  p_operation_id uuid,
  p_result public.upload_state
) returns table (
  submission_id uuid,
  version_id uuid,
  submission_state public.correction_submission_state,
  confirmed_at timestamptz,
  upload_state public.upload_state,
  attempt_id uuid,
  can_open boolean,
  can_resume boolean,
  can_recover boolean
)
```

**Autorización:** submitter, lease vigente, `p_result in ('pending','rejected','confirmed')`.

**Efectos atómicos en una sola transacción:**

1. Actualizar la versión con el mismo patrón S1 (`supabase/migrations/20261003044516_s1_02_upload_expand.sql:380-418`).
2. Si `p_result='confirmed'`:
   - `upload_confirmed_at=now()`;
   - retirar el attempt;
   - `correction_submissions.state='confirmed'` y `confirmed_at = document_versions.upload_confirmed_at` (el guard exige igualdad exacta: `supabase/migrations/20261108150200_s3_01_review_integrity.sql:267-270`);
   - para cada item: `current_submission_id = submission_id`, `coverage_revision = coverage_revision + 1` (guard: `supabase/migrations/20261114150200_s3_02_review_coverage_guards.sql:212-215`);
   - avanzar `correction_rounds.coverage_revision` una sola vez por transacción (permitido: `:37-39`);
   - auditar con `private.append_review_audit(p_user_id, 'correction_submission_confirmed', 'correction_submission', submission_id, {roundId, submissionId}, event_id)`; el actor debe ser Member y la metadata exacta (`supabase/migrations/20261114150300_s3_02_review_command_support.sql:686-700,717-721`).
3. Si `p_result='rejected'`: versión `rejected`; la submission permanece `reserved` para permitir `resume` hasta expirar.
4. Si `p_result='pending'`: versión `pending`; el usuario puede reintentar la transferencia/verificación.
5. No actualizar `version_status`, `processing_status`, `active_version_id`, findings ni créditos.
6. No encolar jobs.

**Idempotencia:** si la versión ya está `confirmed` y la submission ya está `confirmed`, devolver el snapshot sin duplicar auditoría/cobertura. Si la versión está `confirmed` pero la submission sigue `reserved` (fallo parcial histórico), reconciliar en la misma transacción: completar submission/cobertura/auditoría una vez.

**Errores:** `42501`, `P0002`, `40001` (lease obsoleto), `23514` (assignment/revisión/candidata viva -> CONFLICT).

### 4.4 `resume_correction_upload`

```sql
public.resume_correction_upload(
  p_user_id uuid,
  p_submission_id uuid
) returns table (
  submission_id uuid,
  version_id uuid,
  upload_state public.upload_state,
  attempt_id uuid,
  storage_path text,
  canonical_mime_type text,
  can_open boolean,
  can_resume boolean,
  can_recover boolean
)
```

**Autorización:** submitter, submission `reserved`, `expires_at > now()`, base activa y assignment vigentes.

**Efectos:**

- `confirmed` -> devolver snapshot (replay).
- `pending` -> devolver target actual (`private.upload_snapshot`, `supabase/migrations/20261003044516_s1_02_upload_expand.sql:188-201`).
- `rejected` o `verifying/recovering` con lease vencido -> aplicar semántica de recuperación S1 (`supabase/migrations/20261003051326_s1_02_upload_rpc_fix.sql:58-150`): retirar attempt actual; si el objeto temporal está ausente, crear attempt nuevo y volver a `pending`; si existe, dejar `rejected`.
- `expired`/`invalidated` -> `CONFLICT`; se requiere nueva reserva/key.

**Errores:** `42501`, `P0002`, `40001`/`23514` (CONFLICT), `55000`.

### 4.5 `expire_stale_correction_reservations`

```sql
public.expire_stale_correction_reservations(
  p_limit integer default 100
) returns table (
  submission_id uuid,
  outcome text
)
```

**Autorización:** `security definer`, solo `service_role`; no expuesta a `authenticated`.

**Efectos:**

- Seleccionar submissions `reserved` con `expires_at <= now()` con `for update skip locked`, límite `p_limit` (1..1000).
- Outcomes posibles: `expired`, `invalidated`, `skipped_candidate_alive`, `skipped_not_confirmed`, `skipped_version_inconsistent`.
- Si la versión está `verifying`/`recovering` con lease vigente, omitir (`outcome='skipped_not_confirmed'`).
- Si la versión está `confirmed`, omitir (`outcome='skipped_not_confirmed'`) para reconciliación manual; no debe ocurrir con la transacción atómica de `finish`.
- `skipped_version_inconsistent`: la submission es elegible pero el UPDATE de versión falla por el CHECK `upload_fields_consistent` u otra restricción de integridad. El sweep continúa con las demás (`EXCEPTION WHEN OTHERS` por submission).
- Si procede: `state='expired'`; versión `upload_state='rejected'`; attempt `retired_at=now()`, `cleanup_status='pending'`.
- Auditar cada expiración con `INSERT` directo en `public.audit_events`: `actor_id = submitter_id` de la submission expirada, `action='correction_submission_expired'`, `entity_type='correction_submission'`, `entity_id=submission_id`, `metadata=jsonb_build_object('round_id', round_id, 'reason', 'ttl_expired')`. No usar `private.append_review_audit` para el sweep.
- No borrar objetos de Storage; no borrar filas; no reutilizar números.
- Devolver una fila por submission procesada/omitida.

**Errores:** `22023` si `p_limit` fuera de rango; el resto se devuelve como `outcome`.

---

## 5. Policy Storage para Member

Se añade un helper y dos policies aditivas; no se modifican las policies S1.

```sql
create function private.current_correction_upload_attempt_allowed(p_storage_path text)
returns boolean
language sql stable security definer
set search_path = '' set row_security = off
as $$
  select coalesce((
    select private.uploads_enabled()
      and private.current_workspace_id() is not null
      and private.current_workspace_role() = 'Member'
      and exists (
        select 1
        from public.document_upload_attempts a
        join public.document_versions v
          on v.id = a.version_id and v.workspace_id = a.workspace_id
        join public.correction_submissions s
          on s.version_id = v.id and s.workspace_id = v.workspace_id
        where a.storage_path = p_storage_path
          and a.workspace_id = private.current_workspace_id()
          and a.id = v.current_upload_attempt_id
          and a.retired_at is null
          and a.cleanup_status = 'pending'
          and v.upload_state = 'pending'
          and v.workflow_kind = 'correction_submission'
          and s.submitter_id = (select auth.uid())
          and s.state = 'reserved'
          and s.expires_at > now()
      )
  ), false)
$$;
```

Policies:

```sql
create policy document_correction_upload_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'documents'
    and (select private.current_correction_upload_attempt_allowed(name))
  );

create policy document_correction_upload_returning on storage.objects
  for select to authenticated
  using (
    bucket_id = 'documents'
    and (select storage.allow_only_operation('object.upload'))
    and (select private.current_correction_upload_attempt_allowed(name))
  );
```

Propiedades de seguridad:

- Solo `INSERT` y el `SELECT` acotado de retorno de la subida; no `UPDATE`, `DELETE`, listado ni firma.
- Solo el submitter autenticado, en su workspace, con submission `reserved` no vencida y versión `pending`.
- Un Member no puede subir a un intento ajeno, confirmado, retirado o de otro workspace.
- El path se compara por igualdad exacta contra `document_upload_attempts.storage_path`, no por prefijo.
- Se replica el patrón de `document_upload_attempt_returning` (`supabase/migrations/20261003045927_s1_02_upload_cutover.sql:62-66`).

---

## 6. Flujos end-to-end

### 6.1 Member: reserva -> upload -> verificación -> confirm

```text
Member UI          Server action            PostgreSQL                  Storage
   |                    |                       |                          |
   |-- reserve -------->|                       |                          |
   |                    |-- reserve_correction ->|                          |
   |                    |   (auth Member, lock) |                          |
   |                    |<-- submission+target -|                          |
   |<-- target ---------|                       |                          |
   |                                                                       |
   |-- PUT bytes (directo, RLS Member) ----------------------------------->|
   |                                                                       |
   |-- finalize ------->|                       |                          |
   |                    |-- claim_correction -->|                          |
   |                    |<-- temp/canonical ----|                          |
   |                    |-- download temp -------------------------------->|
   |                    |-- verify hash/firma/promote -------------------->|
   |                    |-- finish_correction ->|                          |
   |                    |   (version+submission+coverage+audit atómico)    |
   |                    |<-- snapshot ----------|                          |
   |<-- confirmed ------|                       |                          |
```

No hay job durable: la versión queda `uploaded`/`version_status NULL`.

### 6.2 Admin/QA: consolidado (frontera S3-04/S3-06)

```text
Admin/QA UI        S3-06 (selección)          S3-04 (mecánica)           Storage
   |                    |                          |                       |
   |-- select/consolidate ->|                     |                       |
   |                    |-- crear candidate/version |                      |
   |                    |   (S3-06, base fija)     |                      |
   |                    |-- reservar intento ------>|                      |
   |                    |<-- target ---------------|                      |
   |-- PUT bytes -------------------------------------------------------->|
   |                    |-- verificar/finalizar --->|                      |
   |                    |<-- candidata confirmada -|                      |
```

S3-04 no crea la candidata ni selecciona; solo aporta la mecánica de intento/verificación reutilizable. La creación/selección y el encolado pertenecen a S3-06/S3-05. Ver pregunta pendiente 3.

### 6.3 Reasignación durante transferencia

```text
Member A reserva -> sube bytes -> Admin reasigna finding a Member B
                                         |
                                         v
S3-02 invalida submissions reserved del item
(finding_commands.sql:249-258,385-392)
                                         |
                                         v
finalize de A: guard detecta assignee/revisión obsoleta -> CONFLICT
No se publica submission; el intento temporal queda para expiración/limpieza.
```

La reasignación también avanza la revisión de la ronda (`supabase/migrations/20261114150400_s3_02_finding_commands.sql:240-247`).

### 6.4 Base activa cambió

```text
reserve/finalize compara round.base_version_id con documents.active_version_id
  - igual: continúa
  - distinto: CONFLICT, sin rebase silencioso
```

Evidencia de la base fija al abrir: `supabase/migrations/20261114150200_s3_02_review_coverage_guards.sql:37-39,75-90`.

### 6.5 Idempotencia (replay)

```text
request(key K, payload P1) -> submission S, target T
request(key K, payload P1) -> S, T (misma fila, sin duplicar versión)
request(key K, payload P2) -> CONFLICT (fingerprint distinto)
request(key K, payload P1) tras confirmed -> snapshot de S
request(key K, payload P1) tras expired -> CONFLICT; nueva key
```

La unicidad de negocio es `(workspace_id, submitter_id, idempotency_key)` (`supabase/migrations/20261108150100_s3_01_review_model.sql:84`). El advisory lock evita la carrera de dos inserts simultáneos.

### 6.6 Expiración 24 h

```text
reserved, expires_at <= now()
   |
   +-- lease activo? -> skip
   +-- version confirmed? -> skip (reconciliación)
   +-- otherwise -> submission expired
                    version rejected
                    attempt retired (cleanup pending)
                    Storage se borra después por maintenance/S3-10
```

### 6.7 Compensación Storage <-> PostgreSQL

```text
Caso A: reserva creada, nunca sube bytes
  -> expira; versión rejected; attempt retirado; no hay objeto canónico.

Caso B: bytes suben, finish falla antes de confirmar
  -> versión verifying con lease; al vencer, resume/recovery reconcilia.
  -> si el temporal existe: reintentar verificación.
  -> si el temporal no existe: nuevo attempt.

Caso C: promoción canónica OK, finish RPC falla
  -> versión verifying; replay de finish/claim reconcilia bytes canónicos
     (verification.ts:reconcileCanonical) y confirma una vez.

Caso D: finish confirma en DB pero se pierde la respuesta
  -> replay devuelve snapshot confirmado; no duplica cobertura/auditoría.

Caso E: finish confirmó versión pero no submission (no debería ocurrir)
  -> finish reconcilia submission/cobertura/auditoría en una transacción.
```

`verifyAndPromote` ya resuelve escrituras canónicas inciertas comparando bytes exactos (`src/modules/ingestion/verification.ts:134-189`).

---

## 7. Migraciones planeadas

| Migración | Propósito |
| -- | -- |
| `20261126110000_s3_04_audit_enum.sql` | T1a: solo `ALTER TYPE public.review_audit_action ADD VALUE 'correction_submission_expired'`; sin tablas, funciones ni policies. |
| `20261126120000_s3_04_correction_upload.sql` | T1b: helper `private.allocate_document_version_number`, `public.expire_stale_correction_reservations`, `INSERT` directo en `audit_events`; grants y comentarios. |

Las migraciones son aditivas y posteriores a S3-05 (`20261121130000_s3_05_correction_worker_reads.sql`); no reescriben migraciones integradas. Las RPCs `reserve`, `claim`, `finish`, `resume` y la policy Storage Member se añadirán en migraciones posteriores de T2/T3/T4 con timestamps propios.

---

## 8. Integración con otros tickets

| Ticket | Frontera |
| -- | -- |
| S3-02 | Aporta ronda/item/assignee/revisión, guards de cobertura, invalidación de reservas por reasignación/resolved. S3-04 no cambia findings ni asignaciones. |
| S3-05 | Consume solo candidatas confirmadas/seleccionadas. S3-04 no encola ni procesa; las entregas intermedias quedan `uploaded`/`NULL` y el worker las ignora (`supabase/migrations/20261116120000_s3_05_correction_processing.sql:231-240`). |
| S3-06 | Selecciona candidata directa/consolidada, crea `correction_candidates`, decide devoluciones/aprobación. S3-04 entrega submissions confirmadas y cobertura. |
| S3-07 | Expone `listAssignments`, `getAssignment`, URLs de original y lecturas Member. S3-04 no implementa lecturas ni URLs. |
| S3-08 | Presenta la UI Member de carga/estado. S3-04 entrega server actions/contratos, no pantallas. |
| S3-10 | Programa el cron de expiración/limpieza y borra objetos temporales/reemplazados. S3-04 deja la función SQL y los attempts retirados. |

---

## 9. Riesgos y mitigaciones

| # | Riesgo | Mitigación | Tarea |
| -- | -- | -- | -- |
| R1 | Una corrección con `version_number=1` dispara el enqueue inicial (`supabase/migrations/20261009120000_durable_ingestion_jobs.sql:57-61`). | Forzar `vN > 1`; test explícito de que no hay job tras confirmar. | T1, T2, T6, T7 |
| R2 | Finalizar toca `version_status`/`processing_status` y rompe `assert_review_version_trigger` (`supabase/migrations/20261108150200_s3_01_review_integrity.sql:1036-1055`). | Solo tocar `upload_*`; tests de estados. | T2, T3, T7 |
| R3 | Candidata viva impide reemplazar cobertura (`supabase/migrations/20261114150200_s3_02_review_coverage_guards.sql:222-228`). | Mapear a `CONFLICT`; no reintentar cobertura mientras haya candidata. | T3, T6, T7 |
| R4 | Reasignación durante la transferencia publica con permiso viejo. | Revalidar en claim/finish; guard de submission ya detecta stale; test de carrera. | T3, T6, T8 |
| R5 | La base activa cambió y se aplica un rebase silencioso. | Comparar `round.base_version_id` con `active_version_id` en reserve/claim/finish; `CONFLICT`. | T2, T3, T6, T8 |
| R6 | Policy Storage demasiado amplia expone intentos ajenos o permite listar/firmar. | Helper con igualdad de path, submitter, workspace, reserved y `object.upload`; tests negativos. | T4, T8 |
| R7 | Regresión S1 por ampliar helpers/policies compartidos. | Migraciones aditivas; no tocar `authorized_document_workspace` ni policies S1; regresión S1 en gates. | T1, T4, T9 |
| R8 | Los scripts de upgrade/integración clasifican S3-04 como S2 y rompen sus allowlists (`scripts/review-upgrade-policy.mjs:1-45`; `scripts/check-review-upgrade.mjs:378-405`). | Añadir etapa `s3_04` y allowlists; actualizar tests de política. | T1, T8, T9 |
| R9 | Duplicar verificación y divergir de S1. | Importar `verifyAndPromote`; no copiar hashing/firma. | T3 |
| R10 | El barrido expira un intento con lease activo o una versión confirmada. | `skip locked`, skip active lease y confirmed; tests. | T5, T7 |
| R11 | `coverage_revision` de ronda no avanza y la selección usa un snapshot viejo. | Avanzar ronda una vez al confirmar; test de snapshot. | T3, T6, T7 |
| R12 | `private.upload_control` está `paused` por defecto (`supabase/migrations/20261003044516_s1_02_upload_expand.sql:144-146`). | Fixtures activan y restauran el gate; tests de paused. | T7, T8 |
| R13 | La key text de submission no encaja con la key uuid de versión. | No usar la key de versión para replay; idempotencia en `correction_submissions`. | T2, T6 |
| R14 | Fallo parcial entre promoción Storage y confirmación DB. | `finish` atómico + replay reconciliador; tests de respuesta perdida. | T3, T6, T8 |
| R15 | La nueva suite de integración no corre por no estar en la allowlist (`scripts/review-integration-policy.mjs:1-5`). | Añadir suite y actualizar `tests/unit/review-integration-policy.test.ts`. | T8, T9 |

---

## 10. Out of scope explícito

- Crear/seleccionar `correction_candidates` (`reserveConsolidatedFile`, `selectFinalCandidate`, `finalizeConsolidatedFile`) y consolidación; pertenece a S3-06.
- Encolar, reclamar, procesar, reintentar o finalizar preprocessing; S3-05.
- Aprobar/rechazar candidatas, activar `vN`, actualizar `active_version_id` o resolver findings; S3-06.
- Devolver items, aprobar correcciones o cambiar severidad/estado de findings; S3-02/S3-06.
- Implementar `listAssignments`, `getAssignment`, `listOwnApprovals` o URLs firmadas; S3-07.
- Construir pantallas/UI Member; S3-08.
- Programar cron, borrar objetos de Storage o retener/eliminar versiones reemplazadas; S3-10.
- Emitir notificaciones/digest; S3-11.
- Consumir créditos o llamar al proveedor de análisis.
- Crear tablas nuevas, duplicar `document_upload_attempts` o reescribir migraciones S1.
- Cambiar `private.authorized_document_workspace` o las policies S1 existentes.
- Aceptar `workspaceId`, `role`, `Actor`, paths o hashes de confianza desde el navegador.

---

## 11. Tests obligatorios

### 11.1 pgTAP (`supabase/tests/database/s3_04_*.test.sql`)

**Schema y grants**

- Existe el índice parcial `correction_submissions_reserved_expiry_idx`.
- No se añadieron columnas a `correction_submissions`/`document_versions`.
- Las RPCs S3-04 no son ejecutables por `anon`/`authenticated`; sí por `service_role`.
- `expire_stale_correction_reservations` no es ejecutable por `authenticated`.

**Autorización y tenant**

- Member del workspace correcto reserva.
- Member de otro workspace, Admin/QA o usuario inexistente -> `FORBIDDEN`.
- `p_workspace_id` distinto del Profile -> `FORBIDDEN`.
- Finding ajeno, no asignado, en `pending_review`/`false_positive`/`resolved` -> `FORBIDDEN`/`CONFLICT`.
- Finding sin evidencia sobre el documento -> `CONFLICT`.
- Item de otra ronda/documento -> `CONFLICT`.
- `p_finding_ids` vacío, duplicado o con longitudes distintas de `expected_revisions` -> `INVALID_INPUT`.

**Reserva**

- Crea `vN` con `N = max + 1`, `workflow_kind='correction_submission'`, `upload_state='pending'`, `version_status NULL`, `processing_status='uploaded'`.
- No cambia `documents.active_version_id`.
- No crea job durable.
- `expires_at = reserved_at + 24h`.
- `correction_submission_items` copia assignee/revisión.
- Extensión inválida, tamaño 0, >10 MiB, hash inválido -> `INVALID_INPUT`.
- Uploads paused -> `CONFLICT`.
- Base distinta de la activa -> `CONFLICT`.
- Ronda no `collecting` -> `CONFLICT`.
- Replay misma key/fingerprint -> misma submission/versión/attempt, sin `vN+1`.
- Misma key/fingerprint distinto -> `CONFLICT`.
- Key usada tras `expired` -> `CONFLICT`.

**Verificación y confirmación**

- `claim` pasa a `verifying` con lease de 120 s.
- `finish(confirmed)` confirma versión, submission, items (`current_submission_id`, `coverage_revision+1`) y ronda (`coverage_revision+1` una vez).
- `confirmed_at` de submission = `upload_confirmed_at` de versión.
- Inserta exactamente un `audit_events` `correction_submission_confirmed` con metadata permitida.
- No crea job durable; no toca `version_status`/`processing_status`/`active_version_id`.
- `finish(rejected)` deja submission `reserved` y versión `rejected`.
- `finish(pending)` deja versión `pending` y permite reintento.
- Lease obsoleto/operación distinta -> `CONFLICT`.
- Reasignación entre reserve y finish -> `CONFLICT`, submission invalidada por S3-02.
- Base activa cambió -> `CONFLICT`.
- Candidata viva -> `CONFLICT` al reemplazar cobertura.
- Replay de `finish(confirmed)` no duplica auditoría ni cobertura.

**Resume**

- `pending` devuelve target actual.
- `rejected`/`verifying` vencido recupera; objeto ausente crea nuevo attempt.
- `confirmed` devuelve snapshot.
- `expired`/`invalidated` -> `CONFLICT`.
- No reutiliza número de versión.

**Expiración**

- Expira `reserved` vencida, marca versión `rejected` y retira attempt.
- Omite candidata viva (`skipped_candidate_alive`).
- Omite versión no confirmada (`skipped_not_confirmed`).
- Respeta `p_limit` y `skip locked`.
- Es idempotente: segunda ejecución no cambia filas.
- No borra filas ni objetos de Storage.

### 11.2 Unit (`tests/unit/s3-04-*.test.ts`)

- Zod: `findingIds` no vacío/único, `expectedRevisions` con las mismas claves, extensión/tamaño/hash/firma, key 1..128.
- Fingerprint canónico: determinista, ordena IDs, incluye revisiones, excluye nombre de archivo.
- Store: mapea filas RPC a `CorrectionUploadReservation`/`CorrectionSubmissionSnapshot`.
- Store: mapea SQLSTATE a `ActionResult` (`42501`->FORBIDDEN, `22023`->INVALID_INPUT, `P0002`->NOT_FOUND, `23505`/`23514`/`40001`/`55000`->CONFLICT).
- Action: usa `requireActor`, deriva workspace del actor, rechaza Member ajeno.
- Finalize: orquesta `claim` -> `verifyAndPromote` -> `finish`; tolera fallo de limpieza; no duplica verificación.
- Replay: misma key/payload devuelve misma reserva; distinto payload `CONFLICT`.

### 11.3 Integración real (`tests/integration/review-correction-upload*.test.ts`)

- Auth real: Member A sube a su target; Member B y Admin no pueden usar el target de A.
- Path ajeno, workspace ajeno, intento confirmado/retirado -> denegado por Storage.
- Listado/firma/lectura de intentos -> denegado para Member.
- PDF textual, DOCX y Markdown válidos.
- Firma/MIME/hash falsos -> `rejected`; tamaño >10 MiB -> rechazo.
- Respuesta perdida tras confirmar -> replay devuelve confirmado sin duplicar.
- Dos Members en paralelo -> versiones distintas, sin cruce de cobertura.
- Dos reservas concurrentes mismo documento -> `vN` distintos.
- Reasignación durante transferencia -> no publica.
- Base activa cambió -> `CONFLICT`.
- Expiración -> submission `expired`, versión `rejected`, attempt retirado.
- No job durable, no cambio de activa, no créditos.
- Compensación: temporal eliminado tras confirmar; canónico inmutable; finish reintentable.

### 11.4 E2E

No hay E2E de UI en S3-04 porque la pantalla Member es S3-08. El recorrido integral corresponde a S3-12. Los tests de integración anteriores son el límite máximo de S3-04 contra Auth/Storage reales.

---

## 12. Anexos

### 12.1 RPCs/funciones internas reutilizadas

| Elemento | Ruta:línea | Uso |
| -- | -- | -- |
| `private.insert_upload_attempt` | `supabase/migrations/20261003044516_s1_02_upload_expand.sql:167-186` | Crear intento temporal con path derivado. |
| `private.upload_snapshot` | `supabase/migrations/20261003044516_s1_02_upload_expand.sql:188-201` | Snapshot público de estado. |
| `private.uploads_enabled` | `supabase/migrations/20261003044516_s1_02_upload_expand.sql:144-146` | Gate de uploads. |
| `private.current_workspace_id/role` | `supabase/migrations/00001_initial_schema.sql:34-40` | Policy Storage Member. |
| `private.review_profile_has_role` | `supabase/migrations/20261108150200_s3_01_review_integrity.sql:4-17` | Autorización Member. |
| `private.append_review_audit` | `supabase/migrations/20261114150300_s3_02_review_command_support.sql:552-768` | Auditoría de confirmación. |
| `public.mark_upload_attempt_cleanup` | `supabase/migrations/20261003124137_s1_02_upload_cleanup_marker.sql:1` | Marcar limpieza del temporal. |
| `verifyAndPromote` | `src/modules/ingestion/verification.ts:134-189` | Verificación/hash/promoción canónica. |
| `removeStorageObject` | `src/modules/ingestion/storage.ts:116` | Borrar temporal tras confirmar. |
| `computeRequestFingerprint` (patrón) | `src/modules/ingestion/upload-store.ts:60-74` | Base para fingerprint de corrección. |

### 12.2 Guards existentes que ya cubren parte del comportamiento

| Guard | Ruta:línea | Cobertura |
| -- | -- | -- |
| `guard_correction_submission` | `supabase/migrations/20261108150200_s3_01_review_integrity.sql:218-297` | Ronda collecting, base, submitter Member, versión correction_submission, reserva 24 h, confirmación con upload confirmado, stale assignment. |
| `guard_correction_submission_item` | `supabase/migrations/20261108150200_s3_01_review_integrity.sql:299-326` | Item de la misma ronda/documento, assignee y revisión. |
| `guard_correction_round` | `supabase/migrations/20261114150200_s3_02_review_coverage_guards.sql:4-120` | Base activa al abrir, cobertura completa para consolidar, revisiones. |
| `guard_correction_round_item` | `supabase/migrations/20261114150200_s3_02_review_coverage_guards.sql:125-259` | Reemplazo de cobertura con `coverage_revision+1`, candidata viva, reassignment. |
| `guard_review_workflow_version` | `supabase/migrations/20261108150200_s3_01_review_integrity.sql:574-600` | Versión de corrección no procesada/activada. |
| `assert_review_version_trigger` | `supabase/migrations/20261108150200_s3_01_review_integrity.sql:1036-1055` | Entrega no seleccionada permanece `uploaded`/`NULL`. |
| `current_upload_attempt_allowed` (S1) | `supabase/migrations/20261003045927_s1_02_upload_cutover.sql:34-57` | Patrón de policy de intento; S3-04 añade variante Member. |
| `enqueue_confirmed_ingestion_insert` | `supabase/migrations/20261009120000_durable_ingestion_jobs.sql:57-61` | Riesgo de encolado solo con `version_number=1`. |

### 12.3 Diferencias con S1-02

| Dimensión | S1-02 | S3-04 |
| -- | -- | -- |
| Documento | Crea documento nuevo. | Documento lógico existente. |
| Versión | `v1`. | `vN`, `N > 1`, monotónica. |
| Actor | Admin/QA. | Member asignado. |
| Autorización | `authorized_document_workspace`. | Helper Member + submitter. |
| Persistencia de negocio | Solo versión/intento. | Submission + items + cobertura + auditoría. |
| Enqueue | Confirma `v1` y encola. | No encola; espera candidata S3-06/S3-05. |
| Idempotencia | Key UUID en versión. | Key text en submission + fingerprint. |
| Expiración | No aplica. | Reserva 24 h + barrido. |
| Storage | Policy Admin/QA. | Policy adicional Member. |
| Active version | Queda `v1` activa. | No cambia. |
| Verificación | `verification.ts`. | La misma, importada. |

### 12.4 Evidencia de esquema

- `base_version_id` (no `base_active_version_id`): `correction_submissions.base_version_id` en `supabase/migrations/20261108150100_s3_01_review_model.sql:74`.
- `audit_events.actor_id NOT NULL` + FK a `profiles`: `supabase/migrations/20261108150400_s3_01_review_audit_outbox.sql:30,37`.
- `review_audit_action` enum: `supabase/migrations/20261108150400_s3_01_review_audit_outbox.sql:4`. La ruta `20261108150000_s3_01_review_enums.sql` no contiene este enum.

---

## Preguntas pendientes

1. **Firma de `reserve_correction_upload`:** el brief lista seis parámetros, pero faltan actor, metadatos de archivo y revisiones esperadas. ¿Se aprueba la firma ampliada de 4.1? Sin ella no se puede autorizar ni proteger el CAS de items.
2. **`p_workspace_id`:** se mantiene como aserción redundante derivada del Profile, no como autoridad. ¿Se prefiere eliminarlo de la firma y derivarlo siempre del actor?
3. **Consolidado Admin/QA:** el brief incluye el flujo, pero las RPCs listadas no incluyen `reserve_consolidated_file`/`finalize_consolidated_file`. ¿S3-04 implementa solo la mecánica reutilizable y S3-06 crea/selecciona la candidata, o S3-04 debe añadir esas dos RPCs?
4. **`previous_submission_id`:** el contrato no lo recibe. Si una nueva entrega cubre items con submissions previas distintas, ¿se enlaza la confirmada más reciente que cubra al menos un item, o se deja `NULL` cuando no hay una única anterior?
5. **Resultado `rejected`:** se propone dejar la submission `reserved` para permitir `resume`/recovery hasta las 24 h, en lugar de invalidarla de inmediato. ¿Se aprueba?
6. **Barrido:** ¿`expire_stale_correction_reservations` debe devolver filas por submission (`outcome`) o solo un contador? La propuesta devuelve filas para trazabilidad de tests/operación.
7. **Auditoría de expiración:** el enum no tiene una acción `correction_submission_expired`. ¿Se acepta que el estado `expired` sea la trazabilidad mínima, o se añade un label de auditoría en S3-04?
