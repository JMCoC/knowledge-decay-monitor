# S1-08 — Errores seguros, observabilidad y controles de despliegue

Fecha: 2026-10-04. Estado: documento aprobado por el usuario en conversación. Autoriza redactar el plan; la implementación requiere revisar el plan y elegir su modalidad de ejecución.

## 1. Objetivo y decisiones acordadas

Completar S1-08 sobre el vertical slice existente: detectar fallos sin exponer documentación privada, dar respuestas de error fiables y evitar que Preview o Production publiquen código que no haya superado los controles obligatorios.

El usuario acordó:

- Aprovechar la observabilidad, las suites y el workflow existentes.
- Publicar un Preview por PR del equipo solo después de aprobar CI; aplicar el mismo requisito a Production desde `main`.
- Eliminar el disparador independiente de Vercel que hoy permite publicar mientras GitHub Actions sigue ejecutándose.
- Registrar fallos inesperados con datos permitidos; presentar errores controlados y una referencia de soporte.
- Verificar recepción real en Sentry desde local, Preview y Production, además de las pruebas automatizadas de privacidad.
- Consultar eventos en Sentry; no configurar alertas por correo ni otros canales.
- Dejar procesamiento S1-04 y retry S1-07 a sus desarrolladores. S1-08 entrega el contrato y las exigencias de integración, sin implementar esos tickets.

S1-08 tiene una entrega verificable sobre las capacidades presentes y una aceptación integrada dependiente de S1-04/S1-07. Se registran ambas por separado: aprobar la entrega disponible no equivale a cerrar todos los criterios del ticket ni el sprint.

## 2. Fuentes y estado comprobado

Fuentes normativas:

- [PRD](../../PRD/knowledge-decay-monitor-prd-final.md), especialmente §§51–55.
- [Tickets](../../Tickets/tickets.md), S1-08 y dependencias S1-04/S1-07.
- [Arquitectura base](../../architecture/arquitectura-base.md), §§3–6, y [ADR-001](../../architecture/adr/ADR-001-monolito-modular.md).
- [Día Cero](../../architecture/day-zero-protocol.md): ownership, contratos y límites de fixtures locales.
- [Diseño S1-02](2026-10-02-s1-02-tenant-isolation-integration-design.md), [aceptación](../../testing/s1-02-acceptance.md) y [cutover](../../testing/s1-02-cutover.md).

La documentación histórica no sustituye una comprobación actual. Esta exploración verificó código/configuración y realizó lecturas remotas, sin ejecutar suites ni alterar servicios:

| Área | Hallazgo |
|---|---|
| Checkout | Base observada `0d0dd39`; existen archivos locales ajenos sin seguimiento que deben preservarse. |
| Sentry | `@sentry/nextjs` declarado como `^10.75.0`; inicialización browser/server/edge y funciones `reportAuthFailure`, `captureOperationFailure`, `filterSentryEvent`. |
| Privacidad | El filtro reconstruye eventos marcados desde una allowlist y descarta capturas automáticas. La integración de prueba intercepta envelopes del SDK. |
| Huecos | `global-error.tsx` captura una excepción que el filtro descarta; `next dev` tiene envío deshabilitado; la reconstrucción actual no conserva `environment`/`release`. |
| CI | `.github/workflows/s1-01.yml` ejecuta lint, typecheck, unitarias, SQL, tipos, fixtures, integración, build y E2E. No contiene un job de despliegue que dependa de esos resultados. |
| Pipeline | `src/modules/ingestion/processing.ts` devuelve `uploaded`; no demuestra parsing, embeddings ni transición real a `ready`. |
| Vercel | Lectura del proyecto `knowledge-decay-monitor`, equipo `kdm17`: deployments recientes `READY` de `develop` (`0d0dd39`) y `feature/tenant_isolation` (`d80e1de`). Esto no demuestra aceptación funcional ni bloqueo por CI. |
| Sentry remoto | MCP confirmó acceso a `saas-project-kdm/knowledge-decay-monitor`. En una consulta de 14 días hubo 4 eventos `development`, 1 `vercel-preview` y 2 `vercel-production`. No se inspeccionaron sus payloads ni se atribuyeron al código actual. |
| Settings remotos | No se verificaron en esta especificación las protecciones actuales de GitHub, el entorno objetivo de Production, todos los hooks de despliegue ni la automatización Git de Supabase. Deben inventariarse antes del cambio operativo. |

