# S1-08 — Safe Observability and Quality Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Registrar fallos seguros y verificables en local/Preview/Production y publicar en Vercel únicamente commits que hayan aprobado los controles de Sprint 1.

**Architecture:** Extender la política compartida de Sentry y las fronteras existentes del monolito modular. GitHub Actions será el único disparador automático de publicación; las suites usan Supabase local y el despliegue usa configuración del destino. La recepción real en Sentry constituye una aceptación posterior al despliegue, separada del gate previo.

**Tech Stack:** Next.js 16.3.5, React 19.2.8, TypeScript, Sentry SDK instalado 10.75.0, Supabase, Vitest, Playwright, GitHub Actions, Vercel CLI 62.2.0, Node 24.11.0 y pnpm 12.5.1.

**Spec:** [Diseño S1-08 aprobado](../specs/2026-10-04-s1-08-safe-observability-quality-gates-design.md).

Estado: ejecución inline. Tasks 1–4 completas; Task 5 implementada con aceptación local parcial porque el stack personal no se puede resetear y las pruebas restantes exigen un runner limpio en el puerto esperado; Task 6 implementada y validada con pruebas locales; Task 7 tiene inventario remoto de solo lectura parcial, sin cambios de configuración; Task 8 tiene handoff de ingesta preparado, con recepción real de Sentry pendiente. No hay commit, push ni evento remoto. Evidencia en `.superpowers/sdd/2026-10-04-s1-08-safe-observability-quality-gates/progress.md`.

## Global Constraints

- Se conserva pnpm 12.5.1, el lockfile y las suites existentes.
- Local permanece sin envío real por defecto.
- El filtro final reconstruye un evento nuevo con campos validados.
- Los errores de producto y la referencia de soporte están en inglés.
- El fallo de telemetría nunca transforma una operación exitosa en error ni encubre el fallo de negocio original.
- `NODE_ENV` no distingue Preview de Production: ambos pueden ejecutar builds de producción.
- Los PR ejecutan migraciones en local; no aplican automáticamente migraciones al backend compartido, no usan `--linked` para pruebas y nunca le aplican seed/reset.
- No se ejecuta código no confiable con secretos mediante `pull_request_target`.
- No se implementan procesamiento S1-04 ni retry S1-07; tampoco se modifica `processing.ts` para aparentar un pipeline real.
- No se crean reglas de correo ni se alteran reglas existentes sin revisar su alcance.
- No cambiar dependencias de producto por conveniencia. La CLI de Vercel se invoca con versión exacta; no se agrega al bundle.
- No hacer commit, push, merge o cambios remotos solo por leer/aprobar este plan. Ejecutar el plan completo incluye el corte operativo descrito; si el usuario limita la ejecución a trabajo local, respetar ese límite. Antes del corte deben existir los cambios revisables y sus pruebas locales.

## Review Focus

1. Un resultado perdido después de persistir bootstrap/upload no debe generar un duplicado ni un falso fallo definitivo: tarea 3, pruebas de reconciliación.
2. Adjuntos, sesiones o cabeceras del envelope pueden eludir `beforeSend`: tarea 1, test sobre el transporte final completo.
3. Preview y Production tienen el mismo `NODE_ENV`, y las variables del navegador se fijan al compilar: tarea 2, matriz de configuración y tarea 6, build por destino.
4. Una sesión operadora abierta puede perder rol o superar el vencimiento mientras la pantalla sigue cargada: tarea 4, autorización repetida antes de cada emisión.
5. Un PR obsoleto o un job omitido puede parecer un check válido: tareas 5–7, pruebas de resultado obligatorio, SHA actual y publicación ordenada.

## 0. Lecturas, evidencia y secuencia

Leer la spec, `AGENTS.md`, `docs/architecture/arquitectura-base.md` §§3–6 y el protocolo del Día Cero antes de implementar. Respetar ownership: Dev 1 coordina contratos/configuración/CI; Dev 2 ingesta; Dev 3 Repository. No ejecutar tareas de otros tickets al resolver un test dependiente.

Lecturas de planificación del 2026-10-04:

- Checkout `0d0dd39`; cambios ajenos sin seguimiento en `.agents/`, `.claude/`, `skills-lock.json`, `supabase/snippets/`. Spec y plan también permanecen sin commit.
- GitHub API: repositorio público `JMCoC/knowledge-decay-monitor`, rama predeterminada `main`, permisos administrativos disponibles; `develop` y `main` sin protección. Es fotografía, no permiso para mutar settings.
- CLI Vercel publicada: `62.2.0`, consultada con `npm view vercel version`.
- Guías instaladas: `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md` y `04-functions/unstable_rethrow.md`. Next 16.3.5 no figuraba en las versiones Context7; prevalecen las guías instaladas sobre ejemplos canary.
- Context7 Sentry devuelve también referencias a v11; no adoptar sus cambios de API en el SDK 10.75.0 instalado. Contrastar con declaraciones bajo `node_modules/.pnpm/@sentry+core@10.75.0/` y exports de `@sentry/nextjs`.

Orden: **1 → 2 → 3 → 4 → 5 → 6 → 7 → 8**. Tareas 1–6 producen código verificable localmente; 7 realiza corte operativo; 8 registra aceptación real y handoff. No cambiar settings remotos antes de disponer del gate y el deploy revisables. Cada tarea termina con revisión del diff; commits solo si están autorizados, con lista explícita de archivos.

### Mapa de archivos

| Área | Archivos y responsabilidad |
|---|---|
| Sobre seguro | Nuevos `src/lib/observability/safe-event.ts`, `safe-transport.ts`, `capture.ts`: catálogo, reconstrucción y envío con contrato cerrado. |
| Compatibilidad | `src/lib/observability/auth-events.ts`, `operation-events.ts`: adaptadores de callers actuales, sin dos políticas independientes. |
| Configuración | Nuevo `src/lib/observability/config.ts`; `sentry.server.config.ts`, `sentry.edge.config.ts`, `src/instrumentation-client.ts`, `next.config.ts`: contexto confiable y canales deshabilitados. |
| Fronteras | Nuevo `src/lib/observability/unexpected-error.ts`; `src/instrumentation.ts`, `src/app/global-error.tsx`: fallos inesperados sin request/error crudo. |
| Contratos y UI | `src/types/contracts.ts`, `src/types/contracts.typecheck.ts`, acciones/servicios/formularios de identity/workspace/ingestion/repository; nuevo `src/components/operation-error.tsx`. |
| Diagnóstico | Nuevos `src/lib/observability/diagnostics-policy.ts`, `diagnostics.server.ts`; reemplazar ejemplo por `src/app/sentry-example-page/page.tsx`, `actions.ts`, `diagnostics-panel.tsx`; cerrar el GET existente en `src/app/api/sentry-example-api/route.ts`. |
| Pruebas | Nuevas unitarias de sobre/transporte/configuración/fronteras/diagnóstico/publicación; ampliar privacidad, módulos y E2E existentes. |
| CI | Evolucionar `.github/workflows/s1-01.yml`, conservando ruta para no duplicar workflows; `scripts/with-local-supabase.mjs`, `playwright.config.ts` y `package.json` solo donde cambie el gate. |
| Publicación | Nuevos `vercel.json`, `scripts/deployment-policy.mjs`, `scripts/deploy-vercel.mjs` y `.d.mts` para imports tipados de sus funciones públicas. |
| Operación | Nuevos `docs/testing/s1-08-cutover.md`, `s1-08-acceptance.md`, `s1-08-ingestion-handoff.md`; actualizar referencias obsoletas de entrega S1-01/S1-02 tras validar. |

## Task 1: Un único contrato de telemetría y frontera final de privacidad

