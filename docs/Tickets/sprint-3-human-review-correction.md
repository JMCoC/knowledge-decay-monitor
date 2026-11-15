# Sprint 3 — Human Review & Correction v0.3

Fecha: 2026-11-08.

**Diseño S3-01:** [Diseño técnico aprobado](<https://linear.app/saasprojectkdm/document/s3-01-contratos-modelo-e-aislamiento-diseno-borrador-0edf7dbd192f>). El usuario aprobó el diseño técnico el 2026-11-08; la revisión de consumidores sigue pendiente.

**Publicado en Linear:** [Slice y coordinación](<https://linear.app/saasprojectkdm/document/sprint-3-human-review-and-correction-v03-slice-y-coordinacion-45606628ecac>). Milestone: **Sprint 3 — Human Review & Correction v0.3**; tickets <issue id="e39f7442-4c52-4fbb-b085-dc6435aa9e50" label="SAA-25" href="https://linear.app/saasprojectkdm/issue/SAA-25/contratos-modelo-de-correccion-y-aislamiento-del-workflow-humano" />–<issue id="78628ecb-b907-43ae-8733-1f5bfec5fa7d" label="SAA-36" href="https://linear.app/saasprojectkdm/issue/SAA-36/aceptacion-integral-y-quality-gates-de-human-review-and-correction-v03" />, todos en Todo y ciclo 4 al crearse.

Fuente: [PRD §67](<https://linear.app/saasprojectkdm/document/product-requirements-document-prd-74f94601d8cb>). Formato y continuidad: [slice S2](<https://linear.app/saasprojectkdm/document/sprint-2-ai-analysis-v02-slice-y-coordinacion-88b07a921439>) y [tickets S2](<https://linear.app/saasprojectkdm/document/sprint-2-ai-analysis-v02-slice-y-coordinacion-88b07a921439>). Detalle: tickets S3 (enlaces en el índice al final).

## 1. Objetivo y recorrido

Completar la remediación humana: **review findings → confirm/assign → Admin/QA opens document round → Members submit individual/grouped files → all required findings covered → Admin/QA consolidates or selects one complete file → final candidate processing → QA approves → new active version waits for manual reanalysis**.

El flujo también debe demostrar rechazo con motivo y reenvío, severidad original frente a actual, retención/eliminación de la versión reemplazada, acceso mínimo de Member, auditoría y correos relevantes. La IA no decide estados ni activa correcciones. La aprobación no resuelve findings ni consume créditos.

## 2. Base observada y límites

* Linear: proyecto Knowledge Decay Monitor (<project id="df996994-ddfa-4097-84d3-be20701d522a" label="Knowledge Decay Monitor" href="https://linear.app/saasprojectkdm/project/knowledge-decay-monitor-de9ff4258960" />), equipo SaaS Project KDM (SAA). S1 y S2 figuran al 100%; <issue id="9d9b3eec-f593-42a5-9bc1-dfd469d273fd" label="SAA-5" href="https://linear.app/saasprojectkdm/issue/SAA-5/registro-seguro-y-bootstrap-del-workspace" /> a <issue id="cc868e22-9240-4976-9ec1-c58871fc45cb" label="SAA-24" href="https://linear.app/saasprojectkdm/issue/SAA-24/aceptacion-integral-y-quality-gates-de-ai-analysis-v02" /> están Done. Antes de la creación inicial se comprobó que aún no existían tickets ni milestone S3; esa observación es histórica y no describe su estado después de publicarlos.
* Ciclo vigente: **4**, del **3 al 17 de noviembre de 2026**, zona America/Bogota; termina el 17 a las 00:00. Los doce tickets se incorporan a ese ciclo por petición del usuario. No se crea otro ciclo ni se reasignan tickets anteriores.
* El checkout contiene módulos de análisis/créditos/notificaciones, Vitest, Playwright, jobs durables y Storage seguro. Las notas iniciales de `AGENTS.md` y Día Cero sobre capacidades pendientes son históricas. Se preservan los archivos locales ajenos sin commit.
* Hallazgos ya guardan severity_original/current, status, assignee_id y evidencia exacta. No se encontró implementación del workflow humano, My Assignments, correcciones/aprobación ni audit_events.
* Ingesta actual está limitada a v1 y su finalización activa automáticamente. Las correcciones requieren extender esa ruta sin romper v1.
* notification_events y dispatcher actuales están ligados a analysis_id y eventos completed/failed. Agregar valores al enum no basta: hay que evolucionar referencias, unicidad, autorización, entrega y pruebas.
* analysis_documents y finding_evidence tienen FK RESTRICT a versiones/chunks. La rama delete necesita migración/limpieza real, no un DELETE aislado ni eliminar integridad.
* La auditoría hosted local del 2026-11-07 registró bloqueos de configuración, pero es histórica y no prueba el estado actual. Se respeta el cierre de S2; S3-12 revalida prerequisites de runtime antes de aceptar S3.
* Esta entrega es planificación y creación en Linear. No implementa producto, cambia permisos reales, envía correos de prueba, aplica migraciones, hace commits o despliega.

## 3. Cobertura del PRD §67

| Requisito | Responsable de entrega | Verificación integrada |
| -- | -- | -- |
| Máquina de estados, confirmación, false positive y resolución manual | S3-02 | S3-03 / S3-12 |
| Severity override y original frente a actual | S3-02 | S3-03 / S3-12 |
| Asignación, reasignación y revocación | S3-02 | S3-07 / S3-08 |
| RLS Member y acceso a evidencia/documentos | S3-01 / S3-07 | S3-12 con SQL/HTTP/Storage |
| My Assignments e historial propio aprobado | S3-07 / S3-08 | S3-12 |
| Upload de versión corregida, numeración y procedencia | S3-04 | S3-08 / S3-12 |
| Auto preprocessing, pending approval y fallo/retry | S3-05 | S3-08 / S3-09 |
| Rechazo, motivo obligatorio y resubmission | S3-06 / S3-04 | S3-08 / S3-09 |
| Aprobación, active_version_id y switch atómico | S3-06 | S3-09 / S3-12 |
| Históricas de solo lectura y rechazadas | S3-06 / S3-07 | S3-09 |
| Delete-or-retain de la anterior | S3-06 / S3-10 | S3-09 / S3-12 |
| Pending reanalysis y reanálisis manual | S3-06 / S3-09 | S3-12, APIs S2 |
| Correos relevantes | S3-11 y outbox en cada productor | S3-12 con recepción real |
| Eventos auditables de workflow | S3-01 y transacciones de cada dominio | S3-11 / S3-12 |
| Vitest de estados y pruebas críticas de Member | S3-02 / S3-07 | S3-12 y suites por ticket |
| UI, persistencia, errores, seguridad y CI (§71) | Todos | S3-12 |

Fuera: invitaciones/gestión de roles, pagos, High alerts, Audit Log y Analysis History completos, preferencias y digest general S4; eliminación global del documento y cancelación por borrado S5; autoanálisis, OCR, chat y aprendizaje de falsos positivos.

## 4. Distribución y capacidad

| Colaborador | Tickets | Dominio |
| -- | -- | -- |
| Juan Manuel (Dev 1) | S3-01, S3-02, S3-11, S3-12 | Contratos/RLS, workflow transaccional, eventos y aceptación/CI |
| Diego Alejandro Tolosa Sanchez (Dev 2) | S3-04, S3-05, S3-06, S3-10 | Upload, procesamiento, consolidación, decisiones de versión y cleanup |
| Juan Pablo Castaño Arango (Dev 3) | S3-03, S3-07, S3-08, S3-09 | Revisión UI, lecturas seguras, Member y cola/consolidación/reanálisis |

Las estimaciones de horas por ticket y sus totales se retiraron por petición del usuario el 2026-11-08. No se sustituyen por puntos ni fechas inventadas. Los acuerdos de rondas y consolidación amplían el planning inicial y requieren revisar capacidad con el equipo.

Incorporar los doce tickets al ciclo 4 no acredita capacidad ni promete cierre el 17; no se fija targetDate ni dueDates individuales. Los bloques de mayor riesgo incluyen cobertura concurrente/devoluciones, consolidación, cleanup con FK y el digest mínimo; no ocultarlos para cuadrar calendario.

## 5. Secuencia, dependencias y ownership

**Inicio paralelo:** Juan Manuel publica la entrega mínima de contratos/fixtures S3-01 y prepara S3-02; Diego desarrolla S3-04/S3-05 con fixtures; Juan Pablo trabaja S3-03/S3-07/S3-08. S3-12 empieza desde el día uno con escenarios y corpus.

**Integración:** conectar asignación → preparación/apertura de ronda → entregas/cobertura → consolidación o selección directa → procesamiento de candidata final → decisión/devolución selectiva → proyecciones; completar cleanup y digest; cerrar con ambos caminos de retención, rechazo/reenvío y reanálisis manual. Integrar pequeñas entregas, sin esperar un ticket horizontal gigante.

| Ticket consumidor | Productores para aceptar su integración |
| -- | -- |
| S3-02 | Contratos/RLS/audit/outbox S3-01 |
| S3-03 | S3-02 y lecturas S3-07 |
| S3-04 | S3-01, asignación S3-02 y autorización S3-07 |
| S3-05 | S3-01 / upload S3-04 y worker real |
| S3-06 | S3-01 / S3-04 / S3-05 y rama delete S3-10 |
| S3-07 | Contratos S3-01, asignación S3-02 y procedencia/decisiones S3-04/S3-06 |
| S3-08 | S3-04 / S3-05 / S3-06 / S3-07 |
| S3-09 | S3-05 / S3-06 / S3-07 / S3-10 y S2 |
| S3-10 | Contratos S3-01, switch S3-06 y guardia transaccional con Run S2 |
| S3-11 | S3-01 / S3-02 / S3-06 y Resend |
| S3-12 | S3-01 a S3-11 integrados |

Estas son integraciones de cierre, no una cola de inicio ni un DAG de implementación. S3-06/S3-10 y las lecturas/autorizaciones se desarrollan contra contrato compartido y se integran juntas. En Linear se mantiene el patrón S2: relaciones entre capacidades y once bloqueos explícitos del ticket de aceptación; cada ticket explica sus requisitos de integración.

**Ownership:** Dev 1 coordina src/types, tipos SQL generados, identity/workspace, helpers/policies compartidos, shell, configuración y CI. Dev 2 controla ingestion y jobs/correcciones/switch/cleanup. Dev 3 controla repository/presentación, consultas de asignaciones y rutas. Cada autor redacta migraciones nuevas y pruebas de su dominio con orden coordinado. No modificar archivos de otro dominio sin coordinación.

Mantener módulos por negocio: review posee decisiones/asignación de findings y preparación/apertura del conjunto de ronda; ingestion posee bytes/entregas, cobertura transaccional, consolidación/candidata, procesamiento/versiones; repository consume proyecciones de lectura; notifications consume eventos; audit es una escritura interna mínima y append-only en las transacciones propietarias. Los nombres de nuevas APIs se fijan en S3-01 antes de implementarse. Usar contratos y funciones internas públicas, sin HTTP interno, ciclos ni barrels cliente/servidor mezclados.

## 6. Convenciones y discrepancias explícitas

Los acuerdos de rondas, entregas agrupadas, consolidación Admin/QA, selección directa y devolución selectiva fueron aprobados por el usuario el 2026-11-08 y actualizan explícitamente PRD §§12.5/39/67. El diseño técnico S3-01 fue aprobado por el usuario el 2026-11-08; su implementación y la revisión de consumidores siguen pendientes, por lo que no son contratos implementados.

 1. **Procesamiento frente a aprobación:** la redacción inicial del PRD situaba pending_approval antes del preprocessing; §§12.5/39 ya recogen esta precisión. Se conserva version_status NULL sin ready: la intención/espera pertenece a la ronda y pending_approval solo aparece en la candidata final tras procesamiento completo.
 2. **Asignación:** FR-16 permite asignar confirmed/update_planned. Destinatario S3 es Member del mismo workspace; owner_id no autoriza. Evidencia determina documentos relacionados, y cada envío elige uno explícitamente.
 3. **Rondas y concurrencia:** se sustituye la regla de una sola entrega abierta por documento por una ronda con entregas concurrentes y una única candidata final vigente. Admin/QA prepara findings/responsables y abre explícitamente el conjunto fijo por documento; puede asignarlos todos al mismo Member. Los findings incorporados después quedan para una siguiente ronda. Conservar base fija, revisión/CAS e idempotencia; una reserva sin envío confirmado expira inicialmente a las 24 h, no completa cobertura ni bloquea entregas ajenas. Reasignación/desasignación/resolved invalida el permiso de reservas afectadas. Recuperación/reconciliación limpian solo temporales y no reutilizan numeración; el plazo no es el lease técnico S1.
 4. **Admin/QA y archivo final:** después de completar la cobertura de la ronda, Admin/QA descarga las entregas, consolida manualmente y sube un único archivo final. Si una sola entrega cubre toda la ronda, puede seleccionarla directamente sin nueva transferencia. La selección no aprueba ni activa. Member exige asignación vigente para cada finding de su entrega; Admin/QA conserva su capacidad de proponer versiones sin asignación Member, sin saltarse una ronda abierta ni su aprobación.
 5. **Pérdida de asignación o resolución:** revoca lectura operativa y nuevas cargas/finalizaciones/firmas; invalida reservas todavía sin envío confirmado. La entrega ya enviada (upload confirmado) permanece disponible para Admin/QA con procedencia y validación de base, sin iniciar preprocessing individual; solo la candidata final con cobertura vigente puede procesarse/revisarse; no se borra ni se otorga acceso operativo por ser submitter. Decidirla no reabre/resuelve el finding. Historial aprobado propio usa una proyección mínima separada.
 6. **Evidencia e históricos:** Member puede leer el snapshot de su finding aunque la versión exacta sea histórica. Ese permiso no concede descargar originales históricos ni ver todos los findings de un documento. Originales nuevos requieren autorización vigente; URLs ya emitidas pueden durar hasta 300 segundos.
 7. **Retención:** histórica es solo lectura, no reactivable. Delete de versión exige cleanup durable en S3 porque §67 incluye esa opción; no se aplaza íntegramente a S5. La eliminación global sigue fuera.
 8. **Referencias al eliminar:** en la transacción del switch se invalidan versión, findings y snapshots dependientes, incluidas proyecciones S2, sin esperar a la limpieza física. Política inicial conservadora: purgar versión/bytes/chunks/evidence y findings completos dependientes, así como referencias/asignaciones/payloads reconstruibles, manteniendo solo metadata mínima de estado/coste/audit y marcadores de resultado no disponible. La aprobación de la nueva versión conserva registro propio mínimo y notificación basados en la nueva corrección, desacoplados del finding borrado y sin reconstruir v1. En Retain se conservan findings anteriores; en Delete se retiran los dependientes. Revisar también las relaciones de solicitudes/historial para no bloquear cleanup ni retener contenido eliminado.
 9. **Análisis en curso:** delete de versión anterior devuelve CONFLICT si un run activo la usa; retain sigue permitido. Run y decisión delete comparten guardia/lock para impedir carreras. No se implementa cancelación por borrado global S5.
10. **Correos S3 frente a S4:** §67 exige relevant emails y §40 agrupa eventos no urgentes a las 23:00 UTC. Adelantar solo el mínimo digest de assignment/approval/rejection para que S3 sea completo y respete esa regla; S4 amplía el agrupador y los tipos. No cambiar estos avisos a inmediatos.
11. **Motivo de rechazo:** obligatorio tras trim, límite inicial 2.000 caracteres, privado y renderizado como texto. Audit/email solo indican que hubo rechazo y enlazan a la aplicación.
12. **Reanálisis:** aprobación deja pending_reanalysis sin cobrar; Admin/QA confirma un nuevo coste por S2. Ningún run ni decisión cambia automáticamente el estado humano de findings previos.
13. **Cuentas Member antes de S4:** usar cuentas controladas preparadas por administración en entorno de prueba, sin seed remoto ni credenciales en artefactos. Las invitaciones no son prerequisite implementado de S3.

## 6.1 Acuerdos de producto del 2026-11-08

* La ronda pertenece a un documento y fija los findings esperados al abrirse por Admin/QA. Un Member puede recibirlos todos; los findings incorporados después no amplían la ronda abierta.
* Cada entrega es un archivo completo vinculado a uno, varios o todos los findings asignados al remitente en la misma ronda/documento. Una reserva o transferencia incompleta no cuenta. La cobertura se calcula por findings con entrega vigente, no por número de archivos ni por estado resolved.
* La carga verifica bytes/formato/tamaño/permisos al recibirse. Las entregas intermedias esperan; parsing/chunking/embeddings y aprobación solo avanzan sobre el archivo final seleccionado por Admin/QA cuando están todas las entregas requeridas.
* Admin/QA consolida fuera de la aplicación y carga el resultado; puede seleccionar sin reupload una entrega que por sí sola cubra toda la ronda. No hay edición de contenido ni fusión automática en la interfaz.
* Admin/QA devuelve findings seleccionados con motivo privado obligatorio, conserva las otras entregas y vuelve a esperar solo las correcciones afectadas. Una candidata ya rechazada no se reabre. Entregar, consolidar y aprobar no resuelven automáticamente los findings.
* S3-01 especifica contratos, relaciones, aislamiento y fixtures. Comandos de ronda pertenecen a S3-02, cargas a S3-04, worker a S3-05, consolidación/decisiones a S3-06 y presentación a S3-03/S3-08/S3-09. S3-07/S3-10/S3-11/S3-12 contemplan contribuciones múltiples, privacidad, cleanup y aceptación.
* El diseño técnico S3-01 cuenta con aprobación del usuario del 2026-11-08; la revisión con los tres consumidores y la evidencia de implementación aún deben completarse.

## 7. Criterio de cierre

Evidencia del SHA candidato: rondas con uno/varios Members y entregas individuales/agrupadas; barrera de cobertura antes del preprocessing; selección directa/consolidación y devolución parcial; tests unitarios y de máquina de estados; RLS/Storage/SQL reales; integración upload/worker/switch/cleanup; E2E con dos Members y dos tenants; ambos caminos retain/delete; rechazo y reenvío; reanálisis manual con créditos; recepción de los correos S3 y regresión S2.

Registrar qué se ejecutó y qué no. Estado Done, build, mocks o evidencia histórica no sustituyen el flujo completo. Los archivos ajenos del workspace, semillas remotas, despliegues y secretos permanecen fuera de esta entrega.

## 8. Índice de tickets

| Código | Linear / Ticket | Responsable |
| -- | -- | -- |
| S3-01 | [SAA-25 — Contratos, modelo de corrección y aislamiento del workflow humano](<https://linear.app/saasprojectkdm/issue/SAA-25/contratos-modelo-de-correccion-y-aislamiento-del-workflow-humano>) | Juan Manuel |
| S3-02 | [SAA-26 — Máquina de estados, severidad y asignación transaccional de hallazgos](<https://linear.app/saasprojectkdm/issue/SAA-26/maquina-de-estados-severidad-y-asignacion-transaccional-de-hallazgos>) | Juan Manuel |
| S3-03 | [SAA-27 — Revisión humana de hallazgos con severidad original y controles de asignación](<https://linear.app/saasprojectkdm/issue/SAA-27/revision-humana-de-hallazgos-con-severidad-original-y-controles-de>) | Juan Pablo Castaño Arango |
| S3-04 | [SAA-28 — Carga segura e idempotente de versiones corregidas sobre documentos asignados](<https://linear.app/saasprojectkdm/issue/SAA-28/carga-segura-e-idempotente-de-versiones-corregidas-sobre-documentos>) | Diego Alejandro Tolosa Sanchez |
| S3-05 | [SAA-29 — Preprocesamiento durable de correcciones sin activación automática](<https://linear.app/saasprojectkdm/issue/SAA-29/preprocesamiento-durable-de-correcciones-sin-activacion-automatica>) | Diego Alejandro Tolosa Sanchez |
| S3-06 | [SAA-30 — Aprobación y rechazo con cambio atómico de versión activa](<https://linear.app/saasprojectkdm/issue/SAA-30/aprobacion-y-rechazo-con-cambio-atomico-de-version-activa>) | Diego Alejandro Tolosa Sanchez |
| S3-07 | [SAA-31 — Lecturas de asignaciones y originales con acceso mínimo de Member](<https://linear.app/saasprojectkdm/issue/SAA-31/lecturas-de-asignaciones-y-originales-con-acceso-minimo-de-member>) | Juan Pablo Castaño Arango |
| S3-08 | [SAA-32 — My Assignments con envío, seguimiento y reenvío de correcciones](<https://linear.app/saasprojectkdm/issue/SAA-32/my-assignments-con-envio-seguimiento-y-reenvio-de-correcciones>) | Juan Pablo Castaño Arango |
| S3-09 | [SAA-33 — Cola de aprobación, versiones históricas y reanálisis manual](<https://linear.app/saasprojectkdm/issue/SAA-33/cola-de-aprobacion-versiones-historicas-y-reanalisis-manual>) | Juan Pablo Castaño Arango |
| S3-10 | [SAA-34 — Retener o eliminar la versión reemplazada con limpieza durable acotada](<https://linear.app/saasprojectkdm/issue/SAA-34/retener-o-eliminar-la-version-reemplazada-con-limpieza-durable-acotada>) | Diego Alejandro Tolosa Sanchez |
| S3-11 | [SAA-35 — Eventos auditables y correos de asignación y decisión de correcciones](<https://linear.app/saasprojectkdm/issue/SAA-35/eventos-auditables-y-correos-de-asignacion-y-decision-de-correcciones>) | Juan Manuel |
| S3-12 | [SAA-36 — Aceptación integral y quality gates de Human Review & Correction v0.3](<https://linear.app/saasprojectkdm/issue/SAA-36/aceptacion-integral-y-quality-gates-de-human-review-and-correction-v03>) | Juan Manuel |

---

## 9. Descripciones completas de los tickets de Linear

### S3-01 — Contratos, modelo de corrección y aislamiento del workflow humano

**Linear:** [SAA-25](https://linear.app/saasprojectkdm/issue/SAA-25/contratos-modelo-de-correccion-y-aislamiento-del-workflow-humano) · **Estado al 2026-11-13:** In Progress

**Código del planning:** S3-01

**1. Título del Ticket:** Contratos, modelo de corrección y aislamiento del workflow humano

**Diseño:** [Diseño técnico S3-01 aprobado](<https://linear.app/saasprojectkdm/document/s3-01-contratos-modelo-e-aislamiento-diseno-borrador-0edf7dbd192f>), aprobado por el usuario el 2026-11-08; revisión de consumidores pendiente.

**2. Historia de Usuario (Formato Connextra):**

* **Como** Admin
* **Quiero** que la revisión y las correcciones tengan contratos, permisos y relaciones verificables
* **Para** integrar el tercer vertical sin abrir datos privados ni alterar el análisis existente

**3. Criterios de Aceptación (DoD):**

* Publicar contratos y fixtures revisados con los tres consumidores: mutación de finding/severidad/asignación, preparación/apertura explícita de ronda por documento, entregas individuales o agrupadas, devolución selectiva, consolidación/selección del archivo final, My Assignments, reserva/finalización/retry, revisión de versión, retener/eliminar, historial propio, auditoría y eventos. Mantener ActionResult<T>, validación de frontera y errores controlados; no aceptar Actor, tenant ni rol del navegador.
* Añadir migraciones aditivas para ronda y conjunto fijo de findings/documento, entregas con cobertura de uno o varios findings, submitter y assignee al enviar, versión base, key idempotente, archivo final y sus contribuciones, decisiones/devoluciones selectivas, revisión de concurrencia e historial mínimo de asignación/aprobación. No duplicar findings ni confundir owner_id con assignee_id; relaciones compuestas impiden cruces de tenant.
* Resolver en el contrato la dimensión de estados: conservar version_status NULL mientras uploaded/processing/processing_failed; guardar intención y espera en ronda/entrega. Verificar las cargas al recibirlas, pero procesar únicamente el archivo final elegido por Admin/QA después de completar todas las entregas requeridas. Al finalizar ready, la candidata pasa a pending_approval; v1 conserva su activación S1. Documentar expresamente esta precisión frente al orden narrativo del PRD §§12.5/39.
* Definir permisos mínimos de columnas, proyecciones y RPC. Admin/QA operan su workspace; Member solo su asignación vigente, documentos activos relacionados, evidencia autorizada y correcciones propias autorizadas. El historial de aprobaciones propias es una proyección mínima independiente del acceso global a versiones históricas.
* Crear soporte append-only para audit_events y escritura interna en la misma transacción que cada mutación. Denegar INSERT/UPDATE/DELETE arbitrarios desde el cliente y acceso Member al audit global; metadata permitida excluye texto documental y el contenido del motivo de rechazo.
* Evolucionar notification_events de S2 para entidades de workflow: hoy analysis_id es obligatorio y la unicidad es por análisis/tipo/destinatario. Mantener integridad e idempotencia S2 y admitir múltiples asignaciones/decisiones distintas sin eventos falsos de análisis.
* Entregar fixtures tipados/SQL de dos tenants, Admin/QA/dos Members, un Member con todos los findings, entregas individuales/agrupadas, ronda incompleta/completa, finding posterior diferido, devolución parcial, selección directa de archivo único, consolidación, hallazgo multidocumento, reasignación, candidata pendiente/fallida/rechazada/aprobada, base obsoleta y referencias retenidas/eliminadas. Las cuentas para pruebas compartidas se preparan de forma controlada sin adelantar invitaciones S4 ni publicar credenciales.
* Regenerar database.ts desde el esquema migrado; probar instalación limpia y upgrade S2, RLS/GRANT/FK y contratos. No reescribir migraciones integradas ni ampliar requireDocumentActor para convertir Member en usuario global del Repository.
* Especificar y probar contratos de pertenencia/cobertura de ronda, una entrega para N findings del mismo Member/documento/ronda, archivo único reutilizable como candidata sin nueva transferencia, contribuciones de varios Members y devoluciones parciales. La base de S3-01 no implementa comandos productivos, worker ni UI de S3-02 a S3-12.

**4. Escenarios BDD (Gherkin):**

* **Escenario:** Impedir referencias cruzadas
  * **Dado** existe una corrección de Workspace A y un finding o submitter de B
  * **Cuando** se intenta persistir la relación
  * **Entonces** la base la rechaza incluso con cliente privilegiado
* **Escenario:** Mantener separados procesamiento y aprobación
  * **Dado** Admin/QA seleccionó una candidata final verificada todavía processing
  * **Cuando** se consulta la versión y su solicitud de corrección
  * **Entonces** la versión no es activa ni pending_approval antes de ready y la solicitud sí indica revisión pendiente
* **Escenario:** Avanzar con contratos
  * **Dado** Diego y Juan Pablo reciben fixtures revisados
  * **Cuando** desarrollan pipeline e interfaces
  * **Entonces** pueden comenzar sin esperar todas las migraciones, pero su aceptación exige integración real

**5. Notas Técnicas:**

* **Actualización 2026-11-08:** acuerdos del usuario sobre rondas, entregas agrupadas, consolidación y devolución selectiva incorporados; estimaciones de horas retiradas por petición del usuario. Diseño técnico S3-01 aprobado por el usuario el 2026-11-08; revisión de consumidores pendiente; no acredita implementación.
* **Implementación 2026-11-13:** base técnica S3-01 entregada en `feat/s3-01-human-review`, commits `bee77ba`–`03b7ea0`. Incluye contratos, seis migraciones aditivas, aislamiento, audit/outbox, fixtures de aislamiento HTTP/Auth y verificación de upgrade S2. La sexta migración corrige aditivamente un trigger de contribuciones de aprobación que refería columnas inexistentes. Resultados y límites: [evidencia local S3-01](../testing/2026-11-13-s3-01-foundation-verification.md). La revisión humana de Diego y Juan Pablo sigue pendiente; el ticket permanece In Progress hasta revisar contratos y consumidores.
* **Responsable:** Juan Manuel.
* Continuidad: <issue id="4a1672af-e729-4bab-bd7e-b37945ec7fcf" label="SAA-6" href="https://linear.app/saasprojectkdm/issue/SAA-6/tenant-isolation-y-rbac-base" /> y <issue id="102622a3-04bc-46bf-b85d-30853cdd6e42" label="SAA-13" href="https://linear.app/saasprojectkdm/issue/SAA-13/contratos-esquema-y-aislamiento-del-vertical-de-analisis" />; Dev 1 coordina tipos, SQL compartido, shell y CI. Cada autor mantiene reglas y pruebas de su dominio.
* Inicio: contrato mínimo y fixtures al comienzo; no convertir este ticket completo en bloqueo para todo desarrollo.
* Referencias: PRD §§8, 12, 20–22, 38–41, 46–50 y 67. Consumidores: S3-02 a S3-12.
* Los acuerdos de rondas/entregas/consolidación fueron aprobados por el usuario el 2026-11-08 y se reflejan en PRD §§12.5/39/67 y slice §6. El diseño técnico de S3-01 fue aprobado por el usuario el 2026-11-08; la revisión de consumidores sigue pendiente y esta actualización documental no acredita implementación.
* **Acuerdo de trabajo:** se puede comenzar con contratos/fixtures. Los productores de integración deben estar disponibles para aceptar el ticket; un mock no demuestra cierre real.

**Implementación local y handoff (2026-11-14):** S3-02 quedó implementado en la rama local `feat/s3-02-state-machine`; la evidencia está en [el acta de verificación S3-02](../testing/2026-11-14-s3-02-workflow-verification.md). Esta anotación no actualiza el estado de SAA-26 en Linear; la revisión humana de consumidores sigue pendiente.

* **Dev 2 — ingesta:** mantener separados `round.revision`, `expectedRevision`/revisión de autorización por item y `coverage_revision` de la candidata. Los snapshots de items confirmados son inmutables; una reasignación invalida cobertura/reservas afectadas sin completar silenciosamente la ronda. El fence de un worker debe depender de su propia reserva/lease, no de `round.revision`.
* **Dev 3 — Repository/UI:** consumir la superficie `ReviewApi`: `changeFinding`, `assignFinding`, `listAssignees`, `getFindingReview`, `getRoundDraft`, `prepareRound`, `updateRoundDraft`, `openRound` y `cancelRound`. Las mutaciones llevan revisión e idempotency key y devuelven snapshots/capacidades actuales; en `CONFLICT`, refrescar desde la lectura pública. No llamar RPC internas desde presentación.
* La aceptación integrada completa queda limitada por el cron local preexistente documentado en el acta. No se cambiaron estados de Linear ni se enviaron mensajes.

**Slice y acuerdos de coordinación:** [Sprint 3 — Human Review & Correction v0.3](<https://linear.app/saasprojectkdm/document/sprint-3-human-review-and-correction-v03-slice-y-coordinacion-45606628ecac>)

**Plan de implementación S3-01:** [Plan para revisión y elección de ejecución](<https://linear.app/saasprojectkdm/document/s3-01-plan-de-implementacion-de-la-base-de-revision-humana-46eeacce89d4>). No inicia otros tickets ni acredita ejecución.

### S3-02 — Máquina de estados, severidad y asignación transaccional de hallazgos

**Linear:** [SAA-26](https://linear.app/saasprojectkdm/issue/SAA-26/maquina-de-estados-severidad-y-asignacion-transaccional-de-hallazgos) · **Estado al 2026-11-13:** Todo

**Código del planning:** S3-02

**1. Título del Ticket:** Máquina de estados, severidad y asignación transaccional de hallazgos

**2. Historia de Usuario (Formato Connextra):**

* **Como** QA Lead
* **Quiero** confirmar, descartar, priorizar y asignar hallazgos
* **Para** decidir qué corregir conservando la propuesta original de la IA

**3. Criterios de Aceptación (DoD):**

* Implementar únicamente pending_review → confirmed|false_positive; confirmed → update_planned|resolved; update_planned → resolved; false_positive → resolved. Rechazar saltos, reaperturas de resolved y transiciones automáticas por upload, aprobación o reanálisis.
* Permitir resolución manual desde estados admitidos sin exigir corrección ni análisis exitoso. No autorizar directamente pending_review → resolved; el usuario confirma o marca false_positive primero.
* Admin/QA cambia severity_current entre High/Medium/Low; severity_original permanece inmutable. No exponer confidence, prompts ni datos internos al mutar o devolver resultados.
* Asignar/reasignar/desasignar solo findings confirmed o update_planned a un Member persistido del mismo workspace; Admin/QA puede asignar todos los findings de una ronda al mismo Member o repartirlos entre varios. Validar destinatario en servidor, listar candidatos mínimos sin exponer el directorio a Member y no conceder permisos por owner_id.
* Derivar documentos relacionados desde finding_evidence autorizada. En un hallazgo con varios documentos, la carga de corrección elige explícitamente uno de esos documentos; asignar no concede acceso al resto del Repository.
* Serializar decisiones con versión de revisión/CAS. Dos cambios basados en el mismo estado no se pisan: uno confirma y el otro recibe CONFLICT y estado refrescable. La key idempotente y el payload preservados recuperan el resultado ante respuesta perdida sin duplicar auditoría ni notificación.
* Cada cambio confirmado registra evento audit append-only atómico con actor, entidad y valores de estado/severidad/assignee permitidos. Asignación crea outbox para el destinatario correcto; no-op/reintento no produce eventos duplicados.
* Reasignación/desasignación retira acceso operativo del Member anterior en consultas y nuevas operaciones de archivo/corrección; no borra silenciosamente una solicitud ya enviada. Resolved queda de solo lectura para trabajo nuevo; conservar solo el historial propio de aprobaciones que autoriza el contrato.
* Vitest de toda la matriz de transiciones y SQL/integración de roles, cross-tenant, severidad original, candidatos inválidos, CAS, idempotencia, reasignación y rollback si falla audit/outbox. No habilitar escrituras directas en findings.
* Implementar preparación y apertura explícita de ronda por Admin/QA: seleccionar findings elegibles del documento con responsables persistidos y fijar el conjunto esperado al abrir. Findings incorporados después quedan para una siguiente ronda; no abrir automáticamente al asignar. Reasignación/resolución no completa silenciosamente la cobertura ni altera el estado humano por una entrega.

**4. Escenarios BDD (Gherkin):**

* **Escenario:** Resolver manualmente
  * **Dado** un finding está confirmed y no tiene corrección
  * **Cuando** QA selecciona Resolve
  * **Entonces** queda resolved sin activar análisis ni consumir créditos
* **Escenario:** No sobreescribir otra revisión
  * **Dado** dos reviewers leen la misma revisión del finding
  * **Cuando** uno confirma y el otro intenta false_positive con la revisión anterior
  * **Entonces** solo una decisión se guarda y la otra devuelve CONFLICT
* **Escenario:** Retirar acceso por reasignación
  * **Dado** Member A ve un finding asignado
  * **Cuando** QA lo reasigna a Member B
  * **Entonces** A pierde acceso operativo y B ve solo ese finding y los documentos relacionados

**5. Notas Técnicas:**

* **Actualización 2026-11-08:** acuerdos del usuario sobre rondas, entregas agrupadas, consolidación y devolución selectiva incorporados; estimaciones de horas retiradas por petición del usuario. Diseño técnico S3-01 aprobado por el usuario el 2026-11-08; revisión de consumidores pendiente; no acredita implementación.
* **Responsable:** Juan Manuel.
* Continuidad: <issue id="102622a3-04bc-46bf-b85d-30853cdd6e42" label="SAA-13" href="https://linear.app/saasprojectkdm/issue/SAA-13/contratos-esquema-y-aislamiento-del-vertical-de-analisis" />/<issue id="495e725f-ed28-40a5-801b-31dd091ab08d" label="SAA-20" href="https://linear.app/saasprojectkdm/issue/SAA-20/hallazgos-y-evidencia-con-deduplicacion-y-cierre-atomico" />; Juan Manuel mantiene autorización, transacciones y eventos. Juan Pablo consume desde S3-03/S3-08; Diego revalida asignación en S3-04.
* Integración para aceptar: contratos/RLS S3-01 y productores de audit/outbox; la entrega de correo se verifica en S3-11.
* Referencias: PRD §§8, 20–21, 36, 38–41, 47–50, 67 y FR-16. No agregar comentarios generales, resolución automática ni aprendizaje de falsos positivos.
* **Acuerdo de trabajo:** se puede comenzar con contratos/fixtures. Los productores de integración deben estar disponibles para aceptar el ticket; un mock no demuestra cierre real.

**Slice y acuerdos de coordinación:** [Sprint 3 — Human Review & Correction v0.3](<https://linear.app/saasprojectkdm/document/sprint-3-human-review-and-correction-v03-slice-y-coordinacion-45606628ecac>)

### S3-03 — Revisión humana de hallazgos con severidad original y controles de asignación

**Linear:** [SAA-27](https://linear.app/saasprojectkdm/issue/SAA-27/revision-humana-de-hallazgos-con-severidad-original-y-controles-de) · **Estado al 2026-11-13:** Todo

**Código del planning:** S3-03

**1. Título del Ticket:** Revisión humana de hallazgos con severidad original y controles de asignación

**2. Historia de Usuario (Formato Connextra):**

* **Como** QA Lead
* **Quiero** revisar evidencia y decidir el estado, la severidad y el responsable desde el detalle
* **Para** iniciar una corrección trazable sin perder el contexto del hallazgo

**3. Criterios de Aceptación (DoD):**

* Extender la lista y detalle S2 con acciones Confirm, False positive, Plan update y Resolve únicamente cuando el estado y rol lo permiten. Etiquetas de producto en inglés; errores/cargas/empty states accesibles y responsive.
* Mostrar AI severity y Current severity; permitir override sin modificar la original. Actualizar orden High → Medium → Low y filtros type/severity/status/assignee con paginación estable tras una mutación.
* Integrar selector de Member elegible del mismo workspace y acciones Assign, Reassign y Unassign para estados permitidos. Mostrar documentos relacionados y explicar cuál debe seleccionarse al corregir si la evidencia afecta varios. Permitir preparar el conjunto de findings del documento y sus responsables, y abrir explícitamente la ronda por la API S3-02; asignar por sí solo no la abre.
* Mantener explanation, snapshots exactos y evidencia side-by-side de S2. Admin/QA abre la versión exacta referenciada mediante autorización vigente; el nuevo active_version_id no reemplaza una referencia histórica.
* Usar acciones públicas S3-02; conservar revisión y key/payload por intento, deshabilitar envíos concurrentes y refrescar ante CONFLICT. Una respuesta HTTP perdida no se presenta como éxito ni dispara otra decisión.
* Mostrar resolución manual sin exigir versión o reanálisis; aprobación o análisis posterior no mueve el finding de estado. No ofrecer reapertura de resolved.
* Revalidar accesos en servidor. Member recibe su vista de lectura S3-08 y no puede ejecutar controles mediante URL/requests; ocultar botones por sí solo no satisface permisos.
* Pruebas de UI y Playwright: confirmar/asignar/cambiar severidad/resolver, false_positive → resolved, conflictos entre reviewers, filtros tras cambio y error de autorización; confidence no aparece en DOM/red/telemetría.
* Mostrar preparación/apertura de ronda y su conjunto fijo; permitir asignar todos los findings al mismo Member o repartirlos. Diferenciar trabajo de ronda de estado del finding y señalar que nuevas incorporaciones quedan para otra ronda.

**4. Escenarios BDD (Gherkin):**

* **Escenario:** Conservar la propuesta IA
  * **Dado** el modelo propuso High
  * **Cuando** QA cambia Current severity a Medium
  * **Entonces** ambos valores son visibles y el orden/filtro usa Medium
* **Escenario:** Mostrar solo decisiones válidas
  * **Dado** un finding está pending_review
  * **Cuando** QA abre el detalle
  * **Entonces** puede confirmar o marcar false positive y no saltar directamente a resolved
* **Escenario:** Recuperar un conflicto
  * **Dado** otro reviewer modifica la asignación
  * **Cuando** QA envía un cambio desde la vista anterior
  * **Entonces** ve aviso controlado y el estado actualizado sin perder una decisión ajena

**5. Notas Técnicas:**

* **Actualización 2026-11-08:** acuerdos del usuario sobre rondas, entregas agrupadas, consolidación y devolución selectiva incorporados; estimaciones de horas retiradas por petición del usuario. Diseño técnico S3-01 aprobado por el usuario el 2026-11-08; revisión de consumidores pendiente; no acredita implementación.
* **Responsable:** Juan Pablo Castaño Arango.
* Continuidad: <issue id="97b6febc-f538-4565-988b-7d0c45a40638" label="SAA-22" href="https://linear.app/saasprojectkdm/issue/SAA-22/lista-de-hallazgos-y-detalle-seguro-de-evidencia" />; Juan Pablo mantiene presentación de findings/evidence.
* Inicio con fixtures S3-01; aceptación integrada con S3-02 y lecturas de S3-07. Coordinar navegación común con Dev 1.
* Referencias: PRD §§20–22, 36, 56 y 67. No reconstruir el módulo de análisis ni crear Audit Log global S4.
* **Acuerdo de trabajo:** se puede comenzar con contratos/fixtures. Los productores de integración deben estar disponibles para aceptar el ticket; un mock no demuestra cierre real.

**Slice y acuerdos de coordinación:** [Sprint 3 — Human Review & Correction v0.3](<https://linear.app/saasprojectkdm/document/sprint-3-human-review-and-correction-v03-slice-y-coordinacion-45606628ecac>)

### S3-04 — Carga segura e idempotente de versiones corregidas sobre documentos asignados

**Linear:** [SAA-28](https://linear.app/saasprojectkdm/issue/SAA-28/carga-segura-e-idempotente-de-versiones-corregidas-sobre-documentos) · **Estado al 2026-11-13:** Todo

**Código del planning:** S3-04

**1. Título del Ticket:** Carga segura e idempotente de versiones corregidas sobre documentos asignados

**2. Historia de Usuario (Formato Connextra):**

* **Como** Member
* **Quiero** subir una corrección de uno de mis documentos asignados
* **Para** proponer cambios sin crear otro documento ni sustituir la versión activa

**3. Criterios de Aceptación (DoD):**

* Reservar y finalizar una entrega de archivo sobre un documento lógico existente, vinculada a una ronda abierta y a uno o varios de sus findings. Member requiere que todos los findings seleccionados estén confirmed/update_planned, asignados actualmente a él y relacionados por evidencia con el documento objetivo. Admin/QA puede cargar el consolidado del workspace por el flujo de candidata final, sin bypass de aprobación ni de la cobertura requerida de una ronda abierta.
* Input de entrega incluye roundId, findingIds no vacíos, documento objetivo, baseActiveVersionId, archivo y key; tenant, submitter y permisos se derivan de sesión/Profile. En hallazgo multidocumento la selección es explícita y no permite IDs arbitrarios.
* PDF textual, DOCX y Markdown con máximo 10 MiB por archivo; cada entrega equivale a un archivo completo que puede cubrir uno, varios o todos los findings del Member en ese documento y ronda. Reutilizar verificación real de contenido, hash, transferencia temporal y publicación inmutable S1; no confiar en MIME/firma del navegador ni hacer pasar bytes por una ruta que exceda el límite del hosting.
* Asignar vN de forma atómica y monotónica por documento; rechazo/fallo no reutiliza número. Permitir varias entregas concurrentes por ronda/documento; proteger la cobertura vigente por finding mediante lock/CAS. Sustituir la regla de una sola entrega abierta por documento por una única candidata final vigente por ronda. Al reenviar, conservar procedencia y no sobrescribir archivos confirmados.
* Persistir procedencia y versión base; no cambiar active_version_id, severidad, finding ni créditos. La idempotency key recupera la misma reserva/versión tras doble clic o respuesta perdida y rechaza un payload distinto con la misma key.
* Reautorizar reserva, reanudación, finalización y retry. Una reasignación durante transferencia impide publicar/continuar con el permiso antiguo; limpiar solo el intento temporal abandonado, sin borrar el original canónico ni el documento vigente.
* Coordinar Storage/PostgreSQL con compensación recuperable S1: ninguna versión publicable apunta a bytes inexistentes y ningún fallo parcial reemplaza el original activo. La confirmación cuenta como entrega únicamente tras verificación de bytes y permisos; no encola preprocessing individual. El worker recibe solo la candidata final confirmada, seleccionada cuando la ronda está completa.
* Devueltos findings seleccionados por Admin/QA con motivo, permitir reenviarlos individualmente o agrupados con nueva reserva/key y enlace a la entrega anterior; conservar la cobertura vigente de los findings no devueltos. Para una base activa que cambió devolver CONFLICT y exigir revisar la nueva activa; no rebasar silenciosamente.
* Pruebas reales de Auth/Storage/SQL y unidad: todos los formatos, contenido falso, 10 MiB/límite excedido, concurrencia/respuesta perdida, rol/tenant/target inválido, reasignación y compensación. Registrar audit mínimo de envío sin contenido ni URLs.
* Evitar que una transferencia abandonada bloquee el finding o la cobertura de la ronda: una reserva sin envío confirmado expira inicialmente a las 24 h desde su creación; reasignación, desasignación o resolved la invalida de inmediato. Reserva/finalización/recovery revalida y libera la reserva/cobertura afectada bajo lock sin cancelar entregas ajenas; recuperación programada limpia solo intentos temporales y deja trazabilidad mínima/número no reutilizable. No confundir este plazo con el lease técnico de verificación S1.
* Probar un Member con todos los findings, entregas de uno/dos/tres/todos, dos Members en paralelo, cobertura incompleta, finding ajeno incluido en un lote, devolución parcial y respuesta perdida. Un mismo archivo no puede cubrir findings de otro documento, ronda o Member.

**4. Escenarios BDD (Gherkin):**

* **Escenario:** Corregir el documento existente
  * **Dado** Member tiene un finding asignado que afecta A y B
  * **Cuando** elige B y sube una corrección válida
  * **Entonces** se crea vN de B y A y la activa de B siguen intactos
* **Escenario:** Recuperar la reserva
  * **Dado** la respuesta se pierde tras crear v2
  * **Cuando** Member reintenta con key y archivo originales
  * **Entonces** recupera v2 y no crea v3
* **Escenario:** Reenviar tras rechazo
  * **Dado** v2 fue rechazada y v1 sigue activa
  * **Cuando** Member envía otra propuesta autorizada
  * **Entonces** se crea v3 y se conserva el número y motivo de v2

**5. Notas Técnicas:**

* **Actualización 2026-11-08:** acuerdos del usuario sobre rondas, entregas agrupadas, consolidación y devolución selectiva incorporados; estimaciones de horas retiradas por petición del usuario. Diseño técnico S3-01 aprobado por el usuario el 2026-11-08; revisión de consumidores pendiente; no acredita implementación.
* **Responsable:** Diego Alejandro Tolosa Sanchez.
* Continuidad: <issue id="7564b73e-7281-4ebd-9d52-715c670083d0" label="SAA-7" href="https://linear.app/saasprojectkdm/issue/SAA-7/upload-seguro-de-documentos-y-creacion-de-version-v1" />; Diego mantiene upload, intentos y Storage. No duplicar el pipeline seguro S1 ni habilitar Member para crear documentos nuevos.
* Inicio con fixtures/contrato S3-01; integración con rondas/asignación S3-02 y lecturas S3-07; la candidata elegida mediante S3-06 es la entrada procesable de S3-05 y las entregas se presentan en S3-08.
* Referencias: PRD §§8, 10, 12–14, 38–39, 46–50 y 67. Dev 1 coordina migraciones/tipos; cambios de clientes técnicos/config son compartidos.
* **Acuerdo de trabajo:** se puede comenzar con contratos/fixtures. Los productores de integración deben estar disponibles para aceptar el ticket; un mock no demuestra cierre real.

**Slice y acuerdos de coordinación:** [Sprint 3 — Human Review & Correction v0.3](<https://linear.app/saasprojectkdm/document/sprint-3-human-review-and-correction-v03-slice-y-coordinacion-45606628ecac>)

### S3-05 — Preprocesamiento durable de correcciones sin activación automática

**Linear:** [SAA-29](https://linear.app/saasprojectkdm/issue/SAA-29/preprocesamiento-durable-de-correcciones-sin-activacion-automatica) · **Estado al 2026-11-13:** Todo

**Código del planning:** S3-05

**1. Título del Ticket:** Preprocesamiento durable de correcciones sin activación automática

**2. Historia de Usuario (Formato Connextra):**

* **Como** Member
* **Quiero** que mi corrección se procese y quede lista para revisión
* **Para** conservar el documento vigente hasta que Admin o QA apruebe el cambio

**3. Criterios de Aceptación (DoD):**

* Extender jobs/claim/worker/finish_processing S1, hoy limitados a version_number=1 y activación automática, para distinguir ingesta inicial de corrección mediante procedencia persistida. Solo la candidata final confirmada, elegida por Admin/QA con cobertura completa y vigente de la ronda, genera trabajo durable sin depender de una sesión o pestaña. Las entregas intermedias verificadas esperan sin parsing/chunking/embeddings.
* Reutilizar parsing, chunking y embeddings reales de los tres formatos, privacidad y tamaño. No llamar LLM de análisis ni reservar/consumir créditos por cargar, procesar o reintentar.
* Al terminar la candidata final, persistir todos los chunks/vectores y ready + pending_approval de forma atómica, conservando active_version_id anterior. Mientras no sea ready, version_status permanece NULL y la solicitud indica revisión pendiente.
* Una falla deja processing_failed, sin activación ni chunks parciales visibles; retry reautoriza y reutiliza misma versión/original. Si se opta por una nueva propuesta tras fallo terminal, invalidar la anterior para que un retry tardío no produzca dos solicitudes abiertas.
* Conservar claim atómico, lease/fencing, intento inicial + hasta 2 retries y recovery de jobs perdidos/vencidos. Worker obsoleto no finaliza ni cambia una decisión de rechazo/aprobación.
* La finalización no activa ni resuelve findings, no altera análisis históricos y no vuelve a asignar una corrección tras perderse el permiso. Una entrega ya enviada conserva procedencia para consolidación/decisión de Admin/QA, pero no se procesa individualmente; su submitter no obtiene acceso operativo por eso.
* Emitir estado de corrección/publicación para My Assignments y cola de aprobación sin tratar ready como approved. Mantener v1 → active S1 como regresión obligatoria.
* Pruebas unitarias/SQL/integración del worker real: v1, v2 pending, fallo/retry, crash/reclaim, fencing, propuesta invalidada, rollback de chunks y cero operaciones de crédito.
* Distinguir reserva sin envío de propuesta enviada: reasignación o resolved invalida la primera; una entrega con upload confirmado sigue disponible para Admin/QA; solo una candidata final con cobertura vigente es procesable/revisable, sin devolver al Member acceso operativo. La revisión posterior no reabre ni resuelve el finding.
* La selección del archivo único reutiliza los bytes ya confirmados sin pedir otra transferencia y debe encolar una sola vez. Si hay varios archivos, esperar al consolidado de Admin/QA; completar cobertura por sí solo no inicia jobs. Probar que ni uploads parciales ni reservas ni candidatos obsoletos sortean esta barrera.
* Un fallo terminal deja la ronda en candidate_failed y la versión en processing_failed/version_status NULL. Admin/QA puede reintentar la misma candidata o invalidarla para devolver findings; la invalidación cambia revisión/fence y bloquea todo retry tardío. Nunca marcar rejected una versión no ready.

**4. Escenarios BDD (Gherkin):**

* **Escenario:** Esperar aprobación
  * **Dado** v1 está activa y v2 es una corrección verificada
  * **Cuando** el worker finaliza v2
  * **Entonces** v2 queda ready/pending_approval y el puntero continúa en v1
* **Escenario:** No publicar salida parcial
  * **Dado** la persistencia de un chunk falla
  * **Cuando** el job finaliza su intento
  * **Entonces** no hay propuesta ready ni activación parcial
* **Escenario:** Rechazar worker obsoleto
  * **Dado** un lease expiró y otro worker recuperó el job
  * **Cuando** el worker anterior intenta terminar
  * **Entonces** su fencing es rechazado y no sobrescribe el resultado vigente

**5. Notas Técnicas:**

* **Actualización 2026-11-08:** acuerdos del usuario sobre rondas, entregas agrupadas, consolidación y devolución selectiva incorporados; estimaciones de horas retiradas por petición del usuario. Diseño técnico S3-01 aprobado por el usuario el 2026-11-08; revisión de consumidores pendiente; no acredita implementación.
* **Responsable:** Diego Alejandro Tolosa Sanchez.
* Continuidad: <issue id="5039ab2a-c111-4798-9614-9efd022dd70a" label="SAA-8" href="https://linear.app/saasprojectkdm/issue/SAA-8/procesamiento-e-indexacion-automatica-de-documentos" /> y ADR-002 de ingesta durable; Diego mantiene runtime y recuperación.
* Inicio independiente sobre fixtures S3-01; aceptación con upload S3-04, SQL real y worker de ingesta. No sustituir embeddings reales por mocks para certificar pipeline.
* Referencias: PRD §§12–15, 38–39, 51–53 y 67. Proveedor de versiones revisables para S3-06/S3-09.
* **Acuerdo de trabajo:** se puede comenzar con contratos/fixtures. Los productores de integración deben estar disponibles para aceptar el ticket; un mock no demuestra cierre real.

**Slice y acuerdos de coordinación:** [Sprint 3 — Human Review & Correction v0.3](<https://linear.app/saasprojectkdm/document/sprint-3-human-review-and-correction-v03-slice-y-coordinacion-45606628ecac>)

### S3-06 — Aprobación y rechazo con cambio atómico de versión activa

**Linear:** [SAA-30](https://linear.app/saasprojectkdm/issue/SAA-30/aprobacion-y-rechazo-con-cambio-atomico-de-version-activa) · **Estado al 2026-11-13:** Todo

**Código del planning:** S3-06

**1. Título del Ticket:** Aprobación y rechazo con cambio atómico de versión activa

**2. Historia de Usuario (Formato Connextra):**

* **Como** QA Lead
* **Quiero** aprobar o rechazar una corrección procesada
* **Para** controlar qué versión se considera vigente sin perder trazabilidad

**3. Criterios de Aceptación (DoD):**

* Admin/QA del mismo workspace revisa una candidata final ready/pending_approval vinculada a la ronda y sus contribuciones. Member/anon/otro tenant no puede decidir mediante acciones, RPC o escritura directa. La aprobación/rechazo se apoya en procedencia y versión base persistidas.
* Devolver correcciones exige seleccionar findings de la ronda y motivo no vacío tras trim; guardar el motivo privado por alcance autorizado y mostrarlo solo a sus responsables vigentes y Admin/QA. Usar límite inicial de 2.000 caracteres y texto seguro, sin copiar el motivo a logs, Sentry, email o metadata audit.
* Si existe candidata ready/pending_approval, el rechazo la deja rejected e inmutable y registra decisión; conserva número, original, activa y puntero sin consumir créditos. La devolución invalida solo la cobertura de los findings seleccionados, conserva las demás entregas y vuelve a esperar sus reenvíos. Una devolución durante consolidación se registra en la ronda sin inventar una versión ready/rejected; la siguiente candidata registra un nuevo intento.
* Aprobación bloquea el documento y valida que baseActiveVersionId continúa vigente. En una transacción, nueva versión → active/pending_reanalysis, anterior → historical si se retiene o inaccesible + trabajo durable S3-10 si se elimina; actualizar active_version_id y registrar decisión/audit/outbox.
* Exigir elección explícita retain/delete de la anterior; no eliminar por defecto. La rama delete solo se acepta con limpieza S3-10 integrada y guardia de análisis; no dejar un botón que solo marque historical o un borrado diferido sin ejecución.
* Dos aprobaciones o approve/reject concurrentes no producen dos activas ni decisiones perdidas. Revisión/CAS y key/payload estables recuperan respuesta perdida con un único efecto; base obsoleta o decisión incompatible devuelve CONFLICT.
* La aprobación no resuelve automáticamente findings, no cambia severity ni estado de análisis anteriores y no inicia jobs/reservas. Una histórica es solo lectura y no puede reactivarse.
* Si existe análisis queued/processing que referencia la versión anterior, bloquear únicamente la decisión delete con CONFLICT antes de mutar; permitir retain sin cambiar el scope ni la liquidación del run en curso. La cancelación por eliminación global sigue en S5.
* Pruebas unitarias/SQL e integración: motivo vacío/límite, rol/tenant, procesando/fallida, rollback a mitad de switch, doble decisión/respuesta perdida, base obsoleta, retain/delete, análisis activo y pending_reanalysis.
* Si el finding originador se resolvió o reasignó después del envío confirmado, la propuesta conserva revisión Admin/QA siempre que su versión base siga vigente. La decisión no cambia el estado del finding. En delete, registro mínimo propio de aprobación de la nueva versión y su notificación sobreviven con referencia a la corrección nueva, desacoplados del finding/evidencia borrados.
* Implementar consolidación por Admin/QA después de completar las entregas requeridas: seleccionar directamente una entrega que por sí sola cubre toda la ronda, o cargar un archivo final que reúne sus cambios. Persistir cobertura y contribuciones exactas, versión base, revisión e idempotencia; elegir candidato no aprueba ni activa. Solo el archivo final entra al worker S3-05. No automatizar fusión de PDF/DOCX/Markdown.
* Conservar propuesta administrativa Admin/QA sin asignación mediante modo explícito sin findings y sin otra ronda abierta. Rechazo exige motivo privado sin items ficticios y devuelve el trabajo a consolidación; un intento failed se invalida manteniendo version_status NULL. En rondas Member, devolver desde candidate_failed invalida candidata/retry y retira solo cobertura seleccionada, sin descartar las demás entregas.

**4. Escenarios BDD (Gherkin):**

* **Escenario:** Aprobar conservando
  * **Dado** v1 está activa y v2 ready/pending_approval
  * **Cuando** QA aprueba eligiendo Retain previous version
  * **Entonces** v2 queda active/pending_reanalysis, v1 historical y el puntero cambia en una transacción
* **Escenario:** Exigir motivo
  * **Dado** una propuesta espera revisión
  * **Cuando** QA rechaza con espacios como motivo
  * **Entonces** recibe INVALID_INPUT y no se registra decisión
* **Escenario:** No cambiar una base obsoleta
  * **Dado** otra corrección ya cambió la activa
  * **Cuando** QA intenta aprobar desde una pantalla antigua
  * **Entonces** recibe CONFLICT sin sobreescribir la activa

**5. Notas Técnicas:**

* **Actualización 2026-11-08:** acuerdos del usuario sobre rondas, entregas agrupadas, consolidación y devolución selectiva incorporados; estimaciones de horas retiradas por petición del usuario. Diseño técnico S3-01 aprobado por el usuario el 2026-11-08; revisión de consumidores pendiente; no acredita implementación.
* **Responsable:** Diego Alejandro Tolosa Sanchez.
* Continuidad: <issue id="5039ab2a-c111-4798-9614-9efd022dd70a" label="SAA-8" href="https://linear.app/saasprojectkdm/issue/SAA-8/procesamiento-e-indexacion-automatica-de-documentos" /> y mutaciones versionadas de ingesta; Diego mantiene invariantes de documento/versión. Dev 1 revisa SQL de audit/outbox y tipos.
* Integración: S3-01/S3-04/S3-05, rama delete S3-10 y consumidores S3-09/S3-11. Retain puede integrarse antes, pero el ticket no se acepta completo con delete pendiente.
* Referencias: PRD §§12.2–12.5, 21, 25, 38–41, 46–48 y 67. Resolución manual del hallazgo pertenece a S3-02.
* **Acuerdo de trabajo:** se puede comenzar con contratos/fixtures. Los productores de integración deben estar disponibles para aceptar el ticket; un mock no demuestra cierre real.

**Slice y acuerdos de coordinación:** [Sprint 3 — Human Review & Correction v0.3](<https://linear.app/saasprojectkdm/document/sprint-3-human-review-and-correction-v03-slice-y-coordinacion-45606628ecac>)

### S3-07 — Lecturas de asignaciones y originales con acceso mínimo de Member

**Linear:** [SAA-31](https://linear.app/saasprojectkdm/issue/SAA-31/lecturas-de-asignaciones-y-originales-con-acceso-minimo-de-member) · **Estado al 2026-11-13:** Todo

**Código del planning:** S3-07

**1. Título del Ticket:** Lecturas de asignaciones y originales con acceso mínimo de Member

**2. Historia de Usuario (Formato Connextra):**

* **Como** Member
* **Quiero** consultar únicamente mi trabajo y los documentos autorizados
* **Para** revisar evidencia sin acceder al repositorio privado completo

**3. Criterios de Aceptación (DoD):**

* Crear consultas/proyecciones paginadas de asignaciones vigentes y detalle desde sesión/RLS: finding, type, severidades públicas, estado, evidencia exacta, documentos activos relacionados y entregas propias autorizadas, su cobertura y estado de ronda/candidata sin revelar findings ni entregas ajenas. Confianza interna, vectores, rutas, ledger y metadatos privados de otros análisis quedan fuera del DTO.
* Definir permiso por asignación persistida del finding, nunca por Owner, documentId enviado o metadata. Conceder acceso de documento solo a la activa de los documentos presentes en finding_evidence del finding asignado; no conceder findings ajenos por compartir documento.
* El snapshot de evidencia original sigue visible dentro del finding autorizado aunque su versión haya pasado a historical; mostrar referencia histórica exacta sin sustituir texto por la activa. Member no obtiene por ello el original histórico ni navegación por todas las versiones.
* Autorizar apertura de activa relacionada y de corrección propia mientras exista permiso operativo según contrato. Admin/QA abre versiones de su workspace; Member no abre originales históricos globales. Resolver ruta desde versión autorizada y emitir URL de 300 segundos sin registrarla/persistirla.
* Revisar RLS/GRANT/Storage y las proyecciones S2: acceso a evidencia de un finding no debe requerir conceder al Member el análisis completo, chunks completos o todos sus findings. Evitar recursión de policies y filtraciones por joins, conteos, búsqueda o candidatos de asignación.
* Reasignar/desasignar o cerrar trabajo revoca consultas y nuevas URLs/operaciones del anterior. Documentar el límite de una URL ya emitida, válida hasta su expiración de 300 segundos; no prometer revocación instantánea de un token firmado existente.
* Consultar historial propio aprobado con metadata mínima persistida de submitter/asignación/decisión, incluso tras reasignación. Este historial no concede evidencia/originales de trabajo actual ajeno ni versiones históricas completas y respeta purga de S3-10.
* Pruebas SQL y HTTP Auth/REST/Storage reales: dos tenants, dos Members, Owner sin asignación, mismo documento/distinto finding, paths/versionId conocidos, uniones/filtros, acceso retirado, original histórico y llamadas directas. Renderizar contenido como texto seguro.
* La transacción delete invalida también las lecturas de findings y snapshots dependientes desde el switch; no esperar al worker para ocultarlos. El historial mínimo propio de aprobación de la nueva versión sobrevive sin contenido ni enlace descargable a la versión borrada; proyecciones S2 deben respetar esta invalidación.
* El historial propio aprobado identifica la contribución del Member a la ronda aunque el archivo final lo haya subido Admin/QA. Conservar solo metadata mínima autorizada; pertenecer a una ronda no concede acceso a findings/entregas de compañeros, candidatos consolidados o históricos globales.

**4. Escenarios BDD (Gherkin):**

* **Escenario:** Evitar acceso transitivo
  * **Dado** Member tiene F1 de un documento que también aparece en F2 ajeno
  * **Cuando** consulta F2 directamente
  * **Entonces** no recibe F2 ni su evidencia aunque pueda abrir la activa del documento
* **Escenario:** Separar evidencia e histórico
  * **Dado** la evidencia autorizada apunta a v1 y la activa ahora es v2
  * **Cuando** Member abre su asignación
  * **Entonces** ve snapshot exacto de v1 y puede abrir v2, pero no descargar el original histórico v1
* **Escenario:** Conservar solo historial propio
  * **Dado** Member envió una corrección aprobada y luego se reasigna el finding
  * **Cuando** consulta su historial
  * **Entonces** ve su registro aprobado mínimo sin recuperar acceso al trabajo de otra persona

**5. Notas Técnicas:**

* **Actualización 2026-11-08:** acuerdos del usuario sobre rondas, entregas agrupadas, consolidación y devolución selectiva incorporados; estimaciones de horas retiradas por petición del usuario. Diseño técnico S3-01 aprobado por el usuario el 2026-11-08; revisión de consumidores pendiente; no acredita implementación.
* **Responsable:** Juan Pablo Castaño Arango.
* Continuidad: <issue id="5009345d-3a57-4163-a044-dae8b286a861" label="SAA-9" href="https://linear.app/saasprojectkdm/issue/SAA-9/repository-privado-con-acceso-seguro-a-archivos" />/<issue id="97b6febc-f538-4565-988b-7d0c45a40638" label="SAA-22" href="https://linear.app/saasprojectkdm/issue/SAA-22/lista-de-hallazgos-y-detalle-seguro-de-evidencia" />; Juan Pablo mantiene lecturas, DTO y apertura autorizada. Dev 1 coordina policies/helpers y revisa que no se amplíe el acceso global de identity.
* Inicio con fixtures; aceptación integrada con S3-01/S3-02/S3-04/S3-06 y Storage real. Consumidores: S3-08/S3-09.
* Referencias: PRD §§8.3, 12.4, 22, 38, 46–48 y 67. No cambiar requireDocumentActor para permitir Repository global a Member.
* **Acuerdo de trabajo:** se puede comenzar con contratos/fixtures. Los productores de integración deben estar disponibles para aceptar el ticket; un mock no demuestra cierre real.

**Slice y acuerdos de coordinación:** [Sprint 3 — Human Review & Correction v0.3](<https://linear.app/saasprojectkdm/document/sprint-3-human-review-and-correction-v03-slice-y-coordinacion-45606628ecac>)

### S3-08 — My Assignments con envío, seguimiento y reenvío de correcciones

**Linear:** [SAA-32](https://linear.app/saasprojectkdm/issue/SAA-32/my-assignments-con-envio-seguimiento-y-reenvio-de-correcciones) · **Estado al 2026-11-13:** Todo

**Código del planning:** S3-08

**1. Título del Ticket:** My Assignments con envío, seguimiento y reenvío de correcciones

**2. Historia de Usuario (Formato Connextra):**

* **Como** Member
* **Quiero** revisar mis asignaciones y enviar correcciones desde una vista propia
* **Para** completar mi trabajo y conocer la decisión del reviewer

**3. Criterios de Aceptación (DoD):**

* Implementar My Assignments como entrada principal del Member con navegación privada apropiada; sin dashboard global, Repository, Run Analysis ni ledger detallado. Lista con paginación, estados, documento relacionado, empty/loading/error y filtros mínimos por trabajo/estado.
* Detalle de asignación muestra severidad actual, explicación, evidencia side-by-side y documentos activos autorizados. No incluir controles de cambio de severity/status/assignee ni enlaces globales que divulguen otros datos.
* Seleccionar explícitamente documento objetivo si la evidencia incluye varios; seleccionar uno, varios o todos sus findings elegibles de la misma ronda/documento y enviar un archivo válido al flujo S3-04 usando roundId/findingIds/documento/versión base e idempotency key. Mostrar formato, máximo 10 MiB y diferencia entre upload, processing y aprobación.
* Mostrar transferencia recuperable, entrega recibida/esperando las restantes, consolidación, Processing, Processing failed, Pending approval, devolución de sus findings y Approved a partir de estado persistido, con refresco acotado. Reload/logout no crea otra versión ni implica que processing/ready equivalga a aprobación.
* El retry técnico corresponde a la candidata final y lo solicita Admin/QA por S3-05/S3-06; Member reanuda sus transferencias o reenvía sus findings devueltos mediante S3-04. Resubmit crea nueva entrega inmutable y preserva los findings no devueltos. Base obsoleta, cobertura modificada o permiso retirado producen CONFLICT/error controlado y refresco.
* Mostrar motivo de rechazo solo a personas autorizadas dentro de la aplicación. Archivos y motivos son texto no confiable y no se copian a telemetría, email, HTML ejecutable ni parámetros públicos.
* Incluir historial de aprobaciones propias S3-07 de solo lectura sin abrir originales históricos globales. Ante reasignación o resolución retirar acciones y datos operativos al refrescar; no mostrar como exitosa una operación denegada.
* Pruebas UI y Playwright con Member real: entrada propia, evidencia, documento múltiple, upload/recuperación/fallo/retry/rechazo/reenvío/aprobación/historial y URL directa no autorizada. Preservar experiencia Admin/QA.
* Una reserva de transferencia expirada o invalidada muestra estado recuperable: refrescar permisos/base y, si aún existe asignación, crear otro intento/versionado; nunca finalizar la reserva vieja. Si QA resuelve el finding tras un envío confirmado, retirar operaciones Member y permitir que QA revise esa propuesta desde su cola.
* Un Member puede encargarse de todos los findings de la ronda y entregarlos de uno en uno o en conjuntos. El avance se calcula por cobertura vigente de findings, no por número de archivos ni por cambiar findings a resolved; no mostrar contenido/identidad del trabajo ajeno.

**4. Escenarios BDD (Gherkin):**

* **Escenario:** Trabajar sin repositorio global
  * **Dado** Member inicia sesión con un finding asignado
  * **Cuando** abre la aplicación
  * **Entonces** llega a My Assignments y consulta solo su trabajo
* **Escenario:** Reenviar la propuesta
  * **Dado** QA devolvió uno de los findings de una entrega agrupada con un motivo
  * **Cuando** Member consulta el motivo y envía otro archivo
  * **Entonces** crea una nueva entrega para lo devuelto y conserva el historial y la cobertura de los findings no devueltos
* **Escenario:** Recuperar tras cerrar sesión
  * **Dado** una corrección se sigue procesando
  * **Cuando** Member vuelve a entrar
  * **Entonces** recupera su estado persistido sin duplicar versión

**5. Notas Técnicas:**

* **Actualización 2026-11-08:** acuerdos del usuario sobre rondas, entregas agrupadas, consolidación y devolución selectiva incorporados; estimaciones de horas retiradas por petición del usuario. Diseño técnico S3-01 aprobado por el usuario el 2026-11-08; revisión de consumidores pendiente; no acredita implementación.
* **Responsable:** Juan Pablo Castaño Arango.
* Continuidad: Juan Pablo mantiene rutas/componentes de trabajo; coordinar shell con Dev 1 y UI/contrato de transferencia con Diego.
* Inicio con fixtures S3-01; integración S3-04/S3-05/S3-06/S3-07. El flujo no se acepta con upload o decisiones simuladas.
* Referencias: PRD §§8.3, 12, 38–39, 46–48, 56 y 67. Saldo autorizado S2 puede conservarse; compra de créditos e invitaciones siguen en S4.
* **Acuerdo de trabajo:** se puede comenzar con contratos/fixtures. Los productores de integración deben estar disponibles para aceptar el ticket; un mock no demuestra cierre real.

**Slice y acuerdos de coordinación:** [Sprint 3 — Human Review & Correction v0.3](<https://linear.app/saasprojectkdm/document/sprint-3-human-review-and-correction-v03-slice-y-coordinacion-45606628ecac>)

### S3-09 — Cola de aprobación, versiones históricas y reanálisis manual

**Linear:** [SAA-33](https://linear.app/saasprojectkdm/issue/SAA-33/cola-de-aprobacion-versiones-historicas-y-reanalisis-manual) · **Estado al 2026-11-13:** Todo

**Código del planning:** S3-09

**1. Título del Ticket:** Cola de aprobación, versiones históricas y reanálisis manual

**2. Historia de Usuario (Formato Connextra):**

* **Como** QA Lead
* **Quiero** revisar correcciones pendientes y abrir el reanálisis de la versión aprobada
* **Para** cerrar el ciclo de remediación con control explícito del documento y de los créditos

**3. Criterios de Aceptación (DoD):**

* Crear cola paginada Admin/QA de rondas/candidatas del workspace con documento, responsables, entregas y su cobertura, consolidador, versión/base, procesamiento y estado de revisión; incluir pendientes/fallidas/rechazadas sin depender solo de active_version_id. Sin acceder a otro tenant.
* Detalle permite inspeccionar activa/base y candidata exactas con metadata, evidencia y originales autorizados. Si base ya no es vigente mostrar conflicto; nunca comparar archivos sustituyendo silenciosamente los versionId.
* Mostrar consolidación/selección del archivo final únicamente con cobertura completa; permitir devolver findings seleccionados con motivo y conservar las entregas restantes. Mostrar Approve sobre candidata ready/pending_approval con elección explícita Retain/Delete previous version y Reject con selección de findings y motivo obligatorio. Consumir S3-06/S3-10, conservar key/revisión/payload ante respuesta perdida y mostrar decisiones persistidas con errores recuperables.
* Versiones retenidas aparecen historical/read-only para Admin/QA; rechazadas conservan número/motivo y nunca se reactivan. La rama delete no ofrece papelera, recuperación ni falso éxito de purga; la inaccesibilidad es inmediata tras decisión aceptada.
* Tras aprobar, Repository y detalle muestran la nueva active/pending_reanalysis. Carga, parsing y aprobación no inician Run ni reservan créditos y no resuelven el finding.
* CTA Run analysis preselecciona la nueva versión active/ready, permite revisar sources/comparisons y reutiliza estimación/confirmación/idempotencia S2. No ejecutar hasta consentimiento al coste; Member no obtiene esa acción.
* Revalidar estimaciones si cambió la activa, scope o chunks. Un run previo que termine después del switch no marca analyzed la nueva versión; solo un nuevo run exitoso con ella como source actualiza su estado. En Retain, conservar findings anteriores como registros de su run sin resolución/supresión automática; en Delete, retirar inmediatamente los dependientes y mostrar resultado no disponible conforme S3-10.
* Pruebas UI/E2E: approve/retain, approve/delete, rechazo/motivo, conflicto/base obsoleta, versión fallida, historical/rejected, cero cobro automático, precio confirmado y nueva selección; ocultar confidence y rutas privadas.
* Integrar el trabajo de consolidación Admin/QA con entregas y cobertura autorizadas: descargar archivos para consolidar manualmente o seleccionar sin reupload uno que cubra toda la ronda. La selección directa conserva bytes/procedencia y sigue sujeta a procesamiento y aprobación; la devolución parcial vuelve a esperar solo los findings afectados.

**4. Escenarios BDD (Gherkin):**

* **Escenario:** Esperar consentimiento al coste
  * **Dado** QA aprueba v2
  * **Cuando** abre la versión activa
  * **Entonces** ve Pending reanalysis y saldo sin cambio hasta confirmar Run analysis
* **Escenario:** Reanalizar la fuente correcta
  * **Dado** v2 es la nueva activa y v1 era la analizada
  * **Cuando** QA confirma un nuevo análisis con v2 como source
  * **Entonces** el run usa v2 y no reescribe findings ni decisiones de v1
* **Escenario:** No reactivar históricas
  * **Dado** v1 quedó historical tras aprobar v2
  * **Cuando** QA consulta su historial
  * **Entonces** puede inspeccionarla de solo lectura y no reactivarla

**5. Notas Técnicas:**

* **Actualización 2026-11-08:** acuerdos del usuario sobre rondas, entregas agrupadas, consolidación y devolución selectiva incorporados; estimaciones de horas retiradas por petición del usuario. Diseño técnico S3-01 aprobado por el usuario el 2026-11-08; revisión de consumidores pendiente; no acredita implementación.
* **Responsable:** Juan Pablo Castaño Arango.
* Continuidad: <issue id="5009345d-3a57-4163-a044-dae8b286a861" label="SAA-9" href="https://linear.app/saasprojectkdm/issue/SAA-9/repository-privado-con-acceso-seguro-a-archivos" />/<issue id="ebf9e34f-42dc-4745-b540-c3f24c4a10f6" label="SAA-21" href="https://linear.app/saasprojectkdm/issue/SAA-21/confirmacion-estados-de-analisis-creditos-y-retry-analysis" />/<issue id="97b6febc-f538-4565-988b-7d0c45a40638" label="SAA-22" href="https://linear.app/saasprojectkdm/issue/SAA-22/lista-de-hallazgos-y-detalle-seguro-de-evidencia" />; Juan Pablo integra Repository, versiones y flujo de análisis existente.
* Inicio con fixtures S3-01; aceptación integrada S3-05/S3-06/S3-07/S3-10 y APIs reales S2. No rehacer pricing ni worker IA.
* Referencias: PRD §§12, 21, 24–32, 35–39, 46, 56 y 67. Analysis History completo y Audit Log UI quedan en S4.
* **Acuerdo de trabajo:** se puede comenzar con contratos/fixtures. Los productores de integración deben estar disponibles para aceptar el ticket; un mock no demuestra cierre real.

**Slice y acuerdos de coordinación:** [Sprint 3 — Human Review & Correction v0.3](<https://linear.app/saasprojectkdm/document/sprint-3-human-review-and-correction-v03-slice-y-coordinacion-45606628ecac>)

### S3-10 — Retener o eliminar la versión reemplazada con limpieza durable acotada

**Linear:** [SAA-34](https://linear.app/saasprojectkdm/issue/SAA-34/retener-o-eliminar-la-version-reemplazada-con-limpieza-durable-acotada) · **Estado al 2026-11-13:** Todo

**Código del planning:** S3-10

**1. Título del Ticket:** Retener o eliminar la versión reemplazada con limpieza durable acotada

**2. Historia de Usuario (Formato Connextra):**

* **Como** QA Lead
* **Quiero** elegir si conservar la versión anterior al aprobar una corrección
* **Para** controlar la retención sin dejar archivos o evidencia privada accesibles tras eliminar

**3. Criterios de Aceptación (DoD):**

* Implementar ambas ramas de la elección en S3-06: retain deja historical/read-only sin reactivación; delete hace inaccesibles la versión reemplazada y todos sus findings/snapshots dependientes en la misma transacción del switch y crea un trabajo durable de limpieza del versionId exacto.
* Limitar la limpieza a versión reemplazada y derivados asociados; no eliminar el documento lógico, la nueva activa, otras versiones ni datos de otro tenant. No adelantar la UX de borrado global ni cancelación de análisis de S5.
* Resolver explícitamente las FK RESTRICT actuales desde analysis_documents/finding_evidence/document_chunks. Migración y contrato deben permitir limpiar referencias sin desactivar integridad ni reescribir historia contable; conservar solo marcadores mínimos no reconstruibles en el contexto del run y decisión.
* Política inicial del planning para evitar retener contenido borrado: eliminar snapshots/chunks/embeddings de la versión y findings completos que dependan de ella, con sus asignaciones/referencias derivadas y payloads pendientes que puedan reconstruirla. Mantener únicamente audit/estado/coste mínimos sin texto. El registro de aprobación y aviso de la nueva corrección sobrevive, desacoplado del finding eliminado y sin referencias reconstruibles a v1. Mostrar resultados no disponibles cuando corresponda; revisión conjunta de esta política con Dev 1/Dev 3 antes de implementar.
* Ejecutar cleanup con claim, fencing, recuperación y operaciones idempotentes: borrar original privado y derivados, verificar ausencia y completar. Intento inicial + 2 retries y Sentry saneado al agotar; no depender de un borrado best-effort en la petición web.
* Si cualquier análisis queued/processing referencia la versión, rechazar delete antes del switch con CONFLICT y ofrecer retain o esperar. Un lock/guard compartido con Run evita carrera entre el último chequeo y una nueva reserva; no cancelar ni liquidar créditos desde este cleanup.
* Después de aceptar delete, lecturas y nuevas firmas deniegan el versionId aunque la eliminación física esté pendiente. Documentar expiración máxima de URLs ya emitidas y no informar purga física completa hasta verificar Storage y DB; sin papelera ni recuperación.
* No ejecutar limpiezas destructivas compartidas durante este planning. En implementación, pruebas sobre fixtures locales descartables: fallo Storage/SQL, crash entre pasos, duplicado/lease vencido, FK, finding multidocumento, análisis concurrente y preservación de nueva activa/documento/ledger.
* Registrar decisión y evento mínimo de limpieza sin contenido, nombres de archivo privados, hashes ni signed URLs. No cerrar S3 con la rama delete solo dibujada o aplazada íntegramente a S5.
* Probar que, con cleanup bloqueado o en retry, las proyecciones de findings/evidence S2 ya deniegan datos de la versión retirada; los registros propios de aprobación de la nueva versión siguen visibles sin conceder acceso a la borrada.
* Incluir en el contrato de cleanup las relaciones de ronda/entregas/cobertura/devoluciones y artefactos intermedios dependientes de la versión retirada, para no bloquear FK ni conservar copias reconstruibles de lo eliminado. Preservar expresamente el archivo de la nueva activa y el historial mínimo de las contribuciones aprobadas.

**4. Escenarios BDD (Gherkin):**

* **Escenario:** Eliminar solo la anterior
  * **Dado** v2 está lista para aprobar y no hay análisis usando v1
  * **Cuando** QA aprueba Delete previous version
  * **Entonces** v2 se activa, v1 se vuelve inaccesible y el job elimina su original y derivados sin borrar el documento
* **Escenario:** Recuperar limpieza parcial
  * **Dado** Storage se eliminó y el worker cayó antes de terminar DB
  * **Cuando** el job se recupera
  * **Entonces** repite de forma idempotente y confirma ausencia sin tocar v2
* **Escenario:** No romper un análisis en curso
  * **Dado** un análisis activo usa v1
  * **Cuando** QA intenta aprobar eliminando v1
  * **Entonces** recibe CONFLICT sin switch ni nuevo cargo y puede elegir Retain

**5. Notas Técnicas:**

* **Actualización 2026-11-08:** acuerdos del usuario sobre rondas, entregas agrupadas, consolidación y devolución selectiva incorporados; estimaciones de horas retiradas por petición del usuario. Diseño técnico S3-01 aprobado por el usuario el 2026-11-08; revisión de consumidores pendiente; no acredita implementación.
* **Responsable:** Diego Alejandro Tolosa Sanchez.
* Continuidad: Diego controla archivos/versiones/worker; Dev 1 revisa referencias a análisis/ledger y coordina tipos. Juan Pablo adapta resultados no disponibles y la decisión de retención.
* Inicio: diseñar cleanup y pruebas con fixtures; integración S3-01/S3-06 y guardia de Run S2. No existe hoy un Purge Worker completo reutilizable: este trabajo sí incluye ejecución/recuperación del alcance de versión.
* Referencias: PRD §§12.4–12.5, 22, 39, 43–46, 51, 67 y 69. Decisión explícita: mínimo de limpieza de versión entra en S3 porque §67 exige delete-or-retain; purga global permanece en S5.
* **Acuerdo de trabajo:** se puede comenzar con contratos/fixtures. Los productores de integración deben estar disponibles para aceptar el ticket; un mock no demuestra cierre real.

**Slice y acuerdos de coordinación:** [Sprint 3 — Human Review & Correction v0.3](<https://linear.app/saasprojectkdm/document/sprint-3-human-review-and-correction-v03-slice-y-coordinacion-45606628ecac>)

### S3-11 — Eventos auditables y correos de asignación y decisión de correcciones

**Linear:** [SAA-35](https://linear.app/saasprojectkdm/issue/SAA-35/eventos-auditables-y-correos-de-asignacion-y-decision-de-correcciones) · **Estado al 2026-11-13:** Todo

**Código del planning:** S3-11

**1. Título del Ticket:** Eventos auditables y correos de asignación y decisión de correcciones

**2. Historia de Usuario (Formato Connextra):**

* **Como** Member
* **Quiero** recibir aviso de mis asignaciones y decisiones de revisión
* **Para** continuar la remediación aunque no mantenga la aplicación abierta

**3. Criterios de Aceptación (DoD):**

* Integrar eventos assignment/version_approved/version_rejected de las transacciones S3-02/S3-06. Asignación notifica al nuevo Member; devolución selectiva notifica solo a los responsables vigentes afectados y aprobación notifica a los contribuidores autorizados persistidos de la ronda. No reducir destinatarios al Admin/QA que subió el consolidado; no enviar avisos duplicados si un Member cubrió varios findings. Revisar autorización vigente al preparar y enviar, sin aceptar correos del navegador.
* Preservar semántica PRD §40: estos eventos no urgentes se agrupan en un digest por destinatario a las 23:00 UTC. Implementar la porción mínima del agrupador/scheduler para los tres tipos S3, adelantada explícitamente desde S4; no convertirlos en inmediatos ni añadir preferencias/timezones.
* Reutilizar transporte Resend y seguridad de <issue id="9feef49e-59ab-4d34-94cb-c9f7443d5ac6" label="SAA-23" href="https://linear.app/saasprojectkdm/issue/SAA-23/notificaciones-de-analisis-completado-o-fallido" />, extendiendo contratos hoy ligados a analysisId. Las notificaciones terminales S2 continúan inmediatas; high_finding, invitaciones y ampliación del digest general permanecen en S4.
* Unicidad por evento de negocio/tipo/destinatario y lote de digest estable; reintentar la misma mutación no duplica avisos, pero una reasignación o decisión nueva sí crea su evento. Seleccionar ventana y fijar miembros del lote para no perder/duplicar eventos al fallar a mitad de envío.
* Conservar pending/sent/failed, claim/lease, recovery y hasta 2 retries automáticos, clave idempotente de proveedor y Sentry al agotar. Documentar límites de entrega externa; no prometer exactly-once sin evidencia.
* Correos incluyen solo resumen mínimo de acción/estado y enlaces autenticados. Excluir motivo de rechazo, nombres/contenidos privados de documentos, snapshots, prompts, hashes y URLs firmadas. Eventos retirados por pérdida de autorización/purga no se envían.
* Verificar audit append-only completo para severity/state/assignment, envío de corrección y aprobación/rechazo/retención/eliminación. Cada productor escribe atómicamente; un fallo de email no revierte decisiones, activa, findings ni créditos. UI global de Audit Log queda fuera.
* Pruebas deterministas de reloj 23:00 UTC, lote vacío, corte entre días, reassignment, destinatario no autorizado, retries/crash/respuesta perdida y regresión S2. Demostrar recepción real de asignación, aprobación y rechazo en buzones controlados; un accepted del proveedor no demuestra recepción.
* Documentar configuración/readiness/cutover de scheduler y dispatcher sin valores secretos. Prueba de reloj acortada solo local, nunca cambiar la hora productiva ni enviar correos a terceros sin alcance de prueba autorizado.
* El evento de aprobación de la nueva versión se autoriza mediante la proyección mínima de decisión propia aunque Delete retire el finding originador/asignación; no descartarlo por esa sola retirada. Los eventos y referencias de la versión eliminada sí se retiran. Si ya no pertenece al workspace, no enviar.
* Auditar apertura de ronda, cobertura enviada, selección/consolidación y devoluciones selectivas además de las decisiones de versión. Destinatarios y autorización provienen de las contribuciones persistidas; motivos privados y trabajo de otros Members quedan fuera de email y audit. Mantener digest de los eventos no urgentes a las 23:00 UTC.

**4. Escenarios BDD (Gherkin):**

* **Escenario:** Agrupar trabajo no urgente
  * **Dado** Member recibe asignación y rechazo antes de las 23:00 UTC
  * **Cuando** se ejecuta el corte diario
  * **Entonces** recibe un resumen con enlaces autenticados sin el motivo privado ni evidencia
* **Escenario:** No revertir por fallo de correo
  * **Dado** la aprobación ya activó v2
  * **Cuando** el proveedor agota sus retries
  * **Entonces** el evento queda failed y la decisión y créditos permanecen iguales
* **Escenario:** Revalidar destinatario
  * **Dado** una asignación quedó pendiente de digest
  * **Cuando** QA la retira antes del envío
  * **Entonces** el Member anterior no recibe acceso ni contenido del trabajo retirado

**5. Notas Técnicas:**

* **Actualización 2026-11-08:** acuerdos del usuario sobre rondas, entregas agrupadas, consolidación y devolución selectiva incorporados; estimaciones de horas retiradas por petición del usuario. Diseño técnico S3-01 aprobado por el usuario el 2026-11-08; revisión de consumidores pendiente; no acredita implementación.
* **Responsable:** Juan Manuel.
* Continuidad: <issue id="9feef49e-59ab-4d34-94cb-c9f7443d5ac6" label="SAA-23" href="https://linear.app/saasprojectkdm/issue/SAA-23/notificaciones-de-analisis-completado-o-fallido" />; Juan Manuel mantiene notificaciones, secretos, Sentry y configuración transversal.
* Inicio con eventos/reloj/proveedor fake; aceptación con S3-01/S3-02/S3-06 y Resend real. Cada dominio entrega sus eventos audit/outbox; este ticket no absorbe sus mutaciones.
* Referencias: PRD §§40–41, 46–48, 51, 67–68. Resolver explícitamente la intersección S3/S4 mediante digest mínimo reutilizable, sin cambiar la regla de 23:00 UTC.
* **Acuerdo de trabajo:** se puede comenzar con contratos/fixtures. Los productores de integración deben estar disponibles para aceptar el ticket; un mock no demuestra cierre real.

**Slice y acuerdos de coordinación:** [Sprint 3 — Human Review & Correction v0.3](<https://linear.app/saasprojectkdm/document/sprint-3-human-review-and-correction-v03-slice-y-coordinacion-45606628ecac>)

### S3-12 — Aceptación integral y quality gates de Human Review & Correction v0.3

**Linear:** [SAA-36](https://linear.app/saasprojectkdm/issue/SAA-36/aceptacion-integral-y-quality-gates-de-human-review-and-correction-v03) · **Estado al 2026-11-13:** Todo

**Código del planning:** S3-12

**1. Título del Ticket:** Aceptación integral y quality gates de Human Review & Correction v0.3

**2. Historia de Usuario (Formato Connextra):**

* **Como** Admin
* **Quiero** demostrar el ciclo completo de revisión, corrección y aprobación con permisos reales
* **Para** entregar la tercera vertical con evidencia de seguridad e integración

**3. Criterios de Aceptación (DoD):**

* Desde el inicio preparar fixtures y recorrido E2E: Admin/QA revisa findings reales S2 → confirma/cambia severity/asigna → prepara y abre ronda con conjunto fijo → uno o varios Members consultan evidencia y activa autorizada → entregan individualmente/agrupados → se completa cobertura → QA consolida o selecciona archivo único → worker real procesa candidata → QA devuelve findings seleccionados con motivo → se reenvía solo lo devuelto → nueva consolidación/procesamiento → QA aprueba → nueva activa pending_reanalysis.
* Demostrar ambas decisiones retain/delete sobre fixtures controlados, inspección histórica Admin/QA, historial propio Member, purga física de versión y regresión de v1. No declarar completo con botones/mock, cleanup best-effort o workers no desplegados.
* Comprobar cero cargos por revisión/upload/procesamiento/aprobación y ausencia de análisis automático. Después QA confirma una estimación nueva y ejecuta reanálisis manual S2 sobre la fuente aprobada; solo ese run reserva/consume, conserva findings previos en Retain (en Delete aplica retirada/purga de los dependientes) y no resuelve automáticamente.
* Ejecutar Vitest de matriz de estados, CAS e idempotencia; SQL/HTTP reales de RLS/Storage: cross-tenant, Owner sin asignación, dos Members, mismo documento/distinto finding, histórico, URL/RPC directa, reasignación y acceso al audit/ledger/analysis denegado.
* Cubrir doble clic/respuesta perdida, carga interrumpida, lease/reclaim/fencing, fallo de parsing y retry, propuesta obsoleta, approve/reject concurrentes, switch rollback, delete vs Run y recuperación de cleanup. Cada autor aporta pruebas de su dominio.
* Verificar correos agrupados S3 y regresión de terminales S2 con proveedor real y recepción en buzón controlado. Comprobar ausencia de contenido/motivos/signed URLs/credenciales en email, logs, Sentry y artefactos.
* Incorporar suites S3 a gates existentes: lint/typecheck/unit/SQL/integración/Playwright/build donde corresponda; verificar resultados sobre SHA candidato. Juan Manuel integra raíz/CI; Juan Pablo aporta E2E y Diego worker/Storage/corpus.
* Registrar entorno, SHA, comandos y resultados separados por unit/DB/integración/E2E/runtime compartido/recepción de correo y limitaciones. La auditoría hosted del 2026-11-07 fue histórica y tenía bloqueos; revalidar readiness actual sin reabrir automáticamente S2 ni darlo por probado con Done.
* Documentar arranque/cutover/recuperación de correcciones, cleanup acotado y digest, y la preparación controlada de Members mientras invitaciones siga en S4. No seed/reset remoto, migraciones remotas ni despliegue implícito durante una verificación local.
* El ticket tiene blockedBy de S3-01 a S3-11 para el cierre, pero plan y pruebas comienzan en paralelo desde día 1. Milestone solo se acepta con recorrido completo y críticos verdes; registrar fallos reales en lugar de saltarlos o trasladar requisitos de §67.
* Cubrir específicamente reserva abandonada/24h y slot liberado, reasignación antes/después del upload confirmado, resolved con propuesta pendiente, invisibilidad inmediata de derivados durante cleanup fallido y supervivencia del historial/correo mínimo de aprobación de la nueva versión tras delete.
* Añadir E2E/SQL de ronda abierta explícitamente, findings posteriores para siguiente ronda, todos asignados a un solo Member, entregas individuales/agrupadas, varios Members, cobertura incompleta sin jobs, selección directa sin reupload, consolidación manual y devolución parcial con preservación de lo no devuelto. Verificar historial/notificación de cada contribuidor y denegación de acceso a entregas ajenas.

**4. Escenarios BDD (Gherkin):**

* **Escenario:** Completar la remediación
  * **Dado** QA tiene findings S2 y un Member controlado del workspace
  * **Cuando** recorren rechazo, reenvío, aprobación y análisis manual
  * **Entonces** se demuestra evidencia, nueva activa, coste explícito y correos sin privilegios globales para Member
* **Escenario:** Bloquear regresión de acceso
  * **Dado** una policy permite a Member leer un finding no asignado
  * **Cuando** corren las pruebas críticas del candidato
  * **Entonces** el gate falla e impide declarar aceptado el vertical
* **Escenario:** Distinguir planificación de aceptación
  * **Dado** los doce tickets están creados y el build pasa
  * **Cuando** se evalúa el cierre
  * **Entonces** no se acepta hasta ejecutar el flujo integrado con worker, Storage y correo reales

**5. Notas Técnicas:**

* **Actualización 2026-11-08:** acuerdos del usuario sobre rondas, entregas agrupadas, consolidación y devolución selectiva incorporados; estimaciones de horas retiradas por petición del usuario. Diseño técnico S3-01 aprobado por el usuario el 2026-11-08; revisión de consumidores pendiente; no acredita implementación.
* **Responsable:** Juan Manuel.
* Responsable de integración: Juan Manuel, coherente con la asignación final observada de <issue id="cc868e22-9240-4976-9ec1-c58871fc45cb" label="SAA-24" href="https://linear.app/saasprojectkdm/issue/SAA-24/aceptacion-integral-y-quality-gates-de-ai-analysis-v02" />. Juan Pablo aporta experiencia/rutas y Playwright; Diego pipeline y cleanup.
* Inicio independiente de corpus y automatización; dependencias de cierre: todos los tickets S3. Ningún bloqueo significa aplazar el diseño de pruebas al final.
* Referencias: PRD §§48, 51–56, 64, 67 y 71. No ejecutar implementación, commits/push, migraciones ni despliegues como parte de este pedido de planificación.
* **Acuerdo de trabajo:** se puede comenzar con contratos/fixtures. Los productores de integración deben estar disponibles para aceptar el ticket; un mock no demuestra cierre real.

**Slice y acuerdos de coordinación:** [Sprint 3 — Human Review & Correction v0.3](<https://linear.app/saasprojectkdm/document/sprint-3-human-review-and-correction-v03-slice-y-coordinacion-45606628ecac>)
