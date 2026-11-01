# S2-11 — Analysis Terminal Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar avisos recuperables de análisis completed/failed al iniciador autorizado, mediante Resend, sin cambiar resultados o créditos.

**Architecture:** `analysis` mantiene la producción transaccional de eventos; `notifications` consume la outbox con leases y fencing. Una Edge Function autenticada, invocada por cron cada minuto, usa un sobre inmutable e idempotencia de Resend; login conserva el UUID destino. Los fallos terminales se reportan a Sentry mediante un transporte que reconstruye el envelope permitido.

**Tech Stack:** Next.js 16.3.5, React 19.2.8, TypeScript estricto, Zod 4.6.5, Supabase JS 2.117.2, PostgreSQL/pg_cron/pg_net/Vault, Edge Deno, HTTP fetch de Resend, Sentry Deno 10.75.0, Vitest, Playwright, pnpm 12.5.1.

**Spec:** [Diseño aprobado](../specs/2026-11-01-s2-11-analysis-terminal-notifications-design.md). Leer diseño y plan completos antes de ejecutar. Estado de este archivo: plan preparado para revisión; ninguna tarea de implementación ejecutada.

## Global Constraints

- Eventos exclusivos: `analysis_completed` y `analysis_failed`; destinatario persistido Admin/QA Lead del mismo workspace e iniciador del análisis.
- Remitente: `Knowledge Decay Monitor <notifications@knowledge-decay-monitor.online>`.
- Plantilla inicial `s2-11-terminal-v1`; dos mensajes en inglés y únicamente estado, UUID, fecha terminal original UTC y enlace autenticado.
- `pending/sent/failed`; `sent` significa aceptación del API con ID, no recepción. Un intento inicial y hasta dos retries; máximo 3 claims/intentos de correo, incluso tras crash.
- Cron cada minuto; backoff mínimo de 1 y 5 minutos; sin sleep ni retry HTTP oculto.
- Máximo 5 eventos, concurrencia 2, presupuesto 45 s, HTTP Resend 10 s, lease 90 s. Iniciar un intento solo con al menos 28 s de presupuesto restante; timeout de cada consulta/RPC 3 s, usando reloj monotónico para presupuesto y hora DB para estados.
- Respuesta Resend máxima 64 KiB, `redirect: "error"`, endpoint fijo `https://api.resend.com/emails`; clave `kdm-terminal/<event_id>/v1` y sobre idéntico en cada retry.
- Ventana local 23 h desde `first_submission_at`; no iniciar HTTP si su timeout de 10 s excedería esa ventana o el lease. No prometer exactly-once.
- No cambiar `analyses`, findings, ledger, créditos, Cerebras/Groq, ingesta, recovery ni digest. No añadir webhooks de Resend, adjuntos o tracking de apertura/clic.
- `NOTIFICATIONS_ENABLED` deshabilitado por defecto; cron y control DB también deshabilitados hasta activación explícita. Procesar backlog autorizado cuando se active; no descartarlo silenciosamente.
- No secretos, emails, cuerpos, documentos, tokens o URLs privadas en logs/Sentry/artefactos. El sobre privado es dato operativo, no evidencia exportable.
- Migraciones nuevas; regenerar tipos SQL. Sin reset del stack local con datos, `--linked`, migraciones remotas, commit, push, merge o despliegue durante esta planificación.
- Los pasos de commit son puntos de integración propuestos: ejecutar únicamente si el usuario autoriza commits. Staging explícito por archivos, nunca `git add .`; documentos y cambios previos quedan fuera de commits de implementación salvo pedido expreso.

## Review Focus

1. Backlog del usuario junto a fixtures: pruebas con fakes deben dejarlo intacto; tarea 7 compara un evento centinela ajeno antes/después.
2. Cambio de remitente/origen/plantilla durante un retry: usar exactamente el sobre persistido; tareas 2–3 fijan bytes/clave y reautorizan el destinatario.
3. Resend acepta y se pierde el último ACK: no efectuar un cuarto envío; tarea 7 prueba tercer crash y resultado incierto con análisis/ledger intactos.
4. Sentry drena su buffer pero devuelve 429/500 o descarta el envelope: no marcar reporte aceptado; tarea 4 comprueba status de transporte por event ID, además de `flush`.
5. Nueva migración/función en CI histórico: no introducir columnas en el hash de S2-01 ni incluir config futura en etapas anteriores; tareas 1 y 5 cubren clasificación y snapshot.

## Estado inicial y trabajo preservado

Antes de ejecutar registrar rama, HEAD, `git status --short` y diff de las rutas afectadas. El checkout tiene cambios previos en `docs/testing/second-vertical-e2e-local.md`, página de findings, `analysis/worker/finalization.ts`, sus dos suites y la revisión local; también `credenciales.txt` y `supabase/snippets/` sin seguimiento. No abrir ni incorporar credenciales. No mover, reemplazar o integrar automáticamente esos cambios. Si se necesita aislamiento, resolverlo al comenzar ejecución; un worktree limpio no contiene las correcciones locales y no demuestra el mismo recorrido hasta conciliarlas.

Comandos de este plan se ejecutan desde la raíz con `pnpm` 12.5.1; si falta, sustituir el prefijo por `npx pnpm@12.5.1`. Supabase local y Docker son prerrequisitos. Ahora solo se han hecho lecturas del repositorio/documentación y redacción de documentos.

## Mapa de archivos y contratos

