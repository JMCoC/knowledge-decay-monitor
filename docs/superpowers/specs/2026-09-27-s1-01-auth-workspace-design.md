# S1-01 — Registro, autenticación y bootstrap del Workspace

Fecha: 2026-09-27. Estado: spec aprobada por el usuario, incorporando sus precisiones técnicas sobre orígenes, cookies SSR, plantilla local y recarga de recuperación. Este documento no acredita implementación ni pruebas ejecutadas.

## 1. Propósito y alcance

Un nuevo Admin puede registrarse con email y contraseña, obtener acceso inmediato, crear su Workspace y entrar a un shell privado. Puede retomar un onboarding interrumpido, iniciar y cerrar sesión y recuperar su contraseña. El primer desarrollo y las pruebas usan Supabase local en Docker; la UI está en inglés.

Fuentes de autoridad:

- [S1-01 y tickets relacionados](../../Tickets/tickets.md).
- [PRD](../../PRD/knowledge-decay-monitor-prd-final.md), especialmente autenticación y modelo de Workspace.
- [Arquitectura base](../../architecture/arquitectura-base.md), secciones 3–6.
- [ADR-001](../../architecture/adr/ADR-001-monolito-modular.md).
- [Protocolo del Día Cero](../../architecture/day-zero-protocol.md) y [evidencia histórica](../../architecture/day-zero-verification.md).
- [Contratos](../../../src/types/contracts.ts) y [migración inicial](../../../supabase/migrations/00001_initial_schema.sql).

S1-01 incluye la identidad reutilizable, el bootstrap, la navegación base, los errores seguros de sus operaciones y el CI de sus pruebas. S1-02 amplía la matriz de autorización y aislamiento de los demás recursos. S1-08 completa la observabilidad y los quality gates del sprint. La protección de credenciales y las pruebas necesarias para cerrar S1-01 no se posponen a esos tickets.

Quedan fuera: Repository funcional, invitaciones, gestión de miembros, OAuth, magic links como método de login, SSO, ingesta y cualquier capacidad de sprints posteriores. El enlace de recuperación de contraseña forma parte de Auth; no incorpora login por magic link al producto.

## 2. Base verificada y decisiones

El checkout contiene Next.js 16.3.5, React 19.2.8, TypeScript, Tailwind, Sentry y Supabase CLI como dependencia de desarrollo. Todavía no contiene los clientes de aplicación de Supabase, Zod, Vitest, Playwright ni el flujo Auth/Workspace.

La migración existente define `workspaces`, `profiles`, RLS y `bootstrap_workspace`. La RPC deriva el usuario de `auth.uid()`, obtiene su email de Auth, bloquea su fila y crea Workspace y Profile Admin en una transacción. Se reutiliza sin reescribir la migración. Una necesidad de esquema descubierta durante implementación exige una nueva migración coordinada y regeneración de tipos.

El usuario eligió desarrollar contra Docker local. Informó haber habilitado Email y deshabilitado Confirm email en el proyecto alojado; esa configuración es independiente de Docker y no se verificó remotamente. El archivo local ya habilita signup y deshabilita confirmación. `.env.local` fue creado y el usuario indicó haberlo completado; no se inspeccionaron ni validaron sus credenciales.

### Alternativas consideradas

| Alternativa | Ventaja | Costo | Decisión |
|---|---|---|---|
| Registro y onboarding separados | Recuperación explícita de cuentas sin Profile; coincide con la RPC | Dos pantallas | Elegida |
| Un formulario para cuenta y Workspace | Menos pantallas | Auth y PostgreSQL siguen siendo operaciones separadas; requiere la misma recuperación parcial | Descartada |

El alta en Auth y el bootstrap no son una transacción distribuida. Una cuenta sin Profile es un estado válido y recuperable, no motivo para borrar automáticamente al usuario.

## 3. Arquitectura y contratos

| Unidad | Responsabilidad |
|---|---|
| `src/app` | Rutas, composición de formularios y navegación |
| `src/modules/identity` | Registro, login/logout, recuperación, identidad verificada y resolución del Actor |
| `src/modules/workspace` | Validación y ejecución del bootstrap |
| `src/lib/supabase` | Clientes técnicos tipados de navegador/servidor y renovación de cookies |
| `src/proxy.ts` | Integrar renovación SSR y redirecciones preliminares |
| `src/components/shell` | Shell responsive compartido |

