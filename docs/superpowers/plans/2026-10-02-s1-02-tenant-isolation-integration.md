# S1-02 Tenant Isolation and Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar S1-02 y resolver H01–H17, con aislamiento efectivo, carga directa verificable y recuperable, migraciones y evidencia de los servicios de aceptación.

**Architecture:** Monolito modular existente; identidad verifica sesión y Profile, workspace proporciona Owners, ingesta controla las escrituras y Repository lee proyecciones con RLS. Los bytes viajan del navegador a Storage; un servidor con privilegios limitados por operación verifica un intento inmutable y publica su contenido en el original canónico. Transacciones cortas e identificadores de operación impiden que resultados tardíos cambien el estado vigente.

**Tech Stack:** Next.js 16.3.5, React 19.2.8, TypeScript estricto, Zod 4.6.5, Supabase JS 2.117.2/SSR 0.12.7, PostgreSQL/RLS/Storage, Vitest 5.0.2, Playwright 1.63.0, pnpm 12.5.1, Node 24.11, Vercel y Sentry. Conservar lockfile y versiones instaladas.

**Spec:** [Diseño aprobado](../specs/2026-10-02-s1-02-tenant-isolation-integration-design.md). [Hallazgos y atribución](../../reviews/2026-10-02-s1-02-integration-findings.md).

Estado: ejecución inline en curso en `feature/tenant_isolation`; las casillas reflejan tareas completadas con evidencia. Base: `661eaf416d67ea4c0b97fe08f13c08abe78011d1`. La aprobación de la spec exige resolver los hallazgos; no permite omitirlos para reducir esta entrega.

## Global Constraints

- Admin y QA Lead operan sobre todo su workspace; Member no accede a documentos, versiones, chunks u originales, aunque sea Owner. Owner es metadata.
- Tenant y rol proceden de `getUser()` y Profile persistido; nunca de parámetros, metadata del navegador o JWT editable.
- Upload: 1–10 archivos; 1–10,485,760 bytes por archivo; PDF textual, DOCX o Markdown. Prefijo/hash no demuestran parseabilidad.
- Bucket privado `documents`; canónico `<workspace_id>/<document_id>/<version_id>/original.<ext>`; temporal `<workspace_id>/<document_id>/<version_id>/attempts/<attempt_id>/original.<ext>`.
- URLs de apertura: 300 segundos; solo originales confirmados. Sin registro o persistencia de URLs firmadas, hashes, nombres, contenido, tokens o respuestas de proveedor.
- Una finalización por llamada; máximo dos transferencias y una verificación simultáneas en UI. Presupuesto de verificación 60 segundos, lease 120 segundos.
- Ninguna recuperación ordinaria borra un canónico. No sobrescribir temporales ni canónicos. Sin transacciones SQL abiertas durante HTTP.
- Nuevas reservas atómicas e idempotentes; versión v1 permanece `processing_status='uploaded'`, `version_status=NULL`, sin activar documento ni consumir créditos.
- Sin parsing, embeddings, worker, Retry Processing, invitaciones ni administración de roles. No introducir proveedores nuevos.
- UI y errores de producto en inglés; documentación del equipo en español.
- Conservar migraciones compartidas y cambios ajenos; regenerar `src/types/database.ts`, nunca editarlo a mano. No seed/reset remoto.
- No commit, push, merge o despliegue implícito por escribir el plan. Durante ejecución, usar únicamente el alcance autorizado; si se requiere acceso externo faltante, identificar la operación concreta pendiente.

## Review Focus

1. Rol revocado mientras se verifica Storage: el resultado tardío no confirma con autoridad obsoleta; probar revalidación en RPC de salida (T03/T06).
2. Original legacy procesado pero ausente: bloquear apertura y registrar incidencia sin resetear chunks, estados ni puntero activo (T08).
3. Content-Length falso y Markdown de un byte: limitar bytes reales y aceptar el Markdown válido, sin confiar en metadata (T04/T06).
4. Transferencia y DELETE antiguos terminan tras un nuevo intento: únicamente afectan su temporal; canónico y nuevo intento permanecen intactos (T07/T12).
5. Una versión antigua coincide con filtro pero la última no: excluir documento y mantener conteo/página coherentes, también con NULL (T09/T12).

## Preparación, mapa y orden

Leer AGENTS.md, ticket, PRD, arquitectura §§3–6, ADR-001 y Día Cero antes de ejecutar. Volver a comprobar checkout/servicios: los inventarios de la spec son históricos. `git status --short` primero; conservar las modificaciones preexistentes de `docs/testing/s1-01-auth-workspace.md`, `docs/testing/s1-01-delivery.md`, `.agents/`, `.claude/`, `docs/testing/despliegue-supabase-compartido.md` y `skills-lock.json`. Si se usa worktree, trasladar solo estos documentos aprobados de forma explícita, sin omitir cambios funcionales locales relevantes.

Todas las rutas siguientes parten de la raíz. Los archivos nuevos se crean en su tarea, no como scaffolding vacío.

| Tarea | Archivos y responsabilidad |
|---|---|
| T01 | `vitest.config.mts`, retirar configuración competidora `vitest.config.mjs`, `package.json`, `playwright.config.ts`, `scripts/local-supabase.mjs`, `scripts/with-local-supabase.mjs`: suites completas y entorno local inequívoco |
| T02 | `src/modules/identity/{session,errors,index}.ts`, retirar `application/identity.service.ts` tras adaptar consumidores; `src/modules/workspace/{queries,index}.ts`; `src/lib/supabase/service.ts`; `tests/unit/{identity-session,workspace-queries,supabase-clients}.test.ts`: autorización y clientes |
| T03 | Nuevas migraciones con sufijos `s1_02_upload_expand`, `s1_02_upload_cutover`, `s1_02_repository_projection`; `supabase/tests/database/006_upload_authorization.test.sql`, `007_upload_transitions.test.sql`; `src/types/database.ts`: permisos y transacciones |
| T04 | `src/types/{contracts,contracts.typecheck}.ts`, `src/modules/ingestion/{schemas,validation}.ts`, `tests/unit/{ingestion-schemas,ingestion-validation}.test.ts`: entradas y contratos |
| T05 | `src/modules/ingestion/{actions,index,upload-store}.ts`, `tests/unit/ingestion-actions.test.ts`, `tests/integration/upload-reservation.test.ts`: reserva y consulta |
| T06 | `src/modules/ingestion/{verification,storage,actions}.ts`, `tests/unit/upload-verification.test.ts`, `tests/integration/upload-finalization.test.ts`: lectura acotada, promoción y CAS |
| T07 | `src/modules/ingestion/{recovery,actions}.ts`, `scripts/cleanup-upload-attempts.mjs`, `tests/unit/upload-recovery.test.ts`, `tests/integration/upload-recovery.test.ts`: recuperación y limpieza |
| T08 | `scripts/reconcile-legacy-uploads.mjs`, `scripts/upload-maintenance.mjs`, `tests/integration/upload-migration.test.ts`, `supabase/seed.sql`, `scripts/check-local-fixtures.mjs`: reconciliación y fixtures |
| T09 | `src/modules/repository/schemas.ts`, `application/{repository.service,repository.actions,repository.service.test}.ts`, `infrastructure/repository.repository.ts`, `index.ts`, `tests/integration/repository-isolation.test.ts`: proyección, filtros y apertura |
| T10 | `src/modules/ingestion/ui/{upload-panel,upload-session}.tsx`, `src/modules/repository/ui/{open-document-button,processing-status-badge}.tsx`, `src/app/(workspace)/repository/page.tsx`, `tests/unit/upload-session.test.ts`, `tests/e2e/upload.spec.ts`: UI mínima |
| T11 | `src/lib/observability/{auth-events,operation-events}.ts`, consumidores de Sentry existentes, `tests/unit/operation-privacy.test.ts`: eventos seguros |
| T12 | `tests/support/upload-fixtures.ts`, `tests/integration/tenant-isolation.test.ts`, `tests/e2e/{repository.spec,auth.helper}.ts`, suites nuevas de T05–T10: matriz completa |
| T13 | `.github/workflows/s1-01.yml`, `docs/testing/s1-02-acceptance.md`, `docs/testing/s1-02-cutover.md`: quality gates y operación local/nube |
| T14 | Spec, informe H01–H17, `docs/architecture/arquitectura-base.md`, `docs/architecture/day-zero-protocol.md`, specs S1-03 y documentos de aceptación: coherencia y cierre |

