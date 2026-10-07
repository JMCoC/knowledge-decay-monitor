# S1-07 — Retry de procesamiento: plan de implementación

**Objetivo:** permitir que Admin y QA Lead del workspace propietario soliciten reprocesar una versión `processing_failed`, conservando documento, versión y original, con autorización repetida, concurrencia controlada, estado coherente y telemetría segura.

**Historia:** Como QA Lead, quiero identificar y recuperar documentos cuyo procesamiento haya fallado para corregir problemas de ingesta sin perder el control del Repository.

**Estado:** implementación y aceptación local de S1-07 cerradas. Typecheck, 426 unitarias, integración local, fixtures, pipeline, build y 3 E2E del retry pasaron. `pnpm lint` pasó con 0 errores y 3 warnings preexistentes. La aceptación local no verifica el despliegue cloud de S1-02 ni la recepción de eventos en una cuenta Sentry externa.

### Registro de ejecución — 2026-10-07

- S1-04 ya está disponible en el checkout: `runProcessing(versionId, operationId, operation)` ejecuta el pipeline y `finish_processing` persiste el resultado. S1-07 reutiliza esa implementación; no duplica parsing, chunking ni embeddings.
- Implementados adquisición CAS para `processing_failed` y leases `processing` expirados, Server Action `retryProcessing`, autorización desde actor verificado y workspace persistido, respuesta controlada, dispatch al endpoint interno y botón en Repository para versiones fallidas confirmadas.
- El pipeline valida el `operationId` vigente y marca fallo con compare-and-set, de modo que una ejecución vieja no pisa un retry más reciente. La telemetría segura se emite después de persistir el estado y sin adjuntar error crudo ni datos del documento.
- Añadidas pruebas unitarias de acción, CAS, ruta, pipeline y UI; prueba local de integración para concurrencia, aislamiento de workspace, lease expirado y ausencia de documento duplicado.
- Validación actual: `pnpm typecheck` pasó; `pnpm test:unit` pasó (54 archivos, 422 pruebas); `pnpm lint` reportó 0 errores y 3 warnings preexistentes; `git diff --check` pasó. La primera ejecución de `pnpm test:integration tests/integration/processing-retry.test.ts` falló porque la migración local de S1-04 no estaba aplicada. Se verificó con `pnpm exec supabase migration list --local`, se aplicó solo la migración pendiente mediante `pnpm exec supabase migration up --local` (sin reset ni proyecto remoto) y la repetición pasó (1 archivo, 1 prueba).
- Se reprodujeron los checks reportados: `pnpm test:unit` pasó (54 archivos, 422 pruebas) y `pnpm test:fixtures` pasó (Auth, REST y Storage local). `pnpm test:processing` primero se detuvo por falta de `INGESTION_INTERNAL_TOKEN`; luego, con Supabase local, la Edge Function `embed`, Next.js local y un token temporal compartido entre procesos, pasó completo: Markdown y DOCX `ready` con embeddings 384d, PDF vacío `processing_failed` sin chunks ni puntero, legacy intacto y rechazo de requests sin token/token incorrecto. El primer intento en frío excedió límites locales de CPU/timeout; con runtime y ruta calientes pasó sin modificar el pipeline.
- La prueba Playwright `tests/e2e/processing-retry.spec.ts` pasó 3/3 en Chromium: retry exitoso de Admin, segundo fallo controlado para QA Lead y rechazo de Member/otro workspace. `pnpm build` también pasó.
- `pnpm lint` repetido al retomar la sesión terminó con exit code 0: 0 errores y los mismos 3 warnings preexistentes en `upload-maintenance.test.ts` y `upload-store-finalization.test.ts`.

### Cierre de pendientes — 2026-10-07

