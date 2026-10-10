# S2-01 — Contratos, esquema y aislamiento del vertical de análisis

Fecha: 2026-10-10. Ticket: S2-01 / SAA-13. Responsable: Juan Manuel, Dev 1.

Estado: especificación escrita aprobada por el usuario el 2026-10-10. Este documento define la entrega y su aceptación. La aprobación habilita redactar el plan; no autoriza implementación, commits ni cambios remotos.

## 1. Objetivo y acuerdos aprobados

S2-01 entrega una base verificable de contratos, persistencia y autorización para que los tres desarrolladores construyan AI Analysis v0.2 sin duplicar reglas ni exponer información interna. Admin y QA Lead deben poder integrar análisis y hallazgos de su workspace sobre versiones exactas, con una frontera de tenant protegida también cuando se evita la UI.

El usuario aprobó cuatro bloques: límites y responsabilidades, modelo de datos, permisos y contenido de contratos, y criterios de aceptación. Eligió el cierre independiente de S2-01: cada ticket posterior verifica sus operaciones/RPC y S2-12 acepta el recorrido integrado. S2-01 no permanece abierto hasta terminar todo el sprint.

Se separan los contratos públicos de los internos. La persistencia conserva las seis tablas previstas por el ticket. Se protegen las filas por tenant/rol y las columnas internas mediante permisos explícitos. Los fixtures son exclusivamente sintéticos y locales.

Las decisiones concretas de nombres, campos y organización de esta especificación desarrollan esos acuerdos y se revisan junto con el documento antes de planificar.

### Fuentes y precedencia

- [PRD](../../PRD/knowledge-decay-monitor-prd-final.md), §§20–22, 25–32, 47–50 y 66.
- [Ticket S2-01 y tickets relacionados](../../Tickets/sprint-2-ai-analysis.md).
- [Slice y coordinación de Sprint 2](../../PRD/sprint-2-ai-analysis-slice.md).
- [Arquitectura base](../../architecture/arquitectura-base.md), [ADR-001](../../architecture/adr/ADR-001-monolito-modular.md) y [Día Cero](../../architecture/day-zero-protocol.md).
- Checkout consultado: existen identity/workspace/ingestion/repository, contratos S1, migraciones, Vitest, Playwright y comprobación de tipos SQL. Aún no existen implementaciones de analysis/credits/notifications. Las descripciones del scaffold inicial son históricas.

Se mantiene el monolito modular. El runtime de análisis corresponde a S2-06; ADR-002 cambia la ingesta y no decide el runtime del nuevo vertical. S2-01 no reabre la aceptación del primer vertical.

## 2. Alcance y ownership

| Entrega de S2-01 | Implementación posterior |
|---|---|
| Contratos públicos e internos, errores y ejemplos tipados | Cada productor implementa la operación en su ticket |
| Tablas, claves, restricciones, índices base y permisos | RPC y transacciones por dominio |
| Frontera de tenant/rol y protección de columnas internas | Reautorización de cada comando/consulta |
| Fixtures sintéticos y pruebas de esquema/contratos | Corpus y pruebas de comportamiento real |
| Tipos SQL regenerados y coherentes con contratos | Regeneración coordinada al añadir nuevas migraciones |

Dev 1 coordina `src/types/**`, nuevas migraciones base, permisos, fixtures compartidos y tipos SQL. Diego revisa los contratos de retrieval, proveedor, claim y finalización. Juan Pablo revisa selección, estado y presentación de resultados. La revisión de consumidores es un criterio de aceptación; no se afirma que ya ocurrió por haber aprobado este diseño.

Los nuevos límites de negocio son `analysis`, `credits` y `notifications`. Los tipos no importan implementaciones. No se crean módulos vacíos, barrels mixtos, endpoints ficticios ni HTTP interno para comunicar dominios. Repository solicita comandos al módulo propietario y conserva su lectura autorizada de proyecciones.

### Fuera del ticket

