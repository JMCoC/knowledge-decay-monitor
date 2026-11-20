# S3-07 — Plan de desarrollo: lecturas de asignaciones y originales con acceso mínimo de Member

**Ticket:** SAA-31
**Responsable:** Juan Pablo Castaño Arango (Dev 3)
**Base:** `docs/Tickets/sprint-3-human-review-correction.md`, S3-01 contracts/design, S3-02 review commands, S3-03 human review design and implementation.
**Estado:** Plan de desarrollo; no implica que el ticket esté implementado ni aceptado.

## Objetivo

Entregar las lecturas paginadas y el acceso a evidencia/originales que permiten a un Member consultar exclusivamente asignaciones propias y su historial de aprobaciones. La autorización depende de la asignación persistida del finding y de las relaciones de evidencia; nunca de Owner, IDs enviados por el navegador o pertenencia incidental al mismo documento.

S3-07 prepara la superficie segura que consumen S3-08 (My Assignments) y S3-09 (cola Admin/QA). No implementa la experiencia de envío de correcciones de S3-08 ni la cola de decisiones de S3-09.

## Estado encontrado y decisiones de alcance

- `src/types/review-contracts.ts` ya declara `MemberAssignment`, `OwnApprovalItem`, paginación y `ReviewRepositoryApi` (`listAssignments`, `getAssignment`, `listOwnApprovals`, `getWorkflowOriginalUrl`). Estos tipos son contratos, no funciones disponibles.
- La capa de review ahora exporta `listAssignments`, `getAssignment`, `listOwnApprovals` y `getWorkflowOriginalUrl`; sus acciones usan RPCs server-only y validan el DTO de salida. Falta aceptación funcional/seguridad mediante pruebas.
- Existe el Repository S1 para documentos y originales de Admin/QA. No se debe ampliar su listado global para Member ni relajar `requireDocumentActor`.
- S3-03 ya incluye revisión interactiva y asignación. Sus resultados requieren lecturas que reflejen asignaciones actuales; S3-07 debe conectar esas lecturas sin duplicar sus componentes de revisión.
- **Discrepancia de contrato registrada y resuelta para la implementación:** el diseño S3-01 describe `MemberAssignment` con documento activo singular; el DoD de S3-07 exige documentos activos relacionados y S3-03/S3-08 requieren selección multidocumento. El DTO de este ticket usa `documents[]`, rondas ligadas por documento y `canSubmit`/cobertura por documento o por trabajo propio. Esta decisión está limitada al DTO de lectura y preserva autorización mínima; queda pendiente la revisión de integración con consumidores en Tarea 1.
- S3-01 define datos, auditoría y aislamiento base. Coordinar con Dev 1 cualquier policy, helper compartido, migración o tipo generado; no reescribir migraciones integradas.
- Las policies Storage de S1 excluyen intencionalmente a Member. S3-07 permite una excepción estrecha para el original activo relacionado con una asignación vigente (y la corrección propia que siga operativa): solo el servidor puede resolver la ruta y firmar la URL después de revalidar Profile/relación en DB. No se amplía Storage ni Repository global.
- No inferir cierre a partir de tipos, fixtures o mocks: aceptación crítica requiere Auth/REST/Storage locales con dos tenants y dos Members.

### Handoff explícito desde S3-03

S3-03 no queda integrado solo porque sus controles de QA/Admin estén implementados. Su ticket condiciona la aceptación a lecturas S3-07 y a que Member use la vista S3-08. Para este ticket eso significa:

- Las asignaciones y detalles expuestos a S3-08 deben reflejar estado, severidad actual, asignación, evidencia exacta y documentos relacionados persistidos tras una decisión S3-03; la relectura no puede basarse en estado optimista o fixtures.
- Reasignar, desasignar, resolver o retirar una asignación desde S3-03 debe revocar el detalle/URL del Member anterior cuando S3-07 revalida el permiso.
- El conjunto de documentos que S3-03 presenta al preparar una ronda debe ser coherente con los documentos que S3-07 devuelve desde evidencia; S3-08 seleccionará explícitamente el documento objetivo cuando haya varios.
- S3-07 no construye la ruta Member ni sus controles de envío. S3-08 la implementa como solo lectura/flujo propio y consume las consultas y URLs autorizadas de este ticket.
- La aceptación integrada de S3-03 verifica que QA/Admin conserva sus controles, Member llega por navegación a My Assignments (S3-08), y requests directos no permiten a Member mutar review ni recuperar el Repository global.

