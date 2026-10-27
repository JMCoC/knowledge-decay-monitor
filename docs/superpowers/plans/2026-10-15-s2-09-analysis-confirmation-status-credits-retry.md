# Plan S2-09 — Confirmación, estados de análisis, créditos y Retry Analysis

> Estado: implementación realizada en `feature/analysis-confirmation-status-credits-retry`. S2-05, S2-06 y S2-08 están integrados; cinco recorridos Playwright y la suite unitaria completa pasan. El resultado vacío sigue pendiente de S2-10. La suite de integración completa conserva una excepción por un job cron local preexistente que el test se niega a modificar.

## Objetivo

Completar el flujo de producto desde el selector S2-03: mostrar la estimación persistida de S2-04, confirmar una sola ejecución mediante S2-05, seguir su estado persistido hasta el resultado terminal, consultar créditos y reintentar un fallo con una nueva estimación y confirmación. El trabajo se limita a presentación y recuperación de S2-09; las reglas de reserva, ejecución, recuperación automática y liquidación pertenecen a sus módulos propietarios.

## Fuentes y estado observado en este checkout

- Ticket: [`sprint-2-ai-analysis.md`](../../Tickets/sprint-2-ai-analysis.md), sección S2-09.
- Reglas: PRD §§24–32, 34, 42, 56 y 66; ADR-001; Protocolo del Día Cero; contrato `src/types/contracts.ts`.
- S2-03 tiene `/analysis/run` y la estimación real de S2-04. El botón de continuación aún es un `window.alert` de placeholder en `src/modules/analysis/ui/run-analysis-view.tsx`.
- `src/modules/credits/queries.ts` ya expone `getCreditSnapshot` (para cualquier rol miembro del workspace) y `listCreditLedger` (Admin/QA Lead). No hay todavía página Billing / Credits ni enlace en `AppShell`.
- Los contratos `AnalysisApi` y `AnalysisSnapshot` describen Run, Retry, lectura por ID y lectura del activo; el barrel público de `src/modules/analysis` todavía no exporta esas operaciones reales.
- S2-05 aporta Run/Retry, idempotencia y reserva atómica; S2-06 aporta worker/transiciones; S2-08 aporta liquidación/liberación terminal y publicación de findings. No existe ruta de resultados de S2-10 en este checkout.
- No se prevé migración de S2-09: usar las APIs públicas y la persistencia propiedad de los tickets previos. Cualquier necesidad de esquema o contrato compartido requiere coordinación explícita.

## Límites de arquitectura y seguridad

- La sesión verificada y el Profile persistido son la autoridad de tenant y rol. No recibir `workspaceId`, rol, saldo ni coste autoritativos del cliente.
- La UI consume acciones públicas de `analysis`, `credits` e identidad; no consulta/escribe tablas de otros módulos desde componentes ni añade HTTP interno.
- El servidor valida entradas y cada lectura por ID vuelve a autorizar workspace, actor y RLS. El ID de análisis no concede acceso.
- Member puede ver únicamente el saldo autorizado por `getCreditSnapshot`; ledger, análisis y findings permanecen denegados. Admin y QA Lead pueden consultar el ledger.
- No mostrar desglose de chunks/pares, texto privado, confianza, contenido raw del proveedor ni URLs firmadas. Mensajes de fallo son controlados y telemetría conserva solo campos permitidos.
- La UI no presenta un Run como exitoso por recibir un HTTP 2xx: solo el estado persistido y validado representa el resultado.
- No duplicar APIs de Run/Retry, recuperación del worker, liberación/liquidación de créditos o consultas de findings que pertenecen a otros tickets.

## Decisiones de interacción propuestas