La concesión de créditos y las consultas funcionales de saldo/ledger corresponden a S2-02; selección, a S2-03; retrieval y estimación, a S2-04; creación/reserva y retry manual, a S2-05; worker y recuperación, a S2-06; proveedor y validación de salida, a S2-07; publicación y liquidación, a S2-08; UI de ejecución, a S2-09; consultas funcionales de hallazgos, a S2-10; entrega de correo, a S2-11; E2E integrado, a S2-12.

También quedan fuera asignaciones, revisión humana, cambios de severidad, correcciones de versiones, pagos, History completo, digest y purga. El esquema mantiene las referencias necesarias sin implementar esos flujos.

## 3. Contratos públicos

Los contratos se añaden de forma compatible a `src/types/contracts.ts`. Se conserva `ActionResult<T>`, `Actor` y el enum existente `AnalysisStatus`, que describe la dimensión de una versión documental. El estado de ejecución usa el nombre distinto `AnalysisJobStatus`.

Las entradas públicas no aceptan `Actor`, tenant, rol, precio confiable, destinatario, lease ni configuración del proveedor. El servidor obtiene identidad/rol/workspace de la sesión verificada y del Profile persistido. Una referencia opaca tampoco sustituye la autorización.

| Contrato | Entrada | Salida pública | Productor |
|---|---|---|---|
| Selección elegible | Nombre, categoría, owner y paginación | Página de documento/versión elegible, metadata y total autorizado | S2-03 |
| Estimación | `sourceVersionIds`, `comparisonVersionIds` | `estimateRef`, `fixedCost`, listas exactas normalizadas y `expiresAt` | S2-04 |
| Run | `estimateRef`, `idempotencyKey` | `analysisId`, `status` | S2-05 |
| Retry manual | `failedAnalysisId`, `estimateRef`, nueva `idempotencyKey` | Nuevo `analysisId`, `status`, `retryOfAnalysisId` | S2-05 |
| Estado por ID | `analysisId` | Snapshot autorizado del análisis | S2-09 |
| Análisis activo | Sin tenant recibido del cliente | Snapshot del único queued/processing del workspace, o null | S2-09 |
| Saldo | Sin tenant recibido del cliente | `available`, `reserved` | S2-02 |
| Ledger | Página y tamaño permitidos | Página de movimientos autorizados con tipo, cantidad, análisis y fecha | S2-02 |
| Lista de hallazgos | `analysisId`, filtros de tipo/severidad y paginación | Página de hallazgos publicados | S2-10 |
| Detalle de hallazgo | `findingId` | Hallazgo y evidencia exacta autorizada | S2-10 |

La estimación recibe al menos una fuente y puede recibir comparación vacía. La misma versión puede pertenecer a ambas listas. Los duplicados dentro de una lista se normalizan; el alcance máximo cuenta la unión. `estimateRef` es una garantía opaca emitida y validada por S2-04, no un coste enviado por el navegador. El productor fija su vigencia y devuelve la fecha de vencimiento; este contrato no impone almacenamiento de pares ni un mecanismo de firma específico.

El snapshot público incluye ID, estado, iniciador identificable sin correo, fuentes/comparaciones exactas, coste confirmado, fechas, referencia al análisis anterior, error controlado y `canRetry`. Excluye idempotency key, tokens de operación, lease, conteo técnico de intentos, fingerprints y configuración de retrieval/prompt/schema/model. `canRetry` orienta la UI; el comando vuelve a autorizar y validar.

Un hallazgo público incluye tipo, explicación, severidad original/actual y estado. El detalle de evidencia incluye documento/versión/chunk, página o sección, heading cuando exista y snapshot. No incorpora texto completo de chunks, embeddings, ruta Storage ni URL firmada persistida. La apertura del original sigue usando el contrato autorizado de Repository S1 con caducidad de 300 segundos.

Las páginas mantienen el patrón S1: `items`, `total`, `page`, `pageSize`; valores por defecto 1/25 y máximo 100. Los filtros ausentes se omiten. Owner null significa Unassigned; no concede acceso.

### Errores