## Invariantes de autorización y privacidad

1. Verificar sesión y Profile en servidor. Derivar workspace y rol de esa sesión; ignorar rol, actor, workspace, Owner y permisos enviados por el cliente.
2. Admin/QA conservan lecturas de su workspace. Member solo consulta findings actualmente asignados a su propio `user_id`.
3. El acceso a documento activo se deriva de `finding_evidence` del finding autorizado. Compartir documento no autoriza otros findings, evidencias o entregas.
4. La evidencia del finding puede conservar su versión histórica exacta como snapshot de texto. Eso no autoriza descargar el original histórico ni navegar el historial completo de versiones.
5. El Member puede abrir la versión activa de documentos relacionados y las correcciones propias autorizadas mientras el permiso operativo siga vigente. Generar URL firmada de 300 segundos solo después de revalidar autorización y resolver el Storage path desde la versión autorizada.
6. No guardar ni registrar URLs firmadas. Documentar que una URL ya emitida puede vivir hasta 300 segundos después de una reasignación/revocación.
7. `listOwnApprovals` expone metadata mínima propia aun si luego hay reasignación, pero no da acceso a evidencia, archivos, contenido de entregas ajenas ni a una versión retirada por S3-10.
8. Proyecciones Member excluyen confidence interno, vectores, rutas, ledger, otros análisis privados, otros findings/entregas y datos que se puedan inferir por joins, conteos, filtros o errores.
9. Las funciones de lectura y creación de URL deben fallar de forma controlada ante IDs ajenos, revocación, tenant incorrecto, entidad retirada y estado no operativo.

### Matriz inicial de proyección

| Dato | Member | Admin / QA Lead |
| -- | -- | -- |
| Finding y evidencia | Solo finding asignado actualmente; evidencia snapshot exacta de ese finding | Findings y evidencia del workspace según permisos de review |
| Documentos | Solo documentos relacionados por evidencia; metadata de activa por documento | Documentos relacionados dentro del workspace |
| Ronda/cobertura | Rondas ligadas a sus items; estado mínimo para saber su fase | Rondas/cobertura completas del workspace |
| Submissions | Solo propias y los items propios incluidos; sin entregas/contribuidores ajenos | Proyección operativa del workspace para revisar/consolidar |
| Return reason | Solo devolución dirigida al Member y a sus items | Razones necesarias para administrar la ronda |
| Aprobaciones | Metadata mínima de contribución propia; no archivo/versionId/contenido | Metadata de decisión de su workspace según la cola de S3-09 |
| Originales | Activa relacionada con asignación vigente y corrección propia autorizada; nunca original histórico | Originales autorizados del workspace mediante Repository/workflow |
| Campos excluidos | Confidence, vectores, paths, URLs firmadas persistidas, ledger, análisis/findings/entregas ajenas | Confidence interno, vectores y secretos; campos ajenos al caso de uso |

La API de S3-07 para Member no debe devolver una proyección global de ronda para luego filtrarla en UI. Los endpoints de consulta de rondas completos pertenecen a la superficie Admin/QA consumida por S3-09.

## Secuencia de implementación

### Fase 0 — Cerrar contratos de lectura con consumidores

- Revisar `MemberAssignment`, `OwnApprovalItem`, `ReviewPage`, `FindingEvidenceItem` y las firmas de `ReviewRepositoryApi` frente a S3-08/S3-09 y el diseño S3-03.
- Confirmar qué significa cada fase/estado visible y qué metadatos de ronda, entrega, cobertura y candidata puede ver el submitter.
- Precisar la selección de documento activo cuando un finding tiene varias evidencias; la lectura debe devolver solo documentos autorizados del finding.
- Acordar con Dev 1 las consultas/helpers RLS y con Diego los estados de upload, reserva, submission y candidata que pueden aparecer.
- Ajustar contratos solo si hay discrepancia concreta; actualizar `review-contracts.typecheck.ts` y validaciones Zod en la frontera.