Las acciones del servidor son las entradas de los comandos. No se añaden APIs HTTP internas, repositorios genéricos ni clases de forwarding. Los módulos se consumen por su interfaz pública; los esquemas usados por formularios cliente se mantienen en entradas seguras, separadas del código de servidor.

`workspace` depende de `identity`; `identity` lee el Profile persistido sin depender de `workspace`. Se conservan `Actor`, `CreateWorkspaceInput`, `ActionResult<T>` y `WorkspaceApi.createWorkspace`.

Identity expone una función de servidor `requireAuthenticatedUser()` que devuelve el ID de un usuario verificado, sin exigir Profile. `requireActor()` conserva su firma `Promise<Actor>` y requiere además pertenencia persistida. La ausencia de sesión y la ausencia de Profile se distinguen mediante errores internos tipados que cada frontera convierte en navegación o error controlado. Un fallo de infraestructura no se representa como ausencia de Profile.

No llamar a `requireActor()` antes del bootstrap. Los consumidores de ingesta y Repository sí lo usan para obtener `userId`, `workspaceId` y `role`. Estos valores nunca se aceptan como autorización desde el navegador ni desde metadata editable de Auth.

### Sesión

Usar `@supabase/supabase-js` y `@supabase/ssr`, con cookies compartidas entre las fronteras correspondientes. Proxy renueva tokens y propaga cookies y cabeceras de caché a la respuesta final, incluidas redirecciones. No consulta el Profile en cada request.

Separar explícitamente los factories: `createReadOnlyClient()` para Server Components, que lee `await cookies()` y nunca llama a su método `set`; `createWritableClient()` para Server Actions y Route Handlers, que persiste todas las cookies de `setAll()` sin silenciar fallos. El adaptador de lectura puede aceptar un `setAll` sin escritura porque Proxy asume la renovación; no usar ese cliente para signup, login, logout, recuperación o actualización de contraseña. En Proxy, actualizar tanto `NextRequest` como `NextResponse` y conservar las cookies al construir la respuesta definitiva. Probar estas tres fronteras por separado.

Usar `getClaims()` para verificación del JWT y renovación según el patrón SSR oficial. En los comandos sensibles, `requireAuthenticatedUser()` consulta `getUser()` para obtener identidad vigente de Auth. `getSession()` por sí solo no acredita identidad. La aplicación no promete revocación instantánea de todos los JWT emitidos al cerrar sesión.

Cada lectura o mutación privada verifica autorización junto al acceso a datos. El layout y Proxy no sustituyen esos controles. No compartir resultados autenticados entre usuarios mediante cachés globales, ISR o CDN; las respuestas que manejan sesión y recuperación son privadas y no almacenables.

## 4. Rutas y navegación

| Ruta | Acceso y resultado |
|---|---|
| `/` | Dirige a `/login`, `/onboarding` o `/app` según identidad y Profile |
| `/register` | Pública; solicita email, password y confirm password |
| `/login` | Pública; solicita email y password |
| `/onboarding` | Usuario verificado sin Profile; solicita full name y workspace name |
| `/app` | Requiere Actor; muestra shell y contexto persistido |
| `/forgot-password` | Pública; solicita email y permite pedir otro enlace |
| `/auth/callback` | Entrada pública de verificación del enlace de recuperación |
| `/reset-password` | Requiere sesión verificada; actualiza contraseña |

Un usuario con sesión que abre login o registro continúa al onboarding o al shell. El callback y Forgot Password no se bloquean por esos redirects. Un usuario con Profile que abre onboarding entra al shell, pero una llamada directa a crear un segundo Workspace sigue devolviendo conflicto.

Las rutas Auth pueden agruparse en `(auth)`; onboarding queda fuera del layout que exige Actor. `/app` usa `src/app/(workspace)/app/page.tsx`, bajo el layout compartido previsto para Repository. El futuro `/repository` mantiene el espacio de rutas acordado con Dev 3.

