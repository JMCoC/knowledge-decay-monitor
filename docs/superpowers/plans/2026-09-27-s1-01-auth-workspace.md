# S1-01 Auth/Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Entregar registro, sesión SSR, bootstrap transaccional, shell privado y recuperación de contraseña demostrados contra Supabase local.

**Architecture:** Monolito modular: identity verifica identidad y resuelve Actor; workspace ejecuta la RPC existente con la sesión del usuario. Next.js compone rutas y Server Actions; clientes Supabase separados por capacidad de escritura de cookies. RLS permanece como frontera de datos.

**Tech Stack:** Next.js 16.3.5, React 19.2.8, TypeScript estricto, Tailwind, Supabase CLI 2.117.0, Node.js 24.11.0 y pnpm 12.5.1. Dependencias nuevas fijadas en la tarea 1.

**Spec:** [Diseño aprobado y precisiones del usuario](../specs/2026-09-27-s1-01-auth-workspace-design.md).

## Global Constraints

- Desarrollo en `http://127.0.0.1:3000`; Supabase API local en `http://127.0.0.1:54321`.
- La allowlist incluye exactamente `http://127.0.0.1:3000/auth/callback`.
- UI en inglés; documentación interna en español.
- Un usuario pertenece como máximo a un Workspace; el creador es Admin.
- No llamar a `requireActor()` antes del bootstrap.
- Conservar `ActionResult<T>`, `CreateWorkspaceInput` y `IdentityApi.requireActor(): Promise<Actor>`.
- Política local heredada: contraseña nueva de mínimo seis caracteres, sin trim ni normalización.
- Nombres: trim, 1–120 caracteres, rechazo de campos adicionales.
- Email habilitado y confirmación deshabilitada; registro y onboarding en dos pasos.
- No reescribir migraciones existentes, usar `--linked`, resetear datos del desarrollador ni cambiar el proyecto alojado.
- No imprimir claves, tokens, cookies, correos completos ni URLs de recuperación en logs o artefactos.
- No hacer commit, push o merge sin autorización. Los puntos de revisión de este plan no implican commits.
- Preservar los cambios existentes en `AGENTS.md`, `.agents/`, `.claude/` y `skills-lock.json`.
- La implementación comienza después de revisar este plan y elegir ejecución; los comandos siguientes no se han ejecutado como parte de la planificación.

## Review Focus

1. Refresh durante render de un Server Component: no escribir cookies ni esconder un fallo del cliente de escritura; pruebas tarea 1.
2. Cookies divididas en varios fragmentos y respuesta redirect: conservar todos los fragmentos y cabeceras; pruebas tareas 1 y 5.
3. Cuenta creada sin Profile y consulta de Profile caída: onboarding solo ante ausencia confirmada; pruebas tareas 2–4.
4. Enlace abierto en otro navegador, recarga y replay: sesión persiste; token consumido no vuelve a servir ni borra sesión; pruebas tareas 5–6.
5. Respuesta RPC perdida y dos submits concurrentes: reconciliar sin duplicados ni huérfanos; pruebas tareas 3 y 6.

## Preparación y mapa de archivos

Antes de editar, ejecutar `git status --short`, leer la spec, `AGENTS.md`, arquitectura §§3–6 y documentación Next instalada relevante. Aplicar using-git-worktrees al comenzar ejecución, conservando `.env.local` privado y configurando explícitamente la raíz del proyecto Supabase si se usa otro checkout. No arrancar dos stacks con el mismo project ID ni dos servidores en el puerto 3000. La ruta de templates se resuelve desde la raíz elegida.