| Archivos | Responsabilidad |
|---|---|
| `supabase/migrations/20261101190000_s2_11_notification_delivery.sql` | Estado/lease, sobre privado, control de activación y RPC de entrega/reporte. |
| `supabase/migrations/20261101190100_s2_11_notification_scheduler.sql` | Scheduler propio, Vault y activación idempotente. |
| `src/modules/notifications/{types,config,templates,resend,store,dispatch,telemetry}.ts` | Tipos internos, configuración, render, proveedor, adaptador DB, coordinación y filtrado/reporte. Imports relativos `.ts`, sin Node ni barrels cliente. |
| `supabase/functions/dispatch-notifications/{index,sentry}.ts`, `deno.json` | Handler, composición oficial Sentry/SDK y dependencias Deno fijadas. |
| `src/lib/observability/{safe-event,safe-envelope,safe-transport}.ts` | Catálogo aditivo y extracción mínima del filtrado de envelope para compartirlo con Deno. |
| `src/modules/identity/analysis-continuation.ts`, login y `auth-form.tsx` | UUID de continuación limitado al análisis; contrato de login existente. |
| `scripts/analysis-upgrade-policy.{mjs,d.mts}`, `check-analysis-upgrade.mjs` | Nueva etapa S2-11 y preservación de historia. |
| Nuevas suites `notifications-*`, SQL, integración, Edge y E2E | Casos precisados por tarea; fixtures locales aislados. |
| `docs/testing/s2-11-notifications-runbook.md`, `s2-11-notifications-acceptance.md` | Arranque, configuración, recepción real, evidencia y límites. |

Los timestamps propuestos son posteriores al inventario observado. Antes de crearlos verificar que siguen libres y posteriores a las migraciones compartidas; si hay colisión, elegir dos nuevos timestamps ordenados y actualizar sus referencias exactas en este plan y la política de upgrade. No crear placeholders.

### Interfaces compartidas entre tareas

Definir en `types.ts`, sin añadir contratos públicos:

```ts
type NotificationFailureCode = "DELIVERY_FAILED" | "RECIPIENT_UNAVAILABLE" | "INTERNAL_ERROR";
type NotificationResult<T> = { ok: true; data: T }
  | { ok: false; code: NotificationFailureCode | "LEASE_LOST" };
type NotificationKind = "analysis_completed" | "analysis_failed";
type NotificationLease = { eventId: string; operationId: string; attemptCount: number; leaseExpiresAt: string };
type NotificationContext = { eventId: string; analysisId: string; workspaceId: string;
  recipientId: string; recipientEmail: string; type: NotificationKind; finishedAt: string };
type NotificationBody = { from: string; to: [string]; subject: string; html: string; text: string };
type PreparedNotification = { body: NotificationBody; requestJson: string;
  idempotencyKey: string; firstSubmissionAt: string };
type SendNotificationResult = { ok: true; providerMessageId: string }
  | { ok: false; code: "DELIVERY_FAILED"; retryAfterSeconds?: number };
type NotificationAlertLease = { eventId: string; operationId: string; code: NotificationFailureCode };
```

`requestJson` es la serialización estable de `body`, persistida antes del primer HTTP. No reconstruirla desde jsonb en un retry: se guarda el string exacto además de la estructura validada. Tareas 1–3 consumen el mismo formato. Timestamps son ISO UTC; IDs se validan como UUID. Un error de DB/transporte no se convierte en un resultado vacío exitoso.

Fijar además estos tipos en `types.ts` (las formas anteriores también se exportan):

```ts
type NotificationCandidate = { eventId: string; recoverExpired: boolean };
interface NotificationStore {
  listCandidates(limit: number): Promise<NotificationResult<NotificationCandidate[]>>;
  claim(eventId: string): Promise<NotificationResult<NotificationLease | null>>;
  context(lease: NotificationLease): Promise<NotificationResult<NotificationContext>>;
  prepare(lease: NotificationLease, body: NotificationBody): Promise<NotificationResult<PreparedNotification>>;
  sent(lease: NotificationLease, providerMessageId: string): Promise<NotificationResult<boolean>>;
  failed(lease: NotificationLease, code: NotificationFailureCode, retryAfterSeconds?: number): Promise<NotificationResult<"pending" | "failed" | "lost">>;
  recover(eventId: string): Promise<NotificationResult<"pending" | "failed" | "unchanged">>;
  listAlerts(limit: number): Promise<NotificationResult<string[]>>;
  claimAlert(eventId: string): Promise<NotificationResult<NotificationAlertLease | null>>;
  alertSent(alert: NotificationAlertLease): Promise<NotificationResult<boolean>>;
  alertFailed(alert: NotificationAlertLease): Promise<NotificationResult<boolean>>;
}
type NotificationConfig = { enabled: boolean; internalToken: string; apiKey: string;
  from: string; appOrigin: string; supabaseUrl: string; serviceRoleKey: string;
  sentryDsn: string; environment: "development" | "vercel-preview" | "vercel-production";
  release: string };
type NotificationDispatchDeps = { store: NotificationStore;
  send: (prepared: PreparedNotification) => Promise<SendNotificationResult>;
  report: (alert: NotificationAlertLease) => Promise<boolean>;
  config: Pick<NotificationConfig, "from" | "appOrigin">;
  monotonicNow: () => number; utcNow: () => number };
type NotificationDispatchSummary = { claimed: number; sent: number; failed: number; reported: number };
type NotificationHandlerEnv = Record<string, string | undefined>;
interface NotificationHandlerDeps {
  createStore(config: NotificationConfig): NotificationStore;
  createSender(config: NotificationConfig): NotificationDispatchDeps["send"];
  createReporter(config: NotificationConfig): NotificationDispatchDeps["report"];
  isDispatchEnabled(config: NotificationConfig): Promise<boolean>;
  runDispatch(deps: NotificationDispatchDeps): Promise<NotificationDispatchSummary>;
  waitUntil(work: Promise<unknown>): void;
}
interface NotificationSentrySdk {
  captureEvent(event: Record<string, unknown>): string;
  flush(timeoutMs: number): Promise<boolean>;
  clearDeliveryStatus(eventId: string): void;
  deliveryStatus(eventId: string): number | undefined;
}
```

`NotificationSentrySdk` es una fachada pequeña del adaptador oficial; las dos operaciones de estado son observaciones del transporte envuelto, no métodos inventados del SDK de Sentry. `SafeEnvelope` se exporta desde `safe-envelope.ts` como `[header: {event_id:string; sent_at:string}, items: Array<[{type:"event"}, SafeEvent]>]`, usando el tipo seguro existente. `readNotificationsConfig(read): NotificationConfig` lanza un error controlado de readiness si enabled/configuración es inválida; el handler comprueba antes el flag disabled para devolver 503 sin cargar dependencias. El store no posee métodos de activación global: `isDispatchEnabled` es solo lectura del control privilegiado.