**Files:** crear `src/lib/observability/safe-event.ts`, `safe-transport.ts`, `capture.ts`; modificar `auth-events.ts`, `operation-events.ts`; crear `tests/unit/safe-event.test.ts`, `safe-transport.test.ts`; ampliar `tests/unit/auth-privacy.test.ts`, `operation-privacy.test.ts`, `tests/integration/auth-privacy.test.ts`.

**Interfaces:** produce `SafeFailureInput`, `TelemetryContext`, `filterSafeEvent(candidate, context)`, `captureSafeFailure(input): CaptureReceipt`, `wrapSafeTransport(base, context)`. Los adaptadores existentes conservan sus parámetros; pueden pasar de `void` a `CaptureReceipt | undefined` sin obligar a consumidores antiguos a utilizarlo.

- [x] **1.1 Definir contratos cerrados y sus tests RED.** Usar estos tipos en `safe-event.ts`; validar también en runtime (tipado no concede confianza):

```ts
export const operationCatalog = {
  identity: ["register", "login", "logout", "recovery", "password-update", "session"],
  workspace: ["bootstrap", "reconcile", "owners"],
  ingestion: ["reserve", "verify", "resume", "recover", "cleanup", "reconcile", "process", "retry"],
  repository: ["list", "open"],
  application: ["request", "render", "unhandled", "transport", "diagnostic"],
} as const;
export type SafeOperation = {
  [M in keyof typeof operationCatalog]: {
    module: M; operation: typeof operationCatalog[M][number];
  }
}[keyof typeof operationCatalog];
export type SafeFailureInput = SafeOperation & {
  code: "INTERNAL_ERROR" | "PROVIDER_ERROR" | "PROFILE_LOOKUP_FAILED"
    | "SESSION_UNAVAILABLE" | "PROCESSING_FAILED"
    | "PARSING_FAILED" | "CHUNKING_FAILED" | "EMBEDDING_FAILED" | "PERSISTENCE_FAILED";
  correlationId?: string;
  versionId?: string;
  attemptId?: string;
  synthetic?: boolean;
};
export type TelemetryContext = {
  environment: "development" | "vercel-preview" | "vercel-production";
  release: string;
  runtime: "browser" | "server" | "edge";
};
export type CaptureReceipt = { correlationId: string; eventId?: string };
```

Los códigos de etapas solo son válidos para `ingestion/process` o `ingestion/retry`. Validar UUIDs, SHA completo y sufijo `-dirty` solo en local; rechazar combinaciones no catalogadas. La referencia es un UUID nuevo si el caller no aporta la que acaba de generar en su propia frontera.

- [x] **1.2 Añadir una prueba de reconstrucción.** El test define la forma de entrada marcada por `captureSafeFailure` y exige que el entorno proceda del contexto confiable:

```ts
const correlationId = "d2131057-f063-4b12-bafe-746728e8d7ad";
const context = { environment: "vercel-preview", release: "a".repeat(40), runtime: "server" } as const;
const event = filterSafeEvent({
  message: "DOCUMENT_SENTINEL", environment: "attacker", release: "TOKEN_SENTINEL",
  tags: { "kdm.safe": "true", module: "repository", operation: "open",
    code: "INTERNAL_ERROR", correlation_id: correlationId },
  request: { headers: { authorization: "TOKEN_SENTINEL" } },
  exception: { values: [{ value: "DOCUMENT_SENTINEL" }] },
}, context);
expect(event).toMatchObject({ environment: "vercel-preview", release: context.release,
  tags: { module: "repository", operation: "open", correlation_id: correlationId } });
expect(JSON.stringify(event)).not.toMatch(/SENTINEL|attacker|authorization/);
expect(event).not.toHaveProperty("exception");
```

Añadir filas para operación de otro módulo, código esperado `FORBIDDEN`, UUID malformado, `NaN`/infinito en timestamp, event ID no hexadecimal, tipos de evento distintos de error/message y strings no acotados. Rechazar los campos requeridos inválidos; omitir identidad opcional del SDK inválida. No registrar validaciones de telemetría como otro evento.

- [x] **1.3 Ejecutar RED:** `pnpm test:unit tests/unit/safe-event.test.ts`. Debe fallar por contrato ausente o reconstrucción incorrecta, no por infraestructura.
- [x] **1.4 Implementar reconstrucción sin copiar objetos originales.** Mensaje fijo `Product operation failed`; nivel `error`; solo campos de la spec. `filterSafeEvent(candidate: unknown, context: TelemetryContext)` devuelve el evento canónico o `null`. `captureSafeFailure` valida input, genera correlación, usa `Sentry.withScope`/`captureEvent` con tags cerrados y devuelve el receipt aunque el SDK lance. El caller nunca pasa un `Error` al helper.

```ts
// Forma de salida: cada campo se toma de un valor previamente validado.
return {
  message: "Product operation failed", level: "error", platform: "javascript",
  environment: context.environment, release: context.release,
  tags: { module, operation, code, correlation_id: correlationId,
    runtime: context.runtime, synthetic: synthetic ? "true" : "false",
    ...(versionId ? { version_id: versionId } : {}),
    ...(attemptId ? { attempt_id: attemptId } : {}) },
};
```

No copiar `event.sdk`, request, fingerprint libre, exception, contexts, user ni extras. Preservar event ID/timestamp válidos con asignaciones explícitas. `bootstrap` del adaptador Auth se convierte en `workspace/bootstrap`; el resto en identity. El adaptador de operación no convierte denegaciones esperadas en incidencias.

- [x] **1.5 Probar y cerrar el envelope, no solo el evento.** `wrapSafeTransport` consume el `Transport`/`Envelope` exportado por el SDK instalado y conserva `flush`. Solo envía ítems `event` canónicos; elimina adjuntos, sesiones, client reports, logs, spans y headers de tracing. Revalida/reconstruye el payload canónico sin volver a exigir el marcador privado eliminado por el filtro. Es una defensa final pequeña, no un transporte HTTP propio: delega red/reintentos al transporte oficial.

```ts
const sent: unknown[] = [];
const base = { send: vi.fn(async (envelope: unknown) => {
  sent.push(envelope); return { statusCode: 200 };
}), flush: vi.fn(async () => true) };
const transport = wrapSafeTransport(base, context);
await transport.send([
  { trace: { user_id: "ENVELOPE_SENTINEL" } },
  [[{ type: "event" }, event!],
   [{ type: "attachment", filename: "PRIVATE_SENTINEL" }, "BYTES_SENTINEL"],
   [{ type: "session" }, { did: "USER_SENTINEL" }]],
]);
expect(base.send).toHaveBeenCalledOnce();
expect(JSON.stringify(sent)).not.toMatch(/SENTINEL|attachment|session|user_id/);
expect(await transport.flush(2000)).toBe(true);
```

Eliminar envelope vacío sin red y sin recursión. El header conserva únicamente identidad de evento y fecha de envío válidas; no habilitar tunnel que requiera otros headers. Probar que un transporte que rechaza no provoca otro envío recursivo.

- [x] **1.6 Ejecutar GREEN y revisar compatibilidad:** `pnpm test:unit tests/unit/safe-event.test.ts tests/unit/safe-transport.test.ts tests/unit/auth-privacy.test.ts tests/unit/operation-privacy.test.ts`; `pnpm typecheck`. Extender la prueba de SDK real `auth-privacy.test.ts` para pasar por filtro y wrapper antes de su transporte en memoria.

**Salida revisable:** contrato único y ningún byte ajeno al sobre seguro en el transporte de prueba. Commit sugerido, solo autorizado: `feat(observability): enforce safe event and envelope contracts`.

## Task 2: Contexto por entorno y captura de excepciones inesperadas

