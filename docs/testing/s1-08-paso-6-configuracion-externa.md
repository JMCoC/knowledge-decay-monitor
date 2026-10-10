# S1-08 — Paso 6: configuración externa, pantalla por pantalla

Esta guía amplía el [paso 6 de publicación y cierre](./s1-08-publicacion-y-cierre.md). Preparada el 2026-10-04 a partir del checkout y documentación vigente consultada con Context7. No representa una auditoría nueva de los dashboards ni confirma que los ajustes ya estén aplicados.

## Objetivo y orden

Al terminar, GitHub tendrá las credenciales para publicar, Vercel dejará de desplegar por su conexión Git anterior y la aplicación tendrá las variables y callbacks necesarios. La prueba del flujo completo ocurre después, en los pasos 7–10.

Orden de trabajo:

1. Preparar accesos y coordinar una ventana sin pushes.
2. Registrar Production actual y cortar la publicación automática de Vercel.
3. Obtener los tokens de Vercel y Sentry.
4. Guardar secretos/variables en los Environments de GitHub.
5. Proteger `main` y `develop`.
6. Revisar variables de aplicación en Vercel y Auth en Supabase.
7. Revisar automatizaciones de Supabase y completar la comprobación previa al push.

Dos ajustes quedan para después del primer PR: seleccionar el check real `Quality gates` cuando aparezca y permitir el callback del número de PR asignado. Ninguno impide crear el PR; ambos deben resolverse antes de integrar o probar recuperación, respectivamente.

## A. Preparar accesos y registrar el punto de recuperación

1. Inicia sesión en GitHub, Vercel, Supabase y Sentry.
2. Confirma permisos para editar Settings del repositorio/proyecto. Para emitir un token de integración Sentry necesitas acceso administrativo apropiado en la organización.
3. Coordina con el equipo que no haga pushes, merges ni redeploys durante el cambio de flujo. Los commits locales pueden continuar.
4. Abre Vercel, selecciona team **KDM** (`kdm17`) y proyecto **knowledge-decay-monitor**.
5. Abre **Deployments**, localiza el deployment al que apunta el dominio Production actual y registra: URL/ID, SHA, fecha y alias. No elijas simplemente el deployment más reciente, que podría ser Preview.
6. Abre `https://knowledge-decay-monitor.vercel.app` y registra si responde y permite el acceso esperado.
7. En **Settings → General**, comprueba el Project ID. En los ajustes del team, comprueba el Team ID. Los valores del inventario anterior son:

```text
Team slug: kdm17
VERCEL_ORG_ID: team_bvEGwlSgqo1NXRjZFmbeNrdA
VERCEL_PROJECT_ID: prj_G6YEOlZYghON8XlDozxlrkBuxvUJ
```

Si no coinciden, identifica la causa antes de continuar: el ejecutor contiene restricciones para este proyecto/team. No cambiar IDs para apuntarlo a otro proyecto sin revisar el código.

**Comprobación:** tienes una referencia del deployment vigente, sus aliases y el proyecto correcto. Registrar estos datos no es ejecutar un rollback.

## B. Cortar los deployments automáticos de Vercel

La acción concreta recomendada para este corte es desconectar el repositorio Git **de este proyecto Vercel**. Así GitHub Actions podrá publicar mediante CLI y token sin que un push dispare la vía Git anterior.

1. Dentro del proyecto, entra en **Settings → Git**.
2. Busca **Connected Git Repository** y confirma que muestra `JMCoC/knowledge-decay-monitor`.
3. Revisa primero **Deploy Hooks**. Si hay hooks, registra nombre, rama y quién los usa; no copies sus URLs a documentación, porque permiten disparar deployments.
4. Coordina y elimina los hooks de este proyecto que permitían publicar por fuera del gate. Si la interfaz permite deshabilitarlos, puedes hacerlo. No elimines hooks de otros proyectos.
5. En **Connected Git Repository**, pulsa **Disconnect** y confirma la desconexión del repositorio.
6. Comprueba que ya no aparece como conectado.
7. Revisa que el deployment y los dominios existentes siguen listados y que Production sigue respondiendo.
8. En GitHub, revisa la lista de workflows y Settings → Webhooks buscando otra automatización conocida que publique este proyecto. Coordina la desactivación de la ruta duplicada; conserva la configuración del nuevo workflow.

