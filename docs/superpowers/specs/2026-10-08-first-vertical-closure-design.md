# Diseño de cierre del primer vertical — S1-01 a S1-08

**Fecha:** 2026-10-08.
**Estado:** documento y método de ejecución nativa aprobados por el usuario el 2026-10-08.
**Objetivo:** corregir los defectos del pipeline y demostrar el recorrido completo prometido en local, Preview y Production.
**Base de revisión:** cambios posteriores a `cc844063f23c0e84a8499e58263a823f153e800b`, hasta `4beab01032f836da5aaf40e02f75d5089d587089` en `develop`.

**Actualización de runtime, 2026-10-09:** la decisión de HTTP/Edge, presupuesto de 50 segundos y recuperación manual queda sustituida por el [diseño de ingesta durable](2026-10-09-durable-ingestion-design.md), autorizado mediante la solicitud de implementación. El resto de criterios de este documento se conserva; no interpretar las cifras históricas siguientes como configuración actual.

## 1. Fuentes y decisiones aprobadas

Este documento complementa los [tickets S1-01 a S1-08](../../Tickets/tickets.md), el [PRD](../../PRD/knowledge-decay-monitor-prd-final.md), la [arquitectura](../../architecture/arquitectura-base.md), [ADR-001](../../architecture/adr/ADR-001-monolito-modular.md) y el [protocolo del Día Cero](../../architecture/day-zero-protocol.md). La [especificación S1-04](2026-10-06-s1-04-processing-spec.md) aporta el pipeline existente. El [corte S1-08](../../testing/s1-08-cutover.md) aporta el mecanismo de despliegue; sus inventarios históricos deben verificarse antes de ejecutar operaciones remotas.

El usuario eligió reforzar el pipeline existente y cerrar los tres entornos. Se conservan `gte-small`, embeddings de 384 dimensiones, máximo de 500 chunks por versión, presupuesto de 50 segundos por intento y recuperación manual de leases vencidas a los 180 segundos. Se cambia explícitamente la política de embeddings de S1-04: de ocho entradas por llamada y concurrencia cuatro a una entrada por llamada y un máximo de dos llamadas simultáneas por intento.

El límite de upload de 10 MiB por archivo es distinto del límite de procesamiento. Un archivo aceptado puede terminar en un fallo controlado por exceso de chunks, ausencia de texto, fallo del proveedor o agotamiento del presupuesto. Los casos representativos de éxito definidos aquí deben llegar a `ready`; aceptar cualquier estado terminal no certifica el pipeline.

La entrega comprende código, una migración nueva, contratos y tipos coherentes, regresiones, documentación operativa y aceptación remota. No incorpora una cola durable, scheduler, procesamiento resumible, análisis LLM, búsqueda semántica ni funcionalidades de sprints posteriores. Upload y retry siguen sin consumir créditos. Los objetos huérfanos remotos se revisan por separado y no se borran como parte de este cierre.

## 2. Hallazgos que motivan el cambio

La auditoría del 8 de octubre verificó el flujo local hasta `ready/active` y apertura del original para PDF textual, DOCX y Markdown pequeños. También reprodujo los siguientes defectos:

| Hallazgo | Evidencia | Resultado requerido |
|---|---|---|
| El worker envía todos los chunks a una función que acepta como máximo ocho | Markdown de 14.451 bytes y nueve chunks: cero llamadas al proveedor, `processing_failed` | Procesar más de ocho chunks sin truncar ni rechazar por el tamaño de una llamada |
| Ocho textos por invocación exceden CPU en el runtime local probado | HTTP 546 `WORKER_LIMIT`; una entrada sí devolvió 384 dimensiones | Usar una entrada por llamada y medir la concurrencia aprobada con chunks representativos |
| `finish_processing` valida sin bloquear la versión | Dos conexiones permitieron completar el intento A después de reclamar B | Un intento obsoleto no puede insertar chunks, activar una versión ni borrar el claim vigente |
| El timer no cubre embeddings ni finalización | Con reloj acelerado, un resultado tardío terminó en `ready` | Cancelación, controles de presupuesto y protección SQL contra finalización tardía |
| `after()` descarta la promise de dispatch | El callback devuelve `undefined`; no controla fallos HTTP o de red | Esperar el dispatch, controlar fallos y permitir recuperar el upload confirmado |

Estas evidencias corresponden al checkout auditado. La prueba de deadline utilizó reloj acelerado y proveedor simulado; el HTTP 546 fue observado en local. Ninguna de ellas demuestra por sí sola el comportamiento cloud después de la corrección.