Los registros de aceptación S1-02 describen deployments anteriores. Los deployments recientes observados aquí actualizan esa fotografía, pero no cierran sus comprobaciones funcionales pendientes.

## 3. Alcance y responsabilidades

S1-08 incluye política común de eventos seguros, adaptación de las fronteras de error disponibles, referencia de soporte, pruebas de privacidad, verificación real por entorno, controles de integración/publicación y evidencia reproducible.

Dev 1 coordina `src/lib/observability`, configuración, contratos compartidos, CI y configuración operativa. Dev 2 integra procesamiento/retry y sus invariantes; Dev 3 integra la presentación y los consumidores de Repository. Los cambios dentro de un módulo se revisan con su propietario. No se introducen servicios de telemetría adicionales, colas de observabilidad, tablas de errores ni HTTP entre módulos.

Quedan fuera parsing, chunking, embeddings, implementación de retry, Replace File, nuevos estados de negocio, análisis IA, métricas de cobertura arbitrarias, trazas de rendimiento, Session Replay y alertas externas. Tampoco se reabre toda la aceptación funcional de S1-01 a S1-07 dentro de este ticket.

No se prevé modificar el esquema. Si una corrección de este alcance lo exige, se añade una migración coordinada y se regeneran tipos; no se reescribe una migración compartida ni se edita `database.ts` manualmente.

## 4. Clasificación y contrato de errores

### 4.1 Errores esperados e inesperados

Validaciones, credenciales incorrectas, sesión ausente, denegaciones, recursos no visibles y conflictos de negocio previstos devuelven el `ActionResult` correspondiente sin crear una incidencia en Sentry. Un resultado vacío legítimo no es un fallo.

Errores inesperados de red/proveedor, excepciones de aplicación y fallos de procesamiento registran un evento seguro. La clasificación depende del contexto de la operación; no se decide únicamente por el nombre de una clase de excepción o un código HTTP. Una denegación esperada a un Member no se convierte en fallo del proveedor.

Cada frontera responsable captura una vez. Los helpers propagan errores tipados o resultados; no vuelven a emitir el mismo fallo en cada capa. El fallo de telemetría nunca transforma una operación exitosa en error ni encubre el fallo de negocio original.

### 4.2 Sobre seguro

El filtro final reconstruye un evento nuevo con campos validados. No utiliza una copia extensa del evento original ni admite diccionarios libres de tags, contextos o `extra`.

| Campo | Regla |
|---|---|
| Mensaje | Texto fijo por familia de fallo; nunca `error.message`, payload o input del usuario. |
| Severidad | Valor fijo según la familia; fallos inesperados se registran como error. |
| Módulo y operación | Pares enumerados válidos de identity, workspace, ingestion, repository y application. |
| Código | Catálogo técnico cerrado; no aceptar códigos libres del proveedor. |
| Correlación | UUID generado en la frontera que registra el fallo; no usar una cabecera enviada por el navegador como identidad fiable. |
| Versión/intento | UUID opcional, obtenido del recurso autorizado cuando exista. No añadir identificadores de recursos ajenos a un error de autorización. |
| Entorno | `development`, `vercel-preview` o `vercel-production`, resuelto por configuración del despliegue. |
| Release | SHA completo del commit desplegado; en local, SHA con marca controlada de cambios locales cuando corresponda. |
| Runtime | Enumeración `browser`, `server`, `edge`; el futuro ejecutor de S1-04 se incorpora al definir su runtime real. |
| Prueba sintética | Booleano controlado para distinguir smoke tests de fallos reales. |
| Identidad Sentry | ID/timestamp del SDK validados; nunca campos arbitrarios de un evento externo. |

