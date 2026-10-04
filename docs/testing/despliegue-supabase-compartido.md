# Puesta en marcha: Vercel Preview y Production con un solo Supabase

Guía del 2026-09-29. Decisión acordada: usar el proyecto Supabase existente para los dos despliegues. No requiere branching de Supabase ni contratar otro plan. Los pasos indican qué quedó implementado hoy y qué debe hacerse después.

Esta guía sustituye, para el despliegue, la recomendación de proyectos separados y plantilla basada en `.SiteURL` de [s1-01-delivery.md](s1-01-delivery.md). El desarrollo local y CI continúan usando Supabase local descartable.

## 1. Identificar los entornos y el punto de partida

| Entorno | Aplicación | Backend |
|---|---|---|
| Local | `http://127.0.0.1:3000` | Supabase local `http://127.0.0.1:54321` |
| Preview de develop | `https://knowledge-decay-monitor-git-develop-kdm17.vercel.app` | Proyecto compartido |
| Production | `https://knowledge-decay-monitor.vercel.app` | El mismo proyecto compartido |

Proyecto compartido: `cdyjtoheovbvewewicaa`, URL `https://cdyjtoheovbvewewicaa.supabase.co`.

Estado comprobado mediante MCP y gh:

- El commit base del ticket está publicado en `feature/secure_registration_workspace`, commit `0a467ae`. Los cambios de este documento aún son locales/staged, sin push.
- El workflow S1-01 está en la feature, todavía no en develop. No había PRs ni ejecuciones de Actions.
- main/develop no tenían protección ni rulesets.
- Vercel detectaba Next.js 16.3.5, Node 24.x y pnpm 12.5.1 correctamente.
- Inventario Vercel actualizado el 2026-10-03 mediante MCP en modo `decrypt=false`: Preview de `develop` tiene `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` y `APP_ORIGIN`; Production tiene esos nombres y `SUPABASE_SERVICE_ROLE_KEY`. No se leyeron los valores ni se comprobó que URL/keys coincidan. `SUPABASE_SERVICE_ROLE_KEY` falta en Preview; añadirla como sensible antes de desplegar S1-02. Aún falta un deployment con el código nuevo.
- `src/lib/app-origin.ts` ahora valida el origen por entorno, y la plantilla versionada usa `{{ .RedirectTo }}`.
- Auth URL Configuration, la plantilla alojada y SMTP no pudieron leerse ni actualizarse mediante los MCP disponibles; siguen pendientes en Dashboard.
- La migración `00001_initial_schema` ya está aplicada remotamente. Existen RLS, permisos, RPC de bootstrap y bucket privado documents.

Compartir backend significa compartir usuarios, contraseñas, Workspaces, documentos y cambios de esquema. Un usuario registrado en Preview puede entrar con esa cuenta en Production; las cookies de sesión siguen siendo independientes por hostname. Un cambio de contraseña afecta la cuenta en ambos. Usar cuentas y Workspaces identificados como prueba; nunca ejecutar seed, reset o suites locales sobre este backend.

**Resultado esperado:** identificar claramente qué servicio se modifica en cada paso. No crear una segunda base ni volver a aplicar la migración inicial.

## 2. Resolver el origen en el código antes de integrar

El cambio de código ya está implementado en `src/lib/app-origin.ts`: `getAppOrigin()` resuelve el origen por solicitud. En Vercel exige una variable HTTPS válida; en local usa `http://127.0.0.1:3000`. Rechaza credenciales, rutas, queries y fragmentos, y no deriva el destino del Host ni de parámetros del navegador.

Las llamadas usan el mismo origen:

- `src/modules/identity/actions.ts`: enviar `redirectTo: getAppOrigin() + '/auth/callback'` a `resetPasswordForEmail`.
- `src/app/auth/callback/route.ts`: redirigir a `/reset-password` en ese mismo origen y conservar las cookies que escribe `verifyOtp`.

No agregar la ruta `/auth/callback` al valor de `APP_ORIGIN`: la acción ya la añade.