| Área | Archivos previstos | Responsabilidad |
|---|---|---|
| Configuración | `package.json`, `pnpm-lock.yaml`, `vitest.config.ts`, `vitest.integration.config.ts`, `playwright.config.ts`, `.gitignore` | Versiones, scripts y suites separadas |
| Supabase técnico | `src/lib/supabase/{env,client,server,proxy}.ts`, `src/proxy.ts` | Entorno y factories de lectura/escritura; cookies SSR |
| Identity | `src/modules/identity/{index,session,errors,schemas,actions}.ts`, `auth-form.tsx`, `password-form.tsx` | Contexto, Auth y formularios |
| Workspace | `src/modules/workspace/{index,schemas,actions,queries}.ts`, `onboarding-form.tsx` | Bootstrap y lectura del Workspace propio |
| Rutas | `src/app/(auth)/{register,login,forgot-password,reset-password}/page.tsx`, `src/app/auth/callback/route.ts`, `src/app/onboarding/page.tsx`, `src/app/(workspace)/{layout.tsx,app/page.tsx}`, `src/app/page.tsx` | Navegación y fronteras |
| Shell | `src/components/shell/app-shell.tsx`, `src/app/layout.tsx` | UI responsive y metadata de producto |
| Correo | `supabase/templates/recovery.html`, `supabase/config.toml` | Configuración local reproducible |
| Privacidad | `src/lib/observability/auth-events.ts`, `src/instrumentation-client.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts`, `next.config.ts` | Eventos controlados y protección de capturas automáticas |
| Pruebas | `tests/unit/`, `tests/integration/`, `tests/e2e/auth/`, `tests/support/` | Casos detallados por tarea |
| Ejecución local | `scripts/with-local-supabase.mjs`, `scripts/check-auth-restart.mjs` | Inyección de entorno y prueba de reinicio sin revelar secretos |
| Entrega | `.github/workflows/s1-01.yml`, `docs/testing/s1-01-auth-workspace.md` | CI y evidencia reproducible |

No crear archivos vacíos; crearlos junto al caso de uso de su tarea. Los barrels server-only no exportan esquemas cliente ni viceversa. Las pruebas de UI real pertenecen a Playwright; no añadir un segundo framework de componentes por defecto.

## Task 1: Clientes SSR seguros y entorno ejecutable

**Files:** Crear los cuatro archivos de `src/lib/supabase`, `src/proxy.ts`, `vitest.config.ts`, `tests/unit/supabase-clients.test.ts`, `tests/unit/proxy.test.ts`, `tests/support/server-only.ts`; modificar `package.json`, lockfile y `.gitignore` solo para artefactos de pruebas.

**Interfaces:**

```ts
getSupabaseEnv(): { url: string; publishableKey: string }
createBrowserSupabaseClient(): SupabaseClient<Database>
createReadOnlyClient(): Promise<SupabaseClient<Database>>
createWritableClient(): Promise<SupabaseClient<Database>>
updateSession(request: NextRequest): Promise<NextResponse>
```

- [x] Instalar versiones consultadas en npm durante planificación. Node instalado es 24.11.0; Vitest 5 exige tipos Node 22/24 y Vite como peer requerido, por eso se incluye el ajuste de tipos y Vite. Mantener Next/React y CLI actuales.

```powershell
npx pnpm@12.5.1 add --save-exact @supabase/supabase-js@2.117.2 @supabase/ssr@0.12.7 zod@4.6.5 server-only@0.0.1
npx pnpm@12.5.1 add -D --save-exact vitest@5.0.2 vite@8.3.1 @playwright/test@1.63.0 @types/node@24.19.0
```

- [x] Configurar Vitest en Node con alias `@` a `src`, alias de `server-only` a un módulo vacío exclusivo de tests e include `tests/unit/**/*.test.ts`. Añadir scripts; `start` de despliegue permanece configurable y el origen fijo corresponde a scripts locales:

```json
{
  "dev": "next dev --hostname 127.0.0.1 --port 3000",
  "start:local": "next start --hostname 127.0.0.1 --port 3000",
  "test:unit": "vitest run --config vitest.config.ts",
  "test:integration": "node scripts/with-local-supabase.mjs integration",
  "test:e2e:auth": "node scripts/with-local-supabase.mjs e2e",
  "test:auth:restart": "node scripts/check-auth-restart.mjs"
}
```

- [x] Escribir tests con `vi.mock('next/headers')` y `vi.mock('@supabase/ssr')`: capturar el adaptador pasado a `createServerClient`, invocar `setAll` con dos fragmentos y verificar que lectura no llama `cookieStore.set`, escritura aplica ambos y un fallo de escritura se propaga. El stub de `cookies` devuelve una promesa.

```ts
expect(cookieStore.set).not.toHaveBeenCalled(); // cliente de lectura
expect(cookieStore.set).toHaveBeenCalledTimes(2); // cliente writable
expect(() => writableAdapter.setAll(chunks)).toThrow('write failed');
```

- [x] Ejecutar `npx pnpm@12.5.1 test:unit`; confirmar fallo por factories inexistentes antes de implementarlos.
- [x] Implementar factories tipados y `getSupabaseEnv` con acceso literal a `process.env.NEXT_PUBLIC_*` para el bundler. Rechazar variables ausentes con texto controlado sin sus valores. No validar la URL exclusivamente como loopback en código de producto: esa restricción pertenece a los runners locales.