Los pares iniciales cubren registro/login/logout/recovery/password-update, bootstrap y consultas de workspace, reserve/verify/resume/recover/cleanup/reconcile, list/open, y fronteras inesperadas de aplicación. Se mantienen adaptadores compatibles para los callers actuales mientras se centralizan las reglas duplicadas. `process` y `retry` forman parte del contrato que consumirán S1-04/S1-07.

Quedan excluidos textos de documentos, chunks, embeddings, prompts, respuestas de modelos, nombres de archivo/documento/persona, email, rutas de Storage, hashes de contenido, URLs completas, query strings, signed URLs, IP, cookies, cabeceras, cuerpos HTTP, credenciales y errores crudos de proveedores. Tampoco se envían stack traces originales, variables locales ni líneas de código capturadas automáticamente. La menor profundidad de diagnóstico es una decisión explícita a favor de la privacidad; operación, código, runtime, release y correlación permiten localizar la frontera afectada.

Se deshabilitan los canales no requeridos —replay, trazas, breadcrumbs, logs del SDK y adjuntos— y se verifica el envelope completo. La protección no depende exclusivamente de `beforeSend` para canales que ese hook no controla. Los source maps existentes se revisan como configuración de build; su presencia no demuestra recepción segura y no se promete simbolicación de stacks que esta política elimina.

### 4.3 Excepciones no controladas

Las fronteras de Next.js/navegador deben convertir fallos inesperados en la familia segura `application`, sin reenviar el objeto original. Los eventos automáticos reconocidos se transforman o descartan según una política cerrada; no se habilita el envío automático completo para resolver el hueco actual.

Los mecanismos de control del framework, como redirecciones y respuestas de recurso no encontrado, conservan su semántica y no generan incidentes. Durante implementación se leerán las guías instaladas de Next.js y la documentación vigente del SDK antes de ajustar hooks. Se probarán browser/server y edge solo donde haya ejecución real, sin inventar una ruta Edge para aparentar cobertura.

## 5. Respuestas y consistencia de la UI

Se conserva `ActionResult<T>`. Se propone añadir `correlationId?: string` dentro de `error`, también para errores por ítem en batches. Es una ampliación opcional y compatible: los consumidores existentes pueden seguir mostrando `code`/`message`. Dev 1 coordina el cambio y sus consumidores.

En errores inesperados, la referencia mostrada debe coincidir con la enviada a Sentry. La UI utiliza mensajes fijos en inglés y puede mostrar `Reference: <id>`. El código técnico no expone información interna. Un error de validación esperado no necesita referencia.

Ante un fallo de transporte que impide conocer el resultado del servidor, la UI informa que no pudo confirmar la operación. No asume rollback ni éxito, no crea otra reserva sin comprobar el protocolo existente y usa la reconciliación disponible. Si registra un fallo del navegador, su referencia identifica ese evento cliente, sin atribuirlo a un evento servidor desconocido.

La confirmación de upload no significa que el documento esté procesado. Solo se muestra `ready` con evidencia persistida válida. Repository conserva la separación entre estado de upload, estado técnico y estado funcional. La telemetría no modifica esas columnas.

S1-04/S1-07 deben persistir el resultado técnico correcto aunque Sentry falle; una versión fallida no se activa, un retry no duplica documento/versión y una respuesta perdida no autoriza repetir trabajo concurrente. S1-08 exige las pruebas, pero no introduce esas transiciones en lugar de sus propietarios.

## 6. Configuración y pruebas reales de Sentry

### 6.1 Entornos

`NODE_ENV` no distingue Preview de Production: ambos pueden ejecutar builds de producción. La configuración explícita del entorno y del release debe ser coherente en browser/server/edge y sobrevivir a la sanitización.

Local permanece sin envío real por defecto. Un modo de verificación explícito habilita Sentry con entorno `development`. Las suites ordinarias usan transporte interceptado o envío deshabilitado. Su configuración debe prevalecer frente a archivos `.env` del desarrollador y no apuntar accidentalmente a recursos remotos.