**Files:** crear `src/lib/observability/config.ts`, `unexpected-error.ts`; modificar tres inicializaciones Sentry, `src/instrumentation.ts`, `src/app/global-error.tsx`, `next.config.ts`; crear `tests/unit/observability-config.test.ts`, `unexpected-error.test.ts`; ampliar runner/config de pruebas para prevalencia del modo test.

**Interfaces:** consume tarea 1; produce `resolveTelemetryConfig(input): { enabled: boolean; context: TelemetryContext | null }`, `captureUnexpectedError(error: unknown, operation: "request" | "render" | "unhandled"): CaptureReceipt | undefined` y configuración por runtime. `captureUnexpectedError` no serializa el argumento.

- [x] **2.1 Escribir RED de configuración.** Entrada `input` es `{ target?: string; release?: string; disabled: boolean; localEnabled: boolean; test: boolean; runtime: TelemetryContext["runtime"] }`. Tests mínimos:

```ts
const base = { release: "a".repeat(40), disabled: false, localEnabled: false, test: false, runtime: "browser" } as const;
expect(resolveTelemetryConfig({ ...base, target: "preview" })).toMatchObject({
  enabled: true, context: { environment: "vercel-preview" },
});
expect(resolveTelemetryConfig({ ...base, target: "production" })).toMatchObject({
  enabled: true, context: { environment: "vercel-production" },
});
expect(resolveTelemetryConfig({ ...base, localEnabled: true, test: true }).enabled).toBe(false);
expect(resolveTelemetryConfig({ ...base, target: "preview", release: "bad" }).enabled).toBe(false);
```

Añadir desarrollo sin opt-in, opt-in local válido, kill switch superior a opt-in, target desconocido, release `-dirty` remoto rechazado. `enabled:false` no llama al transporte. Una configuración de despliegue inválida se detecta antes de publicar en tarea 6; el runtime falla cerrado sin romper el caso de uso.

- [x] **2.2 Ejecutar RED:** `pnpm test:unit tests/unit/observability-config.test.ts`.
- [x] **2.3 Configurar por destino y retirar captura incidental.** Variables públicas nuevas, siempre sin secretos: `NEXT_PUBLIC_KDM_SENTRY_TARGET`, `NEXT_PUBLIC_KDM_RELEASE`, `NEXT_PUBLIC_KDM_SENTRY_LOCAL_ENABLED`. Targets válidos `development|preview|production`; el local sin valor se resuelve a development. Mantener kill switches existentes. Las variables públicas se inyectan antes del build; servidor y navegador usan el mismo contexto público compilado, runtime diferente. DSN existente identifica el proyecto y no sustituye una credencial administrativa.

```ts
// Opciones comunes; unirlas a las opciones dataCollection restrictivas existentes.
const restrictedOptions = {
  attachStacktrace: false, sendDefaultPii: false, sendClientReports: false,
  enableLogs: false, beforeSendLog: () => null,
  tracesSampleRate: 0, maxBreadcrumbs: 0,
  replaysSessionSampleRate: 0, replaysOnErrorSampleRate: 0,
  beforeBreadcrumb: () => null, beforeSendTransaction: () => null,
  defaultIntegrations: false,
};
```

Con `defaultIntegrations:false`, la captura de excepciones se implementa explícitamente en las fronteras siguientes; no asumir que el SDK conservará handlers globales. Usar transporte oficial fetch en browser/edge y Node en servidor, envuelto por tarea 1; imports separados por runtime. Si un export no existe en 10.75.0, verificar sus exports públicos y no importar rutas internas ni actualizar SDK sin motivo.

- [x] **2.4 Añadir RED de fronteras y control del framework.** Mock de `captureSafeFailure`, error con payload secreto, `redirect`/`notFound`, captura repetida del mismo objeto y promesa rechazada con string. En handlers browser, la referencia original se usa solo para deduplicar con `WeakMap` cuando es objeto; no como payload. Llamadas explícitas de negocio siguen siendo responsabilidad de una sola frontera.

```ts
const error = new Error("SECRET_SENTINEL");
captureUnexpectedError(error, "render");
captureUnexpectedError(error, "render");
expect(captureSafeFailure).toHaveBeenCalledTimes(1);
expect(captureSafeFailure).toHaveBeenCalledWith({
  module: "application", operation: "render", code: "INTERNAL_ERROR",
});
```

Separar política framework de captura: mantener `redirect`/`notFound` fuera de catches de proveedor; donde deban coexistir, `unstable_rethrow` va primero. No copiar los ejemplos documentales que envían request/context/error.message. No silenciar cualquier error solo porque tiene una propiedad `digest`.

- [x] **2.5 Implementar los hooks y la UI de emergencia.** En `instrumentation.ts` mantener `register` y añadir:

```ts
import type { Instrumentation } from "next";
export const onRequestError: Instrumentation.onRequestError = async (error) => {
  captureUnexpectedError(error, "request");
  await Sentry.flush(2000).catch(() => false);
};
```

Importar captura/SDK válidos para el runtime sin traer clientes privilegiados al browser. En `instrumentation-client.ts`, registrar `error` y `unhandledrejection` una sola vez, usando únicamente `event.error`/`event.reason` para clasificar/deduplicar en memoria. En `global-error.tsx`, error conocido por el handler reutiliza referencia; error local de render no observado se captura con familia render. La UI muestra mensaje fijo y referencia cuando exista. Un error servidor serializado puede originar un fallo de render cliente distinto: no inventar que sus UUID coinciden ni enviar el digest crudo como correlación.

- [x] **2.6 Ejecutar GREEN:** `pnpm test:unit tests/unit/observability-config.test.ts tests/unit/unexpected-error.test.ts`; `pnpm typecheck`; `pnpm lint`. Confirmar compatibilidad con tests de inicialización existentes y revisar que router tracing y monitores automáticos no habiliten canales excluidos.

**Salida revisable:** contextos explícitos, envío local opt-in y errores inesperados observables sin request crudo. Commit sugerido: `feat(observability): configure environments and safe error boundaries`.

## Task 3: Errores de las operaciones y referencia visible sin éxitos falsos

**Files:** modificar `src/types/contracts.ts`, `contracts.typecheck.ts`; `src/modules/identity/actions.ts`, `auth-form.tsx`, `password-form.tsx`; `src/modules/workspace/actions.ts`, `queries.ts`, `onboarding-form.tsx`; `src/modules/ingestion/actions.ts`, `ui/upload-session.tsx`, `ui/upload-panel.tsx`, `ui/recover-upload-button.tsx`; `src/modules/repository/application/repository.service.ts`, `ui/open-document-button.tsx`; `src/app/(workspace)/repository/page.tsx`; crear `src/components/operation-error.tsx`. Ampliar tests unitarios existentes de esos módulos y `tests/e2e/auth/access.spec.ts`, `tests/e2e/upload.spec.ts`, `tests/e2e/repository.spec.ts`.

**Interfaces:** consume `captureSafeFailure`; produce `ActionError` compartido con referencia opcional. No altera firma funcional de upload/retry ni su persistencia.

- [x] **3.1 Añadir RED de contrato/correlación usando los mocks actuales.** En `workspace-actions.test.ts`, simular error de proveedor en `createClient`; mockear el adaptador/capture para devolver un UUID conocido. Exigir el mismo UUID en resultado y evento; repetir en Auth, reserva por ítem, finalize, list/open y owners. Cubrir `IdentityError("INTERNAL_ERROR")`, hoy susceptible de retornar sin captura.

```ts
const { client } = createClient({ rpcResult: {
  data: null, error: { code: "XX000", message: "DATABASE_SENTINEL" },
} });
mocks.createWritableClient.mockResolvedValue(client);
const result = await createWorkspace({ name: "Workspace", fullName: "Operator" });
expect(result).toMatchObject({ ok: false, error: {
  code: "INTERNAL_ERROR", correlationId: expect.any(String),
} });
expect(JSON.stringify(result)).not.toContain("DATABASE_SENTINEL");
expect(mocks.reportAuthFailure).toHaveBeenCalledTimes(1);
```