T01 → T02 → T03 → T04 → T05 → T06 → T07 → T08 → T09 → T10 → T11 → T12 → T13 → T14. Son capacidades del mismo cambio de seguridad, no entregas independientes que permitan activar parcialmente permisos. La expansión y el corte son archivos distintos para que el despliegue pueda detenerse entre ellos. Las migraciones se nombran con timestamps reales de `supabase migration new`; registrar las rutas resultantes en este mapa al crearlas, sin inventar fechas ni renombrar migraciones ya compartidas.

## Contratos que gobiernan las tareas

Conservar `ActionResult<T>` y códigos actuales. `WORKSPACE_REQUIRED` sigue disponible internamente para onboarding, pero en operaciones de documentos se traduce a `FORBIDDEN`. Definir en `src/types/contracts.ts`:

```ts
export type UploadState = 'pending' | 'verifying' | 'rejected' | 'recovering' | 'confirmed';
export interface UploadReference {
  sizeBytes: number;
  sha256: string; // exactamente 64 caracteres hex minúsculos
  signature: string; // base64 de los primeros min(8,sizeBytes) bytes
}
export interface UploadSnapshot {
  versionId: string;
  uploadState: UploadState | null; // null: legacy sin reconciliar
  attemptId: string | null;
  canOpen: boolean;
  canResume: boolean;
  canRecover: boolean;
}
export interface UploadTarget {
  versionId: string;
  attemptId: string;
  storagePath: string; // solo temporal emitido por el servidor
  canonicalMimeType: string;
}
export interface EligibleOwner { id: string; fullName: string }
```

`UploadItemInput` conserva metadata, fileName, declaredMimeType, sizeBytes y signature; añade `idempotencyKey: string` UUID y `sha256: string`. `UploadItemResult` conserva index/outcome y documentId; el éxito incorpora `UploadTarget`. Sustituir `FinalizeItemResult` por `UploadSnapshot`, migrando todos los consumidores juntos.

```ts
// Interfaces públicas de módulos; no aceptan Actor, workspaceId ni rutas.
requireActor(): Promise<Actor>;
requireDocumentActor(): Promise<Actor>;
listEligibleOwners(): Promise<ActionResult<EligibleOwner[]>>;
reserveUpload(items: UploadItemInput[]): Promise<ActionResult<UploadItemResult[]>>;
getUploadState(versionId: string): Promise<ActionResult<UploadSnapshot>>;
finalizeUpload(input: { versionId: string; attemptId: string }): Promise<ActionResult<UploadSnapshot>>;
resumeUpload(versionId: string, reference?: UploadReference): Promise<ActionResult<UploadTarget | UploadSnapshot>>;
recoverUpload(versionId: string): Promise<ActionResult<UploadSnapshot>>;
listDocuments(query: RepositoryQuery): Promise<ActionResult<RepositoryPage>>;
getOriginalUrl(versionId: string): Promise<ActionResult<{ url: string; expiresAt: string }>>;
```

El segundo argumento opcional de `resumeUpload` concreta el caso aprobado de legacy sin archivo/hash: fija la referencia una única vez bajo CAS y no cambia metadata, documento o versión. Con referencia ya existente, otra referencia no la reemplaza: `CONFLICT`. Un resultado `UploadTarget` contiene `storagePath`; uno `UploadSnapshot` contiene `uploadState`, discriminación explícita en UI. La consulta pública de estado nunca devuelve hashes, operationId ni lease. `RepositoryItem.latestVersion` añade `uploadState` y `canOpen`; no expone referencia/hash/temporales.

Interfaces internas tipadas en `upload-store.ts`, solo servidor: `VerificationClaim = { versionId, attemptId, operationId, workspaceId, temporaryPath, canonicalPath, expectedSha256, expectedSizeBytes, canonicalMimeType }` con UUID/path/hash/MIME como string y tamaño number. `claimVerification(userId: string, versionId: string, attemptId: string): Promise<VerificationClaim | UploadSnapshot>`; `finishVerification(userId: string, claim: VerificationClaim, result: 'confirmed'|'rejected'|'pending'): Promise<UploadSnapshot>`. `VerificationResult = { outcome: 'confirmed'|'rejected'|'missing' } | { outcome: 'unavailable'; code: 'INTERNAL_ERROR' }` conserva la diferencia entre ausencia y fallo técnico de Storage. Ningún caller de navegador puede construir estos valores. Funciones SQL devuelven una fila tipada o SQLSTATE controlado; cero filas CAS es conflicto, no éxito.

## T01 — Suites visibles y ejecución local segura

**Consume:** suites actuales y scripts de entorno. **Produce:** `test` y `test:unit` equivalentes; `test:e2e:local` corre toda la suite con Chromium local.

- [x] Capturar inventario inicial con `git status --short` y `npx pnpm@12.5.1 test:unit`; registrar fallos existentes sin reinterpretarlos como regresiones.
- [x] Cambiar `vitest.config.mts` y `package.json` para que las pruebas de Repository se descubran; retirar el `.mjs` competidor tras comprobar que no tiene otra configuración útil:

```ts
// test en vitest.config.mts
include: ['tests/unit/**/*.test.ts', 'src/**/*.test.ts'],
// package.json scripts
// "test": "vitest run --config vitest.config.mts"
// "test:e2e:local": "node scripts/with-local-supabase.mjs e2e"
```

- [x] En Playwright, Chromium es predeterminado; incluir Edge solo con `KDM_TEST_EDGE=1`. Usar `reuseExistingServer:false`, `trace:'off'`, `video:'off'`, `screenshot:'off'`. Conservar tiempos/reintentos; no usar artefactos de red para depurar Auth/originales.
- [x] Ampliar lectura privada del runtime local para proporcionar service role únicamente a procesos servidor/pruebas Node. Rechazar URL distinta de `http://127.0.0.1:54321`; no imprimir `status -o json`. Quitar fallbacks de claves hardcodeadas de `tests/e2e/auth.helper.ts`.
- [x] Ejecutar `npx pnpm@12.5.1 test:unit` y `npx pnpm@12.5.1 exec playwright test --list --project=chromium`. Esperado: aparecen pruebas de ambos directorios y todas las E2E; ningún requisito de Edge en gate mínimo. Una aserción deliberadamente fallida en Repository durante la comprobación local debe hacer fallar `test:unit`; retirarla inmediatamente.

## T02 — Identidad única, Owners y cliente privilegiado