## Task 1: Persistencia durable, autorización SQL y upgrade compatible

**Files:** crear migración `20261101190000_s2_11_notification_delivery.sql`, `supabase/tests/database/s2_11_notifications.test.sql`, `tests/integration/notifications-leases.test.ts`; modificar `src/types/database.ts`, `scripts/analysis-upgrade-policy.mjs`, `.d.mts`, `scripts/check-analysis-upgrade.mjs` y `tests/unit/analysis-upgrade-policy.test.ts`.

**Interfaces:** consume `notification_events`, `analyses`, `profiles`, `auth.users` existentes. Produce los RPC de esta tabla, accesibles solo a `service_role`; todos fijan `search_path = ''`, statement/lock timeouts y validan estado/lease en DB.

| Firma SQL pública propuesta | Resultado/efecto |
|---|---|
| `claim_notification_event(p_event_id uuid)` | `setof public.notification_events`, 0/1 fila. `FOR UPDATE SKIP LOCKED`, control enabled, estado pending, vencimiento y presupuesto; incrementa intento y crea token/lease 90 s. |
| `get_notification_context(p_event_id uuid, p_operation_id uuid)` | `jsonb` correspondiente a `NotificationResult<NotificationContext>`; comprueba token vigente, análisis terminal concordante, iniciador, Profile/tenant/rol y Auth persistido. |
| `prepare_notification_delivery(p_event_id uuid, p_operation_id uuid, p_request_json text)` | `jsonb` correspondiente a `NotificationResult<PreparedNotification>`; valida esquema/campos, reautoriza, inserta una sola vez o devuelve sobre previo idéntico. |
| `confirm_notification_sent(p_event_id uuid, p_operation_id uuid, p_provider_message_id text)` | `boolean`; solo lease vigente, pasa a sent y limpia espera/error/lease. Repetición del mismo ACK ya persistido devuelve true; otra operación no sobrescribe. |
| `record_notification_failure(p_event_id uuid, p_operation_id uuid, p_error_code text, p_retry_after_seconds integer default null)` | `text`: pending/failed/lost. Reintentos 60/300 s o fail por destinatario, intento 3 o ventana vencida. |
| `recover_notification_event(p_event_id uuid)` | `text`: pending/failed/unchanged. Solo leases vencidos; invalida token y aplica presupuesto/backoff. |
| `claim_notification_alert(p_event_id uuid)` | `jsonb` o null; lease de reporte independiente, no incrementa intentos de email. |
| `confirm_notification_alert(p_event_id uuid, p_operation_id uuid)` | `boolean`; marca reporte aceptado y limpia lease de alerta. |
| `retry_notification_alert(p_event_id uuid, p_operation_id uuid)` | `boolean`; limpia lease de alerta, programa siguiente intento de reporte en 60 s. |

- [ ] **1. Escribir pruebas rojas SQL y de política.** Afirmar `anon/authenticated` sin SELECT/INSERT/UPDATE ni EXECUTE; FK cross-tenant falla; claim exclusivo y no debido retorna 0; `attempt_count <= 3`; token obsoleto retorna false/lost sin cambiar filas; sobre y clave no mutan; estado sent limpia lease; claim deshabilitado no toca filas. Policy debe clasificar ambas migraciones como `s2_11`, excluirlas en `s2_08b` y seguir rechazando nombres no registrados.
- [ ] **2. Ejecutar rojo.** `pnpm exec vitest run tests/unit/analysis-upgrade-policy.test.ts`; `pnpm exec supabase test db --local supabase/tests/database/s2_11_notifications.test.sql`. Esperar fallo concreto por stage/objetos aún inexistentes, con stack local disponible; un error de conexión no demuestra rojo.
- [ ] **3. Crear la migración y registrar inventario.** Añadir `operation_id`, `lease_expires_at` y checks de pareja/terminal a la outbox. Crear `private.notification_deliveries` con PK/FK `event_id` (`ON DELETE CASCADE` para el cleanup ya existente), sobre nullable hasta preparar, `request_json` text acotado a 16 KiB, `idempotency_key`, `first_submission_at`, `provider_message_id`, `sent_operation_id`, `failure_reported_at`, `alert_operation_id`, `alert_lease_expires_at`, `alert_next_attempt_at`. El primer claim crea su fila privada mínima; la preparación fija sobre/first_submission_at. `sent_operation_id` permite reconocer el ACK repetido después de limpiar el lease público. `claim_notification_alert` inicializa metadata ausente de un failed histórico sin inventar un envío. Crear `private.notification_dispatch_settings` singleton con `enabled=false`; habilitar RLS y negar acceso a usuarios, concediendo solo permisos técnicos necesarios. Crear índices pending/due y failed/no reportado sin escanear todo el histórico. RPC de lease de reporte deben recuperar también su lease vencido.
- [ ] **4. Implementar contexto desde datos persistidos.** Unir `auth.users` solo dentro de funciones privilegiadas: `id/email/banned_until/deleted_at` fueron comprobados en el stack local. Exigir rol Admin/QA Lead, emails de Auth/Profile no vacíos y concordantes tras trim/lower, no banned vigente y no soft-deleted. Obtener email canónico de Auth sin conceder lectura de Auth al navegador. Zod en el adaptador valida formato; no exigir confirmación de email nueva. `prepare` revalida y compara el to congelado antes de devolver un retry. Un fallo definitivo retorna `RECIPIENT_UNAVAILABLE`; una excepción DB permanece `INTERNAL_ERROR`. No se necesita consultar Auth admin por red en cada intento.
- [ ] **5. Preservar historia en CI.** Añadir `s2_11` al stage order/unión de tipos e inventario por nombres exactos. En la rama notification del hash S2-01 excluir solo `operation_id` y `lease_expires_at`, sin retirar filas ni columnas históricas. La migración no habilita dispatch ni modifica estado/contenido de eventos existentes. Añadir prueba al inventario de exclusiones del hash para detectar futuras omisiones.
- [ ] **6. Aplicar solo local y regenerar tipos.** `pnpm exec supabase migration up --local`. Generar mediante el CLI instalado (`gen types typescript --local --schema public`) y escribir salida UTF-8 completa a `src/types/database.ts`, siguiendo `scripts/check-database-types.mjs` y sin merges manuales. Ejecutar `pnpm check:database-types`, la suite SQL anterior y `node scripts/with-local-supabase.mjs integration tests/integration/notifications-leases.test.ts`. En integración usar dos `LocalSqlSession` y targeted claims del fixture: 1 ganador, 1 token; después de expirar, token antiguo no confirma y no aparece intento 4. Esperado PASS y datos previos intactos.
- [ ] **7. Revisar entrega y punto de commit.** Revisar únicamente paths de esta tarea; mensaje propuesto `feat(notifications): add fenced terminal delivery outbox`. No incluir cambios previos ni documentos en un commit de implementación sin autorización.