Se conservan los códigos actuales y se añaden `INSUFFICIENT_CREDITS`, `ESTIMATE_EXPIRED`, `ESTIMATE_STALE` y `ANALYSIS_FAILED`. Los mensajes de producto son controlados y en inglés. Una respuesta puede incluir `correlationId`, nunca una excepción SQL, prompt o respuesta de proveedor.

`FORBIDDEN` expresa falta de permiso para la operación. Un ID ajeno o inexistente devuelve el mismo `NOT_FOUND`, sin revelar la existencia de otro tenant. `CONFLICT` cubre un análisis activo, una key reutilizada con payload distinto o una precondición concurrente incompatible. S2-01 define y prueba las formas; los productores implementan el mapeo real de errores.

## 4. Contratos internos

Los contratos internos se ubican en un archivo de tipos independiente, `src/types/analysis-internal.ts`, y no se reexportan mediante una entrada cliente. Contienen responsabilidades y datos, sin una implementación simulada.

| Interfaz | Responsabilidad y datos mínimos | Propietario |
|---|---|---|
| Retrieval preparado | Alcance exacto, configuración versionada, cantidades/fingerprint y candidatos autorizados solo en memoria | S2-04 |
| Reserva/liquidación | Contexto autorizado, analysisId, coste fijo y efecto contable dentro de la transacción del llamador | S2-02 |
| Claim del análisis | analysisId, workspace, operationId, número de intento y vencimiento del lease | S2-06 |
| AIProvider | Par mínimo autorizado y configuración; resultado validado o error tipado | S2-07 |
| Finalización | Identidad de operación vigente y findings/evidence estructurados; resultado terminal idempotente | S2-08 |
| Evento terminal | analysisId, workspace, tipo y destinatario persistido; estado de entrega | S2-08 / S2-11 |

La reserva/liquidación expresa una capacidad transaccional de SQL. No se define como una cadena de requests HTTP que aparente atomicidad. El proveedor no decide tenant, asignación, coste ni estado funcional de una versión.

## 5. Persistencia base

Se añaden migraciones nuevas. Las seis tablas se mantienen en `public` con RLS habilitada, GRANT explícitos y acceso mínimo. Estar en ese esquema no concede lectura automáticamente. Los helpers internos permanecen en el esquema privado existente.

Todas las entidades usan UUID y timestamps con zona horaria; las cantidades de créditos son enteros. Campos de configuración usan objetos versionados y validados, sin secretos, prompts completos, documentos ni salida cruda. Las tablas incluyen `workspace_id` y claves compuestas para reforzar las relaciones. Las nuevas referencias utilizan ON DELETE RESTRICT: el ticket no introduce cascadas capaces de borrar historial o ledger. Una purga posterior requiere su propia decisión y migración coordinada.

### 5.1 analyses

Campos base: `id`, `workspace_id`, `initiator_id`, `status`, `fixed_cost`, `reserved_credits`, `idempotency_key`, `request_fingerprint`, `retry_of_analysis_id`, `retrieval_config`, `pricing_version`, `prompt_version`, `output_schema_version`, `provider_config`, `provider_used`, `model_used`, `attempt_count`, `operation_id`, `lease_expires_at`, `created_at`, `updated_at`, `started_at`, `finished_at` y `error_code`.

Estados permitidos: queued, processing, completed y failed. Coste fijo positivo. `reserved_credits` registra la cantidad originalmente reservada y coincide con `fixed_cost`; permanece como dato histórico tras consumir o liberar. No representa el saldo reservado actual, cuya fuente es el ledger. El número de intentos va de 0 a 3: intento inicial y hasta dos retries automáticos. Retry manual crea otra fila enlazada; no cambia el historial failed ni reutiliza su reserva.