1. Dentro del selector S2-03, reemplazar el alert por una confirmación accesible que presente solo `Estimated cost: X credits`, habilitada únicamente si el alcance actual tiene una estimación vigente. Si cambia el alcance, invalidar la estimación, el estado de confirmación y la clave del intento.
2. Guardar en `sessionStorage` únicamente el par opaco `estimateRef`/`idempotencyKey` del intento pendiente para que una recarga de la misma pestaña pueda repetir con seguridad la petición idempotente. No persistir selección ni contenido documental en ese mecanismo. La semántica debe verificarse contra S2-05; su backend es quien garantiza que repetir la clave devuelve la misma ejecución sin otra reserva.
3. Al recibir `analysisId`, navegar a una ruta de seguimiento por ID. El detalle vuelve a consultar al servidor, muestra iniciador, fechas, fuentes/comparaciones exactas, coste y estado. Al volver a la app, recuperar el activo por el API público; si el usuario conserva una URL por ID, consultar el snapshot terminal autorizado.
4. Hacer polling solo para `queued`/`processing`, con intervalo acotado y backoff, detenerlo al llegar a estado terminal o al límite y ofrecer actualización manual. El polling es lectura; cerrar la pestaña o cerrar sesión no cancela el job.
5. En `completed`, ofrecer navegación al resultado del mismo `analysisId`; la ruta y el estado vacío sin findings se coordinan con S2-10. No implementar un listado paralelo de findings.
6. En `failed`, mostrar el fallo controlado y el saldo actualizado solo después de releer el snapshot del ledger. Mostrar Retry únicamente si el backend permite reintento. Retry vuelve a estimar el scope exacto persistido, muestra el nuevo coste y requiere confirmación explícita antes de llamar a S2-05 con una clave nueva.

## Gates de dependencias

Antes de cerrar S2-09 deben estar integrados y revisados:

- **S2-05:** `runAnalysis`, `retryAnalysis`, persistencia de idempotencia, recuperación ante respuesta perdida, conflictos y reserva atómica.
- **S2-06/S2-08:** transiciones persistidas, snapshot de estado y timestamps; fallo terminal con release confirmado y `canRetry` coherente.
- **S2-10:** ruta pública/contrato de resultados por `analysisId` y estado vacío cuando no existan findings. S2-08 ya publica findings, pero S2-10 no está integrado en este checkout.
- **S2-02:** las consultas públicas de snapshot/ledger ya existen aquí; confirmar que el esquema/rpc integrado coincide con su contrato y sus permisos Member/Admin/QA.

Se puede avanzar en paralelo con la página Credits, estados visuales, tests de presentación y wiring de S2-03/S2-04, pero la aceptación final debe probar los contratos reales de extremo a extremo. Si una dependencia aún no está mergeada, marcar los pasos de integración como bloqueados por esa dependencia, no reemplazarla con mocks.

## Tareas

### 1. Revalidar contratos y dependencias

- Revisar contratos y acciones públicas reales de S2-02, S2-04, S2-05, S2-06, S2-08 y S2-10 en la rama integrada.
- Confirmar la estrategia de reejecución idempotente después de recarga, incluyendo el caso en que la ejecución haya alcanzado estado terminal antes de la recarga.
- Confirmar con S2-10 el destino de findings por `analysisId` y los roles permitidos.
- No cambiar `src/types/contracts.ts` sin revisión de Dev 1 y consumidores.

### 2. Billing / Credits

- Crear página autenticada Billing / Credits en `src/app/(workspace)/credits/page.tsx` usando `getCreditSnapshot` y `listCreditLedger` desde el barrel público.
- Mostrar `available` y `reserved` para Admin, QA Lead y Member; mostrar ledger paginado solo para Admin/QA Lead. Member que manipule URL o acción recibe `FORBIDDEN` para el ledger.
- Añadir la entrada de navegación a `AppShell` y reflejar la ruta activa sin modificar el layout compartido más de lo requerido.
- Incluir estados loading, vacío, paginación y error controlado; excluir checkout/paquetes S4.
- **Implementado:** ruta `/credits`, saldo para cualquier miembro, ledger paginado solo Admin/QA Lead y enlace activo en `AppShell`. Playwright confirma que Member ve el saldo, no ve el ledger y su RPC directo de ledger devuelve `42501`; las consultas unitarias cubren paginación.

### 3. Confirmación y envío de Run