## Task 2: Plantillas mínimas y cliente Resend sin retries ocultos

**Files:** crear `src/modules/notifications/{types,config,templates,resend}.ts`, `tests/unit/notifications-templates.test.ts`, `notifications-resend.test.ts`.

**Interfaces:** consume `NotificationContext` y produce `renderTerminalNotification(context: NotificationContext, config: {from: string; appOrigin: string}): NotificationBody`; `createResendSender(options: {apiKey: string; fetchFn?: typeof fetch; timeoutMs?: number}): (prepared: PreparedNotification) => Promise<SendNotificationResult>`. `readNotificationsConfig(read: (name: string) => string | undefined)` retorna configuración validada o error de readiness, sin leer process.env en el núcleo Deno.

- [ ] **1. Escribir pruebas rojas con copy exacto.**

```ts
expect(completed.subject).toBe("Your analysis is complete");
expect(failed.subject).toBe("Your analysis could not be completed");
expect(completed.to).toEqual([context.recipientEmail]);
expect(completed.text).toContain(`/login?analysisId=${context.analysisId}`);
expect(completed.text).toContain("Completed at");
expect(failed.text).toContain("Failed at");
expect(JSON.stringify(completed)).not.toMatch(/DOCUMENT_SENTINEL|SNAPSHOT_SENTINEL|PROMPT_SENTINEL/);
expect(fetchFn).toHaveBeenCalledTimes(1); // una petición por llamada, incluso 429/500
expect(request.headers["Idempotency-Key"]).toBe(`kdm-terminal/${context.eventId}/v1`);
expect(request.body).toBe(prepared.requestJson); // no serializar de nuevo
```

- [ ] **2. Verificar rojo.** `pnpm exec vitest run tests/unit/notifications-templates.test.ts tests/unit/notifications-resend.test.ts`; fallo por exports pendientes.
- [ ] **3. Implementar render/config.** Copy exacto del diseño §4, HTML con texto fijo y valores escapados; UTC de `finishedAt`, origen sin credenciales/ruta/query/hash, HTTPS alojado o loopback de prueba explícito. El sender acordado se configura y valida; sin fallback de credenciales de Auth. Deshabilitado por defecto, token mínimo 32 sin whitespace. Los reintentos conservarán el sobre anterior aunque cambie esta configuración.
- [ ] **4. Implementar cliente.** Host fijo, Bearer, Content-Type, request exacto, timeout total 10 s incluyendo stream, límite 65536 bytes por Content-Length y lectura real, rechazo de redirects y parsing acotado. ID de éxito UUID válido. Mapear fallos sin usar `error.message` externo. `Retry-After` admite segundos enteros no negativos o fecha HTTP válida; normalizar a 0..3600 s, ignorar inválidos; el backoff mínimo y deadline se aplican en DB/worker.
- [ ] **5. Verificar casos de fallo y límites.** Ampliar pruebas con body sin Content-Length, stream lento, timeout tras headers, 2xx sin ID, JSON inválido, 401/429/500, clave vacía y token/config incorrectos. Usar timeout inyectado y fake timers, sin esperas de 10 s ni red real. Capturar logs y comprobar ausencia de API keys/emails/body. Repetir comando del paso 2: PASS.
- [ ] **6. Punto de commit.** `feat(notifications): render minimal terminal emails and call Resend` con paths explícitos si se autoriza.

## Task 3: Adaptador DB y coordinación recuperable de entrega

**Files:** crear `src/modules/notifications/{store,dispatch}.ts`, `tests/unit/notifications-dispatch.test.ts`, `notifications-store.test.ts`.

**Interfaces:** `createNotificationStore(db: SupabaseClient<Database>): NotificationStore`. El tipo usa import type y no introduce imports Node. El store expone `listCandidates(limit: number)`, `claim(eventId: string)`, `context(lease)`, `prepare(lease, body)`, `sent(lease, providerMessageId)`, `failed(lease, code, retryAfterSeconds?)`, `recover(eventId)`, `listAlerts(limit: number)`, `claimAlert(eventId)`, `alertSent(alert)`, `alertFailed(alert)` con resultados `NotificationResult` y RPC de tarea 1. Métodos pendientes/alertas escanean solo metadatos service role; ningún SELECT del sobre privado por navegador.

`runNotificationDispatch(deps: {store: NotificationStore; send: (prepared: PreparedNotification) => Promise<SendNotificationResult>; report: (alert: NotificationAlertLease) => Promise<boolean>; config: {from: string; appOrigin: string}; monotonicNow: () => number; utcNow: () => number}): Promise<{claimed: number; sent: number; failed: number; reported: number}>`.

