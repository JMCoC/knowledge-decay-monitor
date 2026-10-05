# S1-08 — Pasos para publicar, verificar y cerrar

Fecha de preparación: 2026-10-04. Rama local observada: `feature/observability_quality_repository`.

Esta guía parte de los cambios locales de S1-08, todavía sin commit, y lleva hasta su integración en GitHub y funcionamiento comprobado en Preview y Production. Es un procedimiento por ejecutar: las casillas pendientes no representan acciones realizadas.

## 1. Punto de partida y resultado esperado

Está implementada la captura segura de errores en las fronteras disponibles, la correlación con la UI, la separación de entornos/releases, el diagnóstico temporal browser/server y el workflow que condiciona los deployments al SHA aprobado por `Quality gates`.

El [reporte local](./s1-08-acceptance.md) registra 327 pruebas unitarias, 198 SQL en un stack descartable, dos E2E focalizados, typecheck y build aprobados. Lint terminó sin errores y con cinco warnings existentes. La suite completa sobre un runner limpio y la recepción real en Sentry siguen pendientes.

El [inventario remoto](./s1-08-cutover.md), del 4 de octubre, encontró entornos GitHub sin secretos/variables y ramas sin protección. El workflow candidato aún no estaba publicado. Los switches efectivos de Vercel y la configuración hospedada de Auth no quedaron verificados. Releerlos antes del corte: el inventario es una fotografía histórica.

Hay dos hitos diferentes:

| Hito | Condición |
|---|---|
| S1-08 publicado y operativo en su alcance disponible | Código integrado, CI completo aprobado, publicación condicionada comprobada, aplicación accesible y eventos reales local/Preview/Production verificados. |
| S1-08 cerrado por completo | Además de lo anterior, S1-04/S1-07 integrados y criterio A13 demostrado con pipeline/retry reales. |

S1-04 y S1-07 pertenecen a los otros desarrolladores. El [handoff](./s1-08-ingestion-handoff.md) está listo; no reemplaza su implementación. El [plan aprobado](../superpowers/plans/2026-10-04-s1-08-safe-observability-quality-gates.md) define A01–A13 y exige todos para el cierre completo.

## 2. Responsables y reglas del procedimiento

| Responsable | Trabajo |
|---|---|
| Desarrollador de S1-08 | Revisar el diff, probar, preparar commits/PR y registrar evidencia. |
| Administrador GitHub/Vercel/Supabase/Sentry | Configurar accesos, secretos, protecciones y automatismos. Puede ser la misma persona. |
| Otro revisor habilitado | Revisar y aprobar los PR; comprobar que no se eluden los gates. |
| Responsables de S1-04/S1-07 | Implementar/integrar procesamiento y retry, y aportar aceptación A13. |

- Ejecutar los comandos desde la raíz del repositorio y detenerse ante un fallo.
- No subir `.env`, tokens, claves, cookies, documentos privados ni artefactos con datos sensibles.
- Preservar los archivos ajenos a S1-08. No usar `git add .` ni `git add -A`.
- No resetear el Supabase personal ni ejecutar seed/reset remoto.
- Mantener separados los resultados locales, las simulaciones y la evidencia hospedada.
- No usar el botón de redeploy de Vercel para saltarse el workflow.

## 3. Revisar y preparar el candidato local

- [ ] Confirmar la rama y revisar cambios existentes:

```powershell
git branch --show-current
git status --short
git diff --stat
git diff
```

- [ ] Revisar también los archivos nuevos, que no aparecen en `git diff` hasta incorporarlos al índice.
- [ ] Incluir implementación, pruebas, workflow, scripts de despliegue, `vercel.json`, diseño, plan y documentos de S1-08.
- [ ] Revisar especialmente `src/types/contracts.ts` y los consumidores afectados; coordinar con los otros desarrolladores.
- [ ] Excluir los archivos locales ajenos observados: `.agents/`, `.claude/`, `skills-lock.json`, `supabase/snippets/`, salvo revisión y justificación independiente.
- [ ] Confirmar Node.js 24.11.0, pnpm 12.5.1 y Docker disponible.

