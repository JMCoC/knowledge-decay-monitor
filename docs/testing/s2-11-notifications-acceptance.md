# Aceptación — S2-11 notificaciones terminales

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
