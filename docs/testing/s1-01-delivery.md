# S1-01 — entrega y preparación de Preview en Vercel

Revisión del 2026-09-29. Destino: Vercel Preview de `develop` y Production en Vercel. La [guía paso a paso del backend compartido](despliegue-supabase-compartido.md) registra el estado comprobado y las tareas pendientes.

## Estado y aceptación

La implementación cubre la entrega local aprobada. La validación histórica está en [la guía local](s1-01-auth-workspace.md); el usuario también confirmó sus pruebas manuales. No equivale a una validación alojada.

| Requisito S1-01 | Implementación / evidencia |
|---|---|
| Email/password, registro y sesión | Identity actions, schemas, formularios y E2E onboarding |
| Workspace inicial con Admin, único por usuario y creación atómica | RPC existente `bootstrap_workspace`, restricciones SQL, integración bootstrap y pgTAP |
| Zod en formulario y Server Action | Workspace onboarding-form, schemas y actions |
| Shell responsive y acceso privado | Layout privado, AppShell, Proxy y pruebas de acceso |
| Aislamiento entre workspaces | Identidad verificada, Profile persistido, consultas con sesión/RLS y pruebas SQL |
| Forgot Password | Recovery callback, cookies SSR, reset-password; E2E de recarga, replay y enlace vencido |
| Migraciones versionadas | `supabase/migrations/00001_initial_schema.sql`, ya existente; S1-01 no añade migraciones |
| CI antes de integrar | Workflow incluido; pendiente primera ejecución remota y regla de rama que exija su resultado |

Los clientes SSR separan lectura en Server Components y escritura en Actions/Handlers. Proxy propaga cookies al request y response. Los orígenes locales y la plantilla se mantienen como se aprobaron. Las pruebas locales incluyen persistencia de la plantilla después de stop/start.

## Orígenes y callbacks

`src/lib/app-origin.ts` resuelve el origen local o lee y valida `APP_ORIGIN` en tiempo de solicitud. En Vercel requiere HTTPS y rechaza orígenes con credenciales, ruta, query o fragmento. La acción de recuperación y el callback comparten este origen.

`APP_ORIGIN` quedó configurada en Vercel con el dominio de develop para Preview y el dominio de Production para Production. Si falta en Vercel, Auth falla cerrado. No derivar destinos del header Host ni de un parámetro `next` del navegador. Las pruebas cubren orígenes locales y alojados.

Elegir la URL estable de la rama `develop` que muestra Vercel, no una URL de commit. Supabase puede conservar Production como Site URL; la plantilla usa `.RedirectTo`, que recibe el callback del entorno solicitante.

## Supabase alojado compartido

Preview y Production usan el mismo proyecto Supabase gratuito, por lo que comparten cuentas, contraseñas, workspaces y datos. La migración inicial ya está aplicada y S1-01 no requiere otra. No ejecutar seed, fixtures ni reset sobre este proyecto.

Seguir la [guía del backend compartido](despliegue-supabase-compartido.md) para la configuración canónica de Auth: Site URL de Production, callbacks de ambos dominios, plantilla con `{{ .RedirectTo }}`, estado de confirmación de Email y SMTP. La configuración hospedada de Auth/SMTP sigue pendiente de comprobación manual; no se sincroniza desde `supabase/config.toml` ni desde Git.

## Vercel

- Confirmar conexión al repo, framework Next.js, raíz del proyecto y que `develop` genere **Preview**, manteniendo la rama de producción separada.
- Configurar variables para **Preview / rama develop y Production**. No copiar `.env.local` al repo ni reutilizar valores de localhost.

| Variable | Valor / alcance |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Presente para Preview/develop y Production; confirmar que ambos valores apunten al proyecto compartido |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Presente en ambos scopes; confirmar igualdad sin exponerla, nunca usar una secret key aquí |
| `SUPABASE_SERVICE_ROLE_KEY` | Production presente; **Preview falta**. Añadir sensible, solo servidor, para S1-02 |
| `APP_ORIGIN` | Presente en ambos scopes; confirmar el origen HTTPS de Preview y el de Production |
| `SENTRY_AUTH_TOKEN` | Secreto de build, solo si se habilita subida de source maps; nunca `NEXT_PUBLIC_*` |

- Usar Node 24.x compatible con la configuración probada y pnpm 12.5.1 fijado en `packageManager`. Instalación: `pnpm install --frozen-lockfile`; build: `pnpm build`. El runner `scripts/with-local-supabase.mjs` es exclusivo de pruebas locales/CI; no usarlo en Vercel.
- Configurar variables públicas antes del build y volver a desplegar al cambiarlas. No promover el artefacto local de CI: contiene configuración local de Supabase.
- Verificar acceso del equipo a Deployment Protection para que pueda abrir los enlaces de recuperación desde otro navegador.
- El workflow actual prueba el proyecto; **no despliega ni condiciona automáticamente la integración Git de Vercel a GitHub Actions**. Proteger la integración a develop y configurar la política de despliegue adecuada si se exige que tampoco se publique ningún Preview antes de finalizar CI.