```powershell
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test:unit
git diff --check
```

Si pnpm no está disponible, usar `npx pnpm@12.5.1` como prefijo equivalente. Conservar el lockfile fijado; no actualizar dependencias como parte de esta publicación.

**Salida:** candidato revisado, checks básicos aprobados y lista explícita de archivos para el commit. Corregir cualquier fallo nuevo antes de avanzar.

## 4. Completar las pruebas en un entorno descartable

El stack personal en `54321` contiene datos adicionales y no cumple los fixtures de una instalación limpia. No resetearlo. Usar otra máquina/VM con Docker propio y una copia del candidato completo. Clonar únicamente el HEAD actual omitiría los cambios que siguen sin commit; preparar un commit local revisado o transferir explícitamente el candidato sin secretos.

Otro checkout en el mismo Docker no garantiza aislamiento: puede reutilizar proyecto y volúmenes. Los helpers actuales exigen API `127.0.0.1:54321`, Mailpit `54324` y aplicación `3000`. El stack aislado anterior de `54421` solo acreditó SQL y tipos.

- [ ] En ese entorno descartable, instalar dependencias y ejecutar:

```powershell
node scripts/local-supabase-lifecycle.mjs start

# DESTRUCTIVO: solo sobre la base LOCAL DESCARTABLE de esta máquina/VM.
pnpm exec supabase db reset --local
pnpm exec supabase seed buckets --local

pnpm test:db
pnpm check:database-types
pnpm test:fixtures
pnpm test:integration
node scripts/with-local-supabase.mjs build
pnpm exec playwright install chromium
pnpm test:e2e:local
pnpm test:auth:restart
```

En Linux, la instalación de Chromium puede requerir `pnpm exec playwright install --with-deps chromium`, como usa CI.

- [ ] Confirmar todas las suites aprobadas. Ejecutar SQL antes de las pruebas que crean datos o cambian el control de upload.
- [ ] Conservar la salida resumida y la revisión probada, sin claves ni respuestas sensibles.
- [ ] Detener al terminar: `node scripts/local-supabase-lifecycle.mjs stop`.

`test:auth:restart` interrumpe y reinicia Supabase local. El E2E completo también modifica datos de prueba. No apuntar estos runners al proyecto compartido.

Las pruebas automáticas desactivan Sentry: sus errores simulados no deben aparecer en el proyecto real. Un fallo en fixtures de Storage exige revisar su carga; no omitir ese check. Si la instalación limpia de CI revela que falta preparar algún recurso, corregir el workflow y volver a probarlo.

**Salida:** suite completa aprobada sobre datos descartables. Si solo se dispone de GitHub Actions, dejar esta fase pendiente y completarla allí; el PR no se integra hasta que pase todo.

## 5. Verificar envío real a Sentry desde local

- [ ] Arrancar Supabase local y disponer de una cuenta con Profile persistido `Admin`.
- [ ] Obtener su UUID desde Auth local. No usar el UUID de la cuenta hospedada por suposición.
- [ ] Liberar el puerto 3000 y abrir PowerShell en la raíz.

```powershell
$env:APP_ORIGIN = "http://127.0.0.1:3000"
$env:KDM_DISABLE_SENTRY = "0"
$env:NEXT_PUBLIC_KDM_DISABLE_SENTRY = "0"
$env:KDM_SENTRY_DIAGNOSTICS_ENABLED = "1"
$env:KDM_SENTRY_DIAGNOSTICS_OPERATOR_IDS = "<UUID-ADMIN-LOCAL>"
$env:KDM_SENTRY_DIAGNOSTICS_EXPIRES_AT = [DateTime]::UtcNow.AddMinutes(45).ToString("yyyy-MM-ddTHH:mm:ssZ")
node scripts/sentry-local-smoke.mjs
```