`retrieval_config` conserva Top K, umbral, revisiones de chunks/embeddings y fingerprint del conjunto; `provider_config` identifica proveedores/modelos previstos y sus revisiones. Los campos used identifican lo ejecutado y pueden ser null antes de invocar un proveedor. Los errores técnicos usan una taxonomía cerrada: RETRIEVAL_FAILED, ESTIMATE_STALE, PROVIDER_UNAVAILABLE, INVALID_PROVIDER_OUTPUT, PERSISTENCE_FAILED, TIMEOUT, ATTEMPTS_EXHAUSTED e INTERNAL_ERROR. Su mapeo público usa mensajes controlados, sin payload del proveedor.

Iniciador y ejecución previa deben pertenecer al mismo workspace. Un índice único parcial impide dos queued/processing del mismo workspace. La key es única por workspace/iniciador; `request_fingerprint` permite al productor detectar reutilización con otro payload.

S2-05 fija scope/configuración/coste al crear el run. S2-06 controla claim, lease y fencing. S2-08 completa la ejecución. La base no implementa estas operaciones ni promete que los estados contables estén coordinados sin ellas.

### 5.2 analysis_documents

Campos: análisis, workspace, documento, versión exacta y `role` source/comparison. Una clave única incluye análisis, versión y rol. Las relaciones compuestas comprueban análisis/tenant y versión/documento/tenant.

El alcance contiene al menos una fuente y como máximo 20 versiones distintas en la unión. La comprobación debe ser transaccional y resistente a concurrencia: serializar cambios de alcance por fila de análisis y verificar su forma al finalizar la transacción. Esto permite insertar análisis y asociaciones juntos sin aceptar un análisis vacío al commit. La eliminación de una ejecución no deja un validador intentando comprobar un padre ya eliminado.

La versión puede aparecer con ambos roles. La elegibilidad ready/active se revalida al crear el run en S2-05; las relaciones históricas no exigen que una versión siga activa después. No se usa `documents.active_version_id` como referencia mutable de evidencia.

### 5.3 credit_ledger

Campos: ID, workspace, tipo de movimiento, cantidad positiva, analysisId cuando corresponda y fecha. Tipos de S2: Promotional, Reserved, Consumed y Released. Promotional no referencia un análisis; los otros movimientos sí, siempre del mismo tenant.

Unicidades base: una concesión Promotional por workspace, una Reserved por análisis y una única liquidación terminal por análisis, sea Consumed o Released. Los movimientos persistidos son append-only; UPDATE/DELETE de aplicación se rechazan también con el rol de servidor. El esquema no concede créditos a workspaces existentes ni cambia bootstrap en S2-01.

S2-02 implementa grant de 50, saldo, suficiencia y funciones contables. S2-05 y S2-08 coordinan sus efectos con la ejecución en transacciones atómicas. El saldo disponible no se almacena en analyses ni se mantiene desde el navegador.

### 5.4 findings

Campos: ID, workspace, análisis, tipo contradiction/obsolescence, `severity_original`, `severity_current`, `confidence`, `explanation`, `status`, `assignee_id`, `fingerprint` y timestamps.

Severidad admite High, Medium y Low. Confianza es un número finito entre 0 y 1, obligatorio e interno; una confianza baja es válida. Explicación no vacía. Los hallazgos S2 nacen pending_review, con assignee null y ambas severidades iguales. No existe operación S2 que revise, asigne o cambie severidad.

Fingerprint es único dentro del análisis. S2-08 implementa su canonización; otro análisis puede conservar el mismo hallazgo. La asignación futura queda referenciada al mismo tenant, sin dar permisos a Member en S2.

### 5.5 finding_evidence

Campos: ID, workspace, análisis, finding, documento, versión, chunk, página/sección, heading y `snapshot`. El snapshot es texto no vacío con máximo 2.000 caracteres, medidos por longitud de caracteres SQL; un caso con Unicode forma parte de las pruebas.

Las relaciones prueban conjuntamente que el finding pertenece al análisis, el documento corresponde a la versión, el chunk corresponde a esa versión y la versión pertenece al alcance del mismo análisis. No basta con que todas las filas pertenezcan al mismo workspace.