- Se confirmó el contrato de runtime consultando la actualización S1-04 de `arquitectura-base.md`: Route Handler Node, procesamiento síncrono, límite interno de 50 s, finalización atómica mediante `finish_processing`, sin cola durable ni recuperación automática. Un lease de 180 s expirado se recupera con Retry manual; no se promete reanudar el proceso muerto. La matriz de ownership Dev 1/2/3 se respetó; no se añadió migración ni se reservaron timestamps porque el esquema existente basta.
- Se comprobó que `captureOperationFailure` es el adaptador vigente y delega a `captureSafeFailure`; el filtro de eventos y el transporte reconstruyen únicamente el contrato allowlist. No hay discrepancia funcional con el handoff S1-08.
- Añadidas pruebas de privacidad de `ingestion/retry` con contenido, nombre, ruta, URL firmada, cabeceras, excepción y adjunto centinela en el evento. Añadida prueba que confirma que una excepción del transporte de telemetría no altera el fallo controlado después de persistir `processing_failed`.
- Validación tras los cambios: `pnpm test:unit` pasó (54 archivos, 426 pruebas); `pnpm typecheck` pasó (Next muestra un aviso informativo de instrumentación de navegación de Sentry); `pnpm lint` pasó (0 errores, 3 warnings preexistentes); `git diff --check` pasó. La prueba focalizada también pasó (2 archivos, 22 pruebas). La primera ejecución dentro del sandbox fue bloqueada por `spawn EPERM`; repetida con ejecución autorizada y pasó.
- No se ejecutó `pnpm test:db`: S1-07 no agregó ni modificó SQL, RPC, grants o tipos generados; la prueba de integración local del claim sí ejercitó CAS, concurrencia, aislamiento y lease sobre Supabase local. No se ejecutó recepción hosted de Sentry ni validación cloud.
- Se reconciliaron las casillas del plan con el código y la evidencia disponible. Los puntos condicionales de migración/pruebas SQL quedan marcados como no aplicables por no haber cambios de esquema.

### Registro de ejecución — 2026-10-06

- Revisado el estado del checkout y los contratos actuales. `src/modules/ingestion/processing.ts` sigue siendo un stub que devuelve `uploaded`; no se encontraron parser, chunker, generación de embeddings ni ejecución de pipeline en `src/modules/ingestion`, `src`, `tests` o migraciones.
- El plan de S1-08 y el handoff confirman que procesamiento real pertenece a S1-04. No hay ejecutor para que S1-07 invoque con garantías de estado, persistencia e idempotencia.
- Se detiene la implementación dependiente: no se añadió Server Action, RPC, transición de estado ni botón de Retry que sugiera trabajo real. Continuar requiere integrar S1-04 o autorizar explícitamente ampliar el alcance a ese ticket.
- Consultado Context7 para Next.js 16 Server Actions: la documentación indica validar argumentos y autorizar dentro de cada acción; el proyecto local exige además Zod y actor derivado del Profile persistido. El handoff de S1-08 sigue siendo la fuente de Sentry; la consulta Context7 de Sentry no entregó texto utilizable.
- Se centralizó `versionIdSchema` en `src/modules/ingestion/schemas.ts`, se reutiliza en las acciones de versión existentes y se exporta por la API pública de Ingestion para la futura frontera de retry. `tests/unit/ingestion-schemas.test.ts` cubre UUID, entrada inválida y rechazo de propiedades adicionales. Validación: test focalizado 24/24, typecheck OK, lint sin errores (5 warnings preexistentes, incluyendo el stub de procesamiento). Esta preparación no cambia estados ni inicia trabajo.

## Fuentes y decisiones