Los tests de referencia deben comparar el valor exacto, además del matcher de forma anterior. Denegaciones/validación no llaman al reporter y no incluyen IDs de recursos ajenos. Un fallo de la propia captura deja intacto el resultado controlado.

- [x] **3.2 Ejecutar RED** con `pnpm test:unit tests/unit/workspace-actions.test.ts tests/unit/identity-actions.test.ts tests/unit/ingestion-actions.test.ts src/modules/repository/application/repository.service.test.ts`.
- [x] **3.3 Introducir el tipo y propagar referencias.** Reutilizarlo también en `UploadItemResult`; no duplicar formas divergentes:

```ts
export type ActionError = {
  code: ActionErrorCode;
  message: string;
  correlationId?: string;
};
export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: ActionError };
```

En cada catch inesperado generar una referencia única, pasarla al helper seguro y devolverla. Mantener mensajes actuales controlados. Donde un helper de identidad devuelve `INTERNAL_ERROR`, permitir que la frontera responsable lo registre antes de retornar. No registrar errores esperados ni emitir en helper y caller a la vez. Datos opcionales `versionId/attemptId` solo después de autorización de ese recurso.

- [x] **3.4 Mostrar el error sin revelar campos adicionales.** Componente de presentación sin SDK ni dependencias de servidor:

```tsx
export function OperationError({ error }: { error: ActionError }) {
  return <div role="alert"><p>{error.message}</p>
    {error.correlationId ? <p>Reference: {error.correlationId}</p> : null}
  </div>;
}
```

Los formularios guardan `ActionError | null` en vez de perder la referencia al copiar solo message. Los catches cliente usan `application/transport` y texto `We couldn't confirm the operation. Refresh and try again.` cuando el resultado puede ser incierto. Preservar los mensajes de validación y los estados existentes, sin rediseñar formularios.

- [x] **3.5 Añadir regresiones de respuesta perdida.** Ampliar los tests actuales de `reconcileUncertainBootstrap` y `runUploadBatch`: persistencia exitosa seguida de fallo de transporte, reconciliación que confirma, reconciliación que falla, ausencia de segunda reserva y error por ítem que no invalida otros ítems aprobados. La UI no muestra `ready` por confirmar upload. En Playwright abortar una respuesta de acción o transferencia y comprobar el estado controlado, usando los escenarios reales ya existentes, sin inyectores de fallo de negocio en Production.

```ts
// Añadir al caso actual de reconciliación de bootstrap con perfil persistido.
expect(result).toEqual({ ok: true, data: { workspaceId: "workspace-1" } });
expect(rpc).toHaveBeenCalledTimes(1);
expect(mocks.reportAuthFailure).not.toHaveBeenCalled();
```

Para resultado incierto sin reconciliación, exigir `ok:false`, mensaje de confirmación pendiente y ninguna navegación al estado de éxito. Mantener tests de privacidad de `getOriginalUrl`: errores nunca contienen la URL ni el path.

- [x] **3.6 Ejecutar GREEN** de los archivos anteriores, `tests/unit/upload-session.test.ts`, `workspace-queries.test.ts`, `workspace-owners.test.ts`; después `pnpm typecheck` y `pnpm lint`. E2E completo se ejecuta en tarea 5 con stack preparado.

**Salida revisable:** todas las fronteras disponibles devuelven/capturan el mismo error controlado y preservan reconciliación. Commit sugerido: `feat(errors): expose safe support references across operations`.

## Task 4: Diagnóstico temporal autorizado y local opt-in

**Files:** crear `src/lib/observability/diagnostics-policy.ts`, `diagnostics.server.ts`, `src/app/sentry-example-page/actions.ts`, `diagnostics-panel.tsx`; reemplazar `page.tsx` de ejemplo; modificar `src/app/api/sentry-example-api/route.ts`; crear `tests/unit/diagnostics-policy.test.ts`, `diagnostics-actions.test.ts`, `tests/e2e/observability.spec.ts`; crear `scripts/sentry-local-smoke.mjs` y su test `tests/unit/sentry-local-smoke.test.ts`.

**Interfaces:** `canRunDiagnostics(actor: Actor, config: DiagnosticPolicy, nowMs: number): boolean`; `authorizeDiagnostics(): Promise<ActionResult<{ expiresAt: string }>>`; `runServerDiagnostic(): Promise<ActionResult<{ correlationId: string; eventId?: string; flushed: boolean }>>`. Policy contiene `enabled:boolean`, `operatorIds:readonly string[]`, `expiresAt:string`. Todas las Server Actions exportadas son async.

- [x] **4.1 Escribir RED de autorización por datos persistidos y reloj.** Variables server-only: `KDM_SENTRY_DIAGNOSTICS_ENABLED`, `KDM_SENTRY_DIAGNOSTICS_OPERATOR_IDS` (UUID separados por coma), `KDM_SENTRY_DIAGNOSTICS_EXPIRES_AT` (UTC). Config inválida o vencida deniega; timestamps sin zona explícita deniegan. El helper servidor obtiene actor de `requireActor()` y nunca de un parámetro.

```ts
const admin = { userId: "10000000-0000-4000-8000-000000000001",
  workspaceId: "20000000-0000-4000-8000-000000000001", role: "Admin" } as const;
const policy = { enabled: true, operatorIds: [admin.userId], expiresAt: "2026-10-04T18:00:00Z" };
expect(canRunDiagnostics(admin, policy, Date.parse("2026-10-04T17:59:59Z"))).toBe(true);
expect(canRunDiagnostics(admin, policy, Date.parse(policy.expiresAt))).toBe(false);
expect(canRunDiagnostics({ ...admin, role: "Member" }, policy, 0)).toBe(false);
expect(canRunDiagnostics({ ...admin, userId: crypto.randomUUID() }, policy, 0)).toBe(false);
```

Además: habilitada al render y vencida al hacer clic; rol cambiado antes del POST; sesión expirada; no actor; payload añadido manualmente; todos deniegan sin emitir. Testear política con UUIDs sintéticos, no leer configuración operadora real en artefactos.

- [x] **4.2 Ejecutar RED:** `pnpm test:unit tests/unit/diagnostics-policy.test.ts tests/unit/diagnostics-actions.test.ts`.
- [x] **4.3 Reemplazar el ejemplo público.** Página servidor requiere autorización antes de renderizar panel, sin capturar denegación esperada como incidencia. No crea eventos al renderizar. La API GET antigua retorna 404 sin lanzar excepción. No dejar `logger.info`, `startSpan`, `diagnoseSdkConnectivity` ni texto `Error sent to Sentry` basado solo en HTTP 500.

```ts
// src/app/api/sentry-example-api/route.ts
export function GET() { return new Response(null, { status: 404 }); }
```

`runServerDiagnostic` reautoriza, lanza/captura un error de constante inocua dentro de la acción y llama `captureSafeFailure({module:"application", operation:"diagnostic", code:"INTERNAL_ERROR", synthetic:true})`, espera `flush(2000)` y devuelve receipt. No toca tablas de documentos. La prueba browser llama primero `authorizeDiagnostics`, vuelve a comprobar vencimiento recibido y emite el mismo escenario desde el cliente. La autorización protege la superficie, no garantiza que alguien con DSN público no pueda fabricar eventos fuera de ella.

- [x] **4.4 UI mínima:** botones `Test browser reporting` y `Test server reporting`; deshabilitados mientras hay una petición. Mostrar `Submitted for verification`, correlación y estado de flush, nunca recepción confirmada. Esperar la consulta externa a Sentry para confirmar almacenamiento. No colocar enlace en navegación de producto.