No uses **Delete Project**, no borres dominios y no desinstales globalmente la GitHub App de Vercel: esa app puede servir a otros proyectos. Tampoco desconectes la integración de datos Supabase–Vercel al intentar desconectar Git.

`vercel.json` contiene `git.deploymentEnabled=false`, pero todavía es parte del candidato local y no protege revisiones anteriores. La desconexión evita depender de que ese archivo ya haya llegado a todas las ramas. El switch **Require Verified Commits** verifica firmas; no sustituye el resultado de `Quality gates`.

Fuente: [Vercel Git settings](https://vercel.com/docs/project-configuration/git-settings).

**Comprobación ahora:** repositorio desconectado, vías alternativas revisadas y deployment actual accesible. **Comprobación posterior:** el SHA de la prueba deliberadamente fallida del paso 8 no crea deployment.

## C. Crear el token de Vercel

1. Abre [Vercel Account Tokens](https://vercel.com/account/tokens).
2. Selecciona **Create Token**.
3. Asigna un nombre identificable, por ejemplo `kdm-github-actions-s1-08`.
4. Selecciona el scope del team **KDM**. Usa un alcance de proyecto si tu interfaz lo ofrece y cubre las operaciones necesarias; no presupongas que todos los planes tienen ese nivel de granularidad.
5. Elige una expiración que cubra la puesta en marcha y registra una fecha de renovación.
6. Crea el token y cópialo directamente a un gestor de secretos o al formulario GitHub del apartado E. No lo pegues en el documento ni en una terminal con historial.

El token permite al workflow ejecutar pull, build, deploy, inspect, alias y promote en el proyecto previsto. Su validez operativa se comprobará en el primer deployment; haberlo guardado no demuestra sus permisos.

Fuente: [Vercel API Access Tokens](https://vercel.com/kb/guide/how-do-i-use-a-vercel-api-access-token).

## D. Obtener el token Sentry para el build

Este token es distinto del DSN. El DSN ya está en la configuración de la aplicación y sirve para enviar eventos; `SENTRY_AUTH_TOKEN` autoriza las tareas del build, incluidos source maps.

1. Abre Sentry y selecciona la organización **saas-project-kdm**.
2. Confirma que existe el proyecto **knowledge-decay-monitor**.
3. Si ya tienes un token organizacional de CI para este proyecto, comprueba su finalidad y vigencia con su administrador. Puedes reutilizarlo si está destinado a estos builds.
4. Si tu configuración ofrece **Organization Auth Tokens/Auth Tokens** para CI, crea uno con el alcance `org:ci`, destinado a source maps/releases.
5. Si tu interfaz ofrece la ruta de integración interna, sigue **Settings → Custom Integrations → Create New Integration → Internal Integration → Next**.
6. Nombra la integración `KDM GitHub Actions`. Para esa modalidad, otorga **Organization: Read** y **Release: Admin** (scopes `org:read` y `project:releases`) para las tareas de releases/source maps; no selecciones todos los permisos. No confundas estos permisos de integración con el scope del token organizacional de CI anterior.
7. Guarda y copia el token generado en **Tokens** directamente al secret de GitHub. Si la UI presenta permisos distintos, contrástalos con los scopes oficiales antes de ampliarlos.

No es necesario habilitar alertas, Session Replay, tracing ni otro proveedor para completar este paso. No guardar este token como `NEXT_PUBLIC_*` ni como variable runtime de Vercel.

Fuentes: [creación de integración interna](https://docs.sentry.io/api/guides/create-auth-token/) y [permisos de Sentry](https://docs.sentry.io/api/permissions/).

**Comprobación:** token de build guardado de forma segura, organización/proyecto correctos y permisos identificados. La subida efectiva se comprueba con el build remoto.

## E. Cargar GitHub Environments

Abre [Settings → Environments del repositorio](https://github.com/JMCoC/knowledge-decay-monitor/settings/environments).

### E.1 Environment Preview

1. Abre **Preview**. Si no existe, pulsa **New environment**, escribe `Preview` y guarda.
2. En **Environment secrets**, pulsa **Add environment secret**.
3. Escribe `VERCEL_TOKEN`, pega el token de C y guarda.
4. Repite para `SENTRY_AUTH_TOKEN` con el token de D.
5. En **Environment variables**, pulsa **Add environment variable**.
6. Crea `VERCEL_ORG_ID` con el Team ID confirmado.
7. Crea `VERCEL_PROJECT_ID` con el Project ID confirmado.
8. Comprueba que aparecen dos nombres de secrets y dos variables. No necesitas revelar los secrets para comprobar que existen.

### E.2 Environment Production

1. Vuelve a Environments y abre o crea **Production**.
2. Añade los mismos dos nombres de secrets. Se pueden usar tokens separados por entorno si el equipo los administra así.
3. Añade las mismas dos variables de IDs.
4. Añade una tercera variable:

```text
Nombre: APP_ORIGIN
Valor: https://knowledge-decay-monitor.vercel.app
```

5. En **Deployment branches and tags**, selecciona **Selected branches and tags** y permite la rama `main`.

### E.3 Restricción Preview y permisos

Para arrancar con la configuración mínima del diseño, Preview puede conservar **No restriction** en Deployment branches and tags: el workflow comprueba PR interno, no draft, rama destino, SHA y permisos de actores. Esta opción no equivale a conceder secretos a un fork.

Si decides restringir también Preview, GitHub documenta la regla de rama `refs/pull/*/merge` para workflows `pull_request`. Permitir solo `develop` no describe la referencia de ejecución del PR, aunque esa sea su rama destino. Verifica esa regla en el primer run.

Los **Required reviewers del Environment** son una aprobación adicional para ejecutar el job, diferente de la aprobación del PR. No son necesarios para reproducir el flujo automático acordado. Si el equipo los activa en Production, asigna un revisor disponible y cuenta con esa espera antes de publicar.

En Settings → Actions → General, confirma que Actions y las acciones usadas por el workflow están permitidas. No cambies globalmente `GITHUB_TOKEN` a escritura: el workflow declara sus permisos. La persona que origina y quien relanza deben tener `write`, `maintain` o `admin` en el repo.

Fuentes: [secrets de Actions](https://github.com/github/docs/blob/main/content/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets.md) y [restricciones de despliegue por referencia](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).

**Comprobación:** Preview tiene 2 secrets + 2 variables; Production, 2 secrets + 3 variables. Los nombres coinciden exactamente con el workflow. Las variables de Supabase no van en estos Environments para este diseño.

## F. Proteger main y develop

Usa una sola modalidad de protección para evitar reglas duplicadas. Si ya existen rulesets, edítalos conservando reglas del equipo. La siguiente ruta usa reglas clásicas para una configuración nueva:

1. En GitHub, abre **Settings → Branches**.
2. Pulsa **Add classic branch protection rule**.
3. En **Branch name pattern**, escribe `main`.
4. Activa **Require a pull request before merging**.
5. Activa **Require approvals**, con `1` aprobación.
6. Activa **Dismiss stale pull request approvals when new commits are pushed**.
7. Activa **Do not allow bypassing the above settings**, si aparece con ese nombre en tu interfaz. Mantén deshabilitado el bypass ordinario.
8. Mantén desmarcados **Allow force pushes** y **Allow deletions**.
9. Guarda la regla y repite para `develop`.
10. Confirma que existe otro colaborador habilitado para revisar: no puedes contar tu propia aprobación como revisión independiente.

Después de subir el primer PR con el nuevo workflow:

1. Espera a que GitHub registre la ejecución de **Quality gates**.
2. Edita ambas reglas.
3. Activa **Require status checks to pass before merging**.
4. Busca y selecciona el check **Quality gates** real, con **GitHub Actions** como origen esperado cuando la interfaz permita elegirlo.
5. Activa **Require branches to be up to date before merging** y guarda.
6. Comprueba que el PR muestra ese requisito. No marques el antiguo workflow `S1-01 Auth and Workspace` por similitud de nombre ni exijas Preview como check universal, porque los forks no publican.
7. Antes del merge, realiza la prueba negativa del paso 8 y verifica que el merge ordinario queda bloqueado.

Si aún no aparece el check, deja registrada esa tarea y no integres el PR hasta completarla. No habilites una merge queue como parte de este paso: el workflow actual no incorpora el evento `merge_group`.

Fuentes: [crear protección de rama](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/managing-a-branch-protection-rule) y [checks requeridos](https://github.com/github/docs/blob/main/content/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches.md).

## G. Configurar las variables de la aplicación en Vercel

GitHub guarda las credenciales para desplegar. Vercel guarda los valores que consume la aplicación desplegada. Un Environment llamado Preview en GitHub no sincroniza automáticamente las variables del entorno Preview de Vercel.

1. Abre Supabase, proyecto previsto para el entorno. En el inventario era `cdyjtoheovbvewewicaa`.
2. Obtén el Project URL desde **Connect** o **Settings → Data API**, según la interfaz.
3. Abre **Settings → API Keys** y localiza la publishable key.
4. Para mantener la configuración actual, localiza la clave de servidor `service_role` en la sección de claves legacy si está habilitada. No confundas esa clave con `anon`, la contraseña PostgreSQL ni un access token de la cuenta.
5. El código actual lee el nombre `SUPABASE_SERVICE_ROLE_KEY`. Si el proyecto solo usa nuevas secret keys, verifica esa migración de credencial con el responsable antes del corte; no basta con crear una variable llamada `SUPABASE_SECRET_KEY`, porque el cliente actual no la lee.
6. Vuelve a Vercel → proyecto → **Settings → Environment Variables**.
7. Añade o edita las tres variables siguientes, comprobando su scope:

| Nombre | Valor esperado si se mantiene el proyecto compartido | Scope |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://cdyjtoheovbvewewicaa.supabase.co` | Preview y Production |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Publishable key del mismo proyecto | Preview y Production |
| `SUPABASE_SERVICE_ROLE_KEY` | Credencial privilegiada del mismo proyecto | Preview y Production, servidor |

8. Si los entornos tienen proyectos Supabase distintos, crea valores separados por scope; URL y ambas claves deben corresponder al mismo proyecto en cada entorno.
9. Revisa overrides por rama. El ejecutor actual hace `vercel pull --environment=preview` sin `--git-branch`; configura los valores necesarios en Preview general y no dependas de un override exclusivo de `develop`.
10. Marca la credencial privilegiada como sensible según la configuración disponible. No pongas claves privadas en nombres `NEXT_PUBLIC_*`. No reveles valores para documentar la comprobación.
11. Si una integración administra estas variables, revisa su configuración de origen en lugar de crear valores contradictorios que pueda sobrescribir.
12. Mantén `KDM_SENTRY_DIAGNOSTICS_ENABLED=0` y lista/fecha ausentes. La habilitación temporal corresponde a las fases 9 y 10, no a esta preparación.
13. No fijes un SHA manual en `NEXT_PUBLIC_KDM_RELEASE`/`SENTRY_RELEASE`: el script fija release, target y APP_ORIGIN. Si hay valores antiguos, revisa que no compitan con ese flujo.
14. Guarda. Si Vercel propone **Redeploy**, no lo ejecutes ahora: la nueva configuración se probará con GitHub Actions.

Cambiar variables no modifica deployments existentes. La verificación real es login y operaciones de servidor en el nuevo deployment. Fuentes: [variables Vercel](https://vercel.com/docs/environment-variables), [variables sensibles](https://vercel.com/docs/environment-variables/sensitive-environment-variables) y [API keys Supabase](https://supabase.com/docs/guides/api/api-keys).

## H. Configurar callbacks y correo de Supabase Auth

1. En el proyecto Supabase correcto, abre **Authentication → URL Configuration**.
2. En **Site URL**, usa `https://knowledge-decay-monitor.vercel.app` para el backend compartido previsto. Si otro proyecto sirve únicamente Preview, usa su configuración acordada y no cambies el proyecto de otro entorno.
3. En **Redirect URLs**, añade y guarda:

```text
https://knowledge-decay-monitor.vercel.app/auth/callback
```

4. No borres callbacks legítimos de otros flujos durante el corte.
5. Después de crear el PR, añade su callback exacto. Ejemplo para PR 27:

```text
https://kdm-pr-27-kdm17.vercel.app/auth/callback
```

El 27 es un ejemplo; usa el número real. No guardes literalmente `<NUMERO-PR>`. Cada nuevo PR que necesite recuperar contraseña requiere su callback si se mantiene esta política de URLs exactas.

6. Abre **Authentication → Email Templates → Reset Password** (la agrupación puede aparecer bajo Emails).
7. Conserva el diseño del correo si ya existe, pero comprueba que el enlace de recuperación aplica el contrato del archivo `supabase/templates/recovery.html`:

```html
<a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&amp;type=recovery">Reset password</a>
```

La aplicación ya entrega `/auth/callback` dentro de `RedirectTo`; no vuelvas a añadirlo en la plantilla. No uses `SiteURL` en lugar de `RedirectTo` si quieres conservar el entorno desde el que se solicita recuperación.

8. Revisa **SMTP Settings/Custom SMTP** en Auth: proveedor, remitente y disponibilidad para las cuentas autorizadas de prueba. Si el proveedor requiere validar un dominio/remitente, completa esa validación allí. No asumas que el servicio de correo predeterminado entregará a cualquier destinatario.
9. Guarda los cambios de Auth. No es necesario resetear ni migrar la base.
10. Cuando exista el deployment, solicita recuperación desde su alias y comprueba recepción, retorno al mismo origin y cambio efectivo de contraseña. No compartas el enlace recibido: contiene un token.

Fuentes: [Redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls) y [Custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp). El enlace HTML anterior proviene del checkout de este proyecto.

## I. Revisar la automatización Git de Supabase

La desconexión Git de Vercel no modifica la integración de Supabase. Tampoco el workflow S1-08 publica migraciones remotas: sus pruebas SQL usan Supabase local efímero.

1. En Supabase, abre los ajustes de integraciones de la organización y localiza GitHub.
2. Busca la conexión del proyecto y usa **Configure connection** para abrir sus ajustes de proyecto.
3. Registra repositorio, rama de Production, sincronización de ramas y creación automática de previews, si están habilitadas.
4. Revisa también la integración Vercel: si sincroniza variables de branches Supabase, determina qué valores suministrará al nuevo flujo. No asumas que descubrirá una rama automáticamente cuando el despliegue se hace por CLI.
5. Compara el alcance del PR con lo que publica esa integración: migraciones, funciones y configuración de Storage. Comprueba que no se aplicarán fixtures locales al proyecto compartido.
6. Si hay una vía que modifica el backend compartido al hacer push sin el control acordado, coordina su pausa a nivel de proyecto antes de publicar. No revoques OAuth de la cuenta completa ni elimines branches/datos como parte de este paso.
7. Si conservas una automatización independiente, registra su responsable, disparador y criterio de autorización. No declares que S1-08 controla sus migraciones.

Fuentes: [niveles de integración GitHub](https://supabase.com/docs/guides/troubleshooting/managing-or-disconnecting-github-oauth-connections-e3dc3b) y [alcance del despliegue Supabase](https://supabase.com/docs/guides/deployment).

## J. Comprobación de salida y siguiente acción

Antes del push:

- [ ] Proyecto/team correctos y Production vigente registrado.
- [ ] Vercel Git desconectado y hooks/vías alternativas revisados.
- [ ] Token Vercel y token Sentry guardados en ambos Environments GitHub.
- [ ] IDs en ambos Environments y APP_ORIGIN en Production.
- [ ] Protecciones de PR/revisión en main y develop, con revisor disponible.
- [ ] Variables de aplicación correctas en ambos scopes Vercel.
- [ ] Diagnósticos deshabilitados por defecto.
- [ ] Site URL, callback Production, plantilla y correo hospedado revisados.
- [ ] Automatización Supabase entendida y coordinada.

Después del primer PR, antes de integrar:

- [ ] Check real Quality gates seleccionado como requerido en ambas ramas.
- [ ] Callback del PR añadido antes de probar recuperación.
- [ ] Flujo negativo y positivo del paso 8 ejecutados; credenciales, aliases y aplicación comprobados en uso real.

Completar esta guía permite continuar al paso 7: commit/push/PR. No demuestra todavía recepción de eventos ni funcionamiento del deployment; eso se acredita en los pasos siguientes. Actualiza el [reporte de corte](./s1-08-cutover.md) con fecha, responsable y resultado de cada cambio, sin valores de secretos.