- Reemplazar el placeholder del selector por el paso de confirmación integrado con `estimateAnalysis`.
- Mostrar solo el coste total y bloquear confirmación si expiró, cambió el scope o la estimación falló.
- Generar una clave idempotente nueva por intento confirmado; mantener la misma clave en doble clic, timeout, respuesta perdida y recuperación tras recarga.
- Invocar `runAnalysis` desde una acción pública validada, sin aceptar workspace/rol/coste del cliente. Presentar errores controlados de saldo insuficiente, análisis activo, scope obsoleto y conflicto de idempotencia.
- Navegar al seguimiento solo con el `analysisId` devuelto por el backend; las repeticiones con la misma clave no deben reservar de nuevo.
- **Implementado:** diálogo de confirmación/coste, invalidación al cambiar scope, llamada a S2-05, errores controlados, replay de clave desde `sessionStorage` y navegación por ID. Playwright ejercita el cambio de scope y la invalidación del coste; duplica concurrentemente el Server Action, pierde la respuesta y recupera el mismo `analysisId` tras reload, verificando que solo hay una reserva.

### 4. Recuperación y seguimiento por ID

- Implementar página/consulta protegida del snapshot por `analysisId` usando el API público de análisis.
- Recuperar un análisis activo al entrar a la aplicación y mantener una ruta directa para restaurar un análisis por ID tras logout/login.
- Renderizar `Queued`, `Processing`, `Completed` o `Failed` exclusivamente desde snapshots persistidos, con coste, iniciador, timestamps y scope exacto.
- Para estados activos, aplicar polling acotado con backoff; detener al terminar, al límite o al perder la sesión, y ofrecer refresh manual. No interpretar errores de red como transiciones de estado.
- Probar autorización de Admin/QA, Member y tenant cruzado en la lectura directa por ID.
- **Implementado:** acción protegida por rol y lectura de vistas con sesión/RLS; ruta por ID, recuperación activa al entrar en Run Analysis, refresh manual y polling acotado. `canRetry` se deriva de un evento `Released` visible al actor con importe igual al coste persistido. Playwright verifica Admin/QA en los flujos Run/Retry/seguimiento, logout/login, estados `Queued`, `Processing`, `Completed` y `Failed`, y denegación de Member para análisis propios y de otro tenant.

### 5. Resultado completado y fallo/retry

- En `completed`, enlazar al destino de findings de S2-10 conservando el mismo `analysisId`; el destino debe representar correctamente cero resultados.
- En `failed`, releer estado y saldo tras confirmación backend de release; nunca inferir release a partir de un error HTTP.
- Habilitar Retry solo con permiso y elegibilidad reportados por backend. Reestimar las versiones exactas del run fallido, presentar el coste nuevo y requerir otra confirmación.
- Ejecutar retry con `failedAnalysisId` y una nueva clave idempotente. Mostrar saldo insuficiente, conflicto por otro run activo, scope no elegible o estimación vencida sin sobrescribir el run fallido ni generar cargos no confirmados.
- **Implementado:** cuando S2-08 confirma la liberación, la vista reestima el scope exacto, pide confirmación del nuevo coste y llama a S2-05 con una clave idempotente nueva; conserva la clave opaca para recuperar una respuesta perdida. Playwright verifica el fallo con release visible, confirmación del nuevo coste, creación de una ejecución enlazada y preservación del run fallido.

### 6. Cobertura de calidad y aceptación

