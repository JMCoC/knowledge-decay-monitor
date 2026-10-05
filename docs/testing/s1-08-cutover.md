# S1-08 — Configuración del corte y despliegue condicionado

## Flujo local

El workflow `Sprint 1` produce `quality.outputs.tested_sha` desde el checkout exacto usado por `Quality gates`. Preview y Production se ejecutan en jobs separados y vuelven a hacer checkout de ese SHA. Preview solo acepta PR abiertos, no draft, del mismo repositorio; Production solo acepta un push a `main`. Cada job vuelve a comprobar la revisión actual y el permiso `write`, `maintain` o `admin` del actor original y del actor que disparó un rerun antes de usar secretos de Vercel.

El ejecutor fija `vercel@62.2.0`, selecciona explícitamente el proyecto y construye desde el checkout validado. Production crea un deployment prebuilt con `--prod --skip-domain`, sin asignar sus dominios hasta la promoción. Preview usa `--target=preview`: la CLI rechaza `--skip-domain` para este entorno. Vercel puede asignar la URL y aliases automáticos de Preview antes de nuestra inspección. El ejecutor espera con `vercel inspect --json --wait` y después consulta `vercel api /v13/deployments/<id> --method GET --raw --scope kdm17` para verificar proyecto, `READY`, URL y metadatos del SHA. `inspect --json` omite `projectId` y `meta`; la respuesta completa de la API se valida en memoria y no se imprime. El alias controlado `kdm-pr-<pr>-kdm17.vercel.app` se asigna solo después de estas verificaciones y de volver a validar el PR. Production se promueve solo después de las verificaciones equivalentes y de volver a validar `main`.

La configuración versionada `vercel.json` desactiva deployments Git automáticos cuando Vercel la adopte. Por sí sola no confirma que la integración Git, los hooks ni los despliegues anteriores estén desactivados en el proyecto remoto.

## Valores requeridos en GitHub

En **Vercel**, `NEXT_PUBLIC_SUPABASE_URL` y `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` deben estar disponibles para Preview sin filtro de rama cuando todos los PR usan el backend compartido. Tenerlas únicamente en `develop` deja sin configuración los builds de otras ramas o checkouts detached. El 2026-10-05 se retiró ese filtro de ambas variables conservando sus valores. Verificar sus nombres y alcance sin mostrar valores; después ejecutar un nuevo build/deployment, porque las variables `NEXT_PUBLIC_*` se incorporan durante la compilación. Un deployment `READY` no demuestra que la aplicación responda correctamente: comprobar `/` y el acceso a login después del despliegue.

Crear o verificar los entornos `Preview` y `Production` antes de ejecutar el workflow. Los nombres de variables y secretos requeridos son:

| Scope | Nombre | Tipo | Uso |
|---|---|---|---|
| `Preview` y `Production` | `VERCEL_ORG_ID` | Variable | ID del team Vercel confirmado para el proyecto `kdm17`. |
| `Preview` y `Production` | `VERCEL_PROJECT_ID` | Variable | ID del proyecto Vercel verificado; el ejecutor lo pasa explícitamente al CLI y compara el deployment. |
| `Preview` y `Production` | `VERCEL_TOKEN` | Secret | Token limitado al proyecto/team necesario para pull, build, deploy, inspect, alias y promote. |
| `Preview` y `Production` | `SENTRY_AUTH_TOKEN` | Secret | Solo se pasa al proceso `vercel build` para subir source maps del release. No se pasa a deploy, inspect, alias, promote, GitHub API ni runtime. |
| `Production` | `APP_ORIGIN` | Variable | `https://knowledge-decay-monitor.vercel.app`, origin HTTPS del alias Production verificado. |

La cuenta del workflow usa el `github.token` efímero para leer PR/branch y permisos de colaboradores. No se necesita una clave administrativa de Supabase en estos jobs. El repo y actor se consultan mediante argumentos separados; no se interpolan títulos, cuerpos ni nombres de branch en comandos shell.

Los jobs no exportan las variables de Sentry a `Quality gates`. El build fija `NEXT_PUBLIC_KDM_SENTRY_TARGET`, `NEXT_PUBLIC_KDM_RELEASE` y `SENTRY_RELEASE` desde el destino y el SHA verificado. El deployment runtime recibe `APP_ORIGIN` y `KDM_DISABLE_SENTRY=0`. Los killswitches locales y la autorización temporal de diagnósticos no se habilitan por este script.

## Revisión de la CLI fijada