- [ ] Iniciar sesión en `http://127.0.0.1:3000` y abrir `/sentry-example-page`.
- [ ] Pulsar una vez `Test browser reporting` y guardar referencia de correlación e ID del evento.
- [ ] Repetir con `Test server reporting`.
- [ ] En Sentry, organización `saas-project-kdm`, proyecto `knowledge-decay-monitor`, encontrar ambos eventos almacenados, no solo el issue agrupado.
- [ ] Confirmar `environment=development`, release del SHA local, `runtime=browser/server`, `synthetic=true` y correlación idéntica a la UI. Con cambios sin commit, el release lleva `-dirty`.
- [ ] Inspeccionar detalles/JSON: sin documentos, nombres/rutas de archivos, URLs firmadas, usuario, tokens, requests, cookies, cabeceras, stack ni respuesta cruda del proveedor. El diseño envía mensaje fijo y campos permitidos.
- [ ] Probar rechazo para usuario anónimo, Member, QA Lead y Admin fuera de la lista.
- [ ] Mantener una página abierta hasta vencer la ventana y comprobar que no permite nuevas emisiones.
- [ ] Confirmar que `/api/sentry-example-api` devuelve 404.

El event ID y `Queue flush: Completed` son recibos del SDK; encontrar el evento en Sentry es la evidencia de recepción.

Al terminar, detener Next y limpiar la autorización temporal en esa terminal:

```powershell
$env:KDM_SENTRY_DIAGNOSTICS_ENABLED = "0"
$env:KDM_SENTRY_DIAGNOSTICS_OPERATOR_IDS = ""
$env:KDM_SENTRY_DIAGNOSTICS_EXPIRES_AT = ""
$env:KDM_DISABLE_SENTRY = "1"
$env:NEXT_PUBLIC_KDM_DISABLE_SENTRY = "1"
```

**Salida:** dos eventos locales comprobados y diagnóstico cerrado. El script configura el DSN mediante el código existente; no necesita un token administrativo de Sentry para emitir eventos.

## 6. Preparar los servicios externos antes del primer push

Seguir la [guía detallada del paso 6](./s1-08-paso-6-configuracion-externa.md): incluye pantallas, valores, creación de tokens, protecciones, callbacks y comprobación de cada ajuste. Las listas siguientes sirven como resumen.

### 6.1 Vercel: impedir una publicación anticipada

- [ ] Coordinar una ventana sin pushes con el equipo.
- [ ] Registrar deployment, SHA y alias Production vigentes como referencia de recuperación.
- [ ] Abrir el proyecto `knowledge-decay-monitor` del team `KDM` (`kdm17`).
- [ ] Revisar la configuración de Git y desactivar deployments automáticos por Git. Si la interfaz exige desconectar el repositorio, conservar el proyecto, dominios y deployments existentes.
- [ ] Revisar Deploy Hooks y otras automatizaciones; retirar o desactivar las que permitan publicar fuera del gate acordado.
- [ ] Registrar quién hizo el cambio y cuándo. La evidencia posterior debe demostrar que un push fallido no crea deployment.

`vercel.json` desactiva la vía Git cuando Vercel lo adopta. No protege por sí solo las revisiones anteriores. Completar este corte antes de subir el candidato.

### 6.2 GitHub: entornos, credenciales y revisión

En `JMCoC/knowledge-decay-monitor` → Settings → Environments, verificar `Preview` y `Production` y cargar:

| Nombre | Tipo | Entorno | Valor/uso |
|---|---|---|---|
| `VERCEL_ORG_ID` | Variable | Ambos | `team_bvEGwlSgqo1NXRjZFmbeNrdA` |
| `VERCEL_PROJECT_ID` | Variable | Ambos | `prj_G6YEOlZYghON8XlDozxlrkBuxvUJ` |
| `VERCEL_TOKEN` | Secret | Ambos | Token con el alcance mínimo disponible para el team y operaciones de publicación. |
| `SENTRY_AUTH_TOKEN` | Secret | Ambos | Credencial de build/source maps para la organización/proyecto Sentry. |
| `APP_ORIGIN` | Variable | Production | `https://knowledge-decay-monitor.vercel.app` |