Se añadieron pruebas unitarias para orígenes local, Preview, Production, variable ausente y origen inválido, además de comprobar el destino de solicitud y callback. La plantilla local se cambió a `.RedirectTo`; Supabase local reinició y Auth conservó los datos. `supabase/config.toml` sigue usando loopback para el stack local.

**El código está listo localmente; aún falta publicarlo para generar el nuevo Preview.**

## 3. Configurar las variables en Vercel

Abrir el proyecto knowledge-decay-monitor del equipo KDM → Settings → Environment Variables. Revisar las entradas existentes antes de añadir otras con el mismo nombre.

| Variable | Preview, rama develop | Production |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Presente; debe apuntar al proyecto compartido | Presente; igualdad de valor no verificada |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Presente; clave publicable del proyecto compartido | Presente; igualdad de valor no verificada |
| `SUPABASE_SERVICE_ROLE_KEY` | **Falta**; añadir como sensible, solo servidor | Presente como sensible |
| `APP_ORIGIN` | Presente para `develop`; confirmar que sea el origen HTTPS estable de Preview | Presente; confirmar que sea el origen HTTPS de Production |

Los nombres y alcances se verificaron en Vercel, pero los valores están cifrados y no se compararon. Los dos entornos deben usar la misma URL y publishable key del proyecto. `APP_ORIGIN` debe corresponder al origen de cada entorno. No se copió ni se expuso ninguna clave privilegiada.

Para Preview seleccionar la rama develop cuando se quiera limitar estas variables a esa rama. Con esta opción, los Previews de otras features no tienen garantizado Auth: es deliberado en esta guía, que valida Auth alojado en develop y Auth local antes del merge. Si posteriormente se necesita Auth por feature, cada dominio necesitará un origen y callback autorizados; no ampliar ahora la allowlist con comodines generales.

Las variables de Production están presentes por nombre y alcance; los valores no se descifraron ni se compararon con Preview. El código de S1-02 también requiere `SUPABASE_SERVICE_ROLE_KEY` en Preview para las operaciones privilegiadas del servidor. Los nombres `SUPABASE_URL` o `NEXT_PUBLIC_SUPABASE_ANON_KEY` no sustituyen las variables públicas canónicas.

En Settings de build verificar:

- Framework: Next.js; raíz: la raíz del repo.
- Node: 24.x.
- Instalación: detección de pnpm 12.5.1 desde packageManager o comando `pnpm install --frozen-lockfile`.
- Build: `pnpm build`.
- No usar `scripts/with-local-supabase.mjs` en Vercel: ese wrapper inyecta valores del stack local.
- Mantener main como rama de Production y develop como Preview; verificar la conexión Git con JMCoC/knowledge-decay-monitor.

**Estado:** los scopes de Preview/develop y Production están presentes para las variables públicas; sus valores no se compararon. Preview aún carece de `SUPABASE_SERVICE_ROLE_KEY`. Los despliegues existentes no se actualizaron. Añadir esa variable sensible y crear un nuevo build de `develop` antes de probar S1-02.

## 4. Configurar Auth en Supabase compartido