El shell muestra nombre del Workspace y usuario, navegación desktop-first adaptable a móvil y botón Sign out. Incluye Home; reserva Repository como elemento deshabilitado para Admin/QA Lead hasta su implementación y lo omite para Member. No introduce enlaces rotos ni pantallas vacías para capacidades futuras. Formularios con labels, foco visible, errores asociados a campos, estado pendiente y navegación por teclado.

## 5. Registro y bootstrap

1. El servidor valida email, contraseña y su confirmación y solicita signup a Auth.
2. Solo una respuesta con sesión válida permite continuar al onboarding. Si no llega sesión, mostrar error controlado de configuración o registro, sin afirmar acceso concedido.
3. Onboarding valida `{ name, fullName }` con Zod en cliente y servidor. Aplicar trim, longitud de 1–120 caracteres y rechazo de campos adicionales. Alinear el conteo Unicode con SQL para no rechazar nombres válidos por diferencias entre UTF-16 y caracteres.
4. Verificar usuario sin exigir Actor; llamar `bootstrap_workspace(workspace_name, full_name)` con su sesión, nunca service role.
5. Confirmado el éxito, devolver `ActionResult<{ workspaceId: string }>` y navegar a `/app`, que vuelve a resolver el contexto persistido.

Un input no puede elegir email del Profile, rol, user ID ni workspace ID. El email lo obtiene la RPC desde Auth. Deshabilitar submit durante la operación; el bloqueo de la RPC protege además solicitudes concurrentes o clientes manipulados.

Si falla o se pierde la respuesta, consultar el Profile propio antes de permitir reintentar: Profile presente conduce al shell; ausencia confirmada permite reintento; error de consulta mantiene un estado recuperable sin afirmar éxito ni ausencia. Una segunda llamada normal a la RPC no es idempotente: devuelve conflicto.

## 6. Login, logout y recuperación

Login valida formato de email y contraseña no vacía; no aplica retroactivamente la política de creación a contraseñas existentes. Una credencial inválida muestra `Invalid email or password.`. Tras login se resuelve Profile y destino.

Logout se ejecuta como comando POST/Server Action y solicita cierre de la sesión actual (`scope: local`), limpia las cookies correspondientes y dirige a login. No afirmar cierre remoto correcto si falla la operación; ofrecer reintento controlado. Volver atrás o abrir una ruta privada debe volver a comprobar la sesión.

### Recuperación: plantilla y callback como una integración

Se elige el flujo de enlace con `token_hash` verificado mediante `verifyOtp`, evitando depender de un verificador PKCE conservado en el navegador que solicitó el correo. El nombre `/auth/callback` se conserva como se acordó; no implica OAuth ni obliga a usar `exchangeCodeForSession`.

1. Forgot Password valida el email y llama a `resetPasswordForEmail`. Para respuestas aceptadas, exista o no la cuenta, muestra `If an account exists for this email, you will receive password reset instructions.`.
2. Versionar una plantilla local de recuperación cuyo enlace sea `{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=recovery`. Configurar su uso en Supabase local. No mezclar esta plantilla con un callback que espere `code` o tokens en fragmentos.
3. El callback exige token presente y `type=recovery`; rechaza otros tipos. Llama a `verifyOtp({ token_hash, type: "recovery" })` y persiste las cookies de la sesión resultante.
4. En éxito redirige exclusivamente a `/reset-password`, eliminando el token de la URL visible. No admite `next`, un host de destino aportado por el cliente ni redirecciones arbitrarias. Responder sin caché y con `Referrer-Policy: no-referrer`.
5. En error dirige a Forgot Password con un código fijo que la UI traduce a `This reset link is invalid or has expired. Request a new one.`. No incluir token ni mensaje del proveedor.
6. Reset Password solicita contraseña y confirmación. El servidor verifica sesión con Auth y ejecuta `updateUser({ password })`. No requiere Profile: también se puede recuperar una cuenta con onboarding pendiente.
7. Tras éxito muestra confirmación y permite continuar al destino determinado por Profile. Si se pierde la respuesta, no afirma éxito; ofrece iniciar sesión o pedir otro enlace. No repite automáticamente el cambio.