**Consume:** `getIdentityContext`, `IdentityError`, `Actor`. **Produce:** `requireDocumentActor()`, `listEligibleOwners()`, `createServiceClient(): SupabaseClient<Database>`.

- [x] Añadir a `identity-session.test.ts` casos de Member, Profile ausente, sesión expirada y error del proveedor. Mockear el cliente ya utilizado por esa suite; error Auth técnico debe producir `INTERNAL_ERROR`, no anónimo. Añadir este comportamiento al test del guard:

```ts
// Con el fixture de getUser válido y Profile de rol Member:
await expect(requireDocumentActor()).rejects.toMatchObject({ code: 'FORBIDDEN' });
// Con fixture Admin/QA: comparar userId/workspaceId con Profile, no metadata Auth.
```

- [x] Ejecutar los archivos unitarios indicados en T02; comprobar los nuevos fallos por falta del guard. Implementar `FORBIDDEN` en IdentityError y exportar guard desde `identity/index.ts`:

```ts
export async function requireDocumentActor(): Promise<Actor> {
  const actor = await requireActor();
  if (actor.role !== 'Admin' && actor.role !== 'QA Lead') {
    throw new IdentityError('FORBIDDEN');
  }
  return actor;
}
```

- [x] Adaptar Repository a importar identidad pública; retirar factory duplicada cuando `rg 'identity/application|createIdentityService' src tests` no encuentre consumidores. Conservar inyección `IdentityApi` en el servicio para tests; no convertir strings de `.message` en permisos.
- [x] Implementar Owners mediante sesión/RLS, selección `id,full_name`, filtro workspace derivado y orden nombre/id. Member recibe `FORBIDDEN`. No devolver email ni filtrar Members como Owners: la asignación no concede permisos.
- [x] Crear cliente service con `import 'server-only'`, URL validada y clave solo `SUPABASE_SERVICE_ROLE_KEY`; `persistSession:false`, `autoRefreshToken:false`, `detectSessionInUrl:false`. Ningún adaptador cookies. Fallar con error controlado si falta configuración; no serializar clave/error proveedor.
- [x] Ejecutar `npx pnpm@12.5.1 test:unit` y `npx pnpm@12.5.1 typecheck`. Añadir prueba del constructor que rechace configuración faltante y verifique que el cliente de navegador nunca recibe la clave service. Conservar suites de onboarding S1-01.

## T03 — Esquema, RPC y corte de permisos

**Consume:** roles/tenants actuales y migración pendiente `20260930182112_reserve_document.sql`. **Produce:** esquema/funciones siguientes, RLS/GRANT y tipos generados; no activación remota en esta tarea.

- [x] Crear expansión con `npx pnpm@12.5.1 exec supabase migration new s1_02_upload_expand` y registrar nombre real. Añadir enum `upload_state`; columnas nullable para legado en versiones: `upload_state`, `expected_sha256`, `hash_source` (`client_declared|legacy_reconciled`), `upload_initiator_id`, `idempotency_key`, `request_fingerprint`, `current_upload_attempt_id`, `upload_operation_id`, `upload_lease_expires_at`, `upload_confirmed_at`, `reference_set_at`, `reference_set_by`. Mantener `size_bytes` y `storage_path` canónico existentes.
- [x] Añadir `public.document_upload_attempts`: UUID id, workspace_id, version_id, storage_path único, created_at, retired_at, cleanup_checked_at, cleanup_status (`pending|absent|failed`). FK compuesta `(version_id,workspace_id)` a versiones y FK compuesta del intento actual `(current_upload_attempt_id,id,workspace_id)` hacia `(id,version_id,workspace_id)` de intentos; esta última diferida para crear versión/intento juntos. Indexar FKs y `(workspace_id,version_id)`. Referencia a Profile iniciador no debe permitir tenant ajeno.
- [x] Crear índice único parcial `(workspace_id,upload_initiator_id,idempotency_key)` cuando clave no NULL; checks SHA lowercase64, tamaño válido, lease/operation presentes solo en verifying/recovering, confirmed con timestamp/hash/provenance y sin lease. Exigir referencia no NULL para filas nuevas del contrato; permitir legacy NULL solo preexistente y sus transiciones controladas. Denegar a authenticated inserciones nuevas por tabla durante corte.
- [x] Añadir `private.upload_control` singleton `mode` (`paused|active`) inicialmente paused, modificable solo por operación administrativa. RPC nuevas y política de INSERT temporal consultan mode=active; mantenimiento legacy se limita a paused. La app no puede reactivar con variable propia.
- [x] Habilitar RLS explícitamente en intentos; authenticated solo SELECT con tenant derivado y rol Admin/QA, sin mutaciones. Revocar privilegios por defecto de anon/PUBLIC y conceder los mínimos. La política Storage lee el gate mediante `private.uploads_enabled(): boolean`, helper estable SECURITY DEFINER con search_path vacío que retorna únicamente mode=active; EXECUTE solo authenticated/service_role, sin conceder lectura de la tabla privada ni parámetros de autoridad. El helper no reemplaza las comprobaciones de tenant/rol/intento de la política.
- [x] Definir RPC públicas `SECURITY INVOKER`, `SET search_path=''`, solo service_role, con todos los argumentos tipados. Cada RPC consulta Profile por `p_user_id`, deriva workspace y exige Admin/QA dentro de la transacción. Usar nombres: `reserve_document_upload`, `claim_upload_verification`, `finish_upload_verification`, `claim_upload_recovery`, `finish_upload_recovery`, `bind_legacy_upload_reference`. El primer RPC recibe key, fingerprint, name, category, owner, extensión, tamaño y hash además de userId; genera IDs y rutas dentro de SQL. Los claim reciben userId/versionId/attemptId (recovery resuelve attempt actual); los finish reciben userId/versionId/attemptId/operationId y resultado enumerado. Bind recibe userId/versionId/size/hash y registra autor/fecha una sola vez. No aceptar JSON arbitrario para actualizar columnas.
- [x] Implementar reserva con bloqueo transaccional sobre namespace usuario+key, búsqueda del índice y comparación fingerprint. Mismo fingerprint retorna IDs actuales; distinto usa SQLSTATE `40001` como conflicto controlado del contrato. SQL revalida owner, nombre/tamaño/hash/extensión. `42501` = forbidden; `P0002` = ausencia dentro del workspace autorizado; `22023` = entrada inválida; otras excepciones = interno. No diferenciar ajeno de inexistente.
- [x] Implementar claim con bloqueo de versión y lease de 120s, nueva operation UUID. Confirmed retorna snapshot sin relectura. Lease activo genera conflicto; lease vencido permite takeover con operación nueva. Cada finish revalida Profile, tenant, rol y CAS:

```sql
-- Dentro de finish_upload_verification, después de autorizar el Profile:
update public.document_versions
set upload_state = p_result,
    upload_operation_id = null,
    upload_lease_expires_at = null,
    upload_confirmed_at = case when p_result = 'confirmed' then now() else null end
where id = p_version_id and workspace_id = v_workspace_id
  and current_upload_attempt_id = p_attempt_id
  and upload_operation_id = p_operation_id
  and upload_state = 'verifying'
  and upload_lease_expires_at > now();
-- Exigir ROW_COUNT=1; de otro modo lanzar conflicto, nunca afirmar éxito.
```