- [Ticket S1-07](../../Tickets/tickets.md), [PRD](../../PRD/knowledge-decay-monitor-prd-final.md), [arquitectura base](../../architecture/arquitectura-base.md) §§3–6, [ADR-001](../../architecture/adr/ADR-001-monolito-modular.md) y [protocolo del Día Cero](../../architecture/day-zero-protocol.md).
- [Handoff de S1-08 para ingesta](../../testing/s1-08-ingestion-handoff.md) es el contrato vigente de telemetría para este ticket.
- Revisión inicial del checkout (2026-10-06): `retryProcessing(versionId)` estaba solo en el contrato, `processing.ts` era un stub y la UI no ofrecía Retry Processing. El registro de ejecución de 2026-10-07 documenta que S1-04 llegó al checkout y que S1-07 se implementó sobre ese pipeline.
- El retry conserva **el mismo workspace, documento, versión y original**. No reserva otra versión, no duplica el documento lógico y no consume créditos.
- Solo Admin o QA Lead del workspace dueño puede iniciar retry. Member y otros tenants reciben rechazo controlado y el trabajo no se inicia. Esta regla sigue la arquitectura S1 y el acuerdo de recuperación aprobado registrado en [hallazgos de integración](../../reviews/2026-10-02-s1-02-integration-findings.md).
- El retry solo acepta `processing_failed`. La transición a `processing` debe adquirirse atómicamente; dos solicitudes simultáneas no lanzan dos pipelines. Las solicitudes que pierdan la adquisición reciben `CONFLICT` o un resultado equivalente ya definido por el contrato, sin revelar si un ID pertenece a otro tenant.
- `ready` solo puede persistirse después de guardar correctamente todos los artefactos requeridos por S1-04 y activar la versión de forma transaccional. Si un intento falla, su estado final es `processing_failed`; no se presenta como listo.
- **Dependencia de S1-04:** este ticket invoca el pipeline propiedad de Ingestion; no duplica parsers, chunking, embeddings ni persistencia. Como el punto de entrada actual es stub y no hay worker/cola durable documentado, antes de implementar debe acordarse con el responsable de S1-04 cómo se dispara y recupera una ejecución, qué devuelve `startProcessing` y dónde vive la adquisición atómica. No anunciar un retry funcional hasta integrar un ejecutor real.
- **Replace File queda fuera.** El PRD no decide si reemplaza el original de una versión inicial o crea otra versión numerada. No inventar esa semántica en S1-07.
- Sin cambios de contrato de `src/lib/observability`: llamar `captureSafeFailure` con `module: "ingestion"`, `operation: "retry"`, código de etapa permitido y UUIDs confiables. Nunca pasar `Error`, contenido, nombre/ruta, chunks, request, identidad/tenant ni URL firmada. Emitir después de persistir el estado de negocio. Si Sentry falla o devuelve `undefined`, no cambia el estado, el resultado ni el mensaje controlado.

## Límites y ownership

| Área | Responsabilidad de S1-07 |
|---|---|
| `src/modules/ingestion/**` | Validación, autorización de operación privilegiada, adquisición/concurrencia, coordinación con pipeline y resultado seguro de retry. Propietario: Dev 2. |
| `src/modules/repository/**` y `src/app/(workspace)/repository/**` | Acción visible para versiones fallidas y presentación de éxito/conflicto/fallo controlado. Propietario: Dev 3. Repository solicita el retry a Ingestion; nunca cambia estados ni ejecuta parsing. |
| `src/types/contracts.ts` | Ajuste coordinado del resultado de `IngestionApi` si el estado final o la aceptación requieren refinar el tipo actual. Dev 1 coordina contratos compartidos. |
| Migración y tipos DB | Solo si la estrategia elegida necesita persistir intento/lease o una RPC de adquisición. Coordinar timestamp con Dev 1, añadir migración nueva y regenerar `src/types/database.ts`; nunca editar tipos generados a mano ni reescribir migraciones existentes. |
| Sentry | Consumir `captureSafeFailure` y su allowlist existente. No añadir códigos/etapas ni importar SDK de Sentry en una eventual lógica portable del worker. |

Conservar monolito modular y alias `@/*`. No introducir HTTP interno, repositorios genéricos, reglas de autorización duplicadas en UI, clave privilegiada en cliente, worker/cola sin decisión operativa ni capas de forwarding.

## Secuencia de trabajo

### 0. Comprobación de entrada y coordinación