Preview y Production envían eventos seguros de la aplicación. Un smoke test se marca como sintético dentro de su entorno real; no se falsea el entorno para ocultarlo. No se crean reglas de correo ni se alteran reglas existentes sin revisar su alcance.

### 6.2 Mecanismo de smoke test

Se implementa una superficie diagnóstica mínima y temporalmente habilitable en la aplicación, sin navegación de producto. Debe pasar por el mismo SDK, configuración y filtro final que las operaciones reales; un script independiente que envíe directamente a Sentry no sustituye esta prueba.

La superficie ofrece escenarios cerrados de error sintético browser/server. No acepta mensajes, objetos de error, paths, IDs de documentos ni destinos arbitrarios. Usa constantes inocuas y una correlación nueva; no consulta ni cambia documentos o estados de procesamiento. La variante servidor falla dentro de una operación diagnóstica aislada y devuelve un resultado controlado.

El servidor exige sesión verificada, rol Admin persistido, usuario operador incluido en una allowlist de configuración y habilitación temporal con vencimiento. Ser Admin de cualquier workspace no basta. La autorización se repite en el comando servidor; la emisión no se dispara por un GET ni al visitar una página. Deshabilitada, vencida o sin autorización, la superficie no permite emitir eventos. La habilitación operativa no se guarda en tablas de negocio.

El escenario navegador se ejecuta desde esa superficie autorizada. No se convierte la marca `synthetic` en una prueba de identidad o un permiso. La cuenta operadora y la habilitación se usan durante la validación y se verifica después que la superficie quede cerrada.

El envío espera de forma acotada cuando el runtime lo necesita; agotar ese plazo devuelve una comprobación inconclusa, sin afectar datos. Un ID devuelto por el SDK o una cola drenada no prueban que Sentry haya almacenado el evento.

### 6.3 Evidencia y frecuencia

| Prueba | Momento | Criterio |
|---|---|---|
| Privacidad con transporte interceptado | Cada CI | Envelope final sin sentinelas prohibidos; solo familias/campos permitidos. |
| Local real | Aceptación inicial y cambios de observabilidad | Evento browser y server del checkout ejecutado encontrados en `development`. |
| Preview real | Primera aceptación y cambios de observabilidad/despliegue | Eventos encontrados para el deployment y SHA validados. |
| Production real | Primera aceptación y cambios de observabilidad/despliegue | Eventos sintéticos encontrados sin afectar operaciones reales. |

La comprobación remota usa el MCP de Sentry disponible o una consulta equivalente autorizada y acotada por proyecto, entorno, release y correlación. Se espera hasta dos minutos por evento; la ausencia al vencer el plazo deja la prueba fallida/inconclusa y se investiga, sin bucles indefinidos ni declarar éxito por el envío local.

La evidencia contiene fecha UTC, entorno, SHA, runtime, escenario, correlación, ID/enlace de evento y resultado de inspección. Se inspecciona el evento almacenado para confirmar datos permitidos y ausencia de campos sensibles; no se vuelca el payload íntegro a artefactos. Las pruebas con sentinelas que simulan secretos se realizan solo con transporte interceptado, nunca contra Sentry real.

No es obligatorio emitir smoke tests remotos por cada PR ajeno a observabilidad. La indisponibilidad de Sentry no convierte las suites locales en fallidas por dependencia de red. Cuando la comprobación real corresponda, una entrega no se acepta hasta completarla.

## 7. Un único flujo automático de publicación

### 7.1 Flujo acordado

1. PR del equipo hacia `develop` o `main`: ejecutar todos los controles requeridos sobre el SHA que se publicará en Preview.
2. Solo con resultado satisfactorio de todos los controles, publicar Preview para ese PR desde GitHub Actions.
3. Después de integrar en `main`, volver a ejecutar los controles sobre el commit integrado y publicar Production desde Actions si aprueban.
4. Mantener en `develop` los controles de integración. Esta spec no requiere un segundo despliegue automático de rama `develop` además de los Previews por PR.