- [x] **4.5 Añadir launcher local opt-in.** `scripts/sentry-local-smoke.mjs` verifica stack local mediante `readLocalSupabaseRuntime`, consulta SHA por `git rev-parse HEAD` y estado mediante `git status --porcelain`, solicita configuración operadora por variables existentes y lanza `next dev`. Fuerza `NEXT_PUBLIC_SUPABASE_URL` y claves locales en el proceso hijo, target `development`, release SHA/`-dirty` y opt-in público `1`; no imprime secretos. No relajar el runner de suites para enviar Sentry. Validar colisión de puerto mediante el arranque, sin matar procesos del usuario.

```text
node scripts/sentry-local-smoke.mjs
```

Su test mockea procesos y runtime; exige rechazo de URL remota, ausencia de operador/expiry, expiry vencido y conservación de killswitch/test mode. Nunca inicia red real en Vitest.

- [x] **4.6 GREEN y E2E de acceso.** `pnpm test:unit tests/unit/diagnostics-policy.test.ts tests/unit/diagnostics-actions.test.ts tests/unit/sentry-local-smoke.test.ts`; `pnpm typecheck`. En CI, `observability.spec.ts` comprueba cierre por defecto/GET inocuo. Las pruebas de emisión autorizada usan SDK con transporte en memoria en integración; la recepción real se ejecuta en tarea 8. No afirmar que el test del guard demuestra recepción remota.

**Salida revisable:** diagnóstico bajo control explícito y sin mutaciones de negocio. Commit sugerido: `feat(observability): add protected reporting diagnostics`.

## Task 5: Gate de Sprint 1 reproducible y aislado

**Files:** modificar `.github/workflows/s1-01.yml`, `scripts/with-local-supabase.mjs`, `playwright.config.ts`; ampliar `tests/unit/local-supabase-runtime.test.ts`, `e2e-local-supabase-config.test.ts`, `playwright-config.test.ts`; crear `docs/testing/s1-08-acceptance.md` con comandos/resultados de esta tarea. No añadir una segunda suite de RLS que repita las aserciones existentes.

**Interfaces:** conserva comandos `test:unit`, `test:db`, `check:database-types`, `test:fixtures`, `test:integration`, `test:e2e:local`; produce job `quality` con nombre estable `Quality gates` y output `tested_sha`.

- [x] **5.1 Añadir RED de aislamiento de runner.** Partiendo del test del runner actual, configurar en el proceso padre una URL remota, `NEXT_PUBLIC_KDM_SENTRY_LOCAL_ENABLED=1` y variables de diagnóstico activadas. Exigir que el proceso de suites use loopback, killswitch de Sentry y diagnóstico deshabilitado. Usar un valor remoto sintético como `https://example.invalid`, nunca una clave real.

```ts
expect(childEnv.NEXT_PUBLIC_SUPABASE_URL).toBe("http://127.0.0.1:54321");
expect(childEnv.KDM_DISABLE_SENTRY).toBe("1");
expect(childEnv.NEXT_PUBLIC_KDM_DISABLE_SENTRY).toBe("1");
expect(childEnv.KDM_SENTRY_DIAGNOSTICS_ENABLED).toBe("0");
expect(childEnv.NEXT_PUBLIC_KDM_SENTRY_LOCAL_ENABLED).toBe("0");
```

Extender runner y test existentes para incluir estas claves en `childEnv` después del spread de `process.env`; no exportarlas globalmente a jobs de publicación. Ejecutar primero el test RED y después la implementación mínima y GREEN.

- [x] **5.2 Adaptar workflow con SHA explícito, sin filtros que omitan checks críticos.** Mantener un solo job de calidad con pasos secuenciales y sin `continue-on-error`. Conservar SHA exactos de checkout/setup-node ya fijados. Este es el núcleo del checkout y sus outputs:

```yaml
name: Sprint 1
on:
  pull_request:
    branches: [develop, main]
    types: [opened, synchronize, reopened, ready_for_review]
  push:
    branches: [develop, main]
permissions:
  contents: read
jobs:
  quality:
    name: Quality gates
    runs-on: ubuntu-latest
    timeout-minutes: 60
    outputs:
      tested_sha: ${{ steps.revision.outputs.sha }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          ref: ${{ github.event.pull_request.head.sha || github.sha }}
          persist-credentials: false
      - id: revision
        shell: bash
        run: printf 'sha=%s\n' "$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"
```

El PR valida head, no un merge sintético distinto del SHA publicado. GitHub exige la rama actualizada al integrar; el push integrado vuelve a ejecutar todas las pruebas. `tested_sha` solo se considera válido si `needs.quality.result == 'success'`.

- [x] **5.3 Conservar todos los pasos de calidad existentes.** Renombrar pasos a su alcance real, usar `test:e2e:local` en lugar del alias ambiguo `test:e2e:auth` y mantener el test de restart. Secuencia exacta:

```text
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test:unit
node scripts/local-supabase-lifecycle.mjs start
pnpm test:db
pnpm check:database-types
pnpm test:fixtures
pnpm test:integration
node scripts/with-local-supabase.mjs build
pnpm exec playwright install --with-deps chromium
pnpm test:e2e:local
pnpm test:auth:restart
node scripts/local-supabase-lifecycle.mjs stop
```

El stop conserva `if: always()`. El arranque del runner efímero debe aplicar migraciones desde volumen nuevo; registrar esa evidencia y no ejecutar reset sobre el stack personal por comodidad. Si el entorno local ya tiene datos, usar el procedimiento aislado documentado en S1-02 antes de probar instalación limpia. Nada de este job recibe credenciales de Vercel ni acceso de administración al Supabase compartido.

- [ ] **5.4 Ejecutar las suites locales una vez sobre el checkout integrado.** Reutilizar resultados de tareas 1–4 para diagnóstico, pero ejecutar el conjunto final de calidad. Identificar resultados de DB, fixtures y E2E por separado. Si falta Docker o un fixture, corregir la preparación o registrar bloqueo; no reemplazar SQL por mocks. No cambiar globalmente paralelismo o timeouts para esconder fallos.
- [x] **5.5 Registrar evidencia sin payloads y revisar workflow.** Mantener traces/video/screenshots desactivados. La salida de failed assertions no debe incluir tokens, signed URLs ni bytes privados; usar booleanos sanitizados para comparaciones sensibles. El informe registra SHA, comandos, conteos y límites, no supone que el workflow remoto ya se ejecutó.

**Salida revisable:** el mismo SHA atraviesa todos los controles locales y un job remoto identificable. Commit sugerido: `ci(s1): require full local acceptance gates`.

## Task 6: Deploy desde Actions condicionado al SHA aprobado

**Files:** crear `vercel.json`, `scripts/deployment-policy.mjs`, `scripts/deployment-policy.d.mts`, `scripts/deploy-vercel.mjs`; modificar `.github/workflows/s1-01.yml`; crear `tests/unit/deployment-policy.test.ts`, `deploy-vercel.test.ts`; crear `docs/testing/s1-08-cutover.md` con configuración requerida.

**Interfaces:** produce función pura `chooseDeployment(input): DeploymentTarget | null` y script `node scripts/deploy-vercel.mjs preview|production`. `DeploymentTarget` es `{target:"preview"|"production", sha:string, prNumber?:number}`. Inputs contienen `eventName`, `ref`, `qualityResult`, `testedSha`, `headSha`, `headRepository`, `repository`, `prState`, `draft`, `prNumber`, `authorizedActor`. Valores vienen del evento/GitHub API, no de texto del PR interpolado en shell. `prState` es `open|closed` para PR y puede estar ausente en push.