```ts
// En server.ts, import 'server-only'; usar await cookies().
const readOnlyAdapter = {
  getAll: () => cookieStore.getAll(),
  setAll: () => {}, // intencional: Proxy renueva; nunca mutaciones Auth aquí
};
const writableAdapter = {
  getAll: () => cookieStore.getAll(),
  setAll: (items: { name: string; value: string; options: CookieOptions }[]) => {
    for (const { name, value, options } of items) cookieStore.set(name, value, options);
  },
};
```

- [x] Implementar Proxy con `getClaims()`, sin queries de Profile. Su `setAll` actualiza request, reconstruye respuesta y aplica todos los fragmentos a response. Propagar también las cabeceras recibidas por el adaptador SSR 0.12.7; acumular escrituras si se llama más de una vez. Excluir assets, no callback ni reset. Mantener inicialmente las decisiones de destino en páginas y operaciones.

```ts
for (const { name, value } of items) request.cookies.set(name, value);
response = NextResponse.next({ request });
for (const { name, value, options } of accumulatedCookies.values()) {
  response.cookies.set(name, value, options);
}
response.headers.set('Cache-Control', 'private, no-store');
```

- [x] Añadir test que invoque dos ciclos de `setAll`, uno que elimine un fragmento, y una respuesta alternativa: cookies efectivas, atributos y cabeceras llegan al request/response correcto. Fallo de red Auth produce error controlado, no un logout silencioso.
- [x] Ejecutar unitarios, typecheck y lint. Entregable: factories seguros y Proxy verificables, sin formularios todavía.

## Task 2: Contexto Identity y validación compartida

**Files:** Crear `identity/{index,session,errors,schemas}.ts`, `workspace/schemas.ts`, `tests/unit/identity-session.test.ts`, `tests/unit/auth-schemas.test.ts`, `tests/unit/workspace-schema.test.ts`.

**Interfaces:** Consumir factories de tarea 1 y contratos existentes. Exportar estas firmas de servidor desde Identity; los esquemas se importan desde su entrada cliente explícita:

```ts
type IdentityContext =
  | { state: 'anonymous' }
  | { state: 'onboarding'; userId: string }
  | { state: 'ready'; actor: Actor; fullName: string };
class IdentityError extends Error {
  code: 'UNAUTHENTICATED' | 'WORKSPACE_REQUIRED' | 'INTERNAL_ERROR';
}
getIdentityContext(client: SupabaseClient<Database>): Promise<IdentityContext>
requireAuthenticatedUser(client?: SupabaseClient<Database>): Promise<{ userId: string }>
requireActor(): Promise<Actor>
```

- [x] Escribir pruebas: Auth sin sesión → anonymous; usuario sin Profile → onboarding; Profile propio → Actor; error de red Auth o error SQL → `INTERNAL_ERROR`. Metadata con rol Admin no cambia el rol Member persistido. Exportar `IdentityContext` e `IdentityError` para consumidores de servidor.

```ts
expect(await getIdentityContext(clientWithoutProfile)).toEqual({
  state: 'onboarding', userId: verifiedUserId,
});
await expect(getIdentityContext(clientWithQueryFailure)).rejects.toMatchObject({
  code: 'INTERNAL_ERROR',
});
```

- [x] Ejecutar los tres archivos con Vitest y confirmar fallo inicial.
- [x] Implementar `getUser()` y consulta de Profile por ID verificado con `maybeSingle`. Clasificar ausencia de sesión conocida sin confundirla con transporte caído; nunca usar `error => anonymous` universal. Factories por defecto de lectura para consultas; acciones pasan su cliente writable al helper de usuario.
- [x] Definir esquemas estrictos `loginSchema`, `registerSchema`, `forgotPasswordSchema`, `resetPasswordSchema` y `createWorkspaceSchema`. Email con trim y formato válido; login exige password no vacía. Registro/reset exigen mínimo 6 y confirmación igual. Extraer DTO explícito de FormData antes de validar para no tratar metadatos internos de Server Actions como campos de negocio.

```ts
const nameSchema = z.string().trim().refine(
  value => Array.from(value).length >= 1 && Array.from(value).length <= 120,
  'Use between 1 and 120 characters.',
);
export const createWorkspaceSchema = z.strictObject({
  name: nameSchema,
  fullName: nameSchema,
});
```