## 3. Arquitectura y flujo

Se mantiene el monolito modular. `identity` verifica sesión y Profile; `ingestion` autoriza comandos, reclama intentos y procesa; `repository` lee proyecciones con sesión/RLS y solicita comandos al módulo propietario. El handler Node usa Storage, parsing y PostgreSQL; la función auxiliar `embed` genera los vectores con `gte-small`. El navegador no invoca endpoints internos ni recibe credenciales privilegiadas.

El flujo es: confirmar upload → programar y esperar dispatch mediante `after` → reclamar versión atómicamente → descargar original canónico → parsear → generar chunks determinísticos → generar todos los embeddings → finalizar en una transacción. Ante un fallo, el intento vigente marca `processing_failed`. El original confirmado conserva su identidad y continúa disponible para usuarios autorizados.

### 3.1 Embeddings completos y acotados

El adaptador recibe el conjunto de textos de la versión y organiza llamadas de una entrada con concurrencia máxima dos. Conserva la correspondencia entre índice de entrada y vector aunque las respuestas lleguen en otro orden. Valida cantidad, dimensiones y valores finitos de todas las respuestas. No persiste chunks mientras haya resultados pendientes.

Cuando falle una llamada o venza el presupuesto, deja de iniciar llamadas, cancela las esperas compatibles y descarta los resultados parciales. No hay retries automáticos ilimitados del proveedor. El warm-up y las pruebas del adaptador deben representar esta política, sin exigir el antiguo lote de ocho. Los cambios del endpoint auxiliar deben conservar compatibilidad durante el corte con las aplicaciones que aún estén desplegadas.

La concurrencia dos es por intento, no un límite global de toda la plataforma. La aceptación incluye el batch permitido de diez archivos y mediciones en frío y con el modelo calentado. Si la política aprobada no supera estas pruebas, el vertical sigue abierto; no se amplían los límites ni se cambia el modelo silenciosamente.

### 3.2 Presupuesto y recuperación

Los 50 segundos cubren el intento desde su claim, incluyendo descarga, parsing, chunking, embeddings, finalización o persistencia del fallo y entrega acotada de telemetría. Se reservan los últimos cinco segundos para cierre: el trabajo de extracción y embeddings debe detenerse antes de consumir esa reserva. Se comprueba el tiempo restante entre fases y antes de iniciar cada llamada.

Las operaciones de red compatibles reciben cancelación y timeout. El parsing no cancelable debe comprobar el presupuesto inmediatamente después de retornar. La finalización SQL valida la vigencia temporal usando el reloj del servidor y el inicio persistido del intento, después de obtener el bloqueo y antes de activar. Sus esperas y ejecución deben quedar acotadas por el presupuesto restante; una promise cancelada en Node no se considera prueba de rollback en PostgreSQL.

La actualización de fallo exige el mismo `operation_id` y estado `processing`: un worker antiguo tampoco puede marcar como fallido el intento nuevo. Ante una respuesta de finalización perdida, se reconcilia el estado persistido antes de informar el resultado. Un estado ya confirmado como `ready` no se degrada por una pérdida de respuesta.

Una caída del proceso o indisponibilidad de PostgreSQL puede impedir persistir el fallo. En ese caso permanece `processing` y se recupera manualmente cuando venza la lease de 180 segundos. El diseño no promete persistencia de un fallo durante una caída de la base de datos ni recuperación automática sin intervención.

### 3.3 Finalización y migración

Se añade una migración posterior a `20261006172303_finish_processing.sql`; la migración compartida existente permanece intacta. La corrección bloquea la fila de versión antes de validar estado, upload confirmado, v1, estado funcional, identificador de intento y presupuesto. Solo el intento vigente puede continuar.

Chunks, `processing_status=ready`, `version_status=active` y `documents.active_version_id` se persisten juntos. Un error de validación, vector, deadline o escritura revierte toda esa transacción. Los índices de chunks deben conservar orden y unicidad. Un conjunto incompleto no puede activar la versión.

La RPC sigue siendo interna y exclusiva de `service_role`, con permisos y `search_path` explícitos. Ningún identificador del cliente concede tenant o rol. Se revisan tanto los GRANT como RLS y las relaciones de tenant después de migrar.

### 3.4 Dispatch y estados visibles