- [ ] **1. Escribir pruebas rojas del flujo.** Claims simultáneos no duplican llamadas; excepción DB no se interpreta como lista vacía; destinatario inválido nunca llama `send`; la preparación precede a HTTP; `send` recibe sobre previo aunque config cambie; no se consulta contenido del documento ni se invoca contabilidad. Afirmar límites: `claimed <= 5`, máximo 2 envíos activos y ningún claim nuevo después de quedar menos de 28 s del presupuesto 45 s. Cinco alertas con Sentry inaccesible no deben impedir para siempre los nuevos avisos de correo.
- [ ] **2. Verificar rojo.** `pnpm exec vitest run tests/unit/notifications-dispatch.test.ts tests/unit/notifications-store.test.ts`.
- [ ] **3. Implementar store y consultas.** Cada request DB tiene timeout 3 s; traducir errores a códigos controlados. Ordenar candidatos por `created_at,id`, incluir pendientes sin lease debidos y expirados para recuperar. `claim(p_event_id)` es la única reserva: la lista no autoriza enviar. La lista de alertas incluye failed no reportados cuyo backoff/lease lo permita. No usar reloj del navegador ni aceptar filtros desde el HTTP público.
- [ ] **4. Implementar coordinador.** Recuperar leases expirados antes de intentar reclamarlos; manejar hasta 5 unidades de trabajo total por ejecución entre recuperación/alertas/entrega. Procesar como máximo 2 alertas debidas primero y reservar las unidades restantes a correo/recuperación para evitar inanición si Sentry no responde. Consultar contexto, validar email por Zod, renderizar candidato y preparar/recuperar sobre; reconsultar contexto inmediatamente antes del HTTP para detectar cambio de permiso/dirección. Validar deadlines `utcNow + 10_000 < min(firstSubmissionAt + 23h, leaseExpiresAt)` y presupuesto; si no queda presupuesto después del claim, liberar/reprogramar mediante el fallo interno controlado, sin HTTP. Fallos permanentes cierran vía RPC; temporales usan backoff. En ACK DB perdido no compensar con otra key ni marcar enviado en memoria como prueba persistida.
- [ ] **5. Fijar pruebas de tiempo/recuperación.**

```ts
expect(delaysAfterFailures).toEqual([60, 300]);
expect(store.sent).not.toHaveBeenCalled(); // respuesta aceptada pero ACK DB perdido
expect(retryPrepared.requestJson).toBe(firstPrepared.requestJson);
expect(retryPrepared.idempotencyKey).toBe(firstPrepared.idempotencyKey);
expect(send).not.toHaveBeenCalled(); // ventana 23h o lease insuficientes
expect(store.alertSent).not.toHaveBeenCalled(); // report() false
```

Probar horario UTC de fecha terminal, `Retry-After=3600` sin extender ventana de 23 h, relogin irrelevante, cambio de email/rol tras preparar, excepción de `report` y cancelación por presupuesto. Repetir comando del paso 2: PASS. No introducir sleeps ni repetir test suites ajenas a esta tarea todavía.
- [ ] **6. Punto de commit.** `feat(notifications): dispatch terminal events with recoverable retries` si se autoriza.

## Task 4: Sentry oficial Deno y filtro de envelope compartido

**Files:** crear `src/lib/observability/safe-envelope.ts`, `src/modules/notifications/telemetry.ts`, `supabase/functions/dispatch-notifications/sentry.ts`, `tests/unit/notifications-telemetry.test.ts`, `tests/edge/notifications-sentry.test.ts`; modificar `safe-event.ts`, `safe-transport.ts`, sus pruebas y crear `supabase/functions/dispatch-notifications/deno.json`.

**Interfaces:** `sanitizeSafeEnvelope(envelope: unknown, context: TelemetryContext): SafeEnvelope | null` extrae solo el algoritmo puro existente de `safe-transport.ts`; wrapper Next conserva `installSafeTransport/wrapSafeTransport`. El core importa `safe-event.ts` con extensión `.ts`, sin `@sentry/nextjs`. `createNotificationReporter(sdk: NotificationSentrySdk, context: TelemetryContext): (alert: NotificationAlertLease) => Promise<boolean>`. `initNotificationsSentry(config, transportOverride?)` en el adaptador Deno carga el SDK oficial y devuelve ese reporter; override exclusivamente inyectado por tests, no por env/request.

- [ ] **1. Escribir pruebas rojas.** Notifications debe sobrevivir al filtro con sus códigos, pero nunca email/URL/body/Authorization. Los envelopes con anexos/session/span/log/request/exception/trace solo entregan el evento reconstruido. Añadir comprobación `report === false` cuando `flush` true pero transporte 429/500, envelope descartado o timeout; `true` exige status 2xx observado para el event ID estable.
- [ ] **2. Verificar rojo.** `pnpm exec vitest run tests/unit/notifications-telemetry.test.ts tests/unit/safe-event.test.ts tests/unit/safe-transport.test.ts`.
- [ ] **3. Implementar catálogo y extracción mínima.** Añadir `notifications: [dispatch,deliver,recover,alert]`, códigos controlados del diseño; preservar filtros de módulos previos. `event_id = eventId.replaceAll("-", "")`, correlation ID UUID de evento y attempt ID del reporte. El filtro reconstruye la whitelist; un retorno sintético por descarte no cuenta como aceptación de Sentry.
- [ ] **4. Conectar SDK Deno.** Fijar `npm:@sentry/deno@10.75.0`, verificado disponible en npm, y Supabase JS `2.117.2`/Zod `4.6.5` en el grafo/import map. No añadir ni actualizar el SDK raíz Next/Node. Usar `init/captureEvent/getClient/flush` sin instrumentación automática ni hook `/import`; integraciones, PII, requests, logs, breadcrumbs, sessions y traces desactivados. Envolver el transporte oficial con `sanitizeSafeEnvelope`, registrar status por event ID y limitar flush/reporte a 2 s. El reporter devuelve false si no hay aceptación explícita. El runner no marca `failure_reported_at` al crear un event ID.
- [ ] **5. Verificar SDK real sin red externa.** El test Edge usa el SDK oficial, transporte en memoria inyectado y declaraciones locales mínimas de Deno para no ampliar tsconfig; imports npm siguen el mecanismo Deno ya usado por `analyze`. Ejecutar `pnpm dlx deno@2.9.6 test --allow-env tests/edge/notifications-sentry.test.ts`: SDK produce envelope real, filtro elimina sentinelas y no se conceden permisos de red al test. Esta versión de runner fue consultada en npm; no sustituye probar el bundle en el runtime real de Supabase en tarea 5. Repetir Vitest del paso 2: PASS.
- [ ] **6. Punto de commit.** `feat(notifications): report terminal delivery failures safely from Edge` si se autoriza.