- [ ] Contrastar los IDs con el proyecto actual antes de guardarlos.
- [ ] Guardar secretos directamente en GitHub; nunca en commit, chat ni evidencia.
- [ ] Confirmar que quien origina o relanza el workflow tiene `write`, `maintain` o `admin`; el ejecutor valida ambos actores.
- [ ] Disponer de otro revisor habilitado.
- [ ] Proteger `main` y `develop`: PR obligatorio, una aprobación independiente, invalidación de aprobaciones obsoletas, rama actualizada, sin force push/borrado ni bypass ordinario.
- [ ] Tras la primera ejecución del workflow candidato, seleccionar el check real `Quality gates` de GitHub Actions como requerido. No integrar mientras falte esta regla.
- [ ] Si se usan restricciones de ramas en Environments, permitir el flujo real de PR en Preview y limitar Production a `main`; verificar que la política no bloquea los jobs previstos.

El workflow utiliza `github.token` efímero para consultas GitHub. No agregar una clave administrativa de Supabase al job de calidad. `SENTRY_AUTH_TOKEN` se entrega al build, no al runtime.

### 6.3 Variables Vercel y Auth Supabase

- [ ] En Vercel, revisar por separado los scopes Preview y Production: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` y `SUPABASE_SERVICE_ROLE_KEY`. El cliente servidor actual consume exactamente esta última variable.
- [ ] Mantener credenciales privilegiadas sin prefijo `NEXT_PUBLIC_` y fuera de artefactos.
- [ ] Confirmar el backend previsto para cada entorno. Si comparten Supabase, usar cuentas/datos de prueba autorizados y evitar pruebas destructivas.
- [ ] Mantener diagnósticos deshabilitados por defecto. No fijar manualmente un release antiguo: el ejecutor establece SHA, target y origin.
- [ ] En Supabase Auth → URL Configuration, verificar Site URL Production y callback `https://knowledge-decay-monitor.vercel.app/auth/callback`.
- [ ] Cuando exista el número de PR, permitir su callback exacto `https://kdm-pr-<NUMERO-PR>-kdm17.vercel.app/auth/callback` antes de probar recuperación.
- [ ] Verificar plantilla hospedada de recuperación y entrega de correo. La plantilla local/Mailpit no configura el servicio hospedado.
- [ ] Revisar por separado la integración Git/migraciones de Supabase y documentar qué ejecuta y contra qué proyecto. No asumir que cambiar Vercel la desactiva.

S1-08 no agrega una migración. No ejecutar reset, seed, fixtures ni migraciones remotas para validar este ticket. Mantener los controles compartidos de upload según la aceptación de S1-02; no activarlos solo para obtener una prueba verde.

**Salida:** configuración lista, automatismos inventariados y ruta anterior de publicación controlada.

## 7. Crear commit y subir el PR candidato

- [ ] Incorporar exclusivamente las rutas revisadas mediante `git add -- <rutas-revisadas>` o selección individual en el editor.
- [ ] Revisar el índice completo:

```powershell
git diff --cached --name-only
git diff --cached --check
git diff --cached
```

- [ ] Confirmar que scripts y archivos nuevos necesarios están incluidos y que no hay secretos ni cambios ajenos.
- [ ] Crear el commit local si aún no se hizo para las pruebas:

```powershell
git commit -m "feat(observability): add safe reporting and deployment quality gates"
```

- [ ] Solo después del corte externo de la fase 6, subir la rama:

```powershell
git push -u origin feature/observability_quality_repository
```

- [ ] Crear en GitHub un PR de esta rama hacia `develop`, del mismo repositorio y no draft para habilitar Preview.
- [ ] Describir S1-08, comportamiento, contratos afectados, pruebas ejecutadas y pendientes S1-04/S1-07. Enlazar los reportes.
- [ ] Si `develop` avanzó, resolver sus cambios conservando ambas funcionalidades y volver a verificar el candidato actualizado. No forzar el push para eludir la revisión.
- [ ] Observar el workflow `Sprint 1`: deben aparecer todas las etapas de `Quality gates`, sin omisiones críticas.