- [x] Probar límite Unicode de 120/121 caracteres, espacios, password con espacios conservados, confirmación distinta y campos `role`, `workspaceId`, `userId`, `email` rechazados por bootstrap. SQL sigue siendo la autoridad en llamadas directas.
- [x] Ejecutar unitarios y typecheck. Entregable: distinción usable entre identidad y pertenencia sin cambiar `src/types/contracts.ts`.

## Task 3: Bootstrap y reconciliación

**Files:** Crear `workspace/{index,actions,queries}.ts`, `tests/unit/workspace-actions.test.ts`, `tests/unit/workspace-queries.test.ts`.

**Interfaces:** Consumir Identity, `createWritableClient`, schemas y contratos. Producir:

```ts
createWorkspace(input: CreateWorkspaceInput): Promise<ActionResult<{ workspaceId: string }>>
getOwnWorkspace(): Promise<Pick<Workspace, 'id' | 'name'>>
```

- [x] Escribir tests de entrada inválida sin RPC, llamada con solo `workspace_name/full_name`, error `23505` → CONFLICT, `22023` → INVALID_INPUT, ausencia de sesión → UNAUTHENTICATED y fallo técnico → INTERNAL_ERROR.

```ts
expect(rpc).toHaveBeenCalledWith('bootstrap_workspace', {
  workspace_name: 'Acme', full_name: 'Alex',
});
expect(result).toEqual({ ok: false, error: {
  code: 'CONFLICT', message: 'You already belong to a workspace.',
}});
```

- [x] Confirmar fallo con `npx pnpm@12.5.1 exec vitest run tests/unit/workspace-actions.test.ts`.
- [x] Implementar Server Action usando el cliente writable y `requireAuthenticatedUser(client)`, validación en servidor y RPC existente. No envolver un redirect en su catch. La acción devuelve resultado; la UI gestiona navegación.
- [x] Implementar `getOwnWorkspace` con Actor fresco, cliente de sesión y RLS. Una fila ausente o query fallida es error controlado, no onboarding ni nombre inventado.
- [x] Probar reconciliación con `getIdentityContext`: tras INTERNAL_ERROR de bootstrap, consulta propia confirma ready → navegar; confirma onboarding → reintento; consulta falla → mantener error. Conservar CONFLICT en la acción: no falsear el contrato convirtiéndolo en éxito.
- [x] Ejecutar unitarios y typecheck. La atomicidad real se demuestra en tarea 6, no con estos mocks.

## Task 4: Registro, login, onboarding y shell

**Files:** Crear `identity/actions.ts`, `identity/auth-form.tsx`, `workspace/onboarding-form.tsx`, rutas register/login/onboarding/app, layout workspace, `components/shell/app-shell.tsx`, `tests/unit/identity-actions.test.ts`; modificar `src/app/page.tsx` y metadata del layout raíz.

**Interfaces:** Consumir tareas 1–3; acciones Auth devuelven resultados controlados y destinos enumerados:

```ts
type AuthDestination = '/onboarding' | '/app';
register(input: { email: string; password: string; confirmPassword: string }):
  Promise<ActionResult<{ destination: AuthDestination }>>
login(input: { email: string; password: string }):
  Promise<ActionResult<{ destination: AuthDestination }>>
logout(): Promise<ActionResult<{ destination: '/login' }>>
```

- [x] Escribir y ejecutar tests RED: signup sin sesión no informa éxito, credenciales inválidas producen texto neutral, lookup de Profile fallido no lleva a onboarding, logout fallido no afirma cierre.
- [x] Implementar acciones con factory writable, `signUp`, `signInWithPassword`, `signOut({ scope: 'local' })`. Tras mutaciones refrescar la navegación del cliente; no guardar sesión ni rol en estado persistente propio.

```ts
const result = await login(input);
if (result.ok) {
  router.replace(result.data.destination);
  router.refresh();
} else {
  setMessage(result.error.message);
}
```