## Task 5: Handler Edge, scheduler apagado y contrato técnico

**Files:** crear `supabase/functions/dispatch-notifications/index.ts`, migración `20261101190100_s2_11_notification_scheduler.sql`, `supabase/tests/database/s2_11_notification_scheduler.test.sql`, `tests/unit/notifications-handler.test.ts`, `notifications-deno-imports.test.ts`, `docs/contracts/S2-11-notification-dispatch.md`; modificar `supabase/config.toml`, política de stages y sus pruebas. El contrato documental se revisa junto al código, conservando autorización separada para commits de docs.

**Interfaces:** `handleNotificationRequest(request: Request, env: NotificationHandlerEnv, deps: NotificationHandlerDeps): Promise<Response>`; deps son las definidas arriba, incluida lectura de readiness DB. Produce solo `202 {accepted:true}`, 400/401/405/503 controlados. `public.configure_notifications_dispatch(p_enabled boolean) returns void`, invocable solo por `service_role`, usa `private.invoke_notifications_dispatch() returns bigint` invocable por postgres. No parámetros de destinatario/tenant.

- [ ] **1. Escribir pruebas rojas del contrato.** Sin token/correcta configuración no hay query ni claim; Bearer incorrecto 401, método 405, JSON ajeno a `{}` y body >1024 bytes 400, disabled o dependencia sin preparar 503. Request correcto devuelve 202 y registra promesa en waitUntil, sin afirmar sent. El primer resultado de envío no afecta el ACK del disparador.
- [ ] **2. Ejecutar rojo.** `pnpm exec vitest run tests/unit/notifications-handler.test.ts tests/unit/notifications-deno-imports.test.ts tests/unit/analysis-upgrade-policy.test.ts`; prueba SQL scheduler debe fallar por función inexistente.
- [ ] **3. Componer handler y bundle.** Autenticar antes de DB. Readiness comprueba flag runtime, configuración privada/origen, reporter real habilitado y control DB enabled; si falta algo no consume intentos. Declarar `[functions.dispatch-notifications] verify_jwt=false`, mantener secciones previas. Imports relativos `.ts` y cero Node/Next/server-only en el grafo. No añadir un modo fake seleccionable en remoto ni endpoints diagnósticos públicos; pruebas acceden a exports con DI.
- [ ] **4. Implementar scheduler y desactivación.** Vault `notifications_function_url` y `notifications_internal_token`; validar token mínimo 32 sin whitespace y URL exacta `/functions/v1/dispatch-notifications` en host Supabase o dos aliases Docker admitidos. Activación valida secretos, habilita control DB y programa un único `kdm-notifications-dispatch` con `* * * * *`; desactivación cambia control a false y quita el job en una transacción. Claims bloquean el control compartido durante su transacción: un disable confirmado impide nuevos claims, sin intentar retirar HTTP ya emitido. No modificar cron de análisis. Instalación deja control false y no crea el job.
- [ ] **5. Registrar función en etapas.** `functionStage` asigna `supabase/functions/dispatch-notifications/` a `s2_11`. Afirmar omisión de config de notificaciones antes de S2-11, inclusión en S2-11 y rechazo de funciones desconocidas. Actualizar el test existente que esperaba config completa en `s2_06`: debe continuar incluyendo analyze pero no el nuevo dispatcher. No ampliar allowlists de forma global.
- [ ] **6. Verificar integración técnica.** Aplicar solo segunda migración local (`pnpm exec supabase migration up --local`), regenerar tipos y ejecutar `pnpm check:database-types`, unitarias del paso 2, SQL scheduler y test Edge de tarea 4. En un entorno de pruebas aislado servir el bundle con `pnpm exec supabase functions serve dispatch-notifications --env-file <archivo-local-ignorado>`; comprobar carga real y rechazo de request sin token con `NOTIFICATIONS_ENABLED=0`, sin claims ni correo. No iniciar otro servidor si el Edge compartido ya usa el puerto: emplear su mecanismo actual de carga o un stack de prueba aislado. No reiniciar silenciosamente tus procesos de análisis/ingesta.
- [ ] **7. Punto de commit.** `feat(notifications): add authenticated Edge dispatch and one-minute scheduling` si se autoriza.

## Task 6: Continuidad del enlace después del login

**Files:** crear `src/modules/identity/analysis-continuation.ts`, `tests/unit/analysis-continuation.test.ts`, `tests/e2e/notifications-link.spec.ts`; modificar `src/app/(auth)/login/page.tsx`, `src/modules/identity/auth-form.tsx`.

**Interfaces:** `parseAnalysisContinuation(value: string | string[] | undefined): string | null`, `analysisContinuationPath(analysisId: string | null): string | null`; prop opcional `analysisId?: string` en `AuthForm`. No cambiar `login(input: LoginInput)` ni `AuthDestination`.

- [ ] **1. Escribir pruebas rojas.**

```ts
expect(parseAnalysisContinuation(uuid)).toBe(uuid);
expect(parseAnalysisContinuation([uuid, uuid])).toBeNull();
expect(parseAnalysisContinuation("https://example.org")).toBeNull();
expect(parseAnalysisContinuation("//example.org")).toBeNull();
expect(parseAnalysisContinuation("%2Fanalysis%2F" + uuid)).toBeNull();
expect(analysisContinuationPath(uuid)).toBe(`/analysis/${uuid}`);
```