El job de deploy depende explícitamente de los jobs de calidad. Fallo, cancelación o controles omitidos no autorizan publicar. No basta consultar el estado verde más reciente de una rama: la evidencia, el checkout y el despliegue deben corresponder al mismo SHA. Si se valida adicionalmente un merge sintético de PR, ese resultado no se atribuye al head sin validar.

La publicación de PR queda limitada a ramas del mismo repositorio y actores autorizados. Los PR de forks pueden ejecutar controles sin credenciales de publicación. No se ejecuta código no confiable con secretos mediante `pull_request_target`.

Cada PR tiene concurrencia propia; una ejecución reemplazada no actualiza su Preview. Production serializa publicaciones y comprueba que no se publique un commit obsoleto por terminar más tarde. Los secretos de despliegue no se entregan a los jobs de pruebas que no los necesitan.

### 7.2 Corte del disparador de Vercel

Se incorpora `git.deploymentEnabled: false` en `vercel.json`, conservando la configuración existente que pueda añadirse antes de implementar. Se prepara y valida la publicación por CLI desde Actions antes de dar el corte por terminado.

Un archivo versionado solo protege ramas que lo contengan. Por ello se inventariarán ramas activas, deploy hooks y disparadores del proyecto; el corte debe eliminar el bypass de ramas antiguas. Si el vínculo Git sigue permitiendo esas publicaciones, se desconecta el repositorio del proyecto Vercel al completar la transición a CLI. La conexión con GitHub Actions usa las credenciales/identificadores del proyecto y no depende de mantener ese disparador.

Se comprueba la URL de Preview, su asociación con el PR y los dominios/callbacks de Auth antes de cerrar el cambio: no se asume que la CLI conserve automáticamente todos los aliases o comentarios de la integración Git. La URL queda accesible desde el resumen/check del workflow; publicar comentarios de bot no es necesario.

El build destinado a desplegar usa la configuración de Preview o Production. No se reutiliza un artefacto construido contra el Supabase local de CI ni con Sentry deshabilitado para pruebas. Dentro de cada destino se evita reconstruir innecesariamente el mismo artefacto; la implementación fija una versión compatible de la CLI y valida el procedimiento documentado vigente.

### 7.3 Protecciones y comprobación negativa

`develop` y `main` deben exigir los checks observados del workflow, revisión y ausencia de bypass ordinario por push directo. Se comprueba disponibilidad de esas protecciones en el plan y permisos reales de GitHub. Si no pueden configurarse, se registra una limitación de aceptación; no se presenta un YAML como protección de rama efectiva.

La prueba negativa se hace en un PR controlado: se introduce una aserción de aislamiento que falle únicamente en el stack descartable de CI, sin debilitar políticas reales. Deben fallar el gate, el merge ordinario y el job de despliegue. Se comprueba que ese SHA no tenga nuevo deployment. Luego se corrige la prueba y se demuestra que el SHA aprobado sí publica. Se verifican también las condiciones de Production sin integrar deliberadamente una regresión en `main`.

Los accesos administrativos manuales de los proveedores constituyen una vía operativa excepcional; no se promete impedir a un propietario de cuenta modificar sus propias reglas. Se eliminan los bypass automáticos y se documenta cualquier excepción administrativa.

## 8. Suites y migraciones

Se conserva pnpm 12.5.1, el lockfile y las suites existentes. El workflow se nombra según su alcance real de Sprint 1; cambiar nombres de checks requiere actualizar las reglas de rama sin dejar una ventana sin protección.

