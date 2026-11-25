# S1-08 — Configuración del corte y despliegue condicionado

## Integración y despliegue

El workflow `Sprint 1` ejecuta `Quality gates` sobre el merge de prueba de cada PR a `develop` o `main`, y sobre el SHA integrado tras cada push a esas ramas. El job registra ese SHA en `quality.outputs.tested_sha`. GitHub debe exigir el check de GitHub Actions y una aprobación en ambas ramas, con la cabecera actualizada respecto a la base. Las ejecuciones anteriores del mismo PR se cancelan cuando llega una revisión nueva. Los despliegues web de Preview quedan suspendidos.

El job `production` requiere un push a `main`, CI verde para el mismo SHA y aprobación del Environment `Production`. La política del entorno permite solo `main`, impide la autoaprobación y bloquea el bypass administrativo. El ejecutor verifica el permiso `write`, `maintain` o `admin` del actor original y del actor que dispara un rerun. Vuelve a consultar la punta de `main` antes de crear y antes de promover el candidato.

El ejecutor construye una vez con `vercel@62.2.0` y sube el output con `--prebuilt --prod --skip-domain`. Valida el estado `READY`, el proyecto, el ID, la URL y los metadatos de procedencia. El candidato debe servir el HTML de `/login` antes de cambiar el alias. Después de promover ese mismo ID, verifica el destino de `APP_ORIGIN` mediante la API de aliases de Vercel y repite la prueba HTTP sobre el dominio público. Este smoke comprueba el render de la página de acceso. Para releases que alteren Auth, datos, Edge o ingesta, completar también la ficha de release.

## Configuración de Production

| Nombre | Tipo en el Environment | Uso |
| --- | --- | --- |
| `VERCEL_ORG_ID` | Variable | ID del team Vercel que aloja el proyecto. |
| `VERCEL_PROJECT_ID` | Variable | ID del proyecto que se comprueba antes de promover. |
| `APP_ORIGIN` | Variable | Origen HTTPS del alias canónico, `https://knowledge-decay-monitor.vercel.app`. |
| `VERCEL_TOKEN` | Secret | Permisos de build, deploy, promoción y lectura del proyecto. |
| `SENTRY_AUTH_TOKEN` | Secret | Subida de source maps durante el build. |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | Secret opcional | Si Vercel protege la URL única, enviar este valor únicamente en la cabecera de la prueba del candidato. |

La revisión de la configuración se hace por nombres, targets y permisos. Mantener `git.deploymentEnabled: false` en `vercel.json` y comprobar en el panel si existen Deploy Hooks o aliases históricos. El bloqueo de Preview en GitHub no invalida deployments de Vercel ya creados. [Configuración de Vercel](https://vercel.com/docs/project-configuration#git)

## Ficha de release y respuesta a fallos

Antes de aprobar `Production`, el revisor debe asociar al run una ficha con SHA, responsable y ventana. Para cambios que afecten dependencias, incluir el proyecto Supabase, migraciones aplicadas, versiones de Edge Functions, SHA o digest del worker efectivo, schedulers o flags relevantes y la evidencia de compatibilidad. Usar una cuenta y datos sintéticos para la comprobación funcional que corresponda, sin notificaciones reales por defecto. Incluir la referencia a la ficha en el comentario de aprobación. [Runbook del primer vertical](first-vertical-cutover.md)

El resumen de Actions registra el run, el SHA, los IDs del candidato y del deployment anterior, y el resultado de los checks. Ante fallo antes de la promoción, revisar la etapa fallida y el candidato. Si se intentó promover, comprobar primero qué ID recibe tráfico. Si el estado del backend permite volver atrás, usar el deployment anterior y repetir el smoke en el dominio público. Cuando el esquema o el worker requieran la versión nueva, coordinar la recuperación con su responsable. [Rollback de Vercel](https://vercel.com/docs/instant-rollback)

## Inventario histórico de solo lectura — 2026-10-04

**GitHub.** El repositorio `JMCoC/knowledge-decay-monitor` tiene `main` y `develop` sin protección y no devolvió rulesets. Tiene los entornos `Preview` y `Production`, ambos sin reglas ni política de ramas. La lista de secrets y variables de repositorio y de esos dos entornos está vacía; solo se consultaron nombres. El permiso predeterminado de `GITHUB_TOKEN` es `read`, y no puede aprobar PR. El workflow remoto activo sigue llamándose `S1-01 Auth and Workspace`; el workflow local candidato se llama `Sprint 1` y aún no se ha publicado.

**Vercel.** El team confirmado es `KDM` (`kdm17`, `team_bvEGwlSgqo1NXRjZFmbeNrdA`) y el proyecto es `knowledge-decay-monitor` (`prj_G6YEOlZYghON8XlDozxlrkBuxvUJ`). El proyecto está enlazado a `JMCoC/knowledge-decay-monitor`. Los deployments consultados tienen `source: git`: el más reciente del proyecto es de `develop`, SHA `0d0dd39953f34ce490065fd40c5ca1f6f2938ef9`; también existen seis deployments `production` listos. El Production más reciente apunta a `main`, SHA `01516ddb859f35b9b1c6ec06653171649b9b7dac`, y alias `knowledge-decay-monitor.vercel.app`; este queda como `APP_ORIGIN`. MCP no expuso el switch efectivo de deployments Git ni hooks adicionales, así que su estado para futuros cambios sigue sin confirmar. El team no tiene dominios personalizados registrados. La guía de Vercel confirma que un alias plano `*.vercel.app`, como `kdm-pr-<n>-kdm17.vercel.app`, no necesita propiedad DNS; la asignación exacta sigue pendiente hasta el primer deployment porque modifica el estado remoto. Referencia de implementación: [asignación de aliases en Vercel CLI](https://github.com/vercel/vercel/blob/main/packages/cli/src/util/alias/assign-alias.ts).

**Supabase.** El URL de API corresponde al proyecto `cdyjtoheovbvewewicaa`. El historial remoto incluye migraciones hasta `20261003214934`. El MCP disponible no expone el estado de integración Git ni la allowlist de Auth Redirect URLs. Intenté abrir el dashboard para una lectura, pero `computer-use` no pudo inicializar la superficie; no se concluye que callback alguno esté permitido. No se cambió el esquema, Auth ni Storage.

**Sentry.** Está disponible la organización `saas-project-kdm` en `https://us.sentry.io` y el proyecto `knowledge-decay-monitor`. No busqué issues ni envié eventos durante este inventario. La recepción local, Preview y Production sigue pendiente.