- [x] Crear corte con CLI `migration new s1_02_upload_cutover`: revocar EXECUTE sobre reserva antigua y INSERT de documentos/versiones para authenticated; retirar políticas antiguas de upload; SELECT originales exige canonical_path y confirmed, tenant y Admin/QA. INSERT temporal exige intento actual/no retirado/estado pending/mode active. No permitir UPDATE, DELETE, firma ni descarga temporal a usuario. Para todas las funciones nuevas: `REVOKE ALL ... FROM PUBLIC, anon, authenticated; GRANT EXECUTE ... TO service_role;` incluyendo funciones de mantenimiento.
- [x] Escribir SQL en 006/007 que falle sin los nuevos grants/checks: acceso a tablas negocio e intentos ambos tenants, Owner Member, QA workspace rename, forging estados/tenant/Profile, llamadas service RPC como anon/authenticated, duplicate key/concurrent CAS y rol cambiado antes de finish. Añadir pruebas positivas Admin/QA y metadata legítima. No considerar un `UPDATE 0` éxito de mutación.
- [x] Adaptar `001_day_zero.test.sql` a `005_ingestion.test.sql` cuando sus expectativas concedan INSERT/RPC antiguos: ahora deben esperar denegación y preparar filas por vía privilegiada de fixtures. Conservar sus negativas, integridad y bootstrap; no eliminarlas para lograr verde. Incluirlos en el diff de T03.
- [x] Probar upload real sin SELECT temporal y denegaciones de descarga/listado/firma/borrado para Admin/QA/Member. El bloqueo local `42P10` se aisló en un volumen anterior de Storage; el proyecto local separado dejó que la migración interna vigente creara el índice `COLLATE "C"`, sin tocar esquema administrado. Upload/cleanup real y la suite de integración completa pasan.
- [x] Aplicar primero la migración pendiente y luego las nuevas **solo local** con CLI verificada. Ejecutar `npx pnpm@12.5.1 test:db`. Regenerar tipos usando `supabase gen types typescript --local` con salida UTF-8 a `src/types/database.ts`; no mezclar mensajes CLI con TypeScript. Typecheck confirma tablas/RPC disponibles. Mantener aplicación pausada hasta T08 y pruebas.

## T04 — Entradas estrictas e idempotencia del contrato

**Consume:** tipos generados de T03. **Produce:** contratos anteriores, `uploadReferenceSchema`, `finalizeUploadSchema`, `repositoryQuerySchema` pertenece a T09.

- [x] Añadir casos reales a schemas/validation: `signature='YQ=='`, size1, Markdown `a`; tamaño10MiB y +1; 0/1/10/11 items; prefijo incorrecto; propietario UUID inválido; campos role/workspaceId/Actor desconocidos; hash uppercase/longitud incorrecta; idempotencyKey inválida. Envelope inválido rechaza lote, item inválido conserva índice y no bloquea otros.
- [x] Ejecutar `npx pnpm@12.5.1 test:unit -- tests/unit/ingestion-schemas.test.ts tests/unit/ingestion-validation.test.ts`; el Markdown pequeño y campos nuevos deben fallar antes de cambiar lógica.
- [x] Incorporar los contratos definidos arriba, usar objetos strict de Zod, nombre trim1..200 y categoría del enum SQL. Prefijo decodificado debe medir `Math.min(8,sizeBytes)`, no siempre8. Re-encode base64 para rechazar entradas no canónicas; conservar MIME por extensión y comprobación de contenido inicial. No introducir parser.

```ts
export const uploadReferenceSchema = z.strictObject({
  sizeBytes: z.number().int().min(1).max(10_485_760),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string(),
});
export const finalizeUploadSchema = z.strictObject({
  versionId: z.string().uuid(),
  attemptId: z.string().uuid(),
});
```

- [x] Definir fingerprint servidor como SHA-256 de array JSON ordenado: `[1,nameTrimmed,category,ownerId,extension,canonicalMime,sizeBytes,sha256]`; no incluir firma redundante, path, actor o filename diagnóstico. Browser no suministra fingerprint. Igual contenido con otra key es documento nuevo válido.
- [x] Actualizar `contracts.typecheck.ts` con firmas nuevas y consumidores viejos; ejecutar tests específicos y typecheck. Documentar cambio de finalización de array a objeto, sin adaptador que conserve bypass antiguo.

## T05 — Reserva y estado durables

**Consume:** schemas, `requireDocumentActor`, service client, RPC T03. **Produce:** reserveUpload/getUploadState y adaptador SQL `upload-store.ts`.

- [x] En `ingestion-actions.test.ts`, con mocks ya existentes de actor/cliente, exigir: key repetida devuelve mismos IDs; forbidden no crea cliente privilegiado; reserva con otro owner tenant falla; error SQL desconocido devuelve interno sin detalles. Quitar assertions que esperan arranque de procesamiento.
- [x] Añadir integración real `upload-reservation.test.ts`: lanzar dos RPC de reserva con misma key/fingerprint mediante `Promise.all`, comparar IDs y contar exactamente un documento/v1/intento. Cambiar hash conservando key y comprobar conflicto. Usar service role solo como backend de prueba, jamás en navegador.
- [x] Reducir actions a fronteras validadas, autorización, llamada al propietario y mapeo de resultado. `upload-store.ts` contiene únicamente operaciones concretas SQL de ingesta, sin repositorio genérico. `getUploadState` consulta versión autorizada con sesión; crea capacidades a partir de estado y reconciliación, no acepta path.

```ts
// Dentro de la frontera reserveUpload, tras validar envelope:
const actor = await requireDocumentActor();
// Por item validado: fingerprint servidor y RPC con p_user_id: actor.userId.
// Reconstruir resultado con campos explícitos; nunca retornar fila RPC completa.
```

- [x] Preservar errores por item y estado de lote, mensaje común para inexistente/ajeno. `getUploadState` distingue error de consulta y cero filas. Confirmed retorna capacidad canOpen; null requiere reconciliación.
- [x] Ejecutar unitarias y `npm run test:integration`. La idempotencia/concurrencia y la respuesta de reserva perdida se comprueban contra PostgreSQL; la matriz confirma tenant/rol y las escrituras autenticadas heredadas se deniegan. Resultado final registrado en el acta.

## T06 — Verificación de bytes y promoción inmutable

**Consume:** VerificationClaim/VerificationResult y RPC T03/T05. **Produce:** `readBoundedBody(response: Response, signal: AbortSignal): Promise<Uint8Array>`, `verifyAndPromote(claim: VerificationClaim): Promise<VerificationResult>`, finalizeUpload.

- [x] En `upload-verification.test.ts`, crear Response con ReadableStream que exceda10MiB aunque Content-Length sea1; comprobar que lector cancela y no solicita el siguiente chunk. Probar timeout, 404 real, 403/500/red, hash distinto, size distinto, canónico existente correcto/incorrecto y publicación con respuesta perdida. El SDK mock usa `metadata.size` cuando simula list, no propiedad `size` inventada.

```ts
it('rechaza bytes reales sobre el límite con metadata engañosa', async () => {
  const response = new Response(new Uint8Array(10_485_761), {
    headers: { 'content-length': '1' },
  });
  await expect(readBoundedBody(response, new AbortController().signal))
    .rejects.toMatchObject({ code: 'INVALID_INPUT' });
});
```