**Salida:** matriz de DTO por rol y firmas aceptadas por los consumidores; sin cambiar el alcance de S3-08.

### Fase 1 — Consultas de asignaciones y proyecciones

**Archivos implementados/esperados:**

- `src/modules/review/repository.actions.ts` expone Server Actions públicas y valida sesión con `requireActor()`.
- `supabase/migrations/*_s3_07_member_assignment_reads.sql` define RPCs de lectura con proyecciones explícitas y autorización de actor/rol/workspace; no concede SELECT amplio.
- Extender `src/modules/review/index.ts` solo con la superficie pública segura.
- Añadir schemas/paginación al módulo review sin crear repositorio genérico.

**Trabajo:**

- Implementar `listAssignments(input)` como API Member-only, con paginación estable y filtros mínimos de estado; el RPC filtra por `assignee_id = actorId`, workspace y estado operativo. El actor llega de `requireActor()`, no del input. Admin/QA conservan la lista de findings S2 y la cola de rondas S3-09, sin usar este endpoint.
- Implementar `getAssignment(findingId)` sin confiar en un `documentId` del navegador. Componer finding permitido, evidencia snapshot exacta, documentos activos relacionados, estado/cobertura propia de ronda y entregas propias autorizadas.
- Filtrar findings y entregas ajenas antes de construir el DTO; no consultar listas globales y filtrarlas en cliente.
- Implementar `listOwnApprovals(input)` mediante metadata mínima de contribuciones persistida. No hacer join que exponga candidatos o contenido retirado.
- Firmar URLs con el cliente privilegiado solo después de RPC que deriva el path canónico y revalida autorización; la policy Storage S1 sigue negando Member.
- Validar entradas con Zod y devolver `ActionResult<T>` con errores controlados, sin respuestas crudas de Postgres/Storage.
- Añadir pruebas unitarias del servicio y de mappers para cobertura parcial, varios documentos, asignación revocada e historial mínimo.

### Fase 2 — Original activo y corrección propia

**Trabajo:**

- Implementar `getWorkflowOriginalUrl(versionId)` en servidor. Resolver version → documento → workspace → storage path desde DB; jamás aceptar path, bucket o tenant como input.
- Admin/QA: permitir originales de su workspace según las reglas existentes.
- Member: permitir solo versión activa de un documento presente en la evidencia de un finding actualmente asignado, o archivo propio permitido por el estado operativo del contrato. Denegar versiones históricas globales y archivos de otros submitters.
- Revalidar la asignación/permiso en cada solicitud de URL; no usar Owner ni acceso global al Repository como sustituto.
- Emitir URL por 300 segundos; respuesta con `url` y `expiresAt`, sin persistencia ni logs. Evitar incluir URL en eventos, errores, analytics o Sentry.
- Asegurar que el switch delete de S3-06/S3-10 invalide de inmediato las lecturas del finding y derivados dependientes, aunque cleanup físico siga pendiente.
- Coordinar política de URL y firma con S1 Repository/Storage y los propietarios de las migraciones/helpers.

### Fase 3 — RLS, GRANT y superficie REST/Storage

- Revisar policies y GRANT de `findings`, `finding_evidence`, rondas, items, submissions, submission items, approvals/contribuciones, versiones y Storage.
- Mantener la regla Member mínima: el acceso a un finding asignado no concede SELECT al análisis completo, todos los chunks ni findings vecinos.
- Evitar policies recursivas y joins/policies que conviertan acceso al documento en acceso transitivo a otros findings.
- Probar llamadas directas REST y Storage; la seguridad no puede depender de ocultar botones o rutas.
- Si el esquema requiere cambios, Dev 1 coordina migración/tipos generados y ownership compartido antes de tocarlo.

### Fase 4 — Pruebas de aislamiento y regresión

Crear pruebas SQL y HTTP Auth/REST/Storage con dos workspaces, dos Members, Admin/QA, Owner sin asignación, findings F1/F2 que comparten documento, versiones activas e históricas conocidas, entregas propias/ajenas y reasignación.