- [x] Revisar `git status`, preservar cambios ajenos y volver a leer ticket, PRD, arquitectura, ADR, Día Cero, contrato S1-08 y archivos actuales de Ingestion/Repository.
- [x] Validar el ejecutor, runtime, invocación, timeout/recuperación, persistencia transaccional y errores por etapa contra las decisiones ya registradas de S1-04 en `arquitectura-base.md` y su spec. La implementación conserva esos límites.
- [x] Respetar la matriz de ownership para Ingestion (Dev 2), Repository/UI (Dev 3) y contrato compartido (Dev 1). No se añadió esquema, por lo que no hizo falta reservar timestamp de migración.
- [x] El bloqueo inicial por ausencia de ejecutor se registró el 2026-10-06. Quedó resuelto al integrar S1-04; S1-07 reutiliza su pipeline en vez del stub.

### 1. Contrato y errores de frontera

**Archivos candidatos:** `src/types/contracts.ts`, `src/modules/ingestion/schemas.ts`, `src/modules/ingestion/index.ts`, nuevos servicios/acciones y pruebas unitarias correspondientes.

- [x] Usar `versionIdSchema` con Zod en la frontera de `retryProcessing`; el esquema se comparte con las demás acciones de versión.
- [x] Exportar `retryProcessing` desde la API pública de Ingestion y conectar la operación de Repository a esa API pública.
- [x] Definir resultado coherente con comportamiento asíncrono/síncrono que entregue S1-04. No reportar `ready` al mero aceptar o encolar trabajo; distinguir aceptación (`processing`) de finalización (`ready`/`processing_failed`) si el ejecutor no espera hasta terminar.
- [x] Usar `ActionResult<T>` y códigos existentes (`UNAUTHENTICATED`, `FORBIDDEN`, `INVALID_INPUT`, `NOT_FOUND`, `CONFLICT`, `PROCESSING_FAILED`, `INTERNAL_ERROR`) con mensajes fijos en inglés. No exponer SQL, excepciones, causas del parser ni detalles de proveedor.
- [x] Definir la política de no enumeración: un documento ajeno no se distingue de uno no visible por el usuario; en ambos casos no inicia trabajo.

### 2. Autorización y adquisición atómica

**Archivos candidatos:** `src/modules/ingestion/actions.ts`, capa de aplicación/persistencia de Ingestion, migración SQL nueva solo si se justifica, `src/types/database.ts` generado y pruebas SQL/RLS.

- [x] Revalidar sesión con `requireActor()` en servidor y derivar rol/workspace solo del Profile persistido. Permitir Admin/QA Lead; rechazar Member. No aceptar `Actor`, `workspaceId` o `role` suministrados por cliente.
- [x] Resolver versión y documento dentro del workspace autorizado. Comprobar que la versión es `processing_failed`, pertenece al documento esperado y conserva su original canónico autorizado; la ruta del archivo se deriva del registro, nunca de input del navegador.
- [x] Adquirir el retry mediante compare-and-set/operación SQL atómica sobre el estado actual. Solo una solicitud puede cambiar `processing_failed → processing` y arrancar el pipeline. Una carrera perdida no dispara parsing ni Sentry por denegación esperada.
- [x] Controlar el límite de concurrencia según el mecanismo integrado con S1-04. Si se requiere lease/attempt persistido, documentar expiración y recuperación ante caída antes de añadir columnas/RPC; mantener secretos y service role solo en servidor y validar contexto antes de usarlos.
- [x] No crear filas de documento/versión, no cambiar puntero activo ni tocar créditos al iniciar retry. No borrar chunks/original como limpieza incidental. Evitar que un fallo parcial deje la versión `ready` sin todos los artefactos.
- [x] Si se necesita esquema, agregar una migración aditiva y acotada, grants explícitos y pruebas de autorización/concurrencia. Regenerar tipos con el procedimiento del repo.

### 3. Reutilización del pipeline de S1-04 y transiciones