La autorización de actualización es la sesión verificada de Supabase: el enlace establece esa sesión. Una sesión válida existente también permite cambiar contraseña en esta pantalla; no se introduce un sistema adicional de permisos de recuperación ni se considera un query param como prueba de autorización. El token del correo se consume una vez; recargar la pantalla final usa la sesión, no vuelve a canjearlo.

El E2E debe recargar `/reset-password` después del redirect y antes de enviar la nueva contraseña. La pantalla conserva autorización por cookies, aunque el token original ya esté consumido. Una nueva visita al enlace consumido falla sin borrar una sesión válida previamente establecida.

Los límites de envío y fallos técnicos muestran un mensaje genérico de reintento sin indicar existencia de la cuenta. No registrar tokens, URLs completas del callback ni cuerpos de formularios. Los E2E usan el capturador de correo local y verifican también un navegador distinto al que pidió el enlace.

## 7. Entorno y dependencias

Desarrollo en `http://127.0.0.1:3000`; Supabase API local en `http://127.0.0.1:54321`. Usar el mismo hostname en aplicación, cookies y enlaces. El archivo `.env.local` permanece ignorado por Git y contiene:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable key local>
```

Las variables anteriores son configuración pública del cliente. No usar clave privilegiada en ellas. S1-01 no necesita service role ni secretos del proyecto alojado. CI obtiene configuración de su propio stack efímero; no copia el `.env.local` del desarrollador.

Añadir dependencias de producción `@supabase/supabase-js`, `@supabase/ssr` y `zod`; herramientas de desarrollo Vitest y Playwright para los controles definidos. Seleccionar versiones compatibles al preparar el plan, fijarlas y actualizar el lockfile con pnpm 12.5.1. No instalar paquetes durante esta entrega de diseño.

La política actual de `config.toml` es mínimo seis caracteres sin requisitos de composición. Registro y reset la respetan, sin trim ni normalización de la contraseña. Se documenta como política local heredada, no como recomendación de producción; cualquier endurecimiento debe actualizar Auth, validadores y pruebas juntos.

Durante implementación, añadir el callback HTTP local exacto a `additional_redirect_urls` y configurar la plantilla de recuperación. La entrada actual `https://127.0.0.1:3000` no representa el origen elegido. Verificar que el proceso Auth cargue la configuración actualizada sin recurrir a un reset de datos innecesario.

Los scripts locales de `package.json` deben fijar hostname `127.0.0.1` y puerto `3000`; Playwright usa `baseURL` y readiness URL `http://127.0.0.1:3000`. La allowlist incluye exactamente `http://127.0.0.1:3000/auth/callback`. No mezclar `localhost` con `127.0.0.1`: las cookies se delimitan por host y no se comparten entre ambos nombres (el puerto no delimita una cookie, aunque sí forma parte del origen).

Versionar `supabase/templates/recovery.html` y referenciarlo con `[auth.email.template.recovery]`, `content_path = "./supabase/templates/recovery.html"`, ejecutando la CLI desde la raíz. Validar resolución/montaje real solicitando y leyendo un correo local antes y después de `supabase stop` seguido de `supabase start`. Conservar volúmenes; no usar `--no-backup`, `--all` ni reset. Una comprobación del archivo TOML sin correo real no demuestra que Auth cargó la plantilla.

El Dashboard alojado no configura Docker. SMTP real, URLs del hosting y comprobación del proyecto compartido son preparación de despliegue posterior. La captura local de correo demuestra el flujo local, no entrega de correo remoto.

## 8. Errores y observabilidad mínima

| Condición | Resultado de aplicación |
|---|---|
| Input inválido | `INVALID_INPUT`; errores controlados de campos |
| Sesión ausente o inválida | `UNAUTHENTICATED`; login cuando corresponda |
| Identidad autenticada sin permiso | `FORBIDDEN` |
| Workspace ya creado | `CONFLICT`; recuperación del contexto propio |
| Fallo técnico o respuesta incierta | `INTERNAL_ERROR`; no afirmar éxito |

En bootstrap, mapear `22023` a input inválido y `23505` a pertenencia existente. Interpretar `42501` según el contexto verificado de identidad. No aplicar ese mapa indiscriminadamente a otras consultas. Las acciones conservan el discriminante `ok` de `ActionResult`; las redirecciones propias del framework no se capturan como errores técnicos.