Casos críticos:

1. Member ve F1 asignado y no ve F2 aunque compartan documento; acceso directo a F2 y su evidencia se deniega.
2. Ser Owner sin asignación no concede listado, detalle, evidencia ni URL.
3. Member ve snapshot de evidencia histórico exacto y puede abrir solo la versión activa relacionada; el original histórico se deniega.
4. URLs de otra persona, otro tenant, otra versión o ruta inventada se deniegan; ruta siempre se resuelve desde la versión autorizada.
5. Reasignación/cierre revoca nuevas lecturas, URLs y operaciones del anterior; verificar que una URL ya firmada puede seguir viva solo hasta su expiry documentado.
6. Historial propio aprobado sobrevive a reasignación con metadata mínima, incluso si el uploader final fue Admin/QA; no habilita volver al archivo o finding ajeno.
7. Delete de versión anterior hace invisibles finding/snapshot/derivados desde el switch y no revela contenido en historial.
8. Filtros, búsqueda, total, cursores, errores y DTO no filtran IDs, nombres, conteos ni estados de trabajo ajeno.
9. Admin/QA conservan lecturas globales de su workspace y la suite S1/S2 no pierde acceso permitido.
10. Verificar cero salida de confidence, vectores, storage paths, signed URLs persistidas y ledger privado.

Comandos según el estado del entorno y las suites ya existentes: `pnpm test:unit`, `pnpm typecheck`, `pnpm lint`, `pnpm test:db`, `pnpm test:fixtures`; Playwright/E2E cuando el flujo de entorno y los productores de S3 estén disponibles. No ejecutar reset/seed remoto ni migraciones remotas.

### Fase 5 — Handoff a S3-08/S3-09 y aceptación

- S3-08 consume `listAssignments`, `getAssignment`, `listOwnApprovals` y URLs autorizadas para My Assignments; no implementa consultas paralelas en UI.
- S3-09 consume lecturas Admin/QA de rondas/candidatas; mantener separadas las vistas globales autorizadas y el historial mínimo del Member.
- Hacer revisión integrada de S3-03: controles ya implementados deben leer snapshots y capacidades actuales desde la fuente autorizada; corregir solo enlaces/contratos realmente pendientes de S3-07/08.
- Registrar SHA, entorno, comandos y resultado de cada capa. No declarar aceptación completa con mocks, tipos o estado Todo/Done de Linear solamente.

## Tareas pequeñas para completar progresivamente

Marca cada tarea al terminarla y deja sus comandos/resultados en el handoff. Las tareas 1–4 producen la superficie de lectura; 5–7 endurecen acceso y demuestran los límites; 8 cierra la integración. Si una prueba revela una brecha, añade una tarea concreta antes de marcar la tarea relacionada.

### Tarea 1 — Contrato y matriz de autorización

- [x] Comparar `MemberAssignment`, `OwnApprovalItem`, paginación y `ReviewRepositoryApi` con los criterios S3-07 y consumidores S3-08/S3-09.
- [x] Escribir la matriz de campos permitidos para Admin/QA y Member, incluyendo entregas propias, fase de ronda y metadata de aprobación.
- [ ] Acordar con Dev 1 policies/helpers/tipos compartidos y con Dev 2 los estados de submission/candidate que se exponen.
- [ ] Revisar e integrar la propuesta de DTO multidocumento: un finding puede relacionarse con varias rondas documento-scoped; `canSubmit` se expresa por documento.
- [x] Añadir/ajustar type assertions y schemas Zod de entrada donde el contrato actual no alcance.
- **Salida:** DTOs y autorización documentados; sin cambios de UI ni consultas aún.

### Tarea 2 — Infraestructura de consultas y paginación

- [x] Crear las RPCs de review de lectura con proyecciones explícitas, filtrado por tenant/actor y permisos solo de service_role.
- [x] Crear Server Actions que verifican identidad/profile, validan entradas y mapean errores a `ActionResult<T>`.
- [x] Definir orden estable, página/tamaño acotados y filtros mínimos.
- [ ] Añadir pruebas unitarias de paginación, Zod y errores controlados.
- **Salida:** infraestructura probada sin exponer datos nuevos al navegador.