- Unitarias: estado de confirmación/invalidación, clave por intento, retry, polling/backoff, errores controlados, Member vs Admin/QA y paginación de créditos.
- Integración local: APIs reales de snapshot/ledger, Run/Retry, estado activo/terminal y release; verificar tenant y que no haya doble reserva.
- Playwright local ejecutado (5 escenarios): invalidación al cambiar scope, doble envío concurrente, respuesta perdida + reload sin segundo cargo, logout/reingreso de QA, estados persistidos, fallo/release/retry, Member sin ledger ni acceso a análisis propio/de otro tenant, RPC de ledger denegado y ausencia de texto de chunks en la UI. La prueba unitaria de privacidad verifica que la telemetría de análisis reconstruye solo campos permitidos. **Pendiente:** completed vacío (se hará con S2-10).
- Verificar que DOM, respuestas de UI y telemetría no contengan texto documental, confidence, prompts, datos crudos del proveedor o URLs firmadas.
- Controles apropiados: `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, pruebas de integración de los módulos reales, `pnpm test:db`, y los escenarios Playwright del ticket con Supabase local y fixtures. No usar base remota ni presentar mocks como aceptación.

## Matriz de aceptación

| Criterio S2-09 | Tarea | Evidencia esperada |
|---|---:|---|
| Coste explícito antes de confirmar; cambios invalidan confirmación | 3 | Prueba UI + recorrido Playwright |
| Balance/ledger y permisos por rol | 2 | Pruebas de acción/RLS + ruta Member/Admin/QA |
| Run idempotente ante doble clic, pérdida de respuesta y reload | 3, 6 | Integración concurrente y Playwright |
| Estados persistidos; errores HTTP no son éxito | 4, 6 | Pruebas de transición y recuperación |
| Seguimiento por ID, polling acotado, logout no detiene job | 4 | Prueba de autorización, polling y logout/login |
| Completed abre findings del mismo ID y acepta cero resultados | 5 | Integración con S2-10 y Playwright |
| Failed muestra error y release confirmados; retry reestima y confirma | 5 | Integración con S2-05/S2-08 y Playwright |
| Retry conserva antecedente y resuelve saldo/conflicto/scope/coste | 5 | Pruebas de casos y ledger sin cargo inesperado |
| Contexto mínimo exacto, sin History de S4 | 4 | Pruebas de render y contrato de snapshot |
| Privacidad y roles cubiertos en UI/E2E | 6 | Auditoría de DOM, payloads y telemetría |

## Condición de cierre

El ticket se considera completo cuando las diez filas de aceptación están verificadas con las implementaciones reales de sus dependencias. El plan no incluye crear el worker, reserva/ledger, publicación de findings, checkout, History de S4 ni acciones humanas de S3.

## Evidencia de esta implementación

- `pnpm typecheck`: pasó. Next mostró un aviso ya existente de hook de navegación de Sentry.
- `pnpm lint`: pasó con 0 errores y 3 warnings preexistentes en dos tests de ingesta.
- `pnpm test:unit`: 103 archivos y 873 pruebas pasaron; la prueba real DOCX/PDF tiene un timeout dedicado de 30 s para no fallar por el coste del parser en frío.
- `pnpm test:db`: pasó, 29 archivos y 1.197 pruebas SQL. Antes se aplicaron las migraciones locales pendientes de S2-05/S2-06/S2-08; no hubo reset ni conexión remota.
- Integración dirigida (`analysis-run`, `analysis-finalization`, `analysis-isolation`, `credits-access`): pasó, 4 archivos y 9 pruebas.
- `pnpm test:integration`: 29 archivos y 66 pruebas pasaron; el único fallo de suite fue el guard de `analysis-recovery`, que encontró activo un job cron local preexistente `kdm-analysis-recovery` y se negó correctamente a modificarlo; hubo 4 casos omitidos en ese archivo.
- Integración dirigida del worker (`analysis-worker.test.ts`): 5/5 pruebas pasaron después de ampliar los límites de arranque del runtime Edge local.
- Privacidad/parsers dirigidos: 2 archivos, 21 pruebas pasaron.
- `pnpm typecheck`: pasó. Next mostró el aviso de hook de navegación de Sentry.
- `pnpm lint`: 0 errores y 3 warnings preexistentes en dos tests de ingesta.
- `git diff --check`: sin errores de whitespace.
- `pnpm build`: pasó con el aviso existente de hook de navegación de Sentry.
- `pnpm test:e2e:local -- tests/e2e/analysis.spec.ts`: pasó, 5/5 escenarios contra Supabase local; no se usó base remota.
- El job cron preexistente se dejó intacto. El test `analysis-recovery` debe repetirse cuando ese horario local ya no esté configurado.

Por tanto, esta entrega integra S2-08 y su Retry, tiene cinco recorridos Playwright aprobados y una suite unitaria verde. El ticket **no está cerrado** hasta integrar S2-10 y validar completed vacío. La suite de integración tiene un único fallo de preflight por el job cron local preexistente; no se alteró esa configuración.

## Nota sobre herramientas solicitadas

La skill `brainstorming` no aparece en el catálogo ni en las rutas de skills instaladas disponibles en este entorno; se usó una revisión estructurada del ticket, PRD, contratos y arquitectura. Context7 se consultó durante la implementación para Server Actions y seguridad del App Router. También se revisaron las guías locales de Next.js 16.3.5.