- [ ] **2. Verificar rojo.** `pnpm exec vitest run tests/unit/analysis-continuation.test.ts`.
- [ ] **3. Implementar cambio acotado.** La página recibe `searchParams: Promise<Record<string,string|string[]|undefined>>`, espera la promesa y valida una sola entrada `analysisId`. Con contexto ready redirige al path derivado o `/app`; anonymous recibe formulario con UUID; onboarding sigue su destino existente. El formulario solo sustituye `/app` por el path derivado tras login exitoso; fallo de credenciales conserva parámetro. Sin `useSearchParams`, destinos absolutos ni modificaciones al layout o proxy global.
- [ ] **4. Verificar navegador y regresiones.** Usar fixture local con sesión y sin sesión, completed/failed; login vuelve al UUID exacto, enlace a tenant ajeno/Member/ID inexistente muestra errores controlados sin contenido. Login normal sigue `/app`; onboarding no pierde su prioridad; duplicado query no navega al análisis. Ejecutar unitarias y, con build actual, `node scripts/with-local-supabase.mjs e2e tests/e2e/notifications-link.spec.ts tests/e2e/auth/access.spec.ts tests/e2e/auth/recovery.spec.ts --project=chromium`. Esperado PASS; comprobar que Playwright no reutiliza un servidor con build viejo antes de interpretar el resultado.
- [ ] **5. Punto de commit.** `feat(identity): preserve analysis destination from notification login` si se autoriza.

## Task 7: Pruebas integradas de crash, idempotencia y aislamiento

**Files:** crear `tests/support/notification-fixtures.ts`, `tests/integration/notifications-delivery.test.ts`, `notifications-concurrency.test.ts`, `notifications-isolation.test.ts`. Reutilizar `tests/support/analysis-fixtures.ts`, `local-sql-session.ts` y `local-supabase.ts`; cambiar cleanup existente solo si la evidencia lo requiere, preservando su ownership.

**Interfaces:** `createNotificationFixture({status: "completed" | "failed", withLedger?: boolean})` devuelve AnalysisFixture más `eventId`, `snapshot(): Promise<unknown>` y `store: NotificationStore` de prueba. El store usa adaptador real para todos los RPC; únicamente `listCandidates/listAlerts` limitan resultados a los UUIDs de ese fixture desde código de test. El handler real no recibe esos filtros ni dispone de un override de email. Las pruebas SQL unitransacción habilitan el control dentro del rollback; las pruebas concurrentes requieren antes control deshabilitado y ausencia de job/leases activos, lo habilitan temporalmente y lo restauran en finally. Si ya está activo, rechazar ese entorno y usar uno aislado; no desactivar un dispatcher del usuario.

- [ ] **1. Crear pruebas rojas de fallos inyectados.** Casos nombrados: `replays_same_request_after_lost_response`, `stale_lease_cannot_ack`, `third_attempt_crash_never_sends_fourth`, `retries_use_persisted_sender_origin_template`, `email_role_or_tenant_change_prevents_send`, `late_recovery_after_23h_does_not_resend`, `unrelated_pending_event_is_untouched`, `email_failure_preserves_analysis_findings_ledger`, `sentry_failure_is_recovered_without_email_retry`.
- [ ] **2. Ejecutar los casos antes de completar los fixtures.** `node scripts/with-local-supabase.mjs integration tests/integration/notifications-delivery.test.ts tests/integration/notifications-concurrency.test.ts tests/integration/notifications-isolation.test.ts`. Registrar qué falla por soporte pendiente y qué comportamiento ya pasa gracias a tareas anteriores. Los seams de test reproducen la respuesta perdida/crash; no cambiar ni revertir producto o archivos ajenos para fabricar un rojo.
- [ ] **3. Implementar fixtures con cleanup seguro y fake HTTP.** Cada test crea su tenant/datos sintéticos. Un Resend fake con registro por idempotency key devuelve el mismo ID al repetir payload; body distinto con misma key falla. Capturar response perdida después de registrar aceptación para distinguir 2 peticiones de 1 entrega lógica. No usar direcciones reales ni API keys de Resend. Persistencia y funciones terminales son reales en el stack local.
- [ ] **4. Verificar productor real.** Añadir caso que ejecute finalización real de S2-08 sobre un análisis preparado con APIs y fake IA existentes y luego consuma su evento con dispatcher real/fake Resend. Cubrir completed y failed terminal, cero findings y destinatario persistido. No cambiar `analysis/worker/finalization.ts` ni sus pruebas sucias para ocultar problemas; un fallo de la base se informa y se concilia antes de continuar.
- [ ] **5. Afirmar efectos y concurrencia.** Dos sesiones compiten por el mismo evento; solo un claim. Cambiar timestamps exclusivamente de fixtures para simular lease/backoff/ventana, sin esperas de minutos. Comparar snapshots completos de estado/ledger/findings y del centinela ajeno; no hay otra reserva/consumo/liberación, ni alteración de backlog no incluido. `attempt_count===3` tras tercer crash, `sentCalls<=3`, una entrega fake lógica y estado final coherente/resultado incierto documentado.
- [ ] **6. Ejecutar verde y limpiar.** Repetir comando del paso 2; esperar todas PASS y ninguna skipped. Validar cleanup de la relación privada mediante FK cascade y preservar datos originales. Si hay otro despachador real activo, no ejecutar hasta disponer de aislamiento: no detenerlo ni consumir cola global para acomodar tests.
- [ ] **7. Punto de commit.** `test(notifications): cover crash recovery isolation and accounting invariants` si se autoriza.

## Task 8: Quality gates, runbook y aceptación real separada

**Files:** crear `docs/testing/s2-11-notifications-runbook.md`, `docs/testing/s2-11-notifications-acceptance.md`; modificar `.github/workflows/s1-01.yml` únicamente para ejecutar el test Deno sin red de tarea 4. Las suites unit/SQL/integración/E2E ya se descubren por los comandos existentes; no duplicar jobs ni renombrar el workflow.

**Interfaces:** consume todas las entregas y produce evidencia con entorno, HEAD, estado dirty, fecha, comando, código de salida, correlaciones y límites. La recepción real no es automatizable solo con un HTTP accepted; el operador verifica su buzón controlado.