**Archivos candidatos:** `src/modules/ingestion/processing.ts` y módulos internos del pipeline propiedad de S1-04; pruebas del pipeline y de integración.

- [x] Llamar el ejecutor real de S1-04 sobre la misma versión/original ya autorizados; evitar lógica paralela exclusiva para Retry Processing.
- [x] Volver a persistir los artefactos completos mediante la misma ruta transaccional del procesamiento inicial. Confirmar la regla de activación/puntero con S1-04 y no degradar ni reemplazar una versión activa válida si el retry no termina correctamente.
- [x] En éxito, persistir `processing_status = ready` solo después de completar la persistencia requerida. En fallo de cualquier etapa, persistir `processing_failed`, mantener `version_status = NULL` cuando corresponda y devolver error controlado.
- [x] Asegurar idempotencia/reconciliación para timeout o respuesta perdida: repetir una solicitud no debe duplicar chunks, embeddings, documentos ni intentos en ejecución. Registrar el resultado del trabajo antes de cualquier telemetría.
- [x] No añadir scheduler, cola durable, worker desplegado o promesa de recuperación automática sin decisión/evidencia de S1-04/ADR. Aceptar retry no equivale a garantizar recuperación de un proceso que el runtime no puede reanudar.

### 4. Integración segura con Sentry

**Archivos candidatos:** acciones/servicio de Ingestion existentes; pruebas de privacidad para retry. No cambiar `src/lib/observability/safe-event.ts`, `capture.ts` ni catálogos sin coordinación de S1-08.

- [x] Para fallos técnicos inesperados, generar una correlación en una frontera confiable y, tras persistir `processing_failed`, llamar `captureSafeFailure` con operación `retry`, código permitido (`PARSING_FAILED`, `CHUNKING_FAILED`, `EMBEDDING_FAILED`, `PERSISTENCE_FAILED` o `PROCESSING_FAILED`) y `versionId`/`attemptId` únicamente si proceden de registros autorizados.
- [x] No emitir Sentry para validación, Member, tenant ajeno, versión inexistente, estado no elegible o conflicto concurrente esperado.
- [x] No pasar excepción al helper, no serializarla en logs y no adjuntar contenido, chunks, título/nombre/ruta, metadata libre, URLs firmadas, headers, request, usuario o workspace.
- [x] Probar mediante transporte interceptado que las entradas centinela sensibles no llegan al evento/envelope y que una excepción/ausencia de Sentry no altera el estado o `ActionResult` del retry.

### 5. UI de Repository

**Archivos candidatos:** `src/modules/repository/ui/**`, presentación de fila/detalle de documento y composición de la ruta Repository; componente dedicado de retry bajo Repository o componente compartido de operación.

- [x] Mostrar claramente `Processing failed` y mantener la versión fuera de cualquier indicación de análisis/lista. No confundir `uploaded`, `processing` y `ready`.
- [x] Ofrecer Retry Processing solo a Admin/QA Lead y únicamente en registros `processing_failed`; la comprobación visual es comodidad, nunca autorización.
- [x] Enviar solo `versionId` a la acción de Ingestion. Deshabilitar el control durante la solicitud y tratar doble clic/refresco como comportamiento normal que el backend también controla.
- [x] Presentar estados accesibles de envío, aceptación/en curso, éxito y fallo/conflicto en inglés con mensaje controlado; refrescar proyección tras el resultado sin asumir éxito por una respuesta perdida.
- [x] No mostrar exception, stack, código SQL, ruta, URL firmada o texto del documento. Member no ve Repository en S1.

### 6. Verificación por capas y aceptación

Ejecutar desde la raíz, con la versión fijada de pnpm. Detenerse y reportar cualquier fallo de infraestructura sin convertirlo en aceptación.