### Tarea 3 — `listAssignments` y `getAssignment`

- [x] Implementar listado propio del Member filtrado por asignación persistida y estado operativo.
- [x] Implementar detalle que derive finding y documentos de datos persistidos, nunca de un `documentId` enviado por cliente.
- [x] Proyectar evidencia snapshot exacta y documentos activos relacionados; no cargar findings vecinos por compartir documento.
- [x] Incluir entregas propias y fase/cobertura scoped a los items del Member, sin datos de otros colaboradores.
- [x] Renderizar los textos de finding/evidencia/nombre como texto seguro; `finding-evidence-drawer.test.tsx` comprueba que un snapshot con `<script>` se escapa y no se interpreta.
- [ ] Añadir pruebas unitarias de mapping, finding revocado, varios documentos, evidencia histórica y cobertura parcial.
- **Salida:** acciones de asignación completas con DTO mínimo y pruebas de servicio.

### Tarea 4 — `listOwnApprovals`

- [x] Consultar metadata mínima de contribución/aprobación propia, incluyendo aprobación cuyo archivo final subió Admin/QA.
- [x] Mantener el registro tras reasignación sin conceder acceso a evidencia, archivo o finding operativo ajeno.
- [ ] Respetar borrado de versión S3-10: no enlazar ni reconstruir el contenido eliminado.
- [x] Añadir pruebas de aprobación propia, varios findings cubiertos y reasignación; pendiente purga S3-10.
- **Salida:** historial propio de solo lectura listo para S3-08.

### Tarea 5 — URL de original y apertura autorizada

- [x] Implementar `getWorkflowOriginalUrl(versionId)` con resolución de versión/documento/workspace/path en servidor.
- [x] Autorizar Admin/QA en su workspace y Member solo para original activo relacionado/corrección propia mientras la relación operativa siga vigente.
- [x] Denegar original histórico para Member, versionId ajeno, ruta inventada y permiso revocado.
- [x] Emitir URL de 300 segundos con `expiresAt`; no persistir ni registrar la URL.
- [x] Añadir pruebas unitarias de autorización/expiry y errores sin path/URL; probar por integración el original activo y la corrección propia.
- **Salida:** URL firmada solo para Admin/QA tras validar la versión confirmada en su workspace; Member nunca obtiene originales.

### Tarea 6 — Policies RLS/GRANT y Storage

- [x] Revisar y probar las policies/GRANT actuales: Member puede leer sus filas asignadas y evidencia autorizada por RLS; no obtiene el análisis completo ni chunks.
- [x] Probar por REST que un finding/evidencia vecina no aparece ni incrementa conteos; probar aislamiento de tenant y denegación directa en Storage.
- [ ] Coordinar y revisar cambios de migración/tipos con Dev 1 antes de integrarlos.
- [x] Verificar por Auth/REST/Storage reales el alcance de Member, Owner sin asignación, otro Member y tenant ajeno; la URL autorizada descarga el original privado.
- **Salida:** permisos mínimos demostrados en las fronteras de persistencia y archivos.

### Tarea 7 — Revocación, acceso histórico y delete

- [x] Probar reasignación, desasignación y cierre: las nuevas consultas del anterior se deniegan; un original compartido queda accesible mientras conserve otra asignación vigente en ese documento y se revoca al retirar todas.
- [x] Verificar evidencia snapshot histórica visible dentro del finding autorizado, sin resolver el original histórico para Member.
- [ ] Verificar que switch delete de S3-06/S3-10 invalide de inmediato finding/snapshot/derivados.
- [x] Verificar que el bearer token real de Storage codifica expiración de 300 segundos; las URLs emitidas previamente pueden seguir vigentes hasta ese límite.
- **Salida:** casos de ciclo de vida y límites de revocación registrados.

### Tarea 8 — Aceptación integrada y handoff

