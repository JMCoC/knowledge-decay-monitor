# S3-01 — Contratos, modelo e aislamiento de Human Review & Correction

Fecha: 2026-11-08. Ticket: S3-01 / <issue id="e39f7442-4c52-4fbb-b085-dc6435aa9e50" label="SAA-25" href="https://linear.app/saasprojectkdm/issue/SAA-25/contratos-modelo-de-correccion-y-aislamiento-del-workflow-humano" />. Responsable: Juan Manuel, Dev 1.

Estado: **diseño técnico aprobado por el usuario el 2026-11-08; base técnica S3-01 implementada localmente el 2026-11-13; revisión de los tres consumidores pendiente**. Los acuerdos de producto de §2 se han reflejado en Markdown y Linear. La aprobación habilitó preparar el [plan de implementación S3-01](<https://linear.app/saasprojectkdm/document/s3-01-plan-de-implementacion-de-la-base-de-revision-humana-46eeacce89d4>); el alcance y la evidencia de la implementación constan en §13. No se aplicaron migraciones remotas ni se desplegó. Las estimaciones de horas se retiraron por petición del usuario.

## 1. Intención, fuentes y base actual

S3-01 entrega contratos, esquema aditivo, aislamiento, auditoría/outbox y fixtures suficientes para construir el workflow humano en los siguientes tickets. Se acepta por evidencia de esa base; su cierre no espera a implementar todo S3. Las funciones declaradas no se presentan como operaciones disponibles.

Fuentes: [PRD](<https://linear.app/saasprojectkdm/document/product-requirements-document-prd-74f94601d8cb>), §§8, 12, 20–22, 38–41, 46–50 y 67; [slice S3](<https://linear.app/saasprojectkdm/document/sprint-3-human-review-and-correction-v03-slice-y-coordinacion-45606628ecac>); [tickets S3 e índice](<https://linear.app/saasprojectkdm/document/sprint-3-human-review-and-correction-v03-slice-y-coordinacion-45606628ecac>); arquitectura (fuente local: `docs/architecture/arquitectura-base.md`); ADR-001 (fuente local: `docs/architecture/adr/ADR-001-monolito-modular.md`); Día Cero (fuente local: `docs/architecture/day-zero-protocol.md`). La validación del Día Cero y la auditoría hosted de 2026-11-07 son históricas.

El checkout ya tiene identity, ingestion, repository, analysis/credits/results y notifications, pruebas SQL, Vitest y Playwright. Los findings tienen severidades, assignee y snapshots, pero su enum de estado solo contiene pending_review. La ingesta y sus jobs permiten v1 y la activan automáticamente. notification_events exige analysis_id y su dispatcher solo admite terminales S2. No existe review ni audit_events. No se usan las notas del scaffold para inferir capacidades actuales.

## 2. Acuerdos de producto confirmados

 1. Admin/QA puede asignar todos los findings de un documento a un Member o repartirlos entre varios.
 2. Admin/QA prepara y abre explícitamente una ronda por documento. Al abrirse fija los findings esperados; incorporar otros después los deja para una siguiente ronda.
 3. Cada Member entrega archivos completos. Un archivo cubre uno, varios o todos sus findings del mismo documento/ronda; puede enviar varios archivos de manera independiente.
 4. Se espera cobertura de todos los findings de la ronda. Una transferencia incompleta no es una entrega; entregar tampoco cambia un finding a resolved.
 5. Se verifican bytes y permisos al recibir cada carga. Las entregas intermedias esperan; el preprocessing de la versión final no comienza hasta completar el conjunto requerido.
 6. Admin/QA consolida manualmente fuera de la aplicación y sube un único archivo final. Si una entrega cubre por sí sola toda la ronda, puede seleccionarla sin volver a transferirla.
 7. La candidata final se procesa y luego se aprueba o rechaza. No hay aprobación implícita por completar entregas, seleccionar archivo o terminar procesamiento.
 8. Admin/QA puede devolver findings seleccionados con motivo, conservando las demás entregas. Solo los afectados requieren reenvío.
 9. Se conserva retain/delete, switch atómico, pending_reanalysis y reanálisis manual con coste explícito. Ninguna operación de revisión/carga/aprobación cobra créditos o resuelve findings automáticamente.
10. La edición del documento desde la interfaz y la fusión automática de archivos quedan fuera.

## 3. Enfoques considerados y elección

| Enfoque | Ventaja | Coste o límite | Decisión |
| -- | -- | -- | -- |
| Archivos completos independientes y consolidación humana | Mantiene PDF/DOCX/Markdown y deja a una persona resolver incompatibilidades | Añade ronda, cobertura y consolidación explícita | Elegido por el usuario; incluye selección directa de archivo completo |
| Propuestas por fragmentos y composición conjunta | Menos transferencia y cambios más localizados | Requiere anclajes editables, composición y manejo de conflictos; no existe en el checkout | No elegido |
| Edición en interfaz con archivo descargable regenerado | Evita descargar/subir para corregir | Reconstruir PDF/DOCX con formato excede la extracción de texto actual | Exploración descartada por el usuario |

Esta ampliación requiere un diseño completo de la base compartida. Las decisiones técnicas de §§5–9 fueron propuestas por el autor y aprobadas por el usuario junto con este documento; no se atribuye al usuario su formulación técnica ni la revisión de consumidores.

## 4. Alcance de S3-01 y límites

S3-01 incluye:

* Contratos públicos/internos y ejemplos tipados de revisión, ronda, entregas, candidata, devolución, decisión, historial, audit y eventos.
* Migraciones nuevas para relaciones, concurrencia, permisos de base, helpers de autorización e integridad.
* Soporte interno append-only de auditoría e identificación de eventos de negocio/outbox, con regresión S2.
* Fixtures locales sintéticos y pruebas de esquema, RLS/GRANT/FK, estados persistibles y formas de contrato.
* Tipos SQL regenerados desde la base migrada; comprobación de instalación limpia y upgrade desde S2.

Quedan para sus tickets las implementaciones productivas de comandos de ronda/revisión (S3-02), UI (S3-03/08/09), transferencias (S3-04), worker (S3-05), consolidación/decisiones (S3-06), consultas funcionales y URLs (S3-07), cleanup (S3-10), digest/entrega (S3-11) y recorrido integral (S3-12). No se crean stubs de éxito, carpetas vacías, bypass de permisos ni proveedores adicionales.

S3-01 no certifica los efectos de un comando futuro mediante fixtures. Cada productor debe probar su transacción real y sus consumidores antes de aceptar su ticket.

## 5. Modelo propuesto

Los nombres de tablas/campos son propuesta técnica. Todas las relaciones de negocio incluyen workspace_id y, donde corresponda, documento/ronda para impedir referencias cruzadas incluso usando service_role.

| Entidad | Información e invariantes principales |
| -- | -- |
| findings existente | Ampliar enum a pending_review, confirmed, false_positive, update_planned y resolved; revision monotónica para CAS. Conservar severidad original y evidencia inmutables, estado inicial S2 sin asignación. owner_id nunca autoriza. |
| correction_rounds | Documento, creador, baseActiveVersionId, estado, revisión, fechas y referencia a candidata vigente. A lo sumo una ronda no terminal por documento. Base fijada al abrir contra la activa persistida. |
| correction_round_items | Un finding/documento por ronda, assignee inicial y vigente, revisión y referencia a cobertura vigente. El conjunto queda fijo al abrir. El documento debe estar en la evidencia autorizada del finding. |
| correction_submissions | Entrega inmutable: ronda/documento/base, submitter persistido, archivo/versionId, idempotencia y fechas de reserva/confirmación. No confundir remitente con consolidador. |
| correction_submission_items | Relación de una entrega con N items de la misma ronda/documento, assignee al enviar y revisión usada. Cada finding tiene a lo sumo una cobertura vigente, conservando los envíos anteriores. |
| correction_candidates | Cada intento final, versión exacta, selección directa o upload consolidado, consolidador, base, revisión de cobertura y estado/decisión. Una candidata vigente por ronda; una versión rechazada no se reutiliza como candidata nueva. |
| correction_candidate_items | Snapshot relacional de la entrega vigente seleccionada por cada item al construir la candidata. Prueba qué contribuciones cubre; no contiene texto documental. |
| correction_returns e items | Decisión inmutable y findings afectados; motivos privados por alcance de autorización. Mantiene el historial sin sobrescribir entregas ni cambiar severidad/estado humano. |
| review_commands | Recibos internos de idempotencia por workspace/actor/operación/key, payload normalizado y resultado mínimo recuperable; mismo key y distinto payload devuelve CONFLICT. No almacenar archivos/motivos en recibos públicos o logs. |
| correction_approval_contributions | Proyección mínima por decisión/contribuidor: documento actual, referencia de aprobación, fecha y cantidad propia de items. Sobrevive a retirar finding/base sin conservar evidencia ni enlaces al original eliminado. |
| audit_events | Actor, workspace, acción, entidad, fecha y metadata de lista permitida; escritura interna append-only en la transacción propietaria. |

### Bytes y versiones

Propuesta técnica: reutilizar document_versions y document_upload_attempts para los archivos inmutables y su verificación S1, con procedencia explícita que distingue v1, entrega intermedia y candidata. Una entrega intermedia confirmada permanece uploaded/version_status NULL y no genera job. La relación de candidata habilita el procesamiento del archivo seleccionado. Elegir una entrega completa reutiliza su versionId y sus bytes; subir un consolidado crea otro versionId.

La numeración por documento sigue siendo atómica y monotónica, incluyendo archivos reservados/intermedios; por ello la siguiente activa puede saltar números. No se reutilizan números de fallos, devoluciones o reservas vencidas. Las proyecciones deben identificar claramente entregas y candidatas: una fila intermedia no puede aparentar ser la candidata de aprobación ni habilitar retry por ser la última vN.

Los originales permanecen privados en documents con ruta `<workspace_id>/<document_id>/<version_id>/original.<ext>`, máximo 10 MiB y PDF textual/DOCX/Markdown. No se reconstruye el documento concatenando chunks ni se modifica un original confirmado.

Una ronda sin findings solo se admite para la propuesta directa Admin/QA ya permitida por el PRD: mode = administrative, con autorización independiente y sin fabricar asignaciones. Las rondas Member usan mode = assigned_findings y exigen items. El modo es inmutable; una administrativa no puede abrirse mientras exista otra ronda no terminal del documento ni usarse para omitir cobertura. Al abrir pasa de draft a consolidating, permite subir candidata final y, tras rechazo motivado, vuelve a consolidating para otra candidata; no espera reenvíos Member inexistentes.

## 6. Estados, cobertura y concurrencia

### Dimensiones separadas

* Ronda Member: draft → collecting → consolidating → candidate_processing → pending_approval → approved. Un fallo terminal de procesamiento cambia candidate_processing → candidate_failed en la misma transacción que processing_failed. Retry lleva candidate_failed → candidate_processing. Devolución desde consolidating, candidate_failed o pending_approval vuelve a collecting, con historial de intento. Cancelled es terminal; candidate_failed no es rechazo humano.
* Entrega: reserva/verificación de upload S1, confirmación e historial de cobertura por item. Confirmar no implica corrección aceptada.
* Versión: uploaded → processing → ready | processing_failed; version_status NULL hasta ready. Solo candidata lista pasa a pending_approval; v1 conserva ready/active.
* Finding: únicamente las transiciones del PRD §21, implementadas por S3-02, con severidad original inmutable y ninguna transición implícita desde ingesta.

Abrir exige conjunto no vacío para ronda Member, findings confirmed/update_planned, asignados a Members del mismo tenant, relacionados con el documento y base actual. Se bloquea documento/ronda y se fija el conjunto; la asignación sola nunca abre. Nuevos findings quedan disponibles para otra ronda, sin crear una segunda ronda activa ni fijar una base futura obsoleta.

La cobertura es completa si cada item esperado tiene entrega confirmada vigente, no devuelta, de la misma base y con procedencia autorizada. Reservas, archivos parciales y simples contadores no cuentan. El servidor deriva cobertura desde relaciones persistidas.

La selección final toma un snapshot de cobertura bajo lock/CAS. Selección directa exige que todos los items vigentes apunten a la misma entrega; varios archivos requieren que Admin/QA suba el consolidado. Completar cobertura habilita consolidación, pero solo seleccionar/finalizar la candidata crea el trabajo durable. Retorno/select/approve comprueban revisión y base.

Mientras existe candidata vigente no se aceptan reemplazos espontáneos de cobertura: Admin/QA debe devolver los items primero. La devolución anterior a candidata puede registrarse en consolidating; después de ready rechaza la candidata, vuelve a collecting y conserva cobertura no afectada. Durante processing se espera a terminar o fallar antes de devolver; no se introduce cancelación de jobs.

Desde candidate_failed, devolver items invalida la candidata en la misma transacción que retira su vigencia y la cobertura seleccionada, conserva version_status NULL y processing_failed, registra motivo y vuelve a collecting. Incrementa revisión/fence para rechazar todo retry/worker tardío; el archivo fallido permanece inmutable y una candidata posterior usa otro versionId. No se asigna rejected a una versión no ready. Alternativamente, sin devolución, Admin/QA puede reintentar la misma candidata/original. La propuesta administrativa fallida puede invalidarse con motivo y volver a consolidating por el mismo contrato de reemplazo; tampoco genera items ficticios.

### Decisiones técnicas propuestas para excepciones

* Reasignar/desasignar/resolver revoca acceso operativo y reservas no confirmadas del antiguo Member. Los archivos ya enviados conservan procedencia y quedan a disposición Admin/QA; no se destruyen ni se conceden por ello permisos al remitente anterior.
* Una entrega confirmada válida no se descarta por una reasignación posterior. Si QA devuelve ese item, el reenvío corresponde al assignee vigente; un Member nuevo no accede a archivos del anterior.
* Si queda un item sin entrega y sin responsable operativo, la ronda se bloquea. QA debe reasignarlo o cancelar la ronda con motivo; resolved no satisface cobertura. Cancelar no activa nada ni borra las otras entregas. No se retira un item silenciosamente de un conjunto abierto.
* Cambiar la activa vuelve obsoleta la base y produce CONFLICT; nunca aplicar un rebase silencioso. Nueva ronda se prepara explícitamente sobre la nueva activa.
* Reservas no confirmadas expiran a las 24 h de creación; invalidación, recuperación y limpieza de temporales son por entrega/items afectados. Una reserva abandonada no monopoliza el documento.
* Reintentos recuperan la misma operación con igual key/payload. Distinta decisión, cobertura/revisión obsoleta o payload diferente devuelve CONFLICT; no duplica auditoría/outbox.
* El orden de locks compartido será documento → ronda → items ordenados por ID → versión/candidata. Run/delete deben usar la guardia compartida de documento/versión y no introducir un orden inverso.

S3-01 define restricciones/fixtures y el contrato de estas excepciones; S3-02/04/05/06 implementan las transacciones y sus carreras. El plan concretará el guard SQL necesario sin reescribir migraciones integradas.

## 7. Contratos públicos e internos

Contratos públicos de DTO/tipos en src/types/contracts.ts o un archivo review-contracts.ts reexportado solo como tipos. Contratos internos de worker/audit/outbox en archivo independiente; sin importaciones de implementación ni barrels cliente/servidor mixtos.

Todas las firmas devuelven `Promise<ActionResult<T>>`. Entradas estrictas validadas con Zod al implementar la frontera; no aceptan Actor, workspaceId, rol, destinatarios de email, paths arbitrarios ni leases del navegador. ID opaco no sustituye autorización.

| API propuesta | Entrada esencial | Salida / propietario de implementación |
| -- | -- | -- |
| ReviewApi.changeFinding | findingId, revisión, cambio de estado o severidad, key | FindingReviewSnapshot / S3-02 |
| ReviewApi.assignFinding | findingId, revisión, assigneeId o null, key | FindingReviewSnapshot / S3-02 |
| ReviewApi.listAssignees | Paginación | Candidatos mínimos Member / S3-02 |
| ReviewApi.prepareRound | documentId, mode assigned_findings con findingIds no vacíos o mode administrative sin items, key | Ronda draft con revisión / S3-02 |
| ReviewApi.openRound | roundId, revisión, key | Ronda con base y conjunto fijados / S3-02 |
| ReviewApi.cancelRound | roundId, revisión, motivo privado, key | Ronda cancelada / S3-02 |
| IngestionApi.reserveCorrection | roundId, findingIds, baseActiveVersionId, metadata del archivo S1, key y revisiones de items | Referencia de entrega y UploadTarget / S3-04 |
| IngestionApi.finalizeCorrection | submissionId, versionId, attemptId | Entrega confirmada y cobertura propia / S3-04 |
| IngestionApi.resumeCorrection | submissionId y referencia de archivo cuando proceda | UploadTarget o snapshot / S3-04 |
| IngestionApi.selectFinalCandidate | roundId, revisión, submissionId, key | Candidata seleccionada / S3-06 |
| IngestionApi.reserveConsolidatedFile | roundId, revisión, metadata de archivo, key | Referencia de candidata/upload / S3-04 con selección S3-06 |
| IngestionApi.finalizeConsolidatedFile | candidateId, versionId, attemptId, revisión de cobertura | Candidata confirmada y encolada / S3-04/06 |
| IngestionApi.retryCorrectionCandidate | candidateId, revisión, key | Estado aceptado queued / S3-05; solo Admin/QA |
| IngestionApi.returnRoundItems | roundId, revisión, items y motivos privados, key | Ronda esperando items devueltos; candidata rechazada si procede / S3-06 |
| IngestionApi.rejectAdministrativeCandidate | candidateId, revisión, motivo privado, key | Ready → rejected o failed → invalidated; ronda administrativa vuelve a consolidating / S3-06 |
| IngestionApi.approveCorrection | candidateId, revisión, retain o delete, key | Decisión y nueva activa/pending_reanalysis / S3-06/S3-10 |
| RepositoryApi.listAssignments/getAssignment | Filtros/página o findingId | Trabajo y evidencia propios, ronda/entregas propias / S3-07 |
| RepositoryApi.listCorrectionRounds/getCorrectionRound | Filtros/página o roundId | Ronda/cobertura/contribuidores/candidata para Admin/QA / S3-07 |
| RepositoryApi.listOwnApprovals | Página | Proyección mínima propia / S3-07 |
| RepositoryApi.getWorkflowOriginalUrl | versionId | URL autorizada por 300 s y expiresAt / S3-07 |

FindingReviewSnapshot contiene id, revisión, estado, severidad original/actual, assignee mínimo y capacidades calculadas. MemberAssignment contiene únicamente su finding/evidencia, documento activo, estado de sus entregas y sus devoluciones; el avance global se limita a waiting/consolidating/processing/review/approved, sin totales/identidades de trabajo ajeno. ReviewRound para Admin/QA incluye conjunto fijo, base, revisión, cobertura y referencias exactas de candidata/contribuciones.

Las páginas conservan items/total/page/pageSize con defaults 1/25, máximo 100 y solo conteos autorizados. Errores: UNAUTHENTICATED, FORBIDDEN, INVALID_INPUT, NOT_FOUND, CONFLICT, PROCESSING_FAILED e INTERNAL_ERROR; mensajes controlados en inglés. ID ajeno/inexistente produce el mismo NOT_FOUND. No incluir motivos privados en mensajes genéricos ni SQL crudo.

Internamente, los comandos usan identidad obtenida en servidor y SQL vuelve a validar Profile/tenant. Auditoría y outbox se escriben dentro de la transacción del propietario. Helpers internos no crean HTTP entre módulos ni exponen la clave privilegiada.

## 8. Matriz de permisos

| Recurso/operación | Admin/QA del workspace | Member |
| -- | -- | -- |
| Revisión, asignación, abrir/cancelar ronda, consolidación y decisión | Permitido con precondiciones | Denegado |
| Repository y análisis/ledger completos | Según permisos existentes | Denegado |
| Finding/evidencia | Workspace autorizado | Solo asignación vigente; snapshot exacto incluso si refiere histórica |
| Documento descargable | Versiones autorizadas del workspace | Activa relacionada y entregas propias con permiso operativo vigente |
| Entrega de compañero, archivo consolidado e históricos globales | Permitido dentro del workspace | Denegado por pertenecer a la ronda; la nueva activa sí se abre si conserva asignación |
| Reserva/finalización de entrega | Capacidad administrativa según flujo | Solo items propios vigentes del mismo documento/ronda |
| Historial aprobado | Workspace | Solo contribución mínima propia, incluso si consolidó Admin/QA |
| Audit global, recibos, outbox, leases, hashes, paths internos, motivos ajenos | Solo capacidades previstas; técnicos internos no expuestos | Denegado |

RLS en las tablas públicas; GRANT de columnas mínimos y RPC con EXECUTE restringido. No conceder SELECT global para facilitar joins ni permitir escrituras directas authenticated a findings, rondas, decisiones, audit u outbox. No ampliar requireDocumentActor: nuevas capacidades Member reautorizan asignación por separado.

Propuesta de lectura: conservar proyecciones Admin/QA con security_invoker. Para proyecciones Member que requieren relaciones privadas, usar RPC acotada autenticada que obtiene auth.uid(), comprueba Profile/asignación y devuelve columnas autorizadas; revocar EXECUTE por defecto a PUBLIC/anon. Helpers privilegiados en private y search_path explícito, sin confiar en el rol de una llamada previa. No usar una vista con privilegios del propietario como atajo.

Una URL emitida puede permanecer válida hasta 300 s tras revocación; consultas y nuevas firmas se deniegan de inmediato. Motivos como texto privado, límite inicial 2.000 caracteres tras trim, sin HTML ejecutable ni copias en email/logs/Sentry. Un motivo por item evita divulgar a un Member el trabajo de otro.

## 9. Auditoría, notificaciones y eliminación

audit_events se añade con privilegios de lectura Admin/QA y append interno restringido. Actor/entidad/acción/fecha y metadata allowlist (IDs de operación/estados, severidades y asignación), sin contenido, motivos, nombres de archivo, hashes o URLs. No exponer inserción arbitraria a clientes ni UPDATE/DELETE incluso a código normal service_role; fixtures se crean con contexto de migración/local. Cada productor aporta audit en su transacción.

Evolucionar notification_events con referencias tipadas a evento de negocio y tenant, preservando la FK e idempotencia analysis_id/type/recipient para S2. Para workflow usar identidad de asignación, devolución o aprobación y unicidad por evento/tipo/recipient. No fabricar analysisId ni reutilizar un ID de finding como identidad de todas sus reasignaciones. Eventos S3 no son elegibles para el dispatcher terminal S2; un cambio de enum/columna aislado no basta.

Asignación avisa al nuevo Member; devolución solo a los responsables vigentes afectados; aprobación a contribuidores persistidos autorizados, una vez por persona aunque cubra varios findings. Esta última regla es propuesta técnica para mantener el sentido de “historial propio” cuando el uploader final es Admin/QA. Autorización se comprueba de nuevo al preparar y enviar; proyección mínima de aprobación sobrevive a delete. El digest 23:00 UTC, leases/recovery y envío real pertenecen a S3-11.

S3-01 define un contrato de retirada de referencias para S3-10: la transacción del switch debe ocultar versión/findings/snapshots dependientes antes de cleanup físico. Relaciones de ronda, entregas, candidatas, motivos y outbox no deben bloquear ni conservar contenido reconstruible de la versión retirada. Conservar la nueva activa y su metadata mínima de contribuciones; retirar artefactos intermedios que reconstruyan la anterior. No eliminar ledger ni prometer purga antes de verificar ausencia en DB/Storage.

Delete rechaza si un análisis queued/processing usa la anterior, mediante guardia compartida con Run; retain sigue permitido. Implementación de cleanup durable e integridad con analysis_documents/finding_evidence/document_chunks es S3-10. No se deshabilitan FK ni RLS para facilitarla.

## 10. Ownership e integración

* Dev 1 coordina tipos compartidos, revisión de migraciones, helpers/policies, identity/workspace y CI. review posee finding/asignación y composición del conjunto de ronda.
* Dev 2 posee ingestion: bytes, cobertura/candidata y sus transacciones, worker, decisión/switch y cleanup. La relación de ronda compartida no justifica imports circulares; review e ingestion usan contratos y SQL, sin importarse implementaciones internas.
* Dev 3 posee repository, lecturas funcionales y presentación; escribe mediante el productor propietario.
* notifications consume outbox; audit es escritura interna de la transacción propietaria.

La revisión de consumidores exige evidencia de Diego y Juan Pablo además de Dev 1 sobre firmas, fixtures y límites; este documento o un agente revisor no sustituye esa revisión humana. Los contratos pueden desbloquear trabajo con fixtures sin declarar integración completa.

Cambios documentales sincronizados: PRD §§12.5/39/67 y FR-17; slice objetivo/ownership/acuerdos/cierre; S3-01–S3-12. Retiradas las horas de tickets y tablas/totales del slice. No se cambian responsables, estados, ciclos, estimaciones de puntos, dependencias ni fechas en Linear.

## 11. Fixtures y aceptación de S3-01

Fixtures sintéticos locales, nunca seed remoto: dos tenants con Admin/QA y dos Members; findings multidocumento; ronda draft/abierta/completa; todos los findings de un solo Member; archivos que cubren uno/dos/tres/todos; entregas de varios Members; devolución de un item de un archivo agrupado; selección directa; consolidado de Admin/QA; reasignación antes/después de confirmar; base obsoleta; versión fallida/rechazada/aprobada; referencias retenidas/retiradas.

Pruebas de aceptación de la base técnica S3-01 (resultados consolidados en §13):

1. Instalación limpia y upgrade S2 con migraciones nuevas, datos preservados y database.ts regenerado; no resolver tipos generados a mano.
2. Contratos/fixtures TypeScript coherentes y ejemplos de selección/entregas agrupadas/devolución parcial, sin simular APIs disponibles.
3. FK compuestas y restricciones rechazan tenant/documento/ronda/finding/submitter/base incompatibles incluso en escrituras privilegiadas; referencias anulables por purga no permiten combinaciones parciales ambiguas. Solo modo administrativo acepta conjunto vacío; su rechazo/reemplazo nunca fabrica items ni permite saltarse otra ronda abierta.
4. Roles, columnas y RPC directas con sesión real: Member no accede a trabajo ajeno, audit, análisis o Repository; own history no concede originales históricos. Owner no da permiso.
5. Estados persistibles: una intermedia confirmada no genera job; sin ready no hay pending_approval/rejected; la selección directa no duplica bytes; fixtures de v1 conservan activación S1. Candidate_failed admite retry o invalidación/devolución, preserva cobertura no afectada e impide revivir un intento invalidado mediante retry tardío.
6. Soporte audit interno append-only y referencias de eventos S2/S3 válidas, con unicidad que distingue decisiones nuevas de reintentos. Dispatcher S2 no reclama eventos S3.
7. Ronda fija, cobertura por item y candidatos obsoletos comprobados como restricciones/helpers o fixtures donde el productor aún no exista; no afirmar que esto prueba las transacciones futuras.

Comandos al implementar, según alcance: pnpm typecheck, pnpm lint, pnpm test:unit, pnpm test:db, pnpm check:database-types y pruebas HTTP de fixtures pertinentes; build si hay cambios de compilación. Nunca reset/seed/migraciones remotas. S3-12 probará worker/Storage/correo/E2E reales sobre SHA candidato.

La base de contratos, persistencia, permisos, auditoría y upgrade está implementada y probada localmente. El workflow de los tickets S3-02 a S3-12, el worker, la UI y su aceptación integrada siguen fuera de esta entrega.

## 12. Documentación técnica contrastada y decisiones del builder

Consulta mediante find-docs/Context7 el 2026-11-08, biblioteca /supabase/supabase:

* [Funciones y privilegios](<https://github.com/supabase/supabase/blob/master/apps/docs/content/guides/database/functions.mdx>): SECURITY DEFINER requiere autorización en el cuerpo y EXECUTE mínimo; fijar search_path no limita llamadores.
* [Seguridad de vistas](<https://github.com/supabase/supabase/blob/master/apps/docs/content/guides/database/views.mdx>): security_invoker aplica permisos/RLS del llamador.
* [RLS](<https://github.com/supabase/supabase/blob/master/apps/docs/content/guides/database/postgres/row-level-security.mdx>): comprobar permisos de vistas/funciones además de políticas de tablas.

Se deja al builder el orden/número de migraciones coordinadas, índices concretos, nombres finales de constraints, archivos de tests y estructura exacta de Zod, manteniendo estos contratos. No se dejan a su criterio cambios en cobertura fija, agrupación, permisos, consolidación humana o barrera de procesamiento.

Decisiones técnicas incluidas en la aprobación de este diseño: reutilizar document_versions para archivos intermedios con numeración visible potencialmente discontinua; una ronda no terminal por documento; cancelación explícita sin activación para desbloquear trabajo no corregible; retry de candidata por Admin/QA; motivos por item y proyección de contribuciones mínimas para varios remitentes.

## 13. Implementación y evidencia local (2026-11-13)

La base de S3-01 se implementó en la rama `feat/s3-01-human-review`, hasta el commit de código `03b7ea0` (`ci(review): add isolated S3-01 upgrade checks`). La evidencia exacta de entorno, comandos, resultados y límites está en [verificación local S3-01](../../testing/2026-11-13-s3-01-foundation-verification.md).

El alcance entregado incluye contratos/fixtures tipados, seis migraciones aditivas, tipos de base regenerados, restricciones de integridad, autorización por rol/tenant, auditoría/outbox, aislamiento Auth/PostgREST/Storage y un runner de upgrade aislado. La migración `20261108150500_s3_01_approval_contribution_check.sql` es una corrección aditiva: una migración de aprobación ya aplicada contenía un trigger que refería `candidate_id` y `round_id` en `correction_approval_contributions`, donde esas columnas no existen. Se conservó la migración aplicada y se añadió una corrección, por lo que el allowlist y la comprobación de upgrade contienen seis nombres.

La verificación pasa en Supabase local desechable y en el stack local existente con la puerta de upload restaurada a su valor previo. No demuestra ejecución en GitHub Actions, base alojada, correo real ni recorrido de producto de los tickets siguientes. La revisión de firmas, fixtures y límites por Diego y Juan Pablo permanece pendiente; un agente no la sustituye. S3-01 sigue In Progress hasta completar esa revisión humana.