- [ ] **1. Documentar preparación y no activación por defecto.** Runbook con requisitos, configuración por nombre, almacenamiento privado, dominio/from acordado, clave Resend sending-only restringida al dominio, APP_ORIGIN y tracking desactivado. Separar flags/credenciales locales de alojadas, no cambiar SMTP de recovery ni poner emails de override. Sentry Edge usa `SENTRY_DSN`, `NOTIFICATIONS_ENVIRONMENT` (`development|vercel-preview|vercel-production`), `NOTIFICATIONS_RELEASE_SHA` (40 hex; `-dirty` solo development) y killswitch existente. Tests usan reporter inyectado; la habilitación real exige reporter preparado.
- [ ] **2. Añadir gate Deno y verificar todo el candidato.** En CI correr `pnpm dlx deno@2.9.6 test --allow-env tests/edge/notifications-sentry.test.ts` sin secretos del proveedor/Sentry. Mantener el reset ya existente solo del stack descartable de CI. En ejecución local correr una vez `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`, `pnpm test:db`, `pnpm check:database-types`, `pnpm test:fixtures`, `pnpm test:integration`, `node scripts/with-local-supabase.mjs build`, `node scripts/with-local-supabase.mjs e2e --project=chromium` y `git diff --check`, una vez estabilizados cambios. Esperado salida 0 y cero skipped nuevos. Si falla algo, corregir causa y repetir solo gates afectados.
- [ ] **3. Verificar upgrade sin tocar el stack personal.** `node scripts/check-analysis-upgrade.mjs` requiere ausencia del proyecto Supabase que protege su preflight; hoy puede estar ocupado por el stack local del usuario. Ejecutarlo en entorno descartable/CI como ya está diseñado; no parar ni resetear ese stack para obtener verde. Comprobar preservación del hash histórico y nueva política por unitarias locales; registrar upgrade real pendiente si el entorno no está disponible. No afirmar CI remoto sin haber ejecutado y observado el candidato allí; push/PR no forman parte de esta autorización.
- [ ] **4. Preparar recepción real revisable.** Elegir usuario local de prueba cuyo email Auth/Profile pertenezca al operador y confirmar IDs de los dos análisis/eventos. Crear completed y failed usando finalización real y datos sintéticos; el análisis fallido puede usar controles fake locales de IA existentes sin romper claves reales. Inventariar backlog solo por IDs/tipos/fechas/estados y comprobar que todos los eventos que se activarían tienen destinatarios autorizados para la prueba. Si no, usar stack aislado: no omitir eventos ni reescribir su destino para hacer pasar la demo.
- [ ] **5. Ejecutar envío solo dentro del alcance autorizado de ejecución.** Una vez disponibles configuración privada y buzón controlado, habilitar runtime y `configure_notifications_dispatch(true)` en el entorno de prueba elegido. Esperar la revisión de cron, comprobar control/job/lease y recibir ambos mensajes. Revisar asunto, fecha original, contenido mínimo, enlace, login y UUID destino. Guardar evidencia redactada y metadata; no body privado, claves ni direcciones en artefactos. Si el usuario no autorizó todavía estos envíos/activación, presentar la configuración y los dos eventos concretos para esa autorización final; no confundir aprobar el plan con autorizar configuración remota o envío externo.
- [ ] **6. Ejecutar prueba Sentry real separada.** En entorno local aislado usar el SDK Deno oficial y transporte Sentry real con un agotamiento de Resend fake, nunca un correo dirigido a terceros. Comprobar HTTP de ingestión, correlation/event ID, environment/release y ausencia de sentinelas en el transporte final; consultar recepción en Sentry para cerrar. No usar `scripts/with-local-supabase.mjs` para este smoke sin adaptación explícita: elimina DSN y desactiva Sentry. El runbook prescribe ejecución directa con el archivo local ignorado de configuración, sin volcarlo. Desactivar cron y flag al terminar una prueba temporal; dejar estado operativo que el usuario haya pedido expresamente.
- [ ] **7. Registrar cierre por nivel.** Marcar unit/SQL/integración/runtime Edge/browser/Resend inbox/Sentry real/remoto con evidencia propia. Si faltan claves, permisos, buzón, runtime o recepción, registrar pendiente y causa exacta; no skip ni sustitución por 202. Dejar aceptación integral IA/corpus/fallback en S2-12. Revisar `git status --short` y diff de paths para demostrar que cambios ajenos y secretos quedaron intactos.
- [ ] **8. Punto de integración final.** Si se autoriza, separar commit de workflow/pruebas de commits documentales y revisar staged paths. Sin commit/push/merge/despliegue implícitos. Entregar estado real y limitaciones de la rama para decidir integración.

## Revisión del plan y trazabilidad

Autorrevisión requerida por writing-plans, sin delegación: diseño §§1–3 → alcance y restricciones; §4 → tareas 2/6; §§5–8 → tareas 1/3/5/7; §9 → tarea 2; §10 → tarea 4; §11 → tareas 5/8; §12 → tareas 7/8; §13 → mapa e interfaces. Los cinco focos de revisión tienen test propietario. SQL/TScript conservan la misma forma de lease, sobre y códigos; ninguna tarea usa un contrato no definido aquí.

Dependencias: 1 y 2 preceden a 3; 4 puede desarrollarse tras 2 y antes de componer 5; 5 necesita 1–4; 6 es independiente del worker pero comparte el enlace fijado en 2; 7 necesita 1–5; 8 integra todo. La secuencia recomendada de ejecución es la numeración para reducir cambios simultáneos de interfaces.

Se recomienda ejecución **Native**: las tareas comparten contratos SQL/worker/telemetría y el checkout tiene cambios locales que deben preservarse. Puede elegirse subagent-driven con handoffs por Interfaces, pero no se lanzan implementadores durante esta planificación. La selección queda pendiente de la revisión del usuario.

Fuentes de sintaxis: documentación local de Next.js `page.md`/`redirect.md`; [Sentry Deno](https://docs.sentry.io/platforms/javascript/guides/deno) y [transports](https://docs.sentry.io/platforms/javascript/configuration/transports), consultados mediante Context7; `npm view @sentry/deno@10.75.0` y `npm view deno version` comprobaron disponibilidad (2026-11-01). Esto verifica documentación/metadatos, no compatibilidad runtime: tareas 4 y 5 contienen esa prueba. Para Resend/Supabase se conservan las fuentes de la especificación aprobada.