- [x] Construir formularios accesibles con inputs controlados, labels, autocomplete apropiado, validación Zod antes del envío y error del servidor. Deshabilitar submit durante envío; en onboarding después de respuesta incierta refrescar contexto antes de habilitar otro intento.
- [x] Implementar guards en páginas y operaciones: root/login/register eligen destino; onboarding exige usuario sin Profile; layout workspace exige Actor; página app obtiene Workspace autorizado. No confiar en layout como único control de datos.
- [x] Crear shell con Home, Repository deshabilitado para Admin/QA Lead, oculto a Member y Sign out. Mostrar nombres persistidos, no IDs técnicos; verificar teclado y viewport móvil de 390 px y desktop de 1280 px en tarea 6.
- [x] Ejecutar unitarios, typecheck y lint; usar el navegador para un registro local cuando esté lista la protección de telemetría de tarea 7, o mantener el SDK deshabilitado en esta etapa de desarrollo. No transmitir formularios mientras la captura automática siga sin proteger.

## Task 5: Recuperación por correo y cookies del callback

**Files:** Crear `supabase/templates/recovery.html`, `src/app/auth/callback/route.ts`, rutas forgot/reset, `identity/password-form.tsx`, `tests/unit/recovery-callback.test.ts`, `tests/unit/password-actions.test.ts`; modificar `supabase/config.toml` e `identity/actions.ts`.

Crear también `src/lib/app-origin.ts`: exporta `APP_ORIGIN = 'http://127.0.0.1:3000'` como configuración explícita de esta entrega local, compartida por acciones y callback. No derivar ese valor de un Host recibido.

**Interfaces:** Cliente writable de tarea 1; esquemas e identidad de tarea 2. Añadir:

```ts
requestPasswordReset(input: { email: string }): Promise<ActionResult<{ accepted: true }>>
updatePassword(input: { password: string; confirmPassword: string }):
  Promise<ActionResult<{ updated: true }>>
```

- [x] Añadir tests RED: callback sin token/tipo equivocado no llama `verifyOtp`; éxito conserva cookies fragmentadas y `Cache-Control`; `next=https://example.org` nunca se usa; error no borra cookies existentes; update exige usuario verificado, no Profile.
- [x] Versionar configuración exacta; preservar otras secciones de TOML:

```toml
[auth]
site_url = "http://127.0.0.1:3000"
additional_redirect_urls = ["http://127.0.0.1:3000/auth/callback"]

[auth.email.template.recovery]
subject = "Reset your Knowledge Decay Monitor password"
content_path = "./supabase/templates/recovery.html"
```

```html
<h1>Reset your password</h1>
<p><a href="{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&amp;type=recovery">Reset password</a></p>
<p>If you did not request this change, you can ignore this email.</p>
```

- [x] Implementar acciones: `resetPasswordForEmail(email, { redirectTo: 'http://127.0.0.1:3000/auth/callback' })` para el entorno local; encapsular ese origen en configuración de aplicación para no derivarlo de Host no confiable ni incrustarlo como único destino de producción. No añadir una variable secreta. Para esta entrega, una constante local documentada basta; el despliegue ajusta la configuración explícitamente.
- [x] Implementar callback con destino fijo, `verifyOtp` y cookies de `await cookies()` escritas antes de retornar redirect. Afirmar mediante integración real que Next incluye esas cookies en la respuesta final; si se construye otra respuesta manualmente, trasladar todas las cookies y cabeceras, no solo el token principal.

```ts
const tokenHash = request.nextUrl.searchParams.get('token_hash');
const type = request.nextUrl.searchParams.get('type');
// Solo verificar cuando tokenHash existe y type === 'recovery'.
const { error } = await client.auth.verifyOtp({ token_hash: tokenHash, type: 'recovery' });
const destination = error ? '/forgot-password?error=invalid-link' : '/reset-password';
const response = NextResponse.redirect(new URL(destination, 'http://127.0.0.1:3000'));
response.headers.set('Cache-Control', 'private, no-store');
response.headers.set('Referrer-Policy', 'no-referrer');
return response;
```

- [x] Reset usa factory de lectura en GET y writable en acción. No exige query token, evento de navegador `PASSWORD_RECOVERY`, storage local ni flag de recuperación. Mantiene sesión tras recarga y cambia password con `updateUser`. Después del éxito, botón Continue resuelve destino por Profile; no recanjear el enlace.
- [x] Ejecutar unitarios/typecheck/lint. En tarea 6 comprobar correo real y reinicio, porque TOML válido no demuestra montaje de plantilla.

## Task 6: Evidencia local de Auth, concurrencia y reinicio

**Files:** Crear `vitest.integration.config.ts`, `playwright.config.ts`, `scripts/with-local-supabase.mjs`, `scripts/check-auth-restart.mjs`, `tests/support/local-supabase.ts`, `tests/support/mail.ts`, `tests/e2e/auth/{onboarding,recovery,access}.spec.ts`, `tests/integration/bootstrap.test.ts`.