Para comprobar pertenencia al alcance sin exigir unicidad entre source/comparison, un constraint trigger valida la existencia de la asociación exacta. La validación también cubre cambios o eliminación de asociaciones: no puede quedar evidencia cuya versión ya no pertenezca al alcance. Ambas escrituras se serializan por la misma fila de análisis y comprueban el estado final de la transacción. Las claves compuestas garantizan las otras correspondencias. Cuando una clave candidata nueva sea necesaria en document_chunks, se añade mediante una nueva migración compatible con S1.

No se almacena el documento completo ni una URL del original. Las referencias históricas siguen válidas cuando cambia el puntero activo. S2-01 no introduce borrado permanente; la purga S5 deberá eliminar también estos snapshots según el PRD.

### 5.6 notification_events

Campos: ID, workspace, análisis, tipo analysis_completed/analysis_failed, recipientId, estado pending/sent/failed, intentos, fecha del próximo intento, fechas de creación/envío y error controlado. El destinatario referencia un Profile del mismo workspace. La key única es análisis/tipo/destinatario.

No se persiste cuerpo del correo, dirección enviada por el navegador, contenido documental ni respuesta cruda del proveedor. S2-08 crea el evento terminal; S2-11 comprueba la autorización del destinatario y entrega el correo. El fallo de entrega no modifica análisis ni ledger.

### Índices y ownership de estados

Los índices cubren claves foráneas compuestas y lecturas por workspace, análisis, fecha e ID estable, además de las unicidades descritas. No se crean índices vectoriales ni se cambia el algoritmo de retrieval en este ticket.

`analysis` escribe `document_versions.analysis_status` al finalizar únicamente las fuentes/versiones exactas procesadas. Esta ampliación de ownership se revisa con los consumidores. Ingestion conserva processing_status, version_status y activación. S2-01 documenta la frontera; la actualización real corresponde a S2-08.

## 6. Autorización y protección de columnas

| Recurso | Admin / QA Lead | Member | Anon |
|---|---|---|---|
| Análisis y alcance | Lectura de su workspace | Sin acceso | Sin acceso |
| Hallazgos y evidencia | Lectura de análisis completed del workspace | Sin acceso en S2 | Sin acceso |
| Ledger detallado | Lectura de su workspace | Sin acceso | Sin acceso |
| Saldo available/reserved | Consulta autorizada | Consulta autorizada de su workspace | Sin acceso |
| Confidence, leases y configuración técnica | Sin lectura cliente | Sin lectura | Sin lectura |
| Eventos de notificación | Internos del servidor | Sin lectura | Sin lectura |
| Escrituras directas de negocio | Denegadas | Denegadas | Denegadas |

Se reutilizan identidad verificada y Profile persistido. No se amplían los permisos de S1 sobre documentos, chunks u originales. Owner es metadata y no cambia la matriz. No se habilita anticipadamente el acceso por asignación de S3.

Los GRANT de SELECT especifican las columnas públicas de analyses/findings y demás recursos expuestos. No queda un SELECT general que permita leer las columnas internas. Las proyecciones usan listas explícitas y, cuando sean views, `security_invoker = true` para conservar la autorización del llamador. Sus columnas y filtros solo requieren permisos públicos concedidos.

S2-01 incorpora las proyecciones estructurales de análisis/alcance y findings/evidence necesarias para fijar la frontera de lectura, sin implementar navegación, filtros de producto ni Server Actions. S2-09/S2-10 implementan las consultas funcionales sobre esa base. Notification_events no concede lectura a authenticated.

La proyección funcional de saldo es de S2-02. S2-01 prueba que Member no puede consultar el ledger y fija el contrato de saldo sin publicar una RPC de prueba. S2-02 deberá verificar su consulta real de saldo como parte de su cierre; esa prueba no mantiene S2-01 abierto.

Las escrituras del servidor se conceden según necesidad: estado técnico de ejecución, inserción de asociaciones/resultados/eventos y actualización de entrega. El ledger permite inserción, no mutación. Los nuevos objetos revocan accesos por defecto no requeridos. Las RPC añadidas por cada dominio revocan EXECUTE público y verifican su contexto según su ticket.