- [x] Ejecutar test para verlo fallar. Implementar lectura de `response.body.getReader()` con suma incremental; rechazar antes de copiar chunk que supera límite, cancelar reader en finally, abortar fetch con señal. No usar `.blob()`/`.arrayBuffer()` sin límite ni aceptar header como autoridad. Buffer máximo por archivo, nunca diez archivos a la vez.
- [x] `storage.ts` construye endpoint de Storage desde URL configurada y segmentos escapados de rutas SQL verificadas; HTTPS salvo loopback local, `redirect:'error'`, headers privilegiados solo para ese origen. No tomar URL de navegador ni seguir redirecciones que puedan filtrar clave. Respuesta HTTP/error del proveedor se mapea internamente, sin logs crudos. Presupuesto único 60s cubre download, publish y comprobación de colisión.
- [x] Calcular SHA-256 sobre bytes reales, comparar hash/tamaño y prefijo/MIME permitidos. Discrepancia comprobada = rejected. 404 objeto realmente ausente = pending; red/permiso/timeout = pending más error controlado, nunca rejected/confirmed. Eliminar confianza en metadata list para confirmar H01.
- [x] Publicar **ese buffer** en canonical con `upsert:false`; no hacer copy desde ruta temporal mutable. Si conflicto/resultado incierto, leer canonical con mismo límite y comprobar igualdad exacta hash/tamaño antes de afirmar success. Si canonical no coincide, registrar incidente seguro, bloquear confirmación y no borrarlo.
- [x] `finalizeUpload` valida un objeto, autoriza, claim CAS, verifica, finish CAS. SQL revalida rol al finish; si cambió a Member, no confirmar. Resultado tardío con otro operationId no cambia estado. Reintento tras confirmed devuelve estado sin IO aunque attempt recibido sea anterior; todavía exige autorización sobre versión.
- [x] Mapear missing/unavailable a pending en SQL, pero devolver INTERNAL_ERROR para unavailable, conservando la distinción en la acción. Dentro del mismo finish exitoso que confirma, marcar temporal del intento retirado y cleanup pendiente; así también se limpian temporales de cargas exitosas. Si cleanup posterior falla no se desconfirma el original. Probar publicación confirmada seguida de limpieza: original legible y temporal ausente, sin depender de un futuro worker.
- [x] En `upload-storage-acceptance.test.ts` y `upload-finalization.test.ts`, subir bytes reales al temporal, finalizar y abrir el canónico con sesión permitida; impedir lectura directa antes. Simular pérdida de respuesta de publicación/finalización y reconciliar sin sobrescritura. Postgres conserva `processing_status='uploaded'`, `version_status=NULL` y sin puntero activo para la versión inicial.

## T07 — Reanudación, recuperación y limpieza delimitada

**Consume:** snapshot/claim, límites de Storage y RPC de recovery. **Produce:** resumeUpload/recoverUpload y comando `cleanup-upload-attempts.mjs`.

- [x] Añadir test con intento A retirado, nuevo B y DELETE tardío A. Asegurar que llamadas remove contienen exclusivamente la ruta A registrada; nunca canonical ni B. Añadir lease vencido y dos recuperaciones concurrentes; solo una crea B.
- [x] Implementar resume: consultar estado/autorización; confirmed retorna snapshot; verifying activo indica esperar; pending con objeto completo intenta finalización; pending con ausencia probada retorna el target actual; rejected exige recovery. En recuperación cross-session, la RPC service-only `authorize_upload_resume_reference` contrasta rol/tenant y hash/tamaño persistidos antes de emitir target. Error técnico devuelve controlado sin crear intentos ni documentos.
- [x] Para legacy sin referencia, argumento opcional UploadReference solo se acepta si no procesada, original ausente probado y hash todavía NULL; `bind_legacy_upload_reference` fija una vez, fecha/autor y provenance client_declared. Referencia diferente después es conflicto. Antes de enviar archivo reseleccionado, hash/tamaño deben coincidir; comparar en servidor durante confirmación, no confiar solo en UI.
- [x] Implementar recovery: claim marca recovering y retira intento A bajo lock; elimina temporal A mediante API Storage y comprueba ausencia específica. DELETE que no devuelve objetos no prueba ausencia: consultar resultado real. Timeout queda recovering recuperable al vencer lease. Finish CAS crea intento UUID B y pending; no cambia hash/documento/versión/canonical.

```ts
// Invariante verificable en upload-recovery.test.ts:
expect(remove).toHaveBeenCalledWith([retiredAttempt.storagePath]);
expect(remove).not.toHaveBeenCalledWith([claim.canonicalPath]);
```

- [x] Crear CLI con argumentos obligatorios `--target local|linked`, `--mode inspect|apply`; usar selección SQL de intentos retirados, procesamiento por página de100 y un archivo a la vez. Volver a inspeccionar también `cleanup_status='absent'`: una transferencia tardía puede recrearlo. Revalidar retired antes de cada delete; nunca borrar fila de versión/documento ni barrer prefijos. Salida solo contadores/códigos/IDs técnicos, sin rutas/hashes/claves.
- [x] Probar CLI local contra reaparición de intento retirado: una segunda limpieza elimina el objeto tardío y la tercera no modifica documentos ni el canónico. Barreras cubren Storage real/finish; `upload-recovery.test.ts` cubre delete/lease e inspect/apply/inspect sobre fixtures loopback.

## T08 — Upgrade, reconciliación y datos de prueba

**Consume:** esquema expandido/corte pausado y Storage bounded. **Produce:** herramientas inspect/apply idempotentes y fixtures compatibles, sin fingir hashes de bytes inexistentes.

- [x] Crear `scripts/upload-maintenance.mjs` como utilidades concretas de CLI: parseo destino explícito, validación proyecto, cliente servidor privado, lectura bounded/hash y salida sanitizada. Compartir allí entre scripts de mantenimiento; no importar barrels cliente o módulos `server-only` desde Node CLI. Añadir tests de comportamiento CLI con servidor local en `upload-migration.test.ts`, incluida negativa al destino no declarado.
- [x] Crear `reconcile-legacy-uploads.mjs --target local|linked --mode inspect|apply`. Target linked exige project-ref explícito coincidente con proyecto enlazado; secretos solo entorno/gestor, jamás argumentos ni salida. Inspect no escribe. Apply usa RPC service-only `reconcile_legacy_upload` añadida en expansión, con resultado enumerado, IDs y valores verificados, que revalida mode paused y estado legacy; nunca SQL dinámico. Añadir `cleanup_legacy_original` como operación de mantenimiento separada que registra autorización por versión y solo corre en pausa comprobada; borrado Storage lo hace script, no SQL.
- [x] Preparar datos históricos antes de aplicar migraciones nuevas: (a) uploaded sin objeto/hash; (b) uploaded con objeto; (c) ready/activa con original válido; (d) ready sin objeto; (e) uploaded con objeto inválido; (f) fallo de red. Guardar solamente IDs/estados/punteros para comparación, ningún contenido ni hash en artefactos.
- [x] Clasificar resultados: a→pending recuperable sin referencia; b/c→confirmed legacy_reconciled tras leer bytes válidos; d→incidencia/NULL sin apertura ni recarga ordinaria; e→limpieza canónica excepcional solo pausa y ausencia de tráfico antiguo verificadas, luego pending; f→pendiente técnico. No reemplazar hash existente que no coincide. Escribir acciones idempotentes condicionadas a estado leído.
- [x] Probar apply dos veces: mismos IDs y punteros, cero duplicados; c conserva chunks/processing/version_status/active pointer. Prueba principal:

```ts
// before/after se obtienen del mismo registro fixture procesado.
expect(after.active_version_id).toBe(before.active_version_id);
expect(after.processing_status).toBe(before.processing_status);
expect(after.chunkCount).toBe(before.chunkCount);
expect(after.canOpen).toBe(false); // fixture procesado sin original
```

