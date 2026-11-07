# Aceptación — S2-11 notificaciones terminales

Actualización posterior: ver [corrección del dispatcher local del 2026-11-07](#corrección-del-dispatcher-local--2026-11-07)
para evidencia nueva de aceptación por Resend. Las secciones anteriores a esa
actualización conservan su carácter histórico.

Fecha de evidencia: **2026-11-01**. Entorno: checkout local Windows
`C:\KDM\knowledge-decay-monitor`, Supabase CLI 2.117.0, Node 24.11.0 y
pnpm 12.5.1 invocado con `npx`. La corrida parte de `9ad82a1` con el diff de
Task 8 sin commit. No se consultó ni modificó un proyecto Supabase remoto.

Este registro diferencia compilación y pruebas locales de entrega real. No se
habilitó el dispatcher ni se ejecutaron llamadas a Resend o a Sentry.

## Gates locales

| Comando | Resultado | Evidencia y límite |
|---|---|---|
| `npx --yes pnpm@12.5.1 lint` | PASS | 0 errores; 3 warnings existentes en dos archivos de pruebas de upload. |
| `npx --yes pnpm@12.5.1 typecheck` | PASS | Next typegen y TypeScript finalizaron; Next mostró el aviso existente sobre `onRouterTransitionStart` de Sentry. |
| `npx --yes pnpm@12.5.1 test:unit` | PASS | 116 archivos, 988 pruebas. Tras ampliar el inventario de migraciones se repitió la prueba enfocada: `npx --yes pnpm@12.5.1 exec vitest run tests/unit/analysis-upgrade-policy.test.ts`, 9/9 PASS. |
| `npx --yes pnpm@12.5.1 test:db` | PASS | 33 archivos SQL, 1,305 pruebas. |
| `npx --yes pnpm@12.5.1 check:database-types` | PASS | Los tipos generados coinciden con el esquema local. |
| `npx --yes pnpm@12.5.1 test:fixtures` | PASS | Auth, aislamiento REST y descargas/denegaciones de Storage locales. |
| `npx --yes pnpm@12.5.1 dlx deno@2.9.6 test --config supabase/functions/dispatch-notifications/deno.json --node-modules-dir=none --allow-env tests/edge/notifications-sentry.test.ts` | PASS | 1/1; reporter en memoria. No concede permiso de red ni prueba ingestión real. |
| `node scripts/with-local-supabase.mjs build` | PASS | Build de producción completado. La configuración del wrapper desactiva Sentry. |
| `node scripts/with-local-supabase.mjs e2e --project=chromium` | PARCIAL | 38/45 PASS. Los seis fallos de `processing-retry` se concentraron en el worker local (`modelReady=false`; un caso tampoco encontró el botón Retry). La prueba de upload de diez archivos más 10 MiB no llegó a estado terminal en 120 s. Los seis casos de `notifications-link` pasaron; sus fixtures usan datos sintéticos y limpieza. |
| `npx --yes pnpm@12.5.1 test:integration` | PARCIAL | 33 archivos pasaron; falló el preflight de `analysis-recovery.test.ts` porque encontró el cron local preexistente `kdm-analysis-recovery` activo y se negó a alterarlo. 83 pruebas pasaron y 4 quedaron omitidas en esa corrida. No se desactivó el cron. |
| `CI=true GITHUB_ACTIONS=true node scripts/check-analysis-upgrade.mjs` | NO COMPLETADO | En el proyecto desechable `kdm-s2-11-disposable-20261101`, el arranque de la etapa S1 no superó el health check de Postgres en Docker. El script detuvo y limpió su stack; no llegó a verificar el upgrade histórico. El harness temporal llamó al Supabase CLI instalado directamente porque el shim global de `pnpm` no estaba disponible; no se modificó el harness del repositorio. |
| `git diff --check` | PASS | Sin errores de whitespace en el candidato. |

La forma breve del test Deno (`pnpm dlx deno@2.9.6 test --allow-env ...`) no
resolvió `@sentry/deno` en el entorno local. Se fijó el `deno.json` del módulo y
se desactivó el directorio Node de Deno para aislar las dependencias. El comando
con esa configuración es el que queda en CI y es el que pasó localmente.

## Estado local después de las pruebas

Lectura de solo lectura en `knowledge-decay-monitor-s1-02`, después de
Playwright: el dispatcher sigue deshabilitado, no existe
`kdm-notifications-dispatch`, `upload_control` quedó en `active`, el cron
preexistente `kdm-analysis-recovery` continúa instalado, hay cuatro eventos
globales `pending` y cero leases de correo activos. La consulta anterior
confirmó los controles persistidos de autorización de esos cuatro eventos;
eso no confirma que los buzones estén bajo control del operador. No se copian
IDs ni direcciones de esos eventos a este artefacto.

Los fixtures E2E de S2-11 se eliminaron al terminar. La prueba larga de upload
usa nombres aleatorios y un bloque `finally` de limpieza; su fallo de proceso
no demuestra que el worker haya alcanzado estado terminal.

## Aceptación externa pendiente

- **Resend e inbox:** no enviados. La verificación previa del dominio y el flujo
  de recuperación de contraseña no prueban una clave sending-only utilizable
  ni recepción S2-11. Los cuatro eventos existentes son globales y no se
  confirmó control de sus buzones.
- **Sentry real:** no enviado. El test local solo verifica filtrado/status con
  transporte en memoria; no demuestra ingestión en un proyecto Sentry.
- **CI remota:** no ejecutada porque no se hizo push ni se creó un PR.
- **Scheduler:** sigue cerrado; habilitarlo consumiría el backlog global. Un
  envío real requiere aprobación final de destinatarios controlados, runtime
  privado preparado y verificación del inbox. La prueba Sentry requiere además
  un DSN de prueba y autorización independiente.

La cobertura de integración completa permanece pendiente de un runner limpio
que no contenga el cron de recuperación personal y pueda iniciar Postgres. No
se paró, reseteó ni reconfiguró el stack personal para obtener esos resultados.

## Revisión después del reinicio — 2026-11-02

Se restauraron las dependencias con `npx --yes pnpm@12.5.1 install
--frozen-lockfile` (salida 0, sin cambiar el lockfile). La instalación interrumpida
al cierre anterior había dejado `node_modules` incompleto y faltaba `tsx`.
Este hallazgo explica por qué el worker no podía arrancar hoy; no establece por
sí solo la causa de todos los timeouts del día anterior.

`node --conditions=react-server --import tsx scripts/warm-ingestion-model.ts`
pasó tanto con `INGESTION_MODEL_OFFLINE=1` como sin esa variable: 32 vectores de
384 dimensiones. Las repeticiones E2E usaron el modelo en caché con
`INGESTION_MODEL_OFFLINE=1` y el wrapper local habitual, sin reset de Supabase.

Los siete casos fallidos del 1 de noviembre pasaron en repeticiones enfocadas:

| Repetición Chromium | Resultado |
|---|---|
| `processing-retry.spec.ts -g 'near-expired\|Admin can retry'` | 2/2 PASS. |
| `processing-retry.spec.ts` y `upload.spec.ts`, filtrando QA, aislamiento, URL firmada, crash y carga máxima | 4 PASS; QA reprodujo un fallo distinto: esperaba un mensaje temporal que desaparece al refrescar la fila. |
| `processing-retry.spec.ts -g 'QA Lead can retry'`, tras corregir esa espera | 1/1 PASS. |

El test de QA ahora detiene únicamente su worker de prueba, comprueba el estado
persistido `Queued`, lo arranca y conserva las verificaciones de fallo de
parsing, integridad del documento y ausencia de chunks. El botón que contenía
`Processing queued.` se desmonta cuando la fila pasa a `Queued`; esperar ese
mensaje era una condición de carrera en la prueba.

La recuperación tras matar el worker persistió los 500 chunks y rechazó la
operación anterior (5.7 minutos). La URL firmada expiró después de los cinco
minutos reales. La carga de diez archivos más el original de 10 MiB completó
sus comprobaciones (1.6 minutos). ESLint del archivo modificado y
`tsc --noEmit` pasaron con salida 0.

Esta evidencia cierra la reproducción enfocada de los siete fallos; no es una
nueva corrida de los 45 casos completos. El upgrade y la integración completa
siguen pendientes de CI en un runner limpio. La entrega real Resend/Sentry y
la activación del scheduler continúan pendientes según el runbook.

## CI del PR #29 y estabilización del test de crash

El commit `0cbb4ee` tuvo dos ejecuciones legítimas del workflow: apertura del
PR en borrador (run `41459180132`, PASS completo) y evento `ready_for_review`
(run `41465173976`, fallo en integración). El workflow incluye ambos eventos.
No eran dos versiones diferentes del código.

La segunda ejecución pasó unitarias, SQL, tipos, fixtures y upgrade; falló
únicamente `analysis-worker.test.ts`, caso de recuperación después de matar
el Edge worker (86/87 pruebas de integración pasaron). El helper `backdate`
recibió `TypeError: fetch failed / UND_ERR_SOCKET` en el PATCH de preparación,
inmediatamente después del reinicio de Edge y antes de invocar la recuperación.

Se cambió esa preparación al SQL session del fixture, que ya está conectado
directamente al contenedor de DB. El UPDATE valida UUIDs, filtra análisis y
workspace y devuelve exactamente el ID actualizado. Se conserva la muerte y
el reinicio real del worker y todas las verificaciones de recuperación,
checkpoint, findings, notificación y créditos. No se añadieron reintentos del
test ni se relajaron sus aserciones.

Validación local del ajuste: los cinco casos de `analysis-worker.test.ts`
pasaron (71.95 s), ESLint del archivo y `tsc --noEmit` pasaron. La nueva
ejecución completa de CI corresponde al commit que contiene este ajuste; su
resultado debe comprobarse en el PR antes de integrar.

## Corrección del dispatcher local — 2026-11-07

Entorno: Windows, Supabase local `knowledge-decay-monitor-s1-02`, CLI 2.117.0.
HEAD base `dd8427645535712810e3bb96f7e6e9b1ce278830`, con la corrección de
configuración y sus pruebas sin commit. Esta comprobación corresponde a la
solicitud de reparar el flujo de correo ya habilitado por el operador.

### Reproducción y causa

- Cuatro eventos `analysis_completed`, todos `pending`, `attempt_count=0` y sin
  error. Los cuatro destinatarios coincidían con cuentas de prueba configuradas;
  no se guardaron direcciones ni cuerpos de mensajes en esta evidencia.
- Vault tenía las cuatro entradas sin duplicados; ambos tokens coincidían con
  Edge. Los cron de análisis y notificaciones estaban activos cada minuto y la
  compuerta de dispatch estaba habilitada.
- El runtime inyectaba `SUPABASE_URL=http://kong:8000`. La validación rechazaba
  ese HTTP interno antes de autenticar, consultar PostgreSQL o reclamar eventos.
  La misma configuración, cambiando solo esa URL en memoria por una loopback,
  pasaba validación. No se alteró el env del servicio para hacer esta comparación.
- Un POST con Bearer deliberadamente inválido devolvía 401 en `analyze` y 503
  `not_ready` en `dispatch-notifications`, identificando cuál endpoint fallaba.

### Corrección y resultado observado

El validador acepta los gateways `http://kong:8000` y
`http://api.supabase.internal:8000` únicamente para la URL de Supabase en
`development`. No se amplió la validación del origen web ni se permitieron
otros servidores HTTP. No se cambiaron secretos, cron, migraciones, destinatarios
o estado de eventos mediante SQL.

Edge recargó el cambio. En el siguiente tick ya programado, a las
**22:17:00 UTC**, las dos llamadas cron devolvieron 202. Los cuatro eventos
pasaron a `sent`, `attempt_count=1`, `error_code=NULL` y `sent_at` no nulo entre
22:17:00.699 y 22:17:00.908 UTC. No hubo reenvío manual. El POST con token inválido
al dispatcher pasó a devolver 401, conservando la autenticación.

Lectura final a las 22:19:11 UTC: los cuatro eventos seguían `sent`, con un solo
intento y sin errores. Las seis respuestas cron registradas desde la corrección
eran 202, sin nuevos 503. Ambos schedulers del operador permanecieron activos.

| Validación nueva | Resultado |
|---|---|
| Baseline de los dos archivos unitarios afectados | PASS, 42 pruebas. |
| Regresiones antes de corregir | 4 fallos esperados: readiness y handler rechazaban ambos gateways. |
| Pruebas focalizadas después de corregir | PASS, 56 pruebas. |
| `pnpm.cmd test:unit` | PASS, 116 archivos y 1.002 pruebas. |
| `pnpm.cmd typecheck` | PASS; aviso existente de instrumentación de navegación Sentry. |
| `pnpm.cmd lint` | PASS, 0 errores y 3 warnings existentes en pruebas de upload. |

Esto demuestra aceptación por Resend de los cuatro mensajes mediante el
scheduler y dispatcher reales. **No certifica recepción en inbox ni navegación
del enlace**: requieren comprobación del operador. No se ejecutaron aquí SQL,
integración, Playwright, build ni smoke de ingestión real Sentry. No se hizo
commit, push ni despliegue remoto.