La ausencia de UI no impide el acceso directo a tablas/proyecciones; las pruebas se ejecutan con roles de sesión reales. El cliente privilegiado permanece en servidor y las restricciones de relaciones siguen rechazando referencias inválidas aunque se use service_role.

## 7. Fixtures y pruebas de contrato

Los ejemplos TypeScript se ubican bajo `tests/fixtures/analysis/`; las pruebas de compilación de interfaces se integran con la comprobación de contratos existente. Se separan las formas públicas de los fixtures internos; un ejemplo público no contiene confidence ni lease.

Las pruebas SQL crean sus datos dentro de transacciones reversibles. Si se amplía el seed, utiliza IDs sintéticos estables y operaciones locales; nunca se aplica al proyecto compartido. Un fixture inválido es una entrada de prueba cuya persistencia debe fallar, no una fila inválida incorporada al seed.

Casos mínimos: dos tenants y roles Admin/QA/Member; versiones ready/active y no elegibles; scopes de 1/20/21 versiones; solapamiento source/comparison y selección paginada; análisis queued/processing/completed/failed y lease vencido; coste/saldo disponible y reservado en ejemplos; resultados válidos/vacíos/inválidos; confianza baja; snapshots de 2.000/2.001 caracteres; pares repetidos/invertidos; eventos pending/sent/failed.

Los ejemplos de pares y proveedor permiten construir pruebas posteriores; S2-01 no implementa retrieval ni deduplicación semántica. Los ejemplos de saldo muestran el contrato; no demuestran operaciones contables reales. Los fixtures no se importan en rutas de producción ni conceden bypass de Auth.

## 8. Criterios de aceptación y cierre independiente

| Área | Comprobación requerida en S2-01 |
|---|---|
| Contratos | Consumidores revisan entradas/salidas/errores; ejemplos tipados y checks positivos/negativos compilan |
| Tenant | Lectura y mutación directas cross-tenant denegadas, en ambas direcciones |
| Integridad privilegiada | Escrituras service_role con referencias cruzadas o evidencia ajena al alcance son rechazadas |
| Alcance | 1 y 20 versiones distintas aceptadas; 21 rechazadas; solapamiento cuenta una vez; no se admite un commit sin fuente |
| Unicidades | Asociaciones/key/fingerprint/evento duplicados rechazados; solo un queued/processing por tenant; otro tenant independiente |
| Roles y columnas | Admin/QA solo ven columnas permitidas; Member/anon no ven análisis, evidencia ni ledger; confidence/configuración/lease no accesibles por consulta explícita ni wildcard |
| Publicación | Findings/evidence de análisis no completed no son visibles para sesiones de usuario |
| Valores | Enums, costes y confianza válidos; texto/snapshot controlado; extremos 0/1 de confianza y Unicode comprobados |
| Ledger | Movimientos de aplicación no se actualizan/eliminan; no se duplican reserva o liquidación terminal |
| Compatibilidad | Instalación limpia descartable y upgrade desde S1; datos previos preservados; ningún grant o comportamiento S1 se debilita |
| Tipos | database.ts regenerado desde esquema migrado; comprobación de tipos y contratos aprobada |

La resistencia a concurrencia de las restricciones nuevas de alcance y de único análisis activo se comprueba con transacciones concurrentes reales. Estas pruebas demuestran las restricciones base; no reemplazan las pruebas de reserva, claim o finalización de los tickets propietarios.

Después de implementar se ejecutan, con pnpm 12.5.1 o su prefijo equivalente, `test:db`, `check:database-types`, `typecheck`, `lint`, las pruebas unitarias/de contratos pertinentes y las regresiones S1 afectadas. Las verificaciones HTTP de privilegios se integran con las pruebas mantenidas del repositorio. Build corresponde cuando cambie código que lo requiera. No se resetea el stack existente del usuario: la instalación limpia usa un entorno descartable y el upgrade preserva datos.