| Control previo | Evidencia requerida |
|---|---|
| Lint y typecheck | Código y contratos compilan sin errores; generación de tipos Next incluida. |
| Vitest | Reglas de eventos, clasificación, correlación, sanitización, fallos de transporte y consumidores disponibles. |
| SQL/RLS | Aislamiento de lecturas/mutaciones, roles y acceso a originales; no reducir a tests con mocks. |
| Instalación limpia | Stack local descartable creado desde migraciones versionadas, sin ajustes manuales al esquema. |
| Coherencia de tipos | Tipos generados del esquema local coinciden con el archivo versionado. |
| Fixtures/integración | Auth, bootstrap, REST, Storage y flujos de upload/Repository disponibles. |
| Build | Build de aplicación válido; distinguir build local de prueba y build del destino de publicación. |
| Playwright | Auth/Workspace, upload/Repository/apertura y presentación de errores sobre servicios locales reales. Chromium obligatorio. |

Si S1-08 introduce una migración, se prueba también el upgrade desde la base integrada anterior; no se exige rehacer todas las trayectorias históricas por un cambio exclusivamente de telemetría.

Los tests no omiten una aserción porque falte un fixture: su ausencia falla. No se reutiliza un servidor de origen desconocido. Se mantienen desactivados traces, videos, screenshots y HAR que pudieran contener sesión, documentos o signed URLs; los reportes contienen identificadores y resultados controlados.

Git es la fuente de verdad del esquema. Se inventaría en modo lectura la integración Git de Supabase y su destino antes de dar por cerrado el control de publicación. Los PR ejecutan migraciones en local; no aplican automáticamente migraciones al backend compartido, no usan `--linked` para pruebas y nunca le aplican seed/reset. Cualquier automatismo remoto existente que evite los gates debe quedar deshabilitado o subordinado a una operación de release coordinada y comprobada.

Las migraciones remotas necesarias para una entrega se revisan, aplican al destino explícito y verifican como operación separada del test local. No se presupone que rollback de Vercel revierta la base de datos. Preview y Production siguen compartiendo el backend del MVP, de modo que los cambios de esquema deben ser compatibles con los consumidores activos.

## 9. Contrato con S1-04 y S1-07

S1-08 entrega la función de captura segura, pares de operación/código, reglas de entorno/release/correlación, pruebas de contrato y una lista de aceptación a los propietarios. El futuro runtime de procesamiento debe usar un adaptador compatible con la política, sin importar un SDK exclusivo de Next.js a un runtime incompatible.

| Ticket | Obligación al integrarse |
|---|---|
| S1-04 | Identificar etapa fallida mediante catálogo cerrado; emitir fallo seguro; persistir `processing_failed`; mantener v1 sin activar hasta finalizar correctamente; probar parsing/chunking/embeddings reales. |
| S1-07 | Reautorizar, controlar concurrencia, conservar documento/versión/original y registrar fallo del retry; comprobar que fallar otra vez mantiene el estado correcto y no consume créditos. |
| Repository | Mostrar estados persistidos y errores controlados; solicitar retry a ingestion; no escribir estados del pipeline. |
| Integración | Ejecutar `upload → processing → repository → secure open` y retry exitoso/fallido con aislamiento de tenant. |

Mientras no estén integrados, las pruebas de contrato pueden usar dobles para validar el sobre seguro. La evidencia los etiqueta como tales. Los escenarios reales se mantienen en la matriz de pendientes, no como tests omitidos que den una falsa señal de cobertura.

## 10. Matriz de aceptación y cierre