Un push a `develop` ejecuta calidad; Preview se publica desde un PR elegible. Un PR de fork no recibe secretos ni publica Preview. Production solo se publica tras un push a `main` con calidad aprobada.

**Salida:** PR revisable con ejecución remota real. Un build local previo no reemplaza el resultado de Actions.

## 8. Demostrar bloqueo y publicación de Preview

### 8.1 Prueba negativa controlada

- [ ] En el PR, agregar temporalmente una aserción pgTAP `ok(false, 'S1-08 controlled gate failure')`, ajustar el plan de pruebas y conservar la transacción/rollback del archivo.
- [ ] Crear un commit separado y subirlo. No cambiar policies ni datos hospedados.
- [ ] Confirmar fallo específico de SQL dentro de `Quality gates`.
- [ ] Confirmar job Preview omitido y merge ordinario bloqueado por el check requerido.
- [ ] Buscar el SHA fallido en Vercel y demostrar ausencia de un deployment nuevo para ese SHA.
- [ ] Guardar enlaces y SHA. No pulsar bypass ni integrar ese estado.

### 8.2 Camino positivo

- [ ] Retirar únicamente el fallo temporal en otro commit, subirlo y esperar el workflow completo.
- [ ] Confirmar todas las suites aprobadas, incluidas integración, fixtures, E2E y reinicio Auth.
- [ ] Confirmar Preview después de calidad y deployment `READY` en el proyecto previsto.
- [ ] Comparar SHA de `tested_sha`, HEAD del PR y metadatos del deployment: deben coincidir.
- [ ] Abrir `https://kdm-pr-<NUMERO-PR>-kdm17.vercel.app` y comprobar login, sesión, Repository y permisos de los roles disponibles.
- [ ] Comprobar recuperación de contraseña desde ese alias y retorno al mismo entorno.
- [ ] Probar que una ejecución antigua no puede reemplazar el alias del HEAD nuevo. Registrar la secuencia y SHAs; si no se reproduce, dejar la comprobación pendiente.

Si falla una asignación de alias, permiso, build o configuración, resolver la causa y repetir el flujo. No sustituir el alias ni promover manualmente para declarar aprobado el ejecutor.

**Salida:** evidencia del bloqueo real y del SHA verde publicado, sin deployments paralelos por Git.

## 9. Verificar Sentry en Preview

- [ ] Identificar una cuenta hospedada con Profile `Admin` y obtener su UUID.
- [ ] En variables de Vercel, scope Preview, habilitar temporalmente:

```text
KDM_SENTRY_DIAGNOSTICS_ENABLED=1
KDM_SENTRY_DIAGNOSTICS_OPERATOR_IDS=<UUID-ADMIN-HOSPEDADO>
KDM_SENTRY_DIAGNOSTICS_EXPIRES_AT=<FECHA-UTC-CON-Z>
```

La fecha debe estar en el futuro y a no más de una hora al usar el diagnóstico. Configurar cerca del deployment; las pruebas/build pueden consumir la ventana. Una fecha a más de una hora también se rechaza. Si vence, renovar y publicar por el workflow; no ampliar el límite en código.

- [ ] Ejecutar el workflow autorizado del HEAD vigente para crear un deployment que incorpore la configuración. Verificar el nuevo deployment; editar variables no acredita cambios en uno existente.
- [ ] Repetir la fase 5 en el alias Preview: dos botones, dos eventos almacenados e inspección de privacidad.
- [ ] Confirmar `environment=vercel-preview`, release del SHA publicado y correlación exacta.
- [ ] Probar rechazo por rol/lista y vencimiento con página abierta.
- [ ] Deshabilitar `KDM_SENTRY_DIAGNOSTICS_ENABLED`, retirar lista/fecha y publicar de nuevo por el workflow.
- [ ] Confirmar que la página del deployment vigente muestra `Diagnostic access is unavailable.` y no permite nuevas emisiones.