Abrir [el proyecto Supabase](https://supabase.com/dashboard/project/cdyjtoheovbvewewicaa) → Authentication.

1. En la configuración de proveedores/sign-in, habilitar Email y permitir nuevos registros.
2. Confirm email debe coincidir con el flujo que está implementado: el registro requiere sesión inmediata y por eso necesita la confirmación desactivada. Esta configuración se comparte entre Preview y Production. **Implica que cualquier visitante puede registrar una cuenta usando una dirección que no haya verificado**; quien controle primero la cuenta podría impedir que su titular la registre después. Para abrir el registro al público, hace falta implementar confirmación y cambiar esta configuración antes del lanzamiento. Desactivarla solo es una decisión consciente para la etapa de prueba con el proyecto compartido.
3. En URL Configuration, fijar Site URL a:

```text
https://knowledge-decay-monitor.vercel.app
```

4. Añadir a Redirect URLs exactamente estas dos entradas:

```text
https://knowledge-decay-monitor-git-develop-kdm17.vercel.app/auth/callback
https://knowledge-decay-monitor.vercel.app/auth/callback
```

No cambiar Site URL cada vez que se prueba otro entorno. La aplicación envía `redirectTo` para que el enlace de recuperación regrese al entorno que lo solicitó. Local seguirá contra su propio Supabase: no necesita una entrada localhost en la allowlist remota.

**Resultado esperado:** un Site URL estable y dos callbacks permitidos. Guardar estos ajustes no actualiza config.toml, ni viceversa.

## 5. Configurar una plantilla de recuperación para ambos entornos

En Authentication → Email Templates → Reset Password, guardar este HTML:

```html
<h1>Reset your password</h1>
<p>
  <a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&amp;type=recovery">
    Reset password
  </a>
</p>
<p>If you did not request this change, you can ignore this email.</p>
```

La aplicación envía el callback completo en `redirectTo`, por lo que **no** se debe añadir otra vez `/auth/callback` a `.RedirectTo`. El contrato exige un callback sin query previa; la plantilla agrega el primer `?`.

La plantilla anterior usaba `.SiteURL` y enviaría ambos correos al mismo entorno. `.RedirectTo` contiene la URL que pasa `resetPasswordForEmail`, sujeta a la allowlist. Es una adaptación para este repositorio de las variables documentadas por Supabase, pendiente de validación con correo real.

| Solicitud realizada desde | Dominio esperado al abrir el correo |
|---|---|
| Preview de develop | `knowledge-decay-monitor-git-develop-kdm17.vercel.app` |
| Production | `knowledge-decay-monitor.vercel.app` |

Enviar las recuperaciones desde la UI de la app para esta prueba, de modo que se incluya el callback explícito. No sustituir la prueba por un envío manual del Dashboard que podría no llevar el mismo redirectTo. No compartir el enlace del correo ni copiar tokens a logs.

**Resultado esperado:** un único HTML sirve para ambos despliegues. Debe existir tanto en el archivo versionado como en el panel alojado; Git no sincroniza por sí solo las plantillas de Auth.

## 6. Habilitar correo real

Mailpit solo entrega correo dentro del entorno local. En Supabase alojado, comprobar si Custom SMTP ya está configurado.

Si no lo está:

1. Elegir un proveedor SMTP disponible para el equipo.
2. Configurar y verificar el remitente/dominio siguiendo su procedimiento DNS, incluyendo los registros SPF/DKIM que solicite.
3. En Authentication → SMTP Settings, introducir host, puerto, usuario, contraseña y remitente proporcionados por ese servicio.
4. Revisar los límites de Auth y del proveedor para la prueba.
5. Desactivar seguimiento de enlaces en correos Auth si el proveedor lo aplica; comprobar que no altera el enlace de recuperación.

Para una prueba inicial solo con direcciones autorizadas del equipo puede usarse el correo predeterminado, dentro de sus límites. No considerar cerrada la entrega a usuarios externos sin SMTP operativo: el servicio predeterminado restringe destinatarios y no está destinado a producción.

**Resultado esperado:** llega el mensaje a una cuenta controlada por el equipo y, para uso externo, a un destinatario autorizado que no sea miembro de la organización Supabase.

## 7. Validar localmente y publicar el ajuste mediante PR

La verificación local ya se ejecutó después del cambio de código/plantilla:

```powershell
npx pnpm@12.5.1 lint
npx pnpm@12.5.1 typecheck
npx pnpm@12.5.1 test:unit
node scripts/with-local-supabase.mjs build
npx pnpm@12.5.1 test:e2e:auth
npx pnpm@12.5.1 test:auth:restart
```

Resultados: lint OK; typecheck OK; 73/73 unit tests; build local de producción OK; 6/6 Playwright Auth; reinicio local y plantilla OK. El primer typecheck encontró un `validator.ts` truncado antiguo en `.next/dev/types`; se borró solo ese artefacto generado y el typecheck pasó al repetirse.

Seguir además la [suite local Auth/Workspace](s1-01-auth-workspace.md#suite-completa), incluyendo integración y verificaciones de DB/fixtures si se cambia el esquema. Estos runners deben seguir contra Docker local, nunca contra la base compartida. No generar de nuevo una migración para este ajuste de origen.

Con las pruebas correctas:

1. Revisar el diff; agregar solo los archivos del ajuste y esta guía. No incluir .env.local, skills instaladas ni artefactos.
2. Hacer commit y push de la rama del ticket.
3. En GitHub abrir PR `feature/secure_registration_workspace` → `develop`.
4. Verificar que aparezca el workflow **S1-01 Auth and Workspace**, job **auth-workspace**.
5. Esperar su finalización; revisar los pasos fallidos si los hubiera. El check Vercel no sustituye este job.

Los pushes a la feature no disparan este workflow; el PR a develop sí. El estado observado `Supabase Preview: skipped` no impide usar la base compartida y no demuestra una prueba de Auth.

**Resultado esperado:** CI ejecuta lint, tipos, pruebas SQL, fixtures, integración, build, E2E y reinicio usando Supabase efímero. No necesita credenciales de la base alojada.

## 8. Proteger la integración en GitHub

En Settings → Rules → Rulesets, o Branches → Branch protection según la interfaz disponible:

1. Crear reglas activas para develop y main.
2. Exigir Pull Request y al menos una aprobación de otro desarrollador.
3. Exigir el check real de auth-workspace que apareció en el paso anterior; seleccionarlo por el nombre reportado por GitHub.
4. Exigir la rama actualizada si esa es la política elegida por el equipo; resolver conflictos antes de integrar.
5. Bloquear force pushes y borrado de esas ramas; limitar bypass de las reglas.

No exigir un check de Supabase branching que no se ejecutará con esta estrategia. No activar merge queue sin añadir antes su evento al workflow.

Vercel puede construir Previews en paralelo con Actions. Para este proyecto, la puerta de integración será PR + CI obligatorio; un Preview marcado READY no autoriza el merge. main debe recibir el cambio únicamente después de validarlo en develop.

**Resultado esperado:** no se puede integrar el PR normal mientras falten pruebas o revisión.

## 9. Desplegar y probar develop

Integrar el PR aprobado. En Vercel → Deployments:

1. Comprobar que el despliegue corresponde a develop y al commit recién integrado.
2. Si no se generó automáticamente, revisar la conexión Git y los ajustes de despliegue antes de intentar publicarlo manualmente.
3. Si se guardaron variables después de que arrancó el build, generar un nuevo deployment de develop con la configuración actual.
4. Abrir la URL estable de develop del paso 1, no el enlace de una feature o de un commit anterior.

Prueba manual, con un correo propio de pruebas:

| Paso | Resultado esperado |
|---|---|
| Abrir `/login` y `/register` | Renderizan; no hay 500 |
| Registrar usuario nuevo | Aparece onboarding |
| Crear Workspace con nombre `TEST - Auth Preview` | Un Workspace y un Profile Admin; abre `/app` |
| Salir y visitar `/app` | Solicita autenticación |
| Entrar otra vez | Mismo Workspace, no crea otro |
| Solicitar Forgot Password | Mensaje controlado y correo recibido |
| Abrir correo en otro navegador/contexto | Permanece en dominio develop y abre reset-password |
| Recargar reset-password | El formulario sigue autorizado por la cookie |
| Cambiar contraseña | La nueva permite login; la anterior falla |
| Reabrir el enlace consumido | No admite un nuevo intercambio |

No se espera compartir la cookie entre navegadores ni entre dominios. Si el Preview está protegido en Vercel, el segundo navegador debe tener acceso a esa protección antes de abrir la aplicación.

Registrar solo commit, entorno, fecha y resultado de cada prueba. No adjuntar contraseñas, cookies ni enlaces de recuperación. Detener la integración a main si falla una prueba crítica.

## 10. Llevarlo a Production

1. Confirmar que las variables Production del paso 3 estén guardadas y que su APP_ORIGIN sea el dominio de Production.
2. Abrir PR develop → main; obtener revisión y CI verde.
3. Integrar y comprobar que Vercel construye el commit de main con destino Production.
4. No reutilizar el build local ni cambiar solamente el alias de un artefacto Preview.
5. Abrir `https://knowledge-decay-monitor.vercel.app` y repetir la prueba del paso 9.
6. Puede usarse la misma cuenta de prueba para login: ya existe en la base compartida. Para probar registro, usar otra dirección controlada; volver a registrar la misma no es una prueba de alta nueva.
7. Solicitar recuperación desde Production y comprobar que el correo vuelve a Production. Repetir una solicitud desde develop para confirmar que ambos siguen funcionando sin cambiar Site URL.

**Resultado esperado:** los dos despliegues funcionan con los mismos usuarios/datos y cada recuperación vuelve al dominio que la solicitó. No se ejecuta ninguna migración adicional por publicar S1-01.

## 11. Diagnóstico y vuelta atrás

| Síntoma | Revisar primero |
|---|---|
| 500 con `Supabase public environment variables are missing` | Alcance Preview/Production, rama seleccionada, nombres y nuevo build |
| Correo redirige a 127.0.0.1 | Código del origen desplegado y APP_ORIGIN del deployment |
| Preview termina en Production | Plantilla todavía usa SiteURL o falta redirectTo válido en allowlist |
| Enlace contiene dos `/auth/callback` | La plantilla duplicó la ruta que ya contiene RedirectTo |
| Registro crea cuenta pero no abre onboarding | Confirm email activado o error de sesión; no repetir registros sin revisar |
| No llega el correo | SMTP, remitente, spam, destinatarios permitidos, límites y Auth logs |
| READY en Vercel pero Auth falla | Revisar respuesta HTTP y logs de runtime; READY solo acredita el deployment |
| No aparece Actions | PR dirigido a develop/main y workflow presente en el cambio |
| Las pruebas de Preview cambian una cuenta de Production | Es la misma cuenta/base; comportamiento esperado de la decisión adoptada |

Si falla Production, detener nuevas integraciones y volver al deployment conocido disponible en Vercel, teniendo presente qué funcionalidad ofrecía. Esto no revierte contraseñas, datos ni ajustes de Auth. Corregir configuración y volver a construir; nunca resetear la base para solucionar un fallo del frontend.

Para futuras migraciones, coordinar cambios compatibles con ambas versiones mientras convivan: una migración sobre esta base afecta a Preview y Production al mismo tiempo.

## 12. Lista de cierre

- [ ] El código lee y valida APP_ORIGIN; no usa loopback en Vercel.
- [ ] La URL y publishable key coinciden entre Preview y Production y apuntan al proyecto compartido.
- [ ] `SUPABASE_SERVICE_ROLE_KEY` existe como variable sensible, solo servidor, en ambos entornos.
- [ ] `APP_ORIGIN` tiene el origen HTTPS correspondiente a cada entorno y los callbacks están permitidos.
- [ ] Site URL permanece en Production y ambos callbacks están permitidos.
- [ ] La plantilla alojada y versionada usan RedirectTo sin duplicar rutas.
- [ ] Proveedor Email y comportamiento de confirmación coinciden con la app.
- [ ] Recuperación entrega correo a los destinatarios previstos.
- [ ] CI y revisión son obligatorios en develop/main.
- [ ] Auth completo pasa en develop y Production, incluida recarga y replay.
- [ ] El equipo entiende que cuentas, contraseñas y datos son compartidos.

## Referencias

- [Supabase: variables de plantillas, incluida RedirectTo](https://supabase.com/docs/guides/auth/auth-email-templates).
- [Supabase: allowlist y plantillas con redirectTo](https://supabase.com/docs/guides/auth/redirect-urls).
- [Supabase: correo y SMTP](https://supabase.com/docs/guides/auth/auth-smtp).
- [Vercel: variables por entorno](https://vercel.com/docs/environment-variables).
- [GitHub: protección de ramas](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).

La sintaxis RedirectTo se contrastó mediante find-docs/Context7 y documentación oficial. Las lecturas remotas de la revisión anterior describen el punto de partida, no acreditan que estos pasos ya se hayan realizado.