- [x] **6.1 Escribir RED de la decisión de publicación.** Probar éxito, fallo/cancelación/skip, fork, draft, actor no autorizado, SHA diferente, PR cerrado, nueva revisión y push a develop. El job solo acepta eventos PR abiertos actuales o push actual de main.

```ts
const input = { eventName: "pull_request", ref: "refs/pull/8/merge",
  qualityResult: "success", testedSha: "a".repeat(40), headSha: "a".repeat(40),
  headRepository: "JMCoC/knowledge-decay-monitor", repository: "JMCoC/knowledge-decay-monitor",
  prState: "open", draft: false, prNumber: 8, authorizedActor: true };
expect(chooseDeployment(input)).toEqual({ target: "preview", sha: input.testedSha, prNumber: 8 });
for (const qualityResult of ["failure", "cancelled", "skipped"]) {
  expect(chooseDeployment({ ...input, qualityResult })).toBeNull();
}
expect(chooseDeployment({ ...input, headSha: "b".repeat(40) })).toBeNull();
expect(chooseDeployment({ ...input, authorizedActor: false })).toBeNull();
expect(chooseDeployment({ ...input, headRepository: "outsider/fork" })).toBeNull();
expect(chooseDeployment({ ...input, prState: "closed" })).toBeNull();
```

`chooseDeployment` no consulta red ni modifica recursos. Sus declaraciones `.d.mts` reflejan exactamente los exports JS. Ejecutar `pnpm test:unit tests/unit/deployment-policy.test.ts` RED antes de implementar.

- [x] **6.2 Añadir desactivación Git y jobs dependientes.** Configuración versionada:

```json
{ "$schema": "https://openapi.vercel.sh/vercel.json", "git": { "deploymentEnabled": false } }
```

Preservar settings si el archivo ya existe al ejecutar. Los jobs de publicación se añaden al workflow, no a un workflow activado por `deployment_status` ni `pull_request_target`:

```yaml
  preview:
    needs: quality
    if: >-
      ${{ needs.quality.result == 'success' && github.event_name == 'pull_request' &&
          github.event.pull_request.head.repo.full_name == github.repository &&
          !github.event.pull_request.draft }}
    runs-on: ubuntu-latest
    environment: Preview
    permissions:
      contents: read
      pull-requests: read
    concurrency:
      group: preview-${{ github.event.pull_request.number }}
      cancel-in-progress: false
  production:
    needs: quality
    if: >-
      ${{ needs.quality.result == 'success' && github.event_name == 'push' &&
          github.ref == 'refs/heads/main' }}
    runs-on: ubuntu-latest
    environment: Production
    permissions:
      contents: read
    concurrency:
      group: production
      cancel-in-progress: false
```

Los steps de ambos jobs hacen checkout de `needs.quality.outputs.tested_sha`, setup-node/pnpm, instalación frozen, validación de revisión actual y ejecución del script con el destino fijo. Son runners nuevos: no reciben `.next`/`.vercel` del job local. No usar `always()` para autorizar deploy. Los grupos serializan publicación; antes de crear deployment y antes de actualizar alias/promover, el script vuelve a comprobar head actual. Una ejecución obsoleta termina como no publicada, aunque sus pruebas hayan pasado.

- [x] **6.3 Validar identidad del PR y configuración antes de usar secretos.** Añadir un paso sin secretos de Vercel que consulta PR/branch actuales con `gh api` y `GH_TOKEN` del workflow: estado abierto, head repository propio, SHA actual; actor con permiso `write|maintain|admin` obtenido por API. Si no puede comprobar permiso, no publica. En reruns comprobar tanto actor original como `github.triggering_actor`. No confiar solo en `author_association`.

```text
gh api repos/JMCoC/knowledge-decay-monitor/pulls/8 --jq '{state, draft, head: {sha: .head.sha, repo: .head.repo.full_name}}'
gh api repos/JMCoC/knowledge-decay-monitor/collaborators/JMCoC/permission --jq .permission
```

Los números/nombres del ejemplo se sustituyen programáticamente por valores validados con argumentos de proceso, nunca por interpolación de títulos/cuerpos. Una negativa detiene job sin credenciales de publicación. Los secrets Vercel/Sentry se declaran únicamente en los steps que los necesitan, después de esa comprobación.

- [x] **6.4 Implementar el script con subprocess estructurado y configuración del destino.** `deploy-vercel.mjs` ejecuta CLI fijada mediante `pnpm dlx vercel@62.2.0` con argumentos separados y `shell:false`; no construye shell strings. Antes, contrasta `--help` de esta versión para `pull`, `build`, `deploy`, `alias`, `promote` y corrige solo diferencias comprobadas, dejando constancia. Usa `VERCEL_TOKEN` por environment, `--scope kdm17`, `VERCEL_ORG_ID`/`VERCEL_PROJECT_ID` descubiertos y verificados; nunca auto-crea otro proyecto.

La receta por destino es:

```text
pnpm dlx vercel@62.2.0 pull --yes --environment=preview --scope kdm17
pnpm dlx vercel@62.2.0 build --scope kdm17
pnpm dlx vercel@62.2.0 deploy --prebuilt --yes --scope kdm17

pnpm dlx vercel@62.2.0 pull --yes --environment=production --scope kdm17
pnpm dlx vercel@62.2.0 build --prod --scope kdm17
pnpm dlx vercel@62.2.0 deploy --prebuilt --prod --skip-domain --yes --scope kdm17
```

Cada bloque se ejecuta solo para su destino. No se usan artefactos de otro runner, así que no se necesita `--standalone`. El script captura únicamente deployment ID/URL necesarios, verifica proyecto/estado/SHA y nunca imprime archivos `.vercel/.env*` ni env. Los secretos descargados por pull permanecen solo en el runner efímero. No subir `.vercel` como artefacto ni activar shell tracing.

Inyectar target/release públicos de tarea 2 antes de build. Los valores efectivos de build y runtime deben coincidir, usando overrides soportados por CLI y variables de Vercel; verificarlo con metadata segura de la prueba diagnóstica. El `SENTRY_AUTH_TOKEN` queda reservado al build si se mantienen source maps, nunca al bundle ni al runtime. Los killswitches del job de tests no se copian a este job.

- [ ] **6.5 Resolver origin/alias de cada PR antes de publicar.** Patrón propuesto dentro de Vercel: `kdm-pr-<numero>-kdm17.vercel.app`; el script acepta solo entero positivo y construye hostname, sin texto libre de branch. La documentación actual de Vercel confirma que los aliases bajo `.vercel.app` no requieren propiedad DNS y admite este hostname plano; la asignación exacta aún no se probó porque requiere un deployment. El primer corte debe confirmar que la API acepta el alias; si no está disponible, detener el corte y resolver un dominio controlado, sin asignar un alias ajeno ni reutilizar Production. La elección concreta de hostname es configuración operativa, no permiso para comprar un dominio.

El script configura `APP_ORIGIN=https://<alias-del-pr>` en build/runtime; después de `READY` y de volver a verificar SHA actual, asigna alias con `vercel alias set <deployment-url> <hostname> --scope kdm17`. Configurar callbacks de Supabase exclusivamente para el patrón controlado o aliases exactos, nunca `*.vercel.app` indiscriminado. Revisar la configuración Auth existente y probar recovery hacia el mismo Preview con una cuenta operadora, sin seed remoto. Para Production usar el origin existente validado y `vercel promote <deployment-id-or-url>` después de la última comprobación de head/READY.

Conservar protección de acceso a Preview. Si está habilitada, la prueba usa autenticación/autorización de automatización autorizada; no desactivar la protección para facilitar tests. El resumen/check de Actions muestra enlace y SHA. No crear comentarios en PR como parte de este plan.