- [x] Unitarias de Zod/acción/servicio: ID inválido; falta de sesión; Member; rol permitido; estado inválido; resultado controlado; sin consumo de créditos ni duplicado lógico.
- [x] Pruebas SQL/RPC si se agrega persistencia: tenant y roles; grants; elegibilidad; CAS con dos sesiones concurrentes; solo una adquisición y una ejecución; aislamiento de ID ajeno; coherencia de estados/puntero.
- [x] Integración del pipeline real: retry exitoso conserva IDs/original y termina listo; fallo por etapa queda `processing_failed`; chunks/embeddings/persistencia parciales no dan falso `ready`; retry repetido no duplica artefactos.
- [x] Pruebas Sentry: códigos por etapa permitidos, no emisión en errores esperados, sobre final sin centinelas y fallo de telemetría inocuo.
- [x] UI/Playwright: Admin y QA pueden reintentar fixture fallido; Member no accede; tenant B no puede provocar trabajo en tenant A; éxito y segundo fallo se reflejan con mensajes correctos.
- [x] Ejecutar los controles apropiados: `pnpm typecheck`, `pnpm lint`, unitarias focalizadas, `pnpm test:db` si hay SQL, `pnpm test:integration` para pipeline/Storage y Playwright según soporte local. Ejecutar `pnpm build` si los cambios afectan compilación. No existe `pnpm test` genérico asumido: comprobar scripts actuales.
- [x] Inspeccionar `git diff --check`, regeneración/tipos y diff completo. No ejecutar reset/seed sobre Supabase compartido; usar fixtures locales descartables según Día Cero. No usar `--linked`, migraciones remotas, commit, push, merge o deploy como parte de la aceptación local.

**Criterio de aceptación del ticket:** todas las tareas aplicables están demostradas con evidencia reproducible; Admin/QA pueden reintentar la misma versión fallida de su tenant, solo hay una ejecución por adquisición, los fallos mantienen estado seguro, no hay créditos/documentos duplicados ni exposición cross-tenant, y Sentry no recibe contenido privado. Si falta el ejecutor real de S1-04, el ticket permanece abierto con la dependencia identificada.

## Riesgos y preguntas de integración que deben resolverse antes de ejecutar

1. ¿S1-04 ejecuta parsing y persistencia en la misma petición, o entrega un job a otro runtime? El contrato de retry y la UX de aceptación dependen de esa respuesta.
2. ¿Qué mecanismo recupera un trabajo si el proceso termina después de `processing`? No afirmar cola durable/scheduler/worker existente sin evidencia; acordar un slice mínimo y documentar cualquier límite.
3. ¿Se requiere `attemptId` persistido para idempotencia/telemetría y cuál es su ciclo de vida? Solo agregar almacenamiento si resuelve una necesidad demostrada y coordinada.
4. ¿Cómo se reconcilia un retry exitoso de una versión ya activa o un documento con una versión activa anterior? La persistencia final debe preservar las invariantes de activación de S1-04.
5. La nota del ticket formula la prohibición de Member como “documento global no asignado”; la regla de arquitectura S1 es más estricta: Member no accede al Repository ni reintenta documentos. Usar esta última salvo decisión de producto registrada explícitamente.

## Referencias de documentación técnica

- Context7 resolvió Sentry JavaScript a `/getsentry/sentry-javascript`. La invocación de `docs` no devolvió contenido utilizable en esta sesión; por eso este plan toma el contrato comprobable del helper y del handoff local de S1-08 como fuente para Sentry. Antes de codificar una API nueva, consultar la guía instalada en `node_modules` y repetir Context7 si la herramienta está disponible.
- Reglas locales de Next.js exigen consultar `node_modules/next/dist/docs/` antes de escribir código Next específico. El plan no adopta APIs nuevas de Next; hacerlo es un paso de implementación si la acción/UI elegida las requiere.
- Stack observado en `package.json`: Next.js 16.3.5, React 19.2.8, TypeScript estricto, `@sentry/nextjs` ^10.75.0, Supabase JS 2.117.2, Zod 4.6.5, Vitest 5.0.2, Playwright 1.63.0, pnpm 12.5.1. Revalidar versiones al iniciar implementación.