**Interfaces:**

```ts
// tests/support/local-supabase.ts: clientes sin persistencia del SDK en Node.
newLocalUser(): Promise<{ client: SupabaseClient<Database>; userId: string; email: string; password: string }>
// tests/support/mail.ts: consulta con polling acotado, sin logging de payload.
waitForRecoveryLink(email: string): Promise<string>
```

- [x] Implementar runner con subcomandos cerrados `integration`, `e2e` y `build`: ejecutan respectivamente Vitest con `vitest.integration.config.ts`, Playwright con `playwright.config.ts` y Next build. Capturar `supabase status -o json` sin imprimirlo, validar `API_URL === 'http://127.0.0.1:54321'` e inyectar URL/publishable key solo al proceso hijo. Rechazar estado remoto antes de crear usuarios. Usar campos reales de la CLI comprobados al ejecutarla; error de clave ausente no debe imprimir el JSON. No sobrescribir `.env.local`.
- [x] Implementar soporte de correo contra el capturador local anunciado por status, validar hostname loopback y puerto configurado. Consultar su API documentada tras identificar versión; polling con deadline de 15 segundos y filtro por destinatario único. Decodificar HTML y validar protocolo/host/path/type de cada link antes de navegar. No adjuntar el cuerpo ni enlaces a reportes. Los tests no limpian usuarios ajenos; sus cuentas únicas quedan en el stack descartable.
- [x] Configurar Playwright explícitamente y bloquear reutilización accidental de servidor en otro origen. Incorporar un check de readiness que confirme que Next apunta al stack local esperado antes de crear usuarios.

```ts
export default defineConfig({
  testDir: './tests/e2e/auth',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:3000', trace: 'off', screenshot: 'off', video: 'off' },
  webServer: {
    command: 'pnpm start:local',
    url: 'http://127.0.0.1:3000/login',
    reuseExistingServer: false,
  },
});
```

- [x] Escribir E2E antes de corregir integración: registro por UI, navegación a onboarding, abandono/relogin sin Profile, bootstrap y shell con recarga. Otro test comprueba login/logout, visitante en app/onboarding/reset, rol Member y tamaños móvil/desktop. Extraer auxiliares `registerThroughUi(page, email, password)` y `loginThroughUi(page, email, password)` dentro de `tests/support/auth-ui.ts`; crear ese archivo cuando se reutilicen.
- [x] Probar recuperación completa con un segundo browser context. Después del callback comprobar URL limpia y recargar antes del cambio; volver a visitar el enlace consumido y verificar que falla sin perder la sesión válida.

```ts
await recoveryPage.goto(link);
await expect(recoveryPage).toHaveURL('http://127.0.0.1:3000/reset-password');
await recoveryPage.reload();
await expect(recoveryPage.getByLabel('New password', { exact: true })).toBeVisible();
await recoveryPage.getByLabel('New password', { exact: true }).fill(newPassword);
await recoveryPage.getByLabel('Confirm password', { exact: true }).fill(newPassword);
await recoveryPage.getByRole('button', { name: 'Update password' }).click();
await expect(recoveryPage.getByText('Your password has been updated.')).toBeVisible();
```

- [x] Tras update probar nuevo login en contexto limpio: password vieja rechazada y nueva aceptada. Añadir link inválido, tipo signup rechazado, `next` externo ignorado y sesión expirada/no renovable. Para expiración del enlace, fixture local controlado en el stack de CI aislado; no bajar TTL ni modificar Auth de usuarios existentes en el stack personal. Distinguir este caso de un token malformado: debe probar la respuesta de token expirado.
- [x] Integración concurrente con usuario recién registrado y RPC real:

```ts
const results = await Promise.all([
  client.rpc('bootstrap_workspace', { workspace_name: marker, full_name: 'Admin One' }),
  client.rpc('bootstrap_workspace', { workspace_name: marker, full_name: 'Admin One' }),
]);
expect(results.filter(r => !r.error)).toHaveLength(1);
expect(results.find(r => r.error)?.error?.code).toBe('23505');
```

Comprobar además un Profile y un Workspace creados, incluido conteo global de huérfanos para el marcador de prueba con observación SQL local independiente. Usar una conexión administrativa solo en el harness de pruebas, obtenida del status local y nunca del cliente de producto. Para evitar dependencia nueva, ejecutar psql en el contenedor DB identificado por el project ID comprobado; pasar valores como parámetros, no interpolar SQL libre. Escribir el auxiliar de observación en `tests/support/local-supabase.ts`. RLS del usuario por sí sola no permite demostrar ausencia global de huérfanos.