- [x] Ajustar seed y fixture loader al flujo seguro: SQL seed no inventa hashes; subir blobs locales por cliente privilegiado restringido a loopback y reconciliarlos con script. Actualizar check-local-fixtures para lectura confirmada y denegación Member; no dar al navegador permiso especial para sembrar canónicos.
- [x] Verificar upgrade desde Dev 2 y, separado, instalación limpia en stack local descartable: 12 migraciones S1-02 en upgrade; 14 en instalación desde `00001`. Ambas suites SQL: 9 archivos/198 aserciones. Tipos regenerados y comparados. Fixtures/integración pasan; no se usó `--linked` ni se aplicó seed/reset cloud.

## T09 — Repository autorizado, última versión real y apertura

**Consume:** requireActor público, UploadSnapshot y esquema. **Produce:** RepositoryApi sin errores ambiguos y proyección con RLS.

- [x] Añadir `repositoryQuerySchema` estricto: name trim max200, category enum opcional, ownerId UUID/null/undefined, versionStatus enum/null/undefined, page entero≥1 default1, pageSize1..100 default25. Rechazar NaN/infinito/string y overflow de offset, no coerción silenciosa. Testear `%`, `_` y `\` como caracteres literales de búsqueda.
- [x] Crear migración `s1_02_repository_projection` mediante CLI: vista `repository_documents` con `security_invoker=true`, documents LEFT JOIN LATERAL latest `ORDER BY version_number DESC,id DESC LIMIT 1` y owner del mismo workspace. Campos explícitos: metadata, timestamps, latest version/status/uploadState; excluir hashes/rutas/leases. RLS de tablas base sigue vigente; GRANT SELECT authenticated, no anon. Filtrar el estado **después** de elegir latest, nunca en el lateral.

```sql
-- Fragmento central de la vista (el SELECT usa columnas explícitas):
from public.documents d
left join lateral (
  select v.id, v.version_number, v.processing_status,
         v.version_status, v.analysis_status, v.upload_state
  from public.document_versions v
  where v.document_id=d.id and v.workspace_id=d.workspace_id
  order by v.version_number desc, v.id desc limit 1
) latest on true
```

- [x] Cambiar infraestructura para consultar vista con count exact, filtros combinados y order created_at desc/id desc; escapar metacaracteres de ILIKE. No filtrar páginas en memoria ni cargar todas las versiones. Conservar documentos sin activa y sin versión, distinguiendo NULL de filtro ausente.
- [x] Actualizar servicio/actions para mantener `ActionResult<RepositoryPage>` hasta UI; error DB lanza error controlado interno, cero filas devuelve NOT_FOUND. `findVersionStoragePath` exige upload confirmed además de tenant/session; getOriginalUrl reautoriza y firma path leído por300s. No firma si aún falta reconciliar.
- [x] Añadir unitarias y fixture integración multi-versión: v1 active/v2 pending, filtro active excluye; filtro NULL incluye v2; ambos tenants con mismos nombres/fechas no alteran total/paginación. Fixture Member Owner no ve filas ni obtiene URL. Testear expiry aproximado300s sin imprimir URL.
- [x] Ejecutar suite Repository incluida en `test:unit`, test SQL vista y `test:integration`; actualizar barrel público `repository/index.ts` con superficie servidor clara. Regenerar tipos vista y actualizar `contracts.typecheck.ts`.

## T10 — Carga mínima y estados recuperables en UI

**Consume:** APIs públicas listEligibleOwners/reserve/state/finalize/resume/recover y RepositoryApi. **Produce:** flujo de usuario completo sin parser.

- [x] Implementar funciones de estado cliente en `ui/upload-session.tsx` y panel en `upload-panel.tsx`. Entrada file conserva bytes solo memoria; UUID se genera antes de reserva y reutiliza en retries; calcular hash con Web Crypto y prefijo min8. Si reload previo a conocer versionId, key permite resolver reserva al reseleccionar el mismo archivo sin crear duplicado. Guardar solo IDs/key pendientes en localStorage con namespace proyecto+userId; limpiar en logout/cambio identidad y al confirmar.
- [x] Test unitario del controlador con respuestas retrasadas: dos transferencias máximo, una finalización, respuesta perdida dispara consulta/resume, no reserva nueva. Nuevo archivo intencional obtiene key nueva. Preparar tests E2E antes de cablear UI; deben fallar por panel inexistente.
- [x] Panel con selección1..10, nombre default por archivo, categoría obligatoria y Owner actual editable a listado del mismo tenant. Error por archivo e índice, deshabilitar doble-submit durante transición, conservar pendientes de otros archivos. No adjuntar `File` a Server Action.

```ts
// Flujo cliente después de una reserva correcta:
await browserClient.storage.from('documents').upload(target.storagePath, file, {
  contentType: target.canonicalMimeType,
  upsert: false,
});
// Incluso con respuesta ambigua de upload: consultar/reconciliar antes de repetir.
await finalizeUpload({ versionId: target.versionId, attemptId: target.attemptId });
```

- [x] Estados English: Preparing, Uploading, Verifying, Upload incomplete, Upload rejected, Recovering, Uploaded — processing pending, Needs reconciliation. Si SDK no provee progreso real usar indicador indeterminado, no porcentaje inventado. Reanudar pide seleccionar mismo archivo y comprueba hash; no prometer offset resume.
- [x] Página Repository exporta `runtime='nodejs'` y `maxDuration=90`; deja bodySizeLimit predeterminado para metadata. Documentación instalada/Context7 confirma configuración en página para Server Actions; verificar duración efectiva del plan Vercel en T13. Presentar Uploaded sin habilitar Retry Processing. Member no obtiene panel ni datos; servidor deniega aunque invoque acción manualmente.
- [x] Apertura: crear ventana por gesto antes del await, manejar null con mensaje controlado, cerrar ventana vacía si action falla y navegar solo URL devuelta. No logs/estado persistente con URL. Pasar a inglés todos los textos de Repository afectados.
- [x] Ejecutar unitarias y suite E2E Chromium con build local dedicado. Se abrió el original confirmado y se compararon bytes; la UI subió 10 archivos y un archivo real de 10 MiB directo a Storage mientras Next recibió metadata, y rechazó 11 archivos y 10 MiB + 1 antes de transferencia.

## T11 — Observabilidad segura para todos los módulos

**Consume:** filtro allowlist Auth. **Produce:** `captureOperationFailure(event: SafeOperationEvent): void` y filtro compatible con Auth/ingestion/repository.

- [x] Definir `SafeOperationEvent`: module `ingestion|repository`, operation `reserve|verify|resume|recover|cleanup|reconcile|list|open`, code de ActionErrorCode o `PROVIDER_ERROR`, correlationId UUID y opcionales versionId/attemptId UUID. No admitir objetos Error, paths, filenames, búsqueda, hashes ni useremail.
- [x] Añadir `operation-privacy.test.ts` que alimenta filtro con excepción contaminada en request, cookies, headers, extra, breadcrumbs, user y tags. Evento reconstruido solo debe contener campos aprobados; eventos automáticos sin marcador se descartan; Auth sigue pasando igual.

```ts
// Comparar objeto reconstruido exacto, no solamente absence de una propiedad.
expect(JSON.stringify(filtered)).not.toContain('sensitive-fixture-sentinel');
expect(filterSentryEvent({ tags: { operation: 'verify' } })).toBeNull();
```

- [x] Implementar `operation-events.ts` y extensión del filtro común evitando dependencia circular con auth-events. Sustituir captureException crudo de Repository/ingesta; preservar opciones sin tracing/replay/breadcrumbs/request capture. No cambiar DSN ni configurar secretos en commits.
- [x] Ejecutar `test:unit` con privacy tests de Auth y módulos nuevos; probar el `beforeSend` real exportado por la configuración, no solo un mock de captureMessage. T13 validará recepción remota con evento sintético sin datos; éxito local no marca A16 completo.

## T12 — Matriz de aislamiento y carreras con servicios locales

**Consume:** capacidades T01–T11. **Produce:** evidencia local A01–A15/A18, incluyendo SQL, REST/Storage, navegador y concurrencia.

- [x] Preparar fixtures loopback en `tests/support/local-supabase.ts` para Admin A, QA A, Member A Owner, Admin B, QA B y Member B. No se omite aceptación si falta bootstrap; las pruebas fallan y limpian identidades sintéticas.
- [x] En `tenant-isolation.test.ts`, recorrer SELECT y mutaciones directas de workspace/profile/document/version/chunk/attempt por las seis identidades, en ambos sentidos tenant. Verificar respuestas y estado persistido; QA rename y mutaciones cruzadas se deniegan, Admin renombra únicamente su workspace. `upload-storage-acceptance.test.ts` verifica denegaciones reales de Storage.
- [x] Controlar carreras con barreras sobre Storage fetch, respuesta de finish y delete/recovery; cubrir reserva duplicada y respuesta perdida, respuesta perdida de upload, publicación/finalización perdida, leases, finish/attempt antiguo y write autorizado antes de retirar que reaparece después. Cleanup repetido retira el intento re-aparecido y deja el canónico/estado estables. La escritura tardía recreada con service role está identificada como simulación local del commit en vuelo.
- [x] Probar con Storage real la subida temporal permitida y escritura cross-tenant/Member denegada antes de crear objeto; firma/lectura/listado/borrado temporal también se deniegan, bytes canónicos se ocultan hasta confirmar y descarga autorizada compara bytes en memoria. La matriz `pending/rejected` y el canónico `confirmed` están en las integraciones.
- [x] Suite E2E Chromium completa, servidor local nuevo y Sentry apagado: cambio de sesión Admin→QA, recuperación por otro QA, UI Repository y carga. La versión de otro workspace se prueba por RPC con `NOT_FOUND`; Member recibe `FORBIDDEN`. Legacy conserva “Needs reconciliation” sin CTA de recuperación; las consultas fallidas muestran error controlado.
- [x] Ejecutar controles locales secuencialmente y registrar evidencia actual en `docs/testing/s1-02-acceptance.md`: lint, typecheck, unit, DB, tipos, fixtures, integración, build, E2E y restart Auth. Resultado y límites remotos quedan separados.

## T13 — CI, migración cloud y aceptación de servicios

**Consume:** evidencia local, migraciones ordenadas, herramientas de mantenimiento. **Produce:** gate remoto efectivo y acta de corte/reconciliación. No considerar `READY` o variable presente como aceptación funcional.

- [x] Actualizar workflow existente manteniendo triggers develop/main y acciones fijadas. Ejecutar todas las suites T12 y Chromium; instalar Edge solo en job explícito opcional. Agregar comprobación de tipos SQL regenerados contra archivo versionado. Fallo de cualquier suite impide éxito; no `continue-on-error` ni tests condicionales. Mantener nombres de jobs/checks estables y anotarlos para protección remota.
- [x] Escribir runbook `s1-02-cutover.md` con tabla timestamp/app SHA/schema versions/mode/resultado; registrar rutas reales de migraciones generadas. Consultar ayuda CLI actual antes de comandos de aplicación/tipos. Secuencia local probada es requisito de nube, no sustituible por review estático.
- [x] Reinspeccionar solo lectura con CLI/MCP: Supabase ref `cdyjtoheovbvewewicaa`, historial cloud (solo `00001`), bucket privado 10MiB y Storage 66/72/índices; Vercel team/project/Node, dominio verificado y scopes de variables por nombre; GitHub workflow, branches y ambientes. Vercel env values no se leyeron, por lo que su URL/origin no se compara con el proyecto cloud. Sentry no tiene acceso/conector disponible y queda registrado como bloqueo; no se afirmó ni hizo configuración remota.
- [x] Preflight antes de escribir en cloud: destino e inventario legacy confirmados y registrados en el runbook. El plan Free no ofrece PITR/backup disponible; el usuario confirmó que los datos y archivos existentes no necesitan conservarse. No se aplicó seed ni se borraron registros u objetos. Mantener prohibido seed/reset/fixtures locales en cloud y no volcar bases/documentos a artefactos del repo.
- [x] Preparar y aplicar la fase de expansión en un directorio ignorado `.artifacts/s1-02-expand/supabase/`, copiando `config.toml` y únicamente migraciones hasta `s1_02_upload_expand`; se verificaron archivos y dry-run. La CLI 2.117.0 no ofrece selector de versión para `migration up`, así que se usó `--workdir` con conjunto cerrado. La aplicación de esta fase está registrada en el runbook:

```powershell
node node_modules/supabase/dist/supabase.js db push --workdir .artifacts/s1-02-expand --project-ref cdyjtoheovbvewewicaa --skip-vault --dry-run
# Revisar que solo figuran la migración pendiente de Dev2 y expansión.
node node_modules/supabase/dist/supabase.js db push --workdir .artifacts/s1-02-expand --project-ref cdyjtoheovbvewewicaa --skip-vault
```

- [x] Aplicar la fase de corte con las 11 migraciones restantes usando un segundo `--workdir`, después de revisar el dry-run. `migration list` confirma las 13 migraciones hasta `20261003214934`; la base quedó en modo `paused`/uploads deshabilitados. No se incluyeron seed ni roles. El runbook registra destino y resultados.
- [ ] Configurar Preview para el mismo proyecto Supabase, completar la variable sensible `SUPABASE_SERVICE_ROLE_KEY` y verificar `APP_ORIGIN`/allowlist de Auth. Desplegar la aplicación solo después de comprobar que el modo pausado se muestra correctamente.
- [ ] Mantener uploads pausados y resolver los 4 objetos Storage sin versión asociada. El script de reconciliación solo cubre versiones legacy y no puede vincular esos objetos automáticamente; acordar y registrar su tratamiento delimitado antes de eliminarlos. No afirmar reconciliación ni aceptación cloud mientras sigan pendientes.
- [ ] Activar DB mode=active solo cuando reconciliación y checks hayan pasado; app antigua ya no puede escribir por RPC/tabla/Storage. Rollback: mode paused, mantener esquema/datos/políticas fuertes y versión de app compatible; nunca reabrir bypass para recuperar disponibilidad. URLs emitidas antes del corte pueden seguir válidas hasta expirar; respetar ventana antes de afirmar restricciones nuevas completas.
- [ ] Verificar en Vercel el runtime y presupuesto efectivos, no exponer secretos y cubrir las ramas Preview previstas. Probar upload/lectura de 10 MiB y rechazo de 10 MiB + 1; confirmar bytes directos a Storage y errores sanitizados sin guardar HAR ni signed URLs.
- [ ] Emitir evento sintético seguro de ingestion y repository en entorno aceptado y localizarlo en Sentry por correlationId. Comprobar ausencia de payload/tokens/breadcrumbs, source maps por separado. Verificar Auth/email hospedado mediante cuentas de prueba autorizadas: callbacks/origin/template y correo real, sin usar Mailpit como sustituto.
- [ ] Configurar/verificar GitHub protección de integración con checks requeridos y gate de promoción al entorno aceptado. Provocar fallo controlado en rama de prueba para verificar bloqueo, restaurar cambio y confirmar verde; no introducir failure deliberado en rama compartida. Si desplegar/abrir PR requiere acción no autorizada o acceso ausente, entregar resultado concreto listo para esa acción y dejar A17 pendiente.
- [ ] Ejecutar limpieza delimitada solo después de la aceptación y redactar acta con versiones, fecha, roles anonimizados, resultados Axx y limitaciones. No cerrar el ticket mientras la reconciliación legacy, Preview/10 MiB, Sentry, Auth hospedado o protecciones CI sigan pendientes.

## T14 — Trazabilidad y revisión final

**Consume:** cambios y evidencia T01–T13. **Produce:** contrato/documentación coherentes e informe que distingue origen y reparación validada.

- [x] Actualizar arquitectura y Día Cero: límites de módulos, nuevos contratos, temporal/canónico, RPC service-only, garantías/limitaciones de compensación y comando de limpieza. Señalar qué partes de S1-03 quedan sustituidas por este diseño; preservar S1-04/S1-07 pendientes de procesamiento.
- [x] En informe H01–H17 conservar commit/autor original y agregar por hallazgo: archivo de corrección, prueba/evidencia, estado local/remoto y commit corrector **solo si existe**. Sin commit autorizado escribir «cambio local sin commit», nunca inventar SHA o atribuir cierre operativo al autor original.
- [x] Revisar spec/plan contra implementación y actualizar diferencias reales con motivo; no marcar casillas por mera existencia de archivos. `git diff --check`, enlaces locales y búsquedas de importaciones privadas, captura cruda en módulos, políticas permisivas y skips condicionales revisados. La carga directa y el corte remoto permanecen gates explícitos en esta spec/acta.
- [x] Revisión independiente final de autorización, Storage/CAS, migración/corte, UI y evidencia. Encontró CTA inoperativa para `upload_state IS NULL` y una brecha de prueba de escritura Storage no autorizada; se ocultó la acción legacy, se añadieron las pruebas de página/Storage y ambos cambios pasaron los controles afectados. No encontró otros bloqueos locales; gates cloud quedan explícitos.

## Matriz de cierre obligatoria

| Hallazgo | Corrección y prueba |
|---|---|
| H01 tamaño Storage incorrecto | T06 verificación bytes reales y mock metadata.size; T12 HTTP |
| H02 identidad duplicada | T02 guard común y errores tipados; T09 consumidores |
| H03 suites Vitest divididas | T01 descubrimiento explícito; T13 CI |
| H04 Edge/Chromium desalineados | T01 opt-in Edge; T13 Chromium requerido |
| H05 E2E omite assertions | T10/T12 fixtures exigidos y lectura real |
| H06 Sentry descarta módulos | T11 filtro allowlist; T13 recepción remota |
| H07 comentario RLS incorrecto | T03/T05 corregir comentario y demostrar role+tenant |
| H08 migración pendiente | T03/T08 local limpio/upgrade; T13 cloud |
| H09 compensación no entregada | T07 cleanup repetible; T08 legacy; T14 arquitectura |
| H10 UI ausente | T10 upload mínimo, sin fingir procesamiento |
| H11 entradas Repository sin Zod | T09 schemas y casos malformados |
| H12 outage interpretado ausente | T02/T05/T09 error técnico separado |
| H13 textos Spanish | T02/T09/T10 errores y UI English |
| H14 entornos/gates sin evidencia | T13 inventario, preparación y pruebas remotas |
| H15 trazas sensibles | T01 trace/video/screenshot off; T11/T12 no payloads |
| H16 filtro anterior a latest | T09 vista invoker, test multiversión T12 |
| H17 Markdown pequeño | T04 min(8,size), T06/T10 archivo de un byte |

| Aceptación | Tareas con evidencia exigida |
|---|---|
| A01/A02/A03 | T02/T03/T09/T12 roles, tablas, REST/Storage y UI |
| A04 | T02/T05/T09/T12 auth/provider/Profile |
| A05 | T06/T10/T12/T13 upload y bytes de original |
| A06/A07 | T03/T04/T06/T10/T12/T13 límites y metadata |
| A08 | T03/T05/T10/T12 idempotencia y respuesta perdida |
| A09 | T07/T10/T12 reanudación/reload/otro QA |
| A10/A11/A12 | T03/T06/T07/T12 hash/transitorios/leases/carreras/limpieza |
| A13 | T03/T06/T09/T12 firma/lectura denegadas |
| A14 | T09/T12 última versión, filtros y aislamiento |
| A15 | T08/T13 instalación, upgrade y legacy |
| A16 | T11/T13 privacidad y recepción Sentry |
| A17 | T01/T12/T13 suites y bloqueo remoto efectivo |
| A18 | T01/T02/T12/T13 regresión Auth local/hosted |

## Documentación técnica y límites de este plan

Next.js: consultados Context7 `/vercel/next.js` y guías instaladas `maxDuration.md`, `runtime.md`, `serverActions.md` el 2026-10-02. [maxDuration](https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config/maxDuration) se declara en página para sus actions; [Server Actions](https://nextjs.org/docs/app/api-reference/config/next-config-js/serverActions) conserva límite de cuerpo predeterminado1MB. Esto no levanta el límite de payload de Vercel; el archivo evita ese cuerpo.

Supabase: documentación contrastada en la spec para RLS, metadata.size, uploads sin upsert y helpers por operación. Al ejecutar, comprobar compatibilidad de funciones Storage/CLI instaladas y changelog; no elegir un helper de nombre supuesto para permitir SELECT. Este plan fija comportamiento y pruebas, no declara que los proyectos externos estén ya preparados.

La ayuda local del CLI 2.117.0 (`migration up --help`, `db push --help`) se verificó el 2026-10-02: soporta workdir/project-ref/dry-run/skip-vault; consultar ayuda no aplicó migraciones. No actualizar el CLI incidentalmente para ejecutar este ticket.

Autorrevisión del plan (2026-10-03): las tareas locales T01–T12 están implementadas y verificadas. `42P10` se resolvió aislando el Supabase local y conservando el volumen anterior; no se editó el esquema administrado de Storage. Instalación limpia (14 migraciones) y upgrade desde Dev 2 (12 migraciones S1-02) pasaron con 9 archivos/198 aserciones SQL cada uno. La aceptación local registra 35/217 unit tests, 11/15 pruebas en 11 archivos de integración, Chromium 16/16, build, fixtures, tipos y Auth restart; incluye upload directo real de 10 MiB, lote de 10 y recuperación cross-session. Los tests de integración fallan si no se pueden preparar fixtures y cubren respuesta de reserva perdida, Member `FORBIDDEN`, tenant ajeno `NOT_FOUND` y escritura Storage Member/otro tenant denegada. La revisión independiente T14 detectó una CTA legacy inoperativa y esa brecha de prueba; ambos puntos se corrigieron y validaron. Las correcciones de código están en `2cc4aa2`, `6a04794`, `d74419a` y `f6dc98e`. T13 sigue parcialmente abierta: las 13 migraciones cloud se aplicaron por fases según el runbook y `upload_mode` quedó pausado; faltan reconciliación de los objetos legacy sin versión, Preview y despliegue, Auth alojado, Sentry y protecciones CI. No se eliminó ni sembró información del proyecto cloud.