Se regenera database.ts usando el procedimiento vigente del repositorio después de aplicar las migraciones locales. No se edita ni se fusiona manualmente; una generación fallida no sobrescribe el archivo. Si se introduce una view, se comprueba también que sus tipos no expongan columnas internas.

S2-01 cierra cuando las entregas anteriores están implementadas, integradas y tienen evidencia local/CI del candidato. No exige inferencia, saldo funcional, reserva funcional, worker, correo ni E2E completo. Cada ticket aporta esas pruebas y S2-12 verifica el conjunto. No se aplican migraciones remotas, seed, despliegues ni cambios de datos compartidos para certificar la base local.

## 9. Escenarios BDD

1. Dado un análisis A y una versión B, cuando el servidor intenta asociarlos, la base rechaza la operación incluso con service_role y conserva el estado previo.
2. Dado un finding de un análisis A, cuando se intenta usar un chunk de otra versión o una versión del mismo tenant fuera del alcance, la base rechaza la evidencia.
3. Dado un scope de 20 versiones distintas con una en ambos roles, cuando se persiste, la transacción acepta el scope; añadir una versión distinta número 21 lo rechaza.
4. Dado un análisis sin fuentes, cuando se intenta confirmar su transacción, la base lo rechaza sin dejar un análisis vacío.
5. Dado un análisis activo del workspace A, cuando dos transacciones intentan crear otro activo A, ninguna crea un segundo activo; el workspace B puede tener su ejecución independiente.
6. Dado Admin/QA de A, cuando consulta resultados completed, obtiene solo campos públicos de A; pedir confidence, lease o configuración técnica es denegado.
7. Dado un Member que es Owner y conoce los IDs, cuando consulta análisis, findings, evidencia o ledger, no obtiene registros ni metadatos. El contrato de saldo no amplía esos permisos.
8. Dado un análisis processing con salida provisional de prueba, cuando una sesión consulta findings/evidence, no los ve. La publicación atómica real se demuestra en S2-08.
9. Dado un snapshot de 2.000 caracteres, cuando se inserta, se acepta; con 2.001 se rechaza, también usando contenido Unicode.
10. Dado el contrato revisado y fixtures de desarrollo, cuando consumidores implementan retrieval y UI en sus tickets, pueden compilar contra las mismas formas sin esperar al proveedor o ledger funcional.

## 10. Entregables y siguiente etapa

Entregables: contratos públicos/internos y errores, nuevas migraciones base, proyecciones de lectura seguras, tipos generados, fixtures sintéticos, pruebas de esquema/permisos/contratos y evidencia de aceptación de S2-01. El ticket SAA-13 se podrá actualizar con esta definición cuando se autorice su edición externa.

Esta especificación no altera silenciosamente el PRD ni los tickets. Resuelve el cierre de S2-01 mediante los acuerdos del usuario y aclara la propiedad de pruebas posteriores. Conserva comparación opcional, versiones compartidas entre roles, máximo por unión, retry manual nuevo y marcado analyzed solo en fuentes exactas.

El usuario aprobó este archivo y habilitó redactar el [plan de implementación](../plans/2026-10-10-s2-01-analysis-foundation.md) mediante writing-plans. La siguiente etapa es revisar ese plan y elegir su método de ejecución. La aprobación de la especificación no equivale a aprobar el plan ni su ejecución. No se realiza commit, push o implementación durante esta entrega documental.

### Documentación técnica contrastada

Se consultó Context7 resolviendo Supabase y leyendo `/supabase/supabase` para seguridad de datos multi-tenant, esquemas privados, proyecciones y privilegios. Se contrastó además:

- [RLS de Supabase](https://supabase.com/docs/guides/database/postgres/row-level-security).
- [Privilegios por columna](https://supabase.com/docs/guides/database/postgres/column-level-security): RLS no restringe columnas; un grant de tabla no queda revocado al retirar solo un permiso de columna. Las consultas de roles restringidos enumeran columnas explícitas.

Estas fuentes sustentan el diseño técnico. La documentación y los fixtures no son prueba de implementación ni de ejecución end-to-end.