- [x] Simular pérdida de respuesta sin falsear el commit: completar RPC real y descartar su resultado en el harness; luego ejecutar la resolución de Profile y confirmar ready sin segunda RPC. Ejecutar `test:db` para controles existentes y `test:fixtures` como regresión.
- [x] Verificar plantilla antes/después de reinicio: el script obtiene un correo válido, conserva un identificador no secreto del usuario de prueba, ejecuta stop del proyecto actual y start desde la misma raíz, espera readiness y solicita otro correo. Ambos links tienen host/path/type esperados y la cuenta persiste. Invocar CLI sin mostrar salidas que contengan claves.

```powershell
npx pnpm@12.5.1 exec supabase stop
npx pnpm@12.5.1 exec supabase start
```

No usar `--all`, `--no-backup` ni reset. Solo si reaparece el fallo histórico específico de Logflare evaluar la exclusión documentada; nunca asumirla ni ocultar fallos de salud de Auth/DB. Durante implementación, el reinicio forma parte del alcance local aprobado del plan.

- [x] Ejecutar `node scripts/with-local-supabase.mjs build`, `test:integration`, `test:e2e:auth` y `test:auth:restart` secuencialmente; los scripts deben fallar con código distinto de cero ante plantilla incorrecta, claves ausentes, origen equivocado o cookies no persistidas. Describir errores sin imprimir cuerpos ni URLs sensibles.

## Task 7: Privacidad de Auth antes de habilitar telemetría

**Files:** Crear `src/lib/observability/auth-events.ts`, `tests/unit/auth-privacy.test.ts`, `tests/integration/auth-privacy.test.ts`; modificar las tres configuraciones Sentry y `next.config.ts` solo donde requiera evitar envío automático sensible.

**Interfaces:**

```ts
type AuthOperation = 'register' | 'login' | 'logout' | 'bootstrap' | 'recovery' | 'password-update';
type SafeAuthEvent = { operation: AuthOperation; code: string; correlationId: string };
reportAuthFailure(event: SafeAuthEvent): void
```

- [x] Ejecutar esta tarea antes de cualquier prueba interactiva con envío real de Sentry; puede adelantarse inmediatamente después de tarea 1. Leer documentación vigente del SDK instalado con find-docs antes de editar opciones, sin actualizar su versión por conveniencia.
- [x] Escribir RED con sentinelas sintéticos para password, email, token, cookie y query callback. Interceptar el transporte Sentry en tests, nunca enviar esos eventos al proyecto real.

```ts
for (const sentinel of sensitiveSentinels) {
  expect(JSON.stringify(capturedEnvelopes)).not.toContain(sentinel);
}
expect(capturedSafeEvent.tags.operation).toBe('bootstrap');
```

- [x] Implementar `reportAuthFailure` construyendo un evento nuevo desde campos allowlisted. No pasar Error del proveedor, objetos Request ni input. Mapear códigos a una lista cerrada antes de enviar. La captura automática de Auth se descarta si no puede sanearse con fiabilidad; eventos explícitos conservan operación y correlación.
- [x] Deshabilitar Replay para esta entrega y trazas automáticas de Auth; configurar filtros de eventos, breadcrumbs y request data en los tres runtimes. Revisar headers y cuerpos incluso cuando no exista una excepción manual. La política común puede ser más restrictiva mientras solo existe Auth; documentarla para que S1-08 la amplíe sin reabrir fugas.
- [x] Probar URL de callback tanto en request como en breadcrumb/span y errores controlados del formulario. No quitar solamente parámetros de la barra del navegador: la primera petición ya contiene el token.
- [x] Repetir suite de privacidad con errores reales inducidos usando datos sintéticos y transporte en memoria. SDK deshabilitado en procesos E2E/CI por configuración explícita; verificar que build no requiere upload de sourcemaps ni token alojado para estos checks.

## Task 8: CI, runbook y cierre verificable

**Files:** Crear `.github/workflows/s1-01.yml`, `docs/testing/s1-01-auth-workspace.md`; ajustar scripts y configuraciones de tareas anteriores únicamente por resultados de integración.

**Interfaces:** Los scripts de tareas 1 y 6 son la interfaz de CI; no duplicar configuración ni llevar claves de un entorno a otro.

