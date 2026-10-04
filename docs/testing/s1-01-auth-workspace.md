# S1-01 — ejecución y validación local de Auth/Workspace

Esta guía cubre el flujo de registro, sesión SSR, creación inicial del Workspace, rutas privadas y recuperación de contraseña contra Supabase local. La UI se sirve en `http://127.0.0.1:3000`; la API local de Supabase usa `http://127.0.0.1:54321`.

## Requisitos

- Node.js 24.11.0 y pnpm 12.5.1, según `package.json` y el workflow.
- Docker Desktop activo.
- Puertos locales 3000, 54321 y 54324 disponibles.
- Chromium instalado para Playwright: `pnpm exec playwright install chromium`.

## Variables locales

Next.js lee `.env.local` desde la raíz. El archivo existe en este checkout y la regla `.env*` de `.gitignore` lo excluye de Git. Debe contener solo la URL y la clave publicable local:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<clave publicable del proyecto local>
```

La clave debe ser la publishable key del stack local. No usar una `service_role` o secret key en estas variables. No copiar la salida completa de `supabase status` a tickets, logs o artefactos. Los runners de build, integración y E2E consultan el status local y entregan la clave al proceso hijo sin imprimirla.

## Arranque

Desde la raíz del repositorio:

```powershell
pnpm install --frozen-lockfile
node scripts/local-supabase-lifecycle.mjs start
pnpm dev
```

El helper de ciclo de vida llama a la CLI instalada para este proyecto, comprueba la API local esperada y oculta la salida que contiene claves. Para detener el stack al terminar:

```powershell
node scripts/local-supabase-lifecycle.mjs stop
```

La configuración en `supabase/config.toml` fija `site_url = "http://127.0.0.1:3000"` y permite `http://127.0.0.1:3000/auth/callback`. Mantener el mismo hostname en el navegador, `.env.local`, Playwright y Supabase; `localhost` y `127.0.0.1` son orígenes distintos para las cookies.

El proveedor Email debe estar habilitado y la confirmación de email desactivada (`enable_confirmations = false`). Esto permite que el registro local devuelva una sesión sin depender de una confirmación externa.

## Sesiones y cookies

- Los Server Components usan el cliente SSR de solo lectura porque `cookies()` no permite escribir durante el render.
- Server Actions y Route Handlers usan el cliente con capacidad de escritura.
- `src/proxy.ts` actualiza las cookies en el request y en la respuesta para que la renovación de sesión llegue al navegador.
- El callback valida `token_hash` y `type=recovery`; solo después de verificarlo escribe la sesión en cookies y redirige a `/reset-password`.
- `/reset-password` autoriza desde la sesión persistida en cookies. Recargar la página conserva esa sesión; el enlace de correo queda consumido y no es la fuente de autorización de la pantalla.

## Recuperación y reinicio

Supabase local intercepta los mensajes en Mailpit (`http://127.0.0.1:54324`); no los entrega a direcciones externas. La plantilla vive en `supabase/templates/recovery.html` y `supabase/config.toml` la carga mediante `content_path`. El enlace debe conservar este formato, con `&amp;` en el HTML:

```text
{{ .RedirectTo }}?token_hash={{ .TokenHash }}&amp;type=recovery
```

Si se cambia `config.toml` o la plantilla, reiniciar el stack local para que Auth recargue la configuración:

```powershell
node scripts/local-supabase-lifecycle.mjs stop
node scripts/local-supabase-lifecycle.mjs start
pnpm test:auth:restart
```

La prueba de reinicio crea un usuario sintético, verifica que pueda autenticarse tras `stop/start` y comprueba que Auth genere un enlace de recuperación distinto antes y después. No ejecuta `db reset`, no usa `--linked` y deja esas cuentas sintéticas en la base local.

## Suite completa

Con Docker y Supabase local activos, ejecutar en este orden:

```powershell
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:db
pnpm test:fixtures
pnpm test:integration
node scripts/with-local-supabase.mjs build
pnpm exec playwright install chromium
pnpm test:e2e:auth
pnpm test:auth:restart
node scripts/local-supabase-lifecycle.mjs stop
```

`test:integration`, `test:e2e:auth` y el build local usan `scripts/with-local-supabase.mjs`, que rechaza URLs distintas a `127.0.0.1:54321`, desactiva Sentry para estos procesos y no imprime claves. La prueba de reinicio debe ejecutarse sin otras suites Auth simultáneas porque reinicia los servicios locales.

La suite cubre clientes SSR y Proxy, ausencia de Profile y bootstrap concurrente, recuperación tras perder una respuesta de RPC, aislamiento de Member, privacidad de errores Auth, rechazo de rutas privadas anónimas, registro/onboarding/login/logout, rechazo diferenciado de token de acceso vencido y JWT malformado, callback con enlace de recuperación vencido o malformado, recuperación en otro contexto de navegador, recarga de `/reset-password` y replay del enlace consumido. Playwright inicia el build de producción con `next start`.

## Diagnóstico rápido

| Síntoma | Comprobación |
|---|---|
| El callback responde `redirect_to` no permitido | Confirmar que navegador, `site_url` y allowlist usan exactamente `127.0.0.1`, puerto 3000 y ruta `/auth/callback`. |
| El registro no crea sesión | Verificar proveedor Email habilitado, confirmación desactivada y stack local iniciado desde la raíz del proyecto. |
| No llega el enlace o falta `token_hash` | Revisar el mensaje local en Mailpit, `content_path` y la plantilla; reiniciar Supabase local después de cambiar la configuración. No copiar el enlace a logs o tickets. |
| La sesión falla al renderizar o refrescar | Confirmar que los Server Components usan el cliente de lectura y que Server Actions/Route Handlers usan el writable; el Proxy debe propagar cookies al request y a la respuesta. |
| La suite informa API local no disponible | Iniciar Docker y ejecutar `node scripts/local-supabase-lifecycle.mjs start`; confirmar que ningún proceso cambió el hostname a `localhost`. |
| `test:auth:restart` falla en readiness | Esperar a que el endpoint local de Auth responda; el test tiene un límite de 30 segundos y no interpreta solo el estado de la CLI como readiness. |

No resetear la base para limpiar estos tests: preservan los datos existentes y generan usuarios locales sintéticos. `npm run test:db` valida el esquema y RLS sobre el stack ya iniciado.

## Evidencia de esta implementación

| Verificación local | Resultado |
|---|---|
| Lint | Pass |
| Typecheck | Pass |
| Unitarias | 60/60 |
| pgTAP local | 78/78 |
| Fixtures HTTP (Auth, REST y Storage) | Pass |
| Integración | 5/5 |
| Playwright Auth/Workspace sobre build de producción | 6/6 |
| Reinicio local y plantilla de recuperación | Pass; usuario persistente y token de recuperación regenerado |
| Build de producción | Pass |

El workflow `.github/workflows/s1-01.yml` queda preparado para PRs y pushes hacia `develop` y `main`, con Supabase efímero y sin secretos alojados. Esta validación local no ejecuta el workflow en GitHub ni configura reglas de rama o checks requeridos; esas dos condiciones quedan pendientes de confirmación en el repositorio remoto.

El build actual muestra un aviso de Sentry: `withSentryConfig` debe importarse desde `@sentry/nextjs/config` antes de actualizar a Sentry v11. No bloquea typecheck, build ni las pruebas de este ticket.