La revisión inicial de ayuda confirmó la existencia de los flags, pero no sus combinaciones válidas. La reproducción posterior con `vercel@62.2.0 deploy --skip-domain --target=preview` y un token ficticio confirmó el rechazo local: `The --skip-domain option can only be used with production deployments`. No creó ningún deployment. El ejecutor usa `--skip-domain` exclusivamente con `--prod`; Preview usa `--target=preview`. Ambos conservan `--prebuilt --no-wait --json --env --meta --project --scope --yes`. La inspección usa `inspect --json --wait --timeout --scope`, seguida de `alias set` o `promote --yes --scope` según el entorno. Las pruebas del ejecutor verifican esta separación; la aceptación remota requiere un nuevo run con el cambio.

Referencias oficiales: [Vercel CLI en CI](https://github.com/vercel/vercel/blob/main/skills/vercel-cli/references/ci-automation.md), [inspección de deployments](https://github.com/vercel/vercel/blob/main/skills/vercel-cli/references/monitoring-and-debugging.md) y [`git.deploymentEnabled`](https://vercel.com/docs/project-configuration#git).

## Inventario remoto de solo lectura — 2026-10-04

**GitHub.** El repositorio `JMCoC/knowledge-decay-monitor` tiene `main` y `develop` sin protección y no devolvió rulesets. Tiene los entornos `Preview` y `Production`, ambos sin reglas ni política de ramas. La lista de secrets y variables de repositorio y de esos dos entornos está vacía; solo se consultaron nombres. El permiso predeterminado de `GITHUB_TOKEN` es `read`, y no puede aprobar PR. El workflow remoto activo sigue llamándose `S1-01 Auth and Workspace`; el workflow local candidato se llama `Sprint 1` y aún no se ha publicado.

**Vercel.** El team confirmado es `KDM` (`kdm17`, `team_bvEGwlSgqo1NXRjZFmbeNrdA`) y el proyecto es `knowledge-decay-monitor` (`prj_G6YEOlZYghON8XlDozxlrkBuxvUJ`). El proyecto está enlazado a `JMCoC/knowledge-decay-monitor`. Los deployments consultados tienen `source: git`: el más reciente del proyecto es de `develop`, SHA `0d0dd39953f34ce490065fd40c5ca1f6f2938ef9`; también existen seis deployments `production` listos. El Production más reciente apunta a `main`, SHA `01516ddb859f35b9b1c6ec06653171649b9b7dac`, y alias `knowledge-decay-monitor.vercel.app`; este queda como `APP_ORIGIN`. MCP no expuso el switch efectivo de deployments Git ni hooks adicionales, así que su estado para futuros cambios sigue sin confirmar. El team no tiene dominios personalizados registrados. La guía de Vercel confirma que un alias plano `*.vercel.app`, como `kdm-pr-<n>-kdm17.vercel.app`, no necesita propiedad DNS; la asignación exacta sigue pendiente hasta el primer deployment porque modifica el estado remoto. Referencia de implementación: [asignación de aliases en Vercel CLI](https://github.com/vercel/vercel/blob/main/packages/cli/src/util/alias/assign-alias.ts).

**Supabase.** El URL de API corresponde al proyecto `cdyjtoheovbvewewicaa`. El historial remoto incluye migraciones hasta `20261003214934`. El MCP disponible no expone el estado de integración Git ni la allowlist de Auth Redirect URLs. Intenté abrir el dashboard para una lectura, pero `computer-use` no pudo inicializar la superficie; no se concluye que callback alguno esté permitido. No se cambió el esquema, Auth ni Storage.

**Sentry.** Está disponible la organización `saas-project-kdm` en `https://us.sentry.io` y el proyecto `knowledge-decay-monitor`. No busqué issues ni envié eventos durante este inventario. La recepción local, Preview y Production sigue pendiente.

## Condiciones pendientes para el corte

Los entornos de GitHub no tienen las credenciales ni variables que necesita el workflow. Antes de desplegar, un administrador debe guardar en ambos entornos `VERCEL_ORG_ID` y `VERCEL_PROJECT_ID` como variables, y `VERCEL_TOKEN` y `SENTRY_AUTH_TOKEN` como secrets. El token de Vercel debe quedar limitado al team/proyecto; el token de Sentry solo es necesario durante `vercel build`. `Production` requiere además `APP_ORIGIN=https://knowledge-decay-monitor.vercel.app`. No pegar valores de secrets en el repositorio, issue, artefactos o conversación.

Falta leer en dashboard el switch de deployments Git, hooks de Vercel, integración de migraciones Supabase y redirects de Auth. También faltan las protecciones de `main`/`develop`, el check requerido `Quality gates` y una aprobación de revisión. Sin estos ajustes, el workflow candidato no garantiza bloqueo de merge y todavía no puede publicar porque los entornos carecen de credenciales.

No se cambió ninguna configuración de GitHub, Vercel, Supabase o Sentry; no se creó ningún deployment, no se envió un evento y no se publicó el workflow candidato. La lectura de dashboard queda pendiente porque la superficie `computer-use` falló al inicializar antes de mostrar una ventana.