- [x] Crear workflow para pull requests y rama de integración real observada en Git. Usar Node 24.11.0, pnpm 12.5.1, instalación frozen y CLI del lockfile. Elegir versiones/SHAs vigentes de actions oficiales verificando su documentación al implementarlo. No inventar identidades de revisores ni configurar reglas remotas sin autorización.
- [x] Secuencia del job: checkout, setup, install, lint, typecheck, unitarios, Supabase local en runner efímero, SQL, fixtures, integración, build, Chromium, E2E y prueba de reinicio. Capturar configuración local solo para procesos que la necesitan. El runner Docker no reutiliza el proyecto remoto ni datos del desarrollador.

```powershell
npx pnpm@12.5.1 install --frozen-lockfile
npx pnpm@12.5.1 lint
npx pnpm@12.5.1 typecheck
npx pnpm@12.5.1 test:unit
npx pnpm@12.5.1 test:db
npx pnpm@12.5.1 test:fixtures
npx pnpm@12.5.1 test:integration
node scripts/with-local-supabase.mjs build
npx pnpm@12.5.1 exec playwright install chromium
npx pnpm@12.5.1 test:e2e:auth
npx pnpm@12.5.1 test:auth:restart
```

En Linux instalar las dependencias de sistema de Chromium con el comando oficial de Playwright para CI. El subcomando `build` inyecta las variables públicas del stack local del job sin volcar status a logs. Las suites de integración y E2E no pueden pasar como skipped porque falte Docker.

- [x] El workflow falla si falla cualquier paso; detener su stack al terminar sin imprimir secretos. No subir trace, estado autenticado del navegador, `.env`, correos ni salidas crudas de status. Reportes permitidos: nombres de casos, estados, duración y errores sanitizados.
- [x] Escribir runbook con requisitos, comandos anteriores, uso de `127.0.0.1`, ubicación de `.env.local`, política de cookies y plantilla, señales de fallo y evidencia. Documentar que el reinicio preserva datos y que completar checks locales no demuestra checks obligatorios en GitHub.
- [x] Ejecutar controles finales solo después de cambios completos, sin repetir suites ya aprobadas salvo nuevos cambios/fallos. Incluir al menos un recorrido Playwright contra build de producción. Revisar diff limitado y `git diff --check`.
- [x] Registrar matriz de aceptación con resultados reales y límites: creación/sesión, recuperación con recarga, concurrencia, aislamiento, privacidad, plantilla tras reinicio y CI. Las reglas de rama/required checks requieren verificación externa posterior; si no se configuraron, reportar esa condición y no declarar integración protegida.

## Cobertura y entrega

| Requisito de la spec | Tareas |
|---|---|
| Entorno y origen único | 1, 5, 6, 8 |
| Lectura/escritura SSR y Proxy | 1, 2, 5, 6 |
| Registro y onboarding recuperable | 2, 3, 4, 6 |
| Bootstrap atómico, conflicto y concurrencia | 3, 6 |
| Login/logout y shell | 4, 6 |
| Callback, plantilla y recarga de reset | 5, 6 |
| Seguridad, RLS y errores | 2, 3, 6, 7 |
| Pruebas y CI de S1-01 | 6, 7, 8 |

Revisión del plan: comprobar firmas compartidas, correspondencia con spec, pruebas para los cinco riesgos y ausencia de pasos ambiguos. Las opciones concretas de librerías que se verifican al ejecutar no cambian la arquitectura aprobada; una incompatibilidad que afecte contratos se documenta antes de modificarla.

Fuentes consultadas: documentación Next 16.3.5 instalada (`cookies`, `proxy` y autenticación), Context7 `/supabase/supabase`, [SSR oficial](https://supabase.com/docs/guides/auth/server-side/creating-a-client), [plantillas locales](https://supabase.com/docs/guides/local-development/customizing-email-templates), metadatos npm de las versiones fijadas y ayuda de Supabase CLI instalada. No se reiniciaron contenedores durante planificación.

Método de ejecución por elegir tras revisar el plan: ejecución directa en esta sesión o tareas con subagentes y revisiones independientes. Recomendación: ejecución directa, porque las fronteras de cookies, contexto y callback comparten contratos y conviene estabilizarlas secuencialmente; mantener una revisión final independiente según la skill de ejecución elegida. No comenzar implementación hasta recibir esa elección y aprobación del plan.