El callback de `after` devuelve o espera la operación de dispatch y controla configuración ausente, rechazo de red y respuesta HTTP fallida. El origen se obtiene de configuración confiable del servidor y el token interno se envía exclusivamente entre componentes del servidor. El timeout del dispatch debe contemplar la ejecución del handler sin crear una espera indefinida.

Un fallo de dispatch posterior a la confirmación no convierte una transferencia exitosa en un upload fallido ni crea otra versión. Si el handler no reclamó la versión, esta permanece `uploaded`; si alcanzó a reclamarla antes de perderse la respuesta, se conserva y reconcilia su estado persistido. Se emite un fallo seguro de procesamiento y se ofrece la recuperación correspondiente. Un dispatch duplicado pierde el claim sin iniciar un segundo procesamiento.

## 4. Recuperación desde Repository

Admin y QA Lead tienen estas acciones sobre la última v1 no activa con upload confirmado:

| Estado | Acción en la UI, en inglés | Condición del servidor |
|---|---|---|
| `uploaded` | `Start Processing` | Claim inicial atómico sobre la misma versión |
| `processing_failed` | `Retry Processing` | Reautorizar y reclamar un nuevo intento |
| `processing` con lease vencida | `Retry Processing` | Reclaim atómico únicamente después de 180 segundos |
| `processing` vigente | Estado de procesamiento | Rechazar el reclaim |
| `ready`, upload sin confirmar o versión no elegible | Sin acción de procesamiento | Rechazar el comando |

Se reutiliza `retryProcessing(versionId)` como comando de recuperación para los tres estados elegibles; conserva su resultado `ActionResult` y amplía explícitamente su precondición para incluir `uploaded`. Un segundo clic concurrente produce conflicto controlado. Los fallos de procesamiento siguen mostrándose como fallos, aunque el dispatch HTTP haya respondido correctamente.

La proyección autorizada incorpora `latest_processing_started_at`; `RepositoryItem.latestVersion` incorpora `processingStartedAt: string | null`. El tiempo se utiliza para presentar la recuperación de leases vencidas y refrescar el estado. La elegibilidad real se revalida siempre en el servidor. La UI no recibe el token interno ni necesita el identificador de operación.

Documento, versión y ruta del original se conservan en todos los reintentos. `Open Original` continúa disponible para uploads confirmados, independientemente del resultado del procesamiento, con la autorización existente y URL firmada de 300 segundos. Owner sigue siendo metadata; un Member indicado como Owner no obtiene acceso al Repository ni al original.

## 5. Errores y evidencia segura

Se conserva la taxonomía controlada de observabilidad y `ActionResult`. La clasificación de parsing, chunking, embeddings y persistencia no expone errores crudos. Dispatch se registra como operación de procesamiento mediante códigos permitidos; no se introduce una cadena libre como código de fallo.

Cada prueba remota de error debe verificar un evento realmente recibido por Sentry, vinculado a environment, release/SHA y correlation ID. Los identificadores seguros de versión e intento pueden correlacionar el fallo según la allowlist. La entrega de telemetría tiene una espera acotada dentro del presupuesto y su fallo no sustituye el resultado del producto.

No se registran textos, chunks, vectores, documentos, URLs firmadas, tokens, cookies ni respuestas crudas de proveedores. Se inspeccionan el evento persistido y su contexto, no solo el recibo del SDK. El caso de aceptación usa un documento sintético que provoca un fallo real del pipeline; un evento manual desde una página de diagnóstico no lo reemplaza.

## 6. Matriz de aceptación

Cada entorno debe aportar evidencia del recorrido funcional completo. Local y CI aportan además las pruebas determinísticas de carreras y fallos inyectados. Las pruebas remotas usan únicamente cuentas, workspaces y archivos sintéticos de aceptación identificados para ese recorrido.