Los builds con source maps también deben verificarse en su ejecución. La ausencia de stack en el evento seguro es deliberada; no añadir datos privados para conseguir una traza.

**Salida:** dos eventos Preview del release correcto y diagnóstico temporal cerrado.

## 10. Integrar y publicar Production

- [ ] Obtener revisión independiente y resolver observaciones del PR hacia `develop`.
- [ ] Confirmar HEAD actualizado y checks requeridos aprobados; integrar mediante GitHub.
- [ ] Verificar el run de `develop` tras la integración.
- [ ] Crear PR de `develop` hacia `main`, revisando todo el diff de release: no asumir que contiene exclusivamente S1-08.
- [ ] Esperar calidad y revisar el Preview de ese PR. Repetir aceptación que afecten los cambios respecto del candidato probado.
- [ ] Obtener aprobación y realizar merge respetando protecciones.
- [ ] Observar el run de push a `main`: calidad primero, Production después.
- [ ] Confirmar SHA de `main`, SHA probado y deployment publicado; usar el SHA resultante del merge, que puede diferir del de la rama original.
- [ ] Abrir `https://knowledge-decay-monitor.vercel.app` y comprobar login, logout, sesión, Repository y recuperación en cuentas autorizadas.
- [ ] Confirmar origin/callback Production y permisos de Admin/QA Lead/Member según el alcance existente.

Para la recepción real Production, repetir la fase 9 con scope **Production** y `environment=vercel-production`. Publicar la configuración temporal mediante una ejecución autorizada del workflow de push a `main` vigente. Comprobar dos eventos, cerrar variables temporales y volver a publicar el cierre por el workflow. No trasladar un UUID local por suposición.

El cambio de variables puede requerir una nueva publicación del mismo SHA. Registrar cada deployment y cuál quedó finalmente en el alias Production. Si la política de reejecución impide publicarlo, resolver el bloqueo dentro del flujo revisado, sin recurrir a un deployment manual.

- [ ] Comprobar que el deployment final tiene diagnósticos cerrados.
- [ ] Confirmar que los otros desarrolladores conocen el nuevo flujo: PR → quality → Preview; merge a `main` → quality → Production.

**Salida:** código integrado en `main`, aplicación operativa y observabilidad comprobada en Production.

## 11. Qué hacer si algo falla

| Síntoma | Siguiente comprobación |
|---|---|
| SQL falla solo en el stack personal | Usar instalación descartable; no borrar datos personales ni alterar expectativas para ocultarlo. |
| Fixtures no descargan originales | Verificar carga local de Storage y permisos; no omitir `test:fixtures`. |
| El workflow no publica Preview | Revisar PR no draft, mismo repositorio, rama destino, quality, permisos de actores y reglas del Environment. |
| Quality falla pero aparece deployment | Detener la integración; revisar Git/deploy hooks u otra vía externa. No aceptar el corte. |
| Sentry no muestra evento | Revisar proyecto, fecha, environment, release, switches, expiración, autorización, red y bloqueadores del navegador. Buscar el evento exacto, no contar issues. |
| Diagnóstico no disponible | Confirmar Admin persistido, UUID permitido, fecha UTC válida y configuración efectiva del deployment. |
| Recuperación termina en otro entorno | Revisar APP_ORIGIN, callback permitido y plantilla hospedada. |
| Publicación falla antes de asignar alias | Confirmar que el alias anterior sigue operativo; conservar evidencia y corregir el flujo. |
| Regresión después de publicar | Detener nuevas publicaciones, registrar el fallo y preparar reversión revisada por PR/workflow. Si hay incidente que exige rollback de emergencia, coordinarlo explícitamente y registrar deployment/SHA restaurado y validación. |

No considerar `READY` suficiente: es necesario comprobar la aplicación a través del alias. No reactivar automáticamente los deployments Git antiguos como solución a un fallo del workflow nuevo.