- [x] **6.6 Tests del ejecutor con procesos/API falsos.** `deploy-vercel.test.ts` inyecta dependencias de subprocess y consulta GitHub; comprobar orden, flags/target, ausencia de `--prod` para PR, ninguna promoción antes de gate/READY, ninguna asignación si head cambió durante build y rechazo de origin local/target inconsistente. Comprobar que logs controlados no contienen un token centinela ni contenidos de `.env`. Usar pruebas de comportamiento del ejecutor, no snapshots del YAML.

```ts
expect(executedCommands.some((args) => args.includes("--prebuilt"))).toBe(true);
expect(executedCommands.some((args) => args.includes("promote"))).toBe(false);
expect(logLines.join("\n")).not.toContain("TOKEN_SENTINEL");
```

El caso anterior es Preview; agregar Production que sí promueve y uno con head reemplazado que no lo hace. Los fixtures `executedCommands`/`logLines` se alimentan del subprocess inyectado, nunca de comandos reales. Ejecutar `pnpm test:unit tests/unit/deployment-policy.test.ts tests/unit/deploy-vercel.test.ts`, `node --check scripts/deploy-vercel.mjs`, `pnpm typecheck`, `pnpm lint`.

**Salida revisable:** política fail-closed, deploy exacto y build correcto por destino, aún sin modificar integraciones remotas. Commit sugerido: `ci(deploy): publish validated commits through Actions`.

## Task 7: Corte operativo y demostración de bloqueo

**Files:** completar `docs/testing/s1-08-cutover.md`; actualizar `docs/testing/s1-01-delivery.md` y `s1-02-cutover.md` solo con hechos verificados. Settings: GitHub `develop`/`main`, entornos Preview/Production; Vercel proyecto verificado; Supabase integración Git y callbacks.

**Interfaces:** consume gate `Quality gates`, script de tarea 6 y credenciales administradas; produce controles remotos comprobados y registro por SHA. Esta tarea requiere que la ejecución autorizada incluya settings/publicación. Si no, terminar primero las tareas locales y presentar el diff, destinos y cambios operativos concretos para aprobación.

- [ ] **7.1 Inventario read-only y condiciones de entrada.** Obtener de GitHub branches/rulesets/environments/workflows/secrets (solo nombres), de Vercel proyecto/conexión/hooks/origins y de Supabase integración Git/destinos de migraciones. Nunca volcar secrets ni logs crudos. Si una API no muestra un setting, inspeccionar dashboard autenticado en lugar de inferirlo por ausencia. Confirmar proyecto Vercel `prj_G6YEOlZYghON8XlDozxlrkBuxvUJ`, equipo `team_bvEGwlSgqo1NXRjZFmbeNrdA`, contra discovery actual antes de mutar. El inventario GitHub/Vercel/Supabase read-only quedó registrado en `docs/testing/s1-08-cutover.md`; falta confirmar en dashboard los hooks/configuración Git de Vercel y Redirect URLs de Auth de Supabase. La lectura del dashboard no se pudo completar con la superficie `computer-use` disponible.

```text
gh api repos/JMCoC/knowledge-decay-monitor/branches --jq '.[] | {name, protected}'
gh api repos/JMCoC/knowledge-decay-monitor/rulesets --jq '.[] | {id, name, enforcement}'
gh api repos/JMCoC/knowledge-decay-monitor/environments --jq '.environments[] | {name, protection_rules, deployment_branch_policy}'
gh secret list --repo JMCoC/knowledge-decay-monitor
```

Documentar variables requeridas por scope, presencia/ausencia y quién puede operar. No imprimir valores. El token Vercel pertenece al equipo/proyecto correcto; los deploy jobs no necesitan credenciales administrativas de Supabase.

- [ ] **7.2 Preparar transición sin disparadores duplicados.** Con código revisado y credenciales listas, coordinar una ventana sin pushes. Desconectar el disparador Git de Vercel antes de subir la rama de aceptación si ramas antiguas aún lo permiten; conservar el deployment activo. El respaldo de rollback es deployment ID/origin anterior, no reactivar publicación sin gate. Deshabilitar hooks redundantes y automatismos remotos de migración Supabase que eludan CI; si la integración solo sincroniza configuración sin publicar ni migrar, conservarla y registrar evidencia.
- [ ] **7.3 Publicar el PR controlado con workflow candidato y comprobar el check real.** Usar push/PR solo dentro del alcance autorizado, sin stage amplio. Verificar que el workflow candidato no vuelva a publicar por Git integration y que sus checks tengan el nombre/app esperados. PR head probado, `tested_sha`, build release y metadata Vercel deben coincidir. El primer Preview verifica la ruta Actions → Vercel, antes de tocar Production.
- [ ] **7.4 Exigir protección de `develop`/`main`.** Mediante API estructurada o dashboard: requerir `Quality gates` de GitHub Actions, rama actualizada, una aprobación elegible, descartar aprobaciones obsoletas, no force-push/borrado ni bypass ordinario. Vincular el check a la app comprobada, no a un nombre que pueda producir cualquier integración. Revisar que exista un revisor distinto del autor; no cambiar una regla a cero revisores silenciosamente para desbloquear un PR. Conservar reglas previas más restrictivas.

Los entornos limitan Production a `main` y Preview a PR internos validados por la política. No añadir aprobación manual por despliegue como requisito nuevo si las reglas de equipo no la exigen. Evitar que un job required sea el deploy de Preview: causaría dependencia circular o bloquearía PR de forks sin secretos. Proteger cambios de workflow/contratos con revisión de Dev 1 según ownership.

- [ ] **7.5 Ejecutar prueba negativa real.** En el PR controlado, añadir temporalmente al final de una prueba SQL pgTAP un `ok(false, 'S1-08 controlled gate failure')`, ajustar su plan y mantener transacción/rollback del archivo. Solo se ejecuta en stack efímero, no se cambia una policy. El commit debe fallar DB/quality; deploy queda omitido. Inspeccionar que merge ordinario esté bloqueado y que Vercel no tenga deployment de ese SHA. No pulsar bypass ni intentar integrar el commit fallido.
- [ ] **7.6 Corregir el sentinel y ejecutar prueba positiva.** Eliminar la aserción temporal y recuperar el plan original; registrar ambos SHA. Esperar aprobación completa y comprobar nuevo Preview, origin/callback, gate de alias y ausencia de un segundo deployment automático. Repetir condiciones de Production mediante su política probada y publicar un commit legítimo de `main` solo cuando esté autorizado y verde, sin integrar un fallo deliberado.
- [ ] **7.7 Verificar carreras y cierre.** Crear dos revisiones controladas del mismo PR; la más antigua no puede reemplazar el alias de la nueva. Registrar escenario concurrente o, si no puede provocarse de forma fiable, conservar la evidencia de tests del ejecutor y marcar la prueba remota de carrera pendiente. Reconsultar protecciones, disparadores y aliases. Una tarea operativa no termina por recibir HTTP 200 de un cambio: se lee el estado efectivo.

**Salida revisable:** bloqueo real demostrado, ruta positiva probada y settings remotos registrados sin secretos. No cerrar A10/A11 con solo tests de política.

## Task 8: Recepción real de Sentry, aceptación y handoff

**Files:** completar `docs/testing/s1-08-acceptance.md`, crear `docs/testing/s1-08-ingestion-handoff.md`; actualizar resultados de `s1-08-cutover.md`. No crear un segundo SDK o endpoint de envío directo fuera de la aplicación.

**Interfaces:** consume diagnóstico de tarea 4, releases publicados y MCP Sentry. Produce matriz A01–A13, eventos verificados y obligaciones S1-04/S1-07.