## GitHub y subida

1. Revisar el staged y confirmar que no incluye variables, secretos, salidas de runtime ni archivos ajenos.
2. Hacer commit en la rama del ticket y push cuando se decida publicar. No hace falta introducir credenciales remotas para el workflow S1-01: usa Supabase local efímero en el runner.
3. Abrir PR hacia `develop`. El workflow se dispara en PRs hacia `develop`/`main` y pushes a esas ramas; un push aislado a la rama feature no basta.
4. Esperar el primer resultado real de `S1-01 Auth and Workspace` / job `auth-workspace`. Corregir cualquier diferencia del runner Ubuntu antes de integrar.
5. Configurar reglas de rama para exigir revisión y el check observado, impedir bypass/push directo según la política del equipo. Tener un YAML no bloquea por sí solo un merge.
6. Integrar tras checks verdes y adaptación/configuración del origen. Validar el Preview de develop antes de dar por cerrada la entrega alojada.

Durante esta revisión se deshabilitó la caché automática de setup-node: el workflow intentaba resolver el store de pnpm antes de instalarlo. Mantiene instalación con lockfile; no agrega otra action para resolver ese orden.

## Sentry

El DSN ya está fijado en los archivos client/server/edge, y `next.config.ts` apunta al proyecto `knowledge-decay-monitor` de `saas-project-kdm`. Confirmar que es el destino deseado. Añadir `SENTRY_DSN` o `NEXT_PUBLIC_SENTRY_DSN` no lo cambia: esos archivos actualmente no los leen.

Para source maps, configurar el token de build del proyecto con permisos mínimos adecuados. Las opciones `KDM_DISABLE_SENTRY` y `NEXT_PUBLIC_KDM_DISABLE_SENTRY` son switches locales de pruebas; no dejarlas en `1` si se quiere verificar telemetría en Preview. Un build Preview de Next usa `NODE_ENV=production` y puede emitir eventos.

La política actual solo envía fallos Auth marcados y reconstruidos con operación, código controlado e identificador de correlación. Descarta eventos automáticos, breadcrumbs y trazas; no ofrece observabilidad general de Ingestion/Repository. Verificar recepción de un fallo controlado sin publicar tokens ni datos de usuario. La cobertura global y gates del sprint siguen siendo parte de S1-08.

## Prueba de aceptación alojada

Con una cuenta de prueba y el mismo dominio canónico:

1. Registrar usuario, crear Workspace, comprobar Profile Admin y entrada al shell.
2. Salir; comprobar que una ruta privada no abre sin sesión; volver a entrar.
3. Solicitar recuperación, recibir correo real y abrirlo en otro contexto de navegador autorizado para Preview.
4. Confirmar que callback y reset-password permanecen en HTTPS en el dominio de develop; recargar reset-password y cambiar contraseña.
5. Confirmar que la contraseña anterior falla, la nueva funciona y reutilizar el enlace no permite otro intercambio.
6. Verificar aislamiento con dos Workspaces y que Member no ve la navegación Repository.
7. Comprobar el evento seguro de Sentry y ausencia de datos sensibles en logs. Si falla Auth/recuperación, detener la promoción; volver al despliegue conocido y revisar la configuración, sin resetear la base.

## Uso por los otros desarrolladores

- **Dev 2 / Ingestion:** `requireActor()` desde `@/modules/identity` entrega userId, workspaceId y rol derivados de sesión/Profile. Debe seguir autorizando cada upload/retry según rol y RLS; obtener Actor no concede automáticamente un permiso de operación.
- **Dev 3 / Repository:** dispone del mismo contexto y de `getOwnWorkspace()` desde `@/modules/workspace`, además de shell y sesión SSR. Puede conectar su ruta al shell cuando exista; Repository todavía es una entrada deshabilitada.
- Ambos pueden usar los clientes técnicos de `src/lib/supabase`, contratos/tipos existentes y fixtures locales. Imports entre módulos pasan por `index.ts`; los barrels de servidor no se importan en componentes cliente.
- S1-02 y S1-08 reciben una base de identidad, aislamiento y pruebas reutilizable; no quedan completados por cerrar S1-01. Cada desarrollador debe crear su `.env.local` siguiendo la guía local.

## Referencias oficiales consultadas

- [Supabase: redirects](https://supabase.com/docs/guides/auth/redirect-urls) y [SMTP](https://supabase.com/docs/guides/auth/auth-smtp).
- [Supabase: password-based Auth](https://supabase.com/docs/guides/auth/passwords), contrastado mediante Context7.
- [Vercel: URLs estables por rama](https://vercel.com/docs/deployments/generated-urls) y [variables por entorno](https://vercel.com/docs/environment-variables/manage-across-environments), contrastado mediante Context7.
- [setup-node: caché requiere package manager instalado](https://github.com/actions/setup-node).