- [x] Ejecutar la suite aislada con Auth/REST/Storage, dos tenants, Members, Owner sin asignación, findings que comparten documento, versiones conocidas y submissions ajenas; suite S3-07: 3/3 pruebas.
- [ ] Ejecutar regresión S1/S2 apropiada y verificar cero filtración de confidence, vectores, rutas, ledger, signed URLs persistidas o contenido ajeno.
- [ ] Verificar el handoff S3-03: después de asignar/reasignar/desasignar/cerrar, las lecturas reflejan el estado persistido y revocan el acceso anterior.
- [ ] Verificar coherencia multidocumento entre evidencia de S3-03, documentos/rondas que devuelve S3-07 y selección explícita que consumirá S3-08.
- [ ] Confirmar contrato y navegación con S3-08: Member recibe My Assignments, no controles de review ni Repository global; dejar las pruebas UI/end-to-end de esa ruta para S3-08/S3-12.
- [ ] Entregar APIs y escenarios a S3-08/S3-09; no implementar su UI o comandos dentro de S3-07.
- [ ] Registrar SHA, entorno, comandos, resultados y límites; actualizar estado del ticket solo con evidencia suficiente.
- **Salida:** evidencia de aceptación local y handoff reproducible para los consumidores.

Cada tarea mantiene sus propias pruebas y evita abarcar UI de envío de S3-08, decisiones de aprobación de S3-06/S3-09 o digest de S3-11.

## Definición de terminado

- Consultas y URL firmada implementadas mediante API pública de review, con DTOs mínimos y validación.
- Member accede solo a trabajo propio según asignación persistida; Admin/QA retienen acceso de workspace.
- Aislamiento verificado con Auth/REST/Storage local real y casos transitivos, históricos, reasignación y delete.
- Contratos coherentes con S3-08/S3-09 y sin cambios silenciosos de PRD, esquema compartido ni decisiones S3-01.
- Suites apropiadas ejecutadas y resultados/límites documentados; referencias listas para actualizar el estado del ticket en Linear por quien tenga acceso.

## Evidencia de implementación y validación — 2026-11-18

- `pnpm test:unit`: 130 archivos, 1.101 pruebas aprobadas.
- `pnpm typecheck`: aprobado; `pnpm check:database-types`: aprobado tras regenerar `src/types/database.ts` desde Supabase local.
- `pnpm lint`: 0 errores; conserva 3 warnings preexistentes en pruebas de upload.
- `pnpm test:db`: 43 archivos, 1.803 pruebas aprobadas.
- `src/modules/review/repository.actions.test.ts`: 5 pruebas aprobadas; valida identidad, resolución del path autorizado, firma de 300 s y `expiresAt`, denegaciones y que errores/telemetría no incluyan paths ni URLs.
- Integración aislada S3-07: 3 pruebas aprobadas con Auth/PostgREST/Storage local. Comprueba RLS por REST (solo finding/evidencia asignados, sin vecino, conteo, análisis completo o chunks), Owner sin asignación, Member vecino y tenant ajeno; apertura y descarga del original activo relacionado y de la corrección confirmada propia; denegación de Storage directa; bearer token real con expiración de 300 segundos; desasignación/reasignación/cierre y revocación del original al retirar todas las asignaciones del documento; aprobación propia persistente tras reasignar los tres findings cubiertos; snapshot exacto histórico sin resolver el original histórico para Member.
- `pnpm test:integration` ejecutó 34 suites generales: 33 aprobadas, 1 fallida y 4 pruebas omitidas. `analysis-recovery.test.ts` rechazó alterar un job `kdm-analysis-recovery` que ya existía en el Supabase local. El runner aislado posterior de las cuatro suites Review no pudo iniciar; S3-07 sí pasó por separado.
- `git diff --check`: aprobado. No se ejecutó reset ni migración remota.
- Pendiente fuera del alcance solicitado: validar integración con productores S3-04/S3-06, integración con S3-08/S3-09, switch/purga S3-10 y estados operativos restantes de corrección propia.
- `pnpm test:integration -- tests/integration/review-assignment-reads-isolation.test.ts`: 3/3 aprobadas en ejecución final aislada; incluye el claim `exp` del bearer token real y el conteo REST de un finding vecino.
- Pendiente fuera de S3-07: UI y navegación de S3-08, además de pruebas E2E de borrado S3-06/S3-10. La integración de revocación por reasignación sí está cubierta.