- [ ] **8.1 Preparar configuración temporal y probar cierre previo.** En cada entorno confirmar diagnóstico deshabilitado por defecto, GET antiguo 404 y que Member/QA/otro Admin no pueden emitir. Activar únicamente operador Admin permitido con vencimiento UTC corto (máximo operativo de una hora), usando el mecanismo configurado. Cambios de variables Vercel pueden requerir deployment nuevo; ese deployment vuelve a pasar el gate. No imprimir UUIDs de operadores en artefactos públicos si no son necesarios.
- [ ] **8.2 Local real.** Ejecutar launcher opt-in de tarea 4, abrir la ruta autorizada, emitir una prueba browser y una server. Registrar referencia/flush sin declararlas recibidas. Local usa Auth/datos locales y Sentry remoto deliberadamente; no cambiar el runner de CI. La sesión operadora local se obtiene por login normal con fixtures exclusivamente locales.
- [ ] **8.3 Preview y Production reales.** Usar las URLs verificadas de tarea 7 y una sesión operadora autorizada. Emitir un evento browser y otro server por entorno, sin tocar documentos ni interferir con usuarios reales. Registrar SHA/runtime/entorno efectivos. Un ad blocker o fallo de red browser debe producir diagnóstico inconcluso, no un éxito por el evento servidor.
- [ ] **8.4 Buscar e inspeccionar por MCP Sentry con tiempo acotado.** Descubrir el tool de búsqueda apropiado para eventos de tipo message/error; no confundir `captureMessage` con Sentry Logs. Proyecto `saas-project-kdm/knowledge-decay-monitor`, región `https://us.sentry.io`. Consulta acotada por correlación, release y entorno; pedir ID/timestamp/entorno/release/tags necesarios. Si el dataset de `search_errors` excluye mensajes, usar búsqueda de issues/eventos del catálogo MCP y verificar el evento exacto, sin reinterpretar ausencia como envío correcto.

```json
{
  "environment": "vercel-preview",
  "runtime": "server",
  "synthetic": true,
  "operation": "diagnostic",
  "receiptRequired": "stored-event-inspected",
  "timeoutSeconds": 120
}
```

El objeto anterior describe la aserción de aceptación, no argumentos inventados de un tool. Obtener los schemas MCP antes de llamarlos. Reintentos de consulta a 0/15/30/60/120 segundos, esperas individuales máximas de 60 segundos; detener al encontrar el evento. El resultado almacena solo IDs/enlaces y un checklist de campos permitidos/ausentes. Nunca copiar el evento completo al informe.
- [ ] **8.5 Verificar payload almacenado y cierre de diagnóstico.** Confirmar ausencia de user/IP/email, request, rutas/URLs, headers, cuerpos, exception/stack, breadcrumbs, contextos libres, adjuntos, contenido o tokens. Campos técnicos agregados por Sentry se revisan sin asumir que el envelope local describe todo el almacenamiento. Desactivar superficie y verificar denegación desde la sesión ya abierta; comprobar también que el vencimiento bloquea emisión sin depender de cerrar el navegador. No borrar los eventos sintéticos necesarios como evidencia ni cambiar alertas.
- [x] **8.6 Handoff concreto a ingesta.** Documentar import público técnico `captureSafeFailure`, tipos y códigos de etapa de tarea 1. Ejemplo permitido para el runtime Next actual:

```ts
captureSafeFailure({
  module: "ingestion", operation: "process", code: "EMBEDDING_FAILED",
  correlationId: crypto.randomUUID(), versionId: authorizedVersion.id,
});
```

`authorizedVersion` representa la versión persistida previamente autorizada por el módulo propietario, nunca un input del navegador. Si S1-04 usa otro runtime, compartir `safe-event.ts` puro y construir un adaptador de su SDK; no importar Next allí. S1-04 prueba cada etapa, `processing_failed`, activación transaccional y aislamiento de chunks. S1-07 prueba reautorización, concurrencia, identidad estable, éxito/fallo del retry y cero consumo de créditos. El handoff revisable está en `docs/testing/s1-08-ingestion-handoff.md`. No implementar esos comportamientos ni enviar mensajes a los desarrolladores sin instrucción explícita.
- [ ] **8.7 Emitir informe final con evidencia y límites.** Usar la matriz inferior. Repetir suites solo si cambios posteriores invalidaron resultados. `git diff --check`, links locales y revisión de archivos incluidos. Registrar recepción real separada de tests interceptados. A13 permanece pendiente de integración real y no se representa como test omitido exitoso. Si una comprobación remota falla, mantener su criterio pendiente aunque el resto pase.

**Salida revisable:** A01–A12 con evidencia actual cuando se satisfagan; S1-08 completo solo con A13, y Sprint 1 solo con aceptación de todos sus tickets.

## Matriz de trazabilidad y evidencia

| Spec | Tareas | Evidencia mínima |
|---|---|---|
| A01 | 1, 3, 8 | Cada frontera disponible clasifica/captura; test de operación + receipt. |
| A02 | 2, 8 | Fallo inesperado browser/server; flujo framework preservado. |
| A03 | 1, 2, 5, 8 | Envelope interceptado y evento almacenado inspeccionados. |
| A04 | 3, 5 | Correlación exacta, UI controlada, reconciliación sin duplicado. |
| A05 | 4, 8 | Dos eventos locales reales con SHA y entorno. |
| A06 | 6, 8 | Dos eventos Preview del SHA publicado. |
| A07 | 7, 8 | Dos eventos Production y diagnóstico cerrado. |
| A08 | 5, 7 | Migraciones desde stack limpio/tipos; automatización remota inventariada. |
| A09 | 5 | Resultado remoto de todas las suites, sin omisión crítica. |
| A10 | 6, 7 | SHA fallido sin deployment y merge bloqueado. |
| A11 | 6, 7 | SHA verde publicado, origin correcto, serialización y ausencia de bypass. |
| A12 | 1, 8 | Contrato y checklist entregados como documento. |
| A13 | 8 + S1-04/S1-07 | Pipeline y retry reales integrados; pendiente hasta recibirlos. |

Formato del informe de ejecución:

```text
UTC | SHA | environment | criterion | command-or-scenario | result | safe-evidence-link
```

Resultados permitidos: `passed`, `failed`, `blocked`, `not-run`, `external-dependency`. No agregar evidencias históricas como resultados de esta implementación.

## Referencias consultadas y comandos de validación documental

- [GitHub Actions: dependencias de jobs](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-jobs).
- [GitHub Actions: controles de despliegue](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments).
- [GitHub REST: consultar el permiso de un colaborador](https://docs.github.com/en/rest/collaborators/collaborators#get-repository-permissions-for-a-user), revisado para confirmar que el token de Actions necesita solo `Metadata: read`.
- [Vercel CLI deploy](https://vercel.com/docs/cli/deploy) y [alias/promoción](https://vercel.com/docs/cli/alias).
- [Vercel Actions](https://vercel.com/kb/guide/how-can-i-use-github-actions-with-vercel).
- [Sentry opciones](https://github.com/getsentry/sentry-javascript/blob/develop/packages/core/src/types/options.ts), contrastadas con tipos 10.75.0 instalados, sin migrar a v11.
- Guías locales Next.js indicadas en §0; las rutas bajo `node_modules` no se incorporan a Git.

Antes del handoff, verificar cobertura A01–A13, firmas exportadas y rutas. Durante ejecución, si una versión distinta cambia los hooks o comandos, documentar la diferencia y preservar los resultados del diseño; no reemplazar una comprobación real por una suposición.

## Revisión y elección de ejecución

La modalidad seleccionada es **ejecución inline**. Las tareas 1–6 están implementadas; Task 5 conserva una aceptación local parcial por el estado del stack personal, y Task 6 aún espera probar la asignación del alias en el primer Preview. El inventario remoto se hizo en modo solo lectura. Las tareas restantes requieren configuración remota, un workflow publicado y credenciales por entorno; no se cambian settings, no se publica código ni se emiten eventos sintéticos sin autorización aplicable.