## 12. Recoger evidencia y cerrar

Actualizar el [reporte de aceptación](./s1-08-acceptance.md) conservando sus límites históricos y añadiendo resultados fechados. Actualizar el [documento de corte](./s1-08-cutover.md) con la configuración efectiva, sin secretos. Incorporar los reportes mediante un PR revisado; no dejarlos solo en el chat o equipo local.

| Evidencia | Registro por completar |
|---|---|
| Commit/PR de implementación y release | SHA, enlaces y revisor |
| Suite limpia y workflow completo | Entorno, fecha, run y resultado de cada etapa |
| Fallo deliberado bloqueado | SHA, SQL fallida, deploy omitido, merge bloqueado y ausencia en Vercel |
| Preview válido | SHA, run, deployment y alias |
| Protección frente a ejecución obsoleta | SHAs, secuencia y resultado |
| Production válido | SHA de main, run, deployment y alias |
| Sentry local | IDs y correlaciones de browser/server, release y entorno |
| Sentry Preview | IDs y correlaciones de browser/server, release y entorno |
| Sentry Production | IDs y correlaciones de browser/server, release y entorno |
| Privacidad y cierre de diagnósticos | Inspección de eventos y prueba de rechazo/caducidad/cierre |
| Integración S1-04/S1-07 | Responsable, PR y resultado de pipeline/retry real |

Guardar enlaces/IDs y resultados sanitizados; no adjuntar capturas o JSON con secretos, documentos, tokens o URLs firmadas.

Checklist final:

- [ ] Código y documentación en `main` mediante PR aprobado.
- [ ] Quality gates completo aprobado sobre la revisión publicada.
- [ ] Publicación condicionada y bloqueo ante fallo demostrados.
- [ ] No queda una vía automática Git/hook que eluda el flujo acordado.
- [ ] Preview y Production funcionan y Auth usa el origin correcto.
- [ ] Seis eventos reales comprobados: browser/server en cada uno de los tres entornos.
- [ ] Diagnósticos cerrados en deployments vigentes.
- [ ] A01–A12 documentados con evidencia, sin confundir simulaciones con pruebas remotas.
- [ ] S1-04/S1-07 integrados: fallos por etapa, retry autorizado/concurrente, estados correctos, sin duplicación ni exposición de contenido y sin alterar el resultado de negocio si falla Sentry.
- [ ] A13 documentado y ticket S1-08 cerrado solo entonces.

Hasta recibir S1-04/S1-07, el estado correcto puede ser **“publicado y operativo; cierre integral pendiente de A13”**. Lo pendiente no son únicamente pruebas: también requiere la implementación e integración de esos tickets, además de cualquier corrección que revele la aceptación remota.

## Referencias

- [Diseño aprobado](../superpowers/specs/2026-10-04-s1-08-safe-observability-quality-gates-design.md).
- [Plan y matriz A01–A13](../superpowers/plans/2026-10-04-s1-08-safe-observability-quality-gates.md).
- [Evidencia local](./s1-08-acceptance.md), [corte operativo](./s1-08-cutover.md) y [handoff de ingesta](./s1-08-ingestion-handoff.md).
- [Supabase: desarrollo local y migraciones](https://github.com/supabase/supabase/blob/master/apps/docs/content/guides/local-development/database-migrations.mdx).
- [Supabase: redirects de Auth](https://supabase.com/docs/guides/auth/redirect-urls).
- [Sentry: APIs del SDK y flush](https://github.com/getsentry/sentry-docs/blob/master/docs/platforms/javascript/common/configuration/apis.mdx).
- [Vercel: configuración Git](https://vercel.com/docs/project-configuration#git) y [CLI en CI](https://github.com/vercel/vercel/blob/main/skills/vercel-cli/references/ci-automation.md).

Los comandos y nombres del proyecto se contrastaron con el checkout y las consultas de documentación realizadas durante esta sesión. La creación de esta guía no ejecuta ninguno de sus pasos de publicación ni modifica servicios externos.