| Área | Criterio comprobable | Entornos |
|---|---|---|
| Auth y workspace | Registro, bootstrap atómico Admin, rechazo de segundo workspace, sesión, logout/login y rutas privadas | Local, Preview, Production |
| Recuperación de cuenta | Solicitud, enlace recibido, callback del entorno correcto y cambio de contraseña | Local, Preview, Production |
| Upload | PDF textual, DOCX, Markdown, metadata y owner válidos; 1–10 archivos; límites de 10 MiB y validación de contenido | Local/CI completos; recorrido y batch real en Preview y Production |
| Pipeline exitoso | Tres formatos, Markdown de nueve y 32 chunks; `ready`, v1 activa, puntero correcto y todos los vectores de 384 dimensiones | Local, Preview, Production |
| Identidad y original | Bytes/hash iguales al archivo cargado, original abierto; nueva URL autorizada y expiración real de la URL anterior tras 300 s | Local, Preview, Production |
| Repository | Última versión visible sin puntero activo; metadata, estados, búsqueda por nombre, filtros combinados, paginación y sin resultados | Local, Preview, Production |
| Aislamiento y roles | Admin/QA dentro del tenant; Member y otro tenant denegados; lectura y mutación en ambas direcciones; owner ajeno rechazado | Local/CI exhaustivos y pruebas remotas contra tenants sintéticos |
| Fallos controlados | Documento sin texto, más de 500 chunks, proveedor fallido y deadlines durante embeddings/finalización; sin chunks parciales ni activación | Local/CI; sin texto y exceso de chunks también en Preview y Production |
| Recuperación | `uploaded`, fallo y lease vencida; mismo documento/versión/original; ninguna duplicación; conflicto concurrente | Local/CI; tres estados también en Preview y Production |
| Carrera SQL | B reclama mientras A intenta finalizar; A se rechaza después de esperar el bloqueo y no altera B | Local y CI con dos conexiones reales |
| Dispatch | Promise esperada; configuración, HTTP y red fallidos controlados; upload confirmado recuperable | Local/CI por inyección; ciclo de vida real en Preview y Production |
| Observabilidad | Error del pipeline recibido y saneado en Sentry con environment, release y correlación | Local, Preview, Production |
| Integración y despliegue | Gates obligatorios; deployment del SHA probado; Preview y Production ejecutados, no omitidos | GitHub/Vercel |

Los fixtures para nueve y 32 chunks deben producir esos conteos con el chunker real. El caso de 500 chunks comprueba el límite de cantidad, pero no presupone éxito si el presupuesto temporal se agota: ambos límites son independientes. Se registran tiempos, número de llamadas y estados finales sin contenidos privados.

Las pruebas de timeout cubren dos resultados legítimos de una carrera de finalización: una transacción confirmada dentro del presupuesto permanece `ready`; una finalización rechazada o cancelada revierte sus escrituras. También prueban la protección SQL cuando un resultado llega después del presupuesto y la recuperación tras una caída abrupta.

Los casos remotos de lease vencida se preparan exclusivamente sobre una versión sintética, con una operación controlada e identificada; nunca modifican documentos existentes para simular una caída. Para el flujo remoto de recuperación de contraseña se requiere un buzón de aceptación controlado y acceso al enlace recibido. Si no está disponible, ese criterio permanece pendiente.

## 7. Validación local y CI

Se preservan datos y configuración local existentes. Las aserciones SQL que dependen de conteos globales se restringen a fixtures identificados; las pruebas de uploads pausados fijan y restauran su precondición dentro de una transacción. El resultado no puede depender de que el usuario haya agregado documentos legítimos o dejado uploads activos.

Se ejecutan lint, typecheck, unitarias, integración, SQL, consistencia de tipos generados, build y E2E adecuados al cambio. `database.ts` se regenera desde el esquema migrado, sin edición manual. Fixtures y restart completos se certifican en el stack descartable de CI; no se resetea ni reinicia por sorpresa el stack del usuario.

El recorrido real local se incorpora a pruebas mantenidas en el repositorio. Las pruebas de upload afirman transferencia y metadata; las pruebas de procesamiento afirman `ready/active`, chunks completos y original autorizado. Los scripts temporales de auditoría no son la única prueba de regresión.

Se requiere una ejecución completa aprobada del SHA final. Un test fallido que pasa en aislamiento se documenta como tal y se resuelve antes del cierre; no se suma a los resultados parciales para presentar una suite completa aprobada.

## 8. Corte de Preview y Production

El inventario del 8 de octubre detectó que local ya tiene `20261006172303_finish_processing`, pero el remoto compartido solo tiene migraciones hasta `20261003214934`; faltan las columnas y RPC de procesamiento. No había funciones Edge desplegadas y faltaba `INGESTION_INTERNAL_TOKEN` en Vercel. Los uploads remotos estaban activos. Preview y Production compartían el proyecto Supabase `cdyjtoheovbvewewicaa`; no son bases aisladas.

Este inventario debe refrescarse antes del corte. El procedimiento escrito identificará proyecto, migraciones exactas, configuración, SHA, estado inicial de uploads y operaciones reversibles. Las credenciales se configuran por canales de secretos; nunca se guardan en el documento o los artefactos.

El orden de corte es:

1. Aprobar la implementación local y los quality gates del SHA candidato. Configurar `Quality gates` como check obligatorio para integrar en `develop` y `main`, preservando las protecciones existentes.
2. Revisar el dry-run de la migración pendiente y de la nueva corrección/proyección. Las migraciones deben ser compatibles con la aplicación todavía desplegada. Coordinar una pausa temporal de nuevos uploads durante la ventana compartida y registrar el estado previo.
3. Aplicar solo las migraciones revisadas, sin reset, seed, cambios de roles ni Vault. Desplegar únicamente `embed`, conservando su autenticación y sin eliminar otras funciones.
4. Configurar el token interno y credenciales de servidor para ambos entornos; confirmar origen efectivo, Auth Redirect URLs, recuperación por correo y configuración segura de Sentry. La duración efectiva del handler debe cubrir el presupuesto interno y su cierre; ampliar duración no sustituye los controles de deadline.
5. Desplegar Preview mediante el workflow condicionado al SHA probado. Verificar proyecto, revisión y ejecución real. Habilitar uploads para la aceptación controlada y ejecutar la matriz remota.
6. Después de aprobar Preview, desplegar Production mediante el mecanismo existente y ejecutar la misma aceptación. Verificar el comportamiento servido por el dominio de Production, no solo la URL o estado `READY` de un deployment.
7. Recuperar los cuatro uploads confirmados pendientes identificados en la auditoría, si siguen elegibles, mediante el comando autorizado sobre sus versiones existentes. El worker lee sus originales para procesarlos; la verificación utiliza estados y conteos, sin inspeccionar manualmente ni registrar su contenido. No volver a subirlos ni duplicarlos.
8. Restaurar el estado de uploads acordado, registrar evidencia de cierre y conservar el inventario de objetos huérfanos para su revisión separada.

Como Preview usa la misma base que Production, las migraciones y el despliegue de `embed` afectan a ambas aplicaciones antes del despliegue final. La compatibilidad se verifica antes de aplicar esos cambios. Un rollback de aplicación no revierte automáticamente SQL, objetos ni procesamiento completado.

Si falla la aceptación, se detiene la promoción, se mantiene o restablece la pausa de uploads y se usa el deployment compatible previamente identificado cuando corresponda. No se eliminan migraciones aplicadas ni datos para aparentar recuperación. Una corrección de esquema se entrega mediante otra migración revisada. El runbook del plan debe concretar los deployments y estados efectivos inmediatamente antes del corte.

La aprobación de este diseño habilita escribir el plan. Las escrituras remotas, cambios de protección, despliegues, recuperación de documentos existentes, commits e integración se ejecutarán únicamente dentro del alcance del plan y del método de ejecución que apruebe el usuario.

## 9. Criterios de cierre y entregables

El vertical se declara finalizado cuando se cumplan todos estos puntos:

- Los cinco defectos tienen regresiones que fallen con el comportamiento auditado y pasen con la corrección.
- La suite completa del SHA final pasa en CI, incluida la carrera SQL con dos conexiones; la ejecución local preserva los datos del usuario.
- Los tres entornos demuestran el recorrido desde cuenta/workspace hasta documentos procesados, Repository y original, junto con recuperación de cuenta, roles y aislamiento.
- Los errores previstos dejan resultados controlados y se comprueba recepción segura en Sentry en los tres entornos.
- Supabase remoto tiene las migraciones y `embed` correctos; Preview y Production sirven revisiones verificadas mediante gates obligatorios.
- Los uploads existentes pendientes se recuperan sin duplicación o se documenta su fallo controlado verificable. Los huérfanos quedan identificados sin limpieza automática.
- El reporte final distingue evidencia estática, tests, ejecución local y ejecución remota; cualquier aceptación pendiente impide declarar cierre completo.

Los entregables son la corrección acotada por módulos, migración nueva, contratos/tipos sincronizados, pruebas mantenidas, runbook de corte con recuperación y reporte de aceptación por entorno. La evidencia contiene SHA, entorno, fecha, tipo de prueba, conteos/estados, tiempos y referencias seguras a CI, deployment y eventos Sentry. No contiene documentos, chunks, URLs firmadas ni secretos.

Los advisors preexistentes detectados en la auditoría —permisos de `rls_auto_enable` y protección de contraseñas filtradas— se documentan como revisión separada. Si durante la ejecución se demuestra que alguno permite vulnerar el aislamiento exigido por S1, ese fallo sí bloquea la aceptación de seguridad y debe resolverse explícitamente.