| ID | Requisito | Evidencia y responsable |
|---|---|---|
| A01 | Fallos de Auth/Workspace/upload/Repository registrables | Tests de las fronteras disponibles y eventos seguros; S1-08 con propietarios. |
| A02 | Excepciones no controladas detectables sin filtrar datos | Prueba de frontera browser/server y envelope; S1-08. |
| A03 | Privacidad integral | Sentinelas ausentes de eventos/envelopes y artefactos; canales no requeridos deshabilitados. |
| A04 | Mensaje controlado, correlación y ausencia de éxito falso | Vitest/Playwright con error backend y respuesta perdida. |
| A05 | Local observable | Eventos browser/server encontrados e inspeccionados en Sentry con release local. |
| A06 | Preview observable | Eventos del SHA desplegado encontrados e inspeccionados. |
| A07 | Production observable | Eventos sintéticos del SHA desplegado encontrados e inspeccionados; superficie diagnóstica cerrada después. |
| A08 | Schema reproducible | Instalación limpia, SQL/RLS y coherencia de tipos aprobados; upgrade si hay nueva migración. |
| A09 | CI obligatorio | Todas las suites requeridas ejecutadas; Auth/Workspace y Upload/Repository reales dentro del alcance existente. |
| A10 | Publicación y merge bloqueados | PR negativo, ausencia de deployment del SHA fallido, reglas remotas y ausencia de disparadores paralelos. |
| A11 | Publicación válida | Preview por PR y Production desde `main`, SHA y configuración de destino correctos, sin publicación obsoleta. |
| A12 | Handoff de procesamiento/retry | Contrato y escenarios entregados para revisión de los propietarios; integración real identificada como dependencia. |
| A13 | Fallos de procesamiento y retry consistentes y observables | Pruebas reales de S1-04/S1-07 integrados; responsabilidad compartida al cerrar Sprint 1. |

**Entrega S1-08 sobre la base actual:** requiere satisfacer A01–A12 con evidencia actual. Si falta configuración/acceso remoto, queda pendiente aunque los tests locales pasen. Esta entrega se informa como parcial respecto del DoD completo cuando A13 aún no exista.

**Cierre íntegro de S1-08:** requiere satisfacer A01–A13. **Cierre de Sprint 1:** además, aceptación de los demás tickets; una prueba crítica de aislamiento fallida impide declararlo Done.

Las pruebas previas bloquean crear/publicar el deployment. Las verificaciones reales de Sentry ocurren después de publicar; si fallan, la entrega queda sin aceptar y se corrige o se vuelve a una versión conocida cuando corresponda. No se llama a esa comprobación posterior un bloqueo previo ni se realiza rollback automático por una demora de ingestión de Sentry.

## 11. Artefactos de implementación y revisión

El plan posterior concretará tareas y comandos sobre estos puntos existentes:

- `src/lib/observability/`, inicialización Sentry, `src/instrumentation.ts`, `src/app/global-error.tsx` y ejemplos diagnósticos existentes.
- Fronteras y UI de `identity`, `workspace`, `ingestion` y `repository`, únicamente para contrato de errores y captura segura.
- `src/types/contracts.ts` y tests de sus consumidores para la referencia opcional.
- `tests/unit/`, pruebas de transporte/integración y E2E críticos; scripts locales de verificación.
- `.github/workflows/`, `vercel.json`, configuración de tests/build y documentación operativa.
- Informe de aceptación S1-08 con SHA, comandos, resultados, enlaces seguros y pendientes explícitos.

No se añaden dependencias ni se ejecutan cambios remotos al redactar esta spec. Se preservan archivos ajenos sin seguimiento. La instrucción del repositorio de no hacer commit sin autorización prevalece sobre el commit sugerido por brainstorming; el documento queda sin commit para revisión.

## 12. Referencias técnicas consultadas

Consulta realizada con Context7 y documentación oficial durante el diseño:

- [Vercel: desactivar deployments Git](https://vercel.com/docs/project-configuration/git-configuration#turning-off-all-automatic-deployments).
- [Vercel: GitHub Actions, builds y despliegues](https://vercel.com/kb/guide/how-can-i-use-github-actions-with-vercel).
- [Sentry JavaScript: filtro beforeSend](https://github.com/getsentry/sentry-docs/blob/master/platform-includes/configuration/before-send/javascript.mdx).
- [Sentry JavaScript: opciones del SDK](https://github.com/getsentry/sentry-docs/blob/master/docs/platforms/javascript/common/configuration/options.mdx).
- [Sentry JavaScript: API de flush](https://github.com/getsentry/sentry-docs/blob/master/docs/platforms/javascript/common/configuration/apis.mdx).

Las opciones concretas se contrastarán con versiones instaladas durante la planificación/implementación. Esta spec fija resultados y fronteras; no toma snippets de otros runtimes como instrucciones de Next.js.
