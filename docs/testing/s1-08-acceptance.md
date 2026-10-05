# S1-08 — Evidencia local y límites de aceptación

Revisión local: 2026-10-04 UTC. Base observada: `0d0dd39953f34ce490065fd40c5ca1f6f2938ef9`; los cambios de S1-08 permanecen sin commit. No se ha ejecutado el workflow remoto ni se ha enviado un evento a Sentry.

## Controles ejecutados

| Control | Resultado | Límite |
|---|---|---|
| `npm run lint` | 0 errores, 5 warnings | Los warnings son de reglas React Hook en `src/modules/ingestion/processing.ts` y dos pruebas existentes de ingesta/mantenimiento. |
| `npm run typecheck` | Aprobado | Verifica tipos locales; no acredita un deployment. |
| `npm run test:unit` | 47 archivos, 327 pruebas aprobadas | Incluye política de publicación y ejecutor Vercel con procesos/API falsos; no usa servicios hospedados. |
| `npm run test:db` en el stack descartable `.artifacts/s1-02-clean-install` vía `SUPABASE_WORKDIR` | 9 archivos, 198 pruebas aprobadas | Stack local aislado en el rango de puertos 54421–54429; reset solo de esa base descartable, con migraciones y seed locales. |
| `npm run check:database-types` con el mismo `SUPABASE_WORKDIR` | Aprobado | Los tipos coinciden con el esquema local aislado. |
| `npm run test:fixtures` contra Supabase local de 54321 | Aprobado: 4 logins Auth, aislamiento REST, 3 descargas firmadas, 3 denegaciones, bucket privado y RPC legacy denegada | Antes de ejecutar, la reconciliación no tenía filas pendientes en los workspaces de fixtures. No se accedió a Supabase remoto. |
| `npm run test:e2e:local -- tests/e2e/observability.spec.ts` | 2/2 Chromium aprobadas | E2E focalizado; el runner desactiva Sentry y los controles no suben eventos. |
| Build local `node scripts/with-local-supabase.mjs build` | Aprobado durante la verificación de la tarea 4 | Build local; no es un build de Vercel. |
| `node --check` de `deploy-vercel.mjs`, `deployment-policy.mjs` y `sentry-local-smoke.mjs` | Aprobados | Sintaxis de scripts; no ejecuta Vercel, GitHub Actions ni envía eventos. |
| `git diff --check` | Aprobado en la revisión local previa | Revisión del diff; no es una prueba de workflow remoto. |

## Estado del stack local personal

El stack conservado en el puerto 54321 no es una instalación limpia. Su prueba SQL detectó dos diferencias en fixtures previos: cinco documentos v1 incompletos donde la aserción espera dos y `private.upload_control = active`. No se reseteó ni se alteró ese stack. La suite completa de integración, el E2E de uploads y la prueba de reinicio de Auth no se ejecutaron contra él: el E2E cambia el modo global de upload y puede crear datos persistentes.

El stack descartable de `.artifacts/s1-02-clean-install` sí permitió pasar DB y consistencia de tipos, pero está configurado en 54421; los helpers de integración y Playwright existentes exigen 54321. Por tanto, la suite completa de integración/E2E sobre una instalación limpia queda pendiente de un runner aislado que pueda usar ese puerto sin detener el stack personal.

## Sin evidencia remota todavía

La revisión local no demuestra que GitHub haya ejecutado el job `Quality gates`, que Vercel publique únicamente el SHA aprobado, ni que Sentry haya recibido un evento de Preview o Production. El inventario remoto de solo lectura y sus bloqueos están en [s1-08-cutover.md](./s1-08-cutover.md). Esa evidencia se registrará por entorno después del corte operativo y se distinguirá del receipt local del SDK.

El handoff técnico para los tickets S1-04 y S1-07 está en [s1-08-ingestion-handoff.md](./s1-08-ingestion-handoff.md). No reemplaza sus implementaciones ni acredita integración con un worker real.