Se permite observabilidad con operación, código controlado e ID de correlación. No enviar contraseñas, email, nombres introducidos, tokens, cookies, Authorization, payloads completos ni URLs con parámetros de recuperación. Revisar la captura automática existente de Sentry, incluido Replay, breadcrumbs, request bodies y trazas; desactivar en los flujos Auth toda captura que no pueda demostrarse segura. Sanitizar antes del envío en cliente y servidor; no confiar solo en ocultar campos en la UI.

## 9. Pruebas y criterios de cierre

| Nivel | Casos requeridos |
|---|---|
| Unitario con Vitest | Esquemas, límites de nombres, contraseña sin trim, traducción de errores, decisión de navegación y Profile ausente frente a consulta fallida |
| Integración Auth/DB local | RPC con sesión real; bootstrap atómico; segundo Workspace rechazado; concurrencia; respuesta perdida y reconciliación |
| SQL/RLS | Controles existentes de bootstrap y aislamiento; lectura/mutación de otro tenant bloqueadas |
| E2E con Playwright | Registro nuevo → onboarding → shell; recarga; onboarding retomado; login/logout; rutas privadas sin sesión; recuperación por correo → nueva contraseña → nuevo login |
| E2E negativo | Enlace inválido/usado/vencido; callback de tipo no permitido; intento de destino externo; sesión expirada; credenciales incorrectas |
| Privacidad | Credenciales y tokens sintéticos no aparecen en eventos capturados por el transporte de prueba de Sentry ni en logs |

La prueba concurrente envía dos bootstrap para el mismo usuario autenticado: exactamente uno tiene éxito, el otro devuelve conflicto y se conserva un único Profile/Workspace de esa creación, sin huérfanos. No simular la RPC para acreditar atomicidad.

El E2E principal usa una cuenta nueva creada por UI, no un Profile insertado manualmente. La recuperación comprueba que la contraseña anterior deja de permitir un nuevo login y que la nueva funciona. Los casos de vencimiento usan un entorno de pruebas controlado; no requieren esperar una hora ni modificar el proyecto alojado.

Pruebas locales con datos descartables, usuarios únicos y guardas de host local antes de preparar o limpiar datos. No usar `--linked`, migraciones remotas ni seed contra el proyecto compartido. Los artefactos de Auth no deben conservar correos completos, credenciales o URLs con tokens; limitar trazas, capturas y adjuntos según el contenido.

Controles de cierre: lint, `next typegen && tsc --noEmit`, Vitest, pruebas SQL locales, integración de bootstrap, E2E Auth/Workspace y build de producción. Mantener la prueba HTTP de fixtures como regresión de la base cuando se cambie su configuración.

GitHub Actions ejecuta estos controles aplicables al ticket sobre un stack local efímero, con dependencias del lockfile y sin claves alojadas. La integración requiere checks verdes; configurar protección de rama es una acción externa separada y debe verificarse antes del cierre, pues un archivo YAML por sí solo no impide integrar. S1-08 amplía esos controles al resto del sprint y al bloqueo de despliegue.

Reportar por separado resultados estáticos, pruebas locales y cualquier limitación externa. La evidencia histórica del Día Cero no sustituye estas ejecuciones.

## 10. Fuentes técnicas y siguiente etapa

Se consultó Context7 con la skill find-docs y se contrastaron las guías oficiales. Las convenciones de Next.js se revisaron también en la documentación instalada de la versión 16.3.5.

- [Supabase SSR: paquetes, clientes, cookies y verificación](https://supabase.com/docs/guides/auth/server-side/creating-a-client).
- [Supabase email/password y recuperación](https://supabase.com/docs/guides/auth/passwords).
- [Fuente de la guía, incluido el ejemplo SSR de token_hash](https://github.com/supabase/supabase/blob/master/apps/docs/content/guides/auth/passwords.mdx).
- Next.js instalado: `node_modules/next/dist/docs/01-app/01-getting-started/16-proxy.md` y `01-app/02-guides/authentication.md`.

La spec y las precisiones técnicas están aprobadas. El siguiente artefacto es el plan con writing-plans; revisar ese plan y elegir el método de ejecución antes de implementar. Esta entrega no autoriza commits, pushes ni cambios remotos.
