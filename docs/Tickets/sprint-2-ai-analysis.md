# Sprint 2 — AI Analysis v0.2 — Tickets

Fecha: 2026-10-10. Alcance: segundo vertical del [PRD, §66](../PRD/knowledge-decay-monitor-prd-final.md#66-sprint-2--ai-analysis-v02).

Este documento conserva las cinco secciones de [Sprint 1](tickets.md). El [slice y acuerdo de coordinación](../PRD/sprint-2-ai-analysis-slice.md) contiene alcance, contratos iniciales, convenciones, dependencias de integración y criterios de cierre. Los identificadores S2-xx son códigos del planning; Linear asigna sus propios SAA-xx.

Milestone creada en el [proyecto Knowledge Decay Monitor](https://linear.app/saasprojectkdm/project/knowledge-decay-monitor-de9ff4258960): **Sprint 2 — AI Analysis v0.2**. [Slice y coordinación en Linear](https://linear.app/saasprojectkdm/document/sprint-2-ai-analysis-v02-slice-y-coordinacion-88b07a921439). Los doce tickets están en Todo; SAA-24 tiene bloqueos de cierre por SAA-13 a SAA-23.

## Responsables

Distribución verificada en Linear el 2026-10-10:

| Desarrollador | Responsabilidad anterior | Continuidad en S2 |
|---|---|---|
| Juan Manuel (Dev 1) | SAA-5 Auth/Workspace; SAA-6 Tenant/RBAC; SAA-12 observabilidad/quality gates | Contratos/datos/RLS, créditos, Run transaccional, notificaciones y coordinación CI |
| Diego Alejandro Tolosa Sanchez (Dev 2) | SAA-7 Upload; SAA-8 procesamiento/embeddings | Retrieval/precio, worker, proveedores IA, resultados/evidencia |
| Juan Pablo Castaño Arango (Dev 3) | SAA-9 Repository; SAA-10 búsqueda/filtros; SAA-11 recuperación UI | Selección, Run/status/retry UI, hallazgos/evidencia y aceptación E2E |

Son cuatro tickets por persona; el número de tickets no representa igualdad de esfuerzo. La carga IA/runtime de Diego debe revisarse a diario y el equipo apoya pruebas/revisión sin duplicar ownership de archivos.

## Índice

| Código | Linear | Ticket | Responsable |
|---|---|---|---|
| S2-01 | [SAA-13](https://linear.app/saasprojectkdm/issue/SAA-13/contratos-esquema-y-aislamiento-del-vertical-de-analisis) | Contratos, esquema y aislamiento del vertical de análisis | Juan Manuel |
| S2-02 | [SAA-14](https://linear.app/saasprojectkdm/issue/SAA-14/creditos-promocionales-ledger-y-saldos-transaccionales) | Créditos promocionales, ledger y saldos transaccionales | Juan Manuel |
| S2-03 | [SAA-15](https://linear.app/saasprojectkdm/issue/SAA-15/seleccion-autorizada-de-documentos-y-alcance-de-comparacion) | Selección autorizada de documentos y alcance de comparación | Juan Pablo Castaño Arango |
| S2-04 | [SAA-16](https://linear.app/saasprojectkdm/issue/SAA-16/retrieval-semantico-acotado-y-estimacion-exacta-de-creditos) | Retrieval semántico acotado y estimación exacta de créditos | Diego Alejandro Tolosa Sanchez |
| S2-05 | [SAA-17](https://linear.app/saasprojectkdm/issue/SAA-17/run-analysis-idempotente-con-reserva-atomica-de-creditos) | Run Analysis idempotente con reserva atómica de créditos | Juan Manuel |
| S2-06 | [SAA-18](https://linear.app/saasprojectkdm/issue/SAA-18/analysis-worker-durable-leases-y-recuperacion-automatica) | Analysis Worker durable, leases y recuperación automática | Diego Alejandro Tolosa Sanchez |
| S2-07 | [SAA-19](https://linear.app/saasprojectkdm/issue/SAA-19/deteccion-ia-validada-con-cerebras-y-fallback-groq) | Detección IA validada con Cerebras y fallback Groq | Diego Alejandro Tolosa Sanchez |
| S2-08 | [SAA-20](https://linear.app/saasprojectkdm/issue/SAA-20/hallazgos-y-evidencia-con-deduplicacion-y-cierre-atomico) | Hallazgos y evidencia con deduplicación y cierre atómico | Diego Alejandro Tolosa Sanchez |
| S2-09 | [SAA-21](https://linear.app/saasprojectkdm/issue/SAA-21/confirmacion-estados-de-analisis-creditos-y-retry-analysis) | Confirmación, estados de análisis, créditos y Retry Analysis | Juan Pablo Castaño Arango |
| S2-10 | [SAA-22](https://linear.app/saasprojectkdm/issue/SAA-22/lista-de-hallazgos-y-detalle-seguro-de-evidencia) | Lista de hallazgos y detalle seguro de evidencia | Juan Pablo Castaño Arango |
| S2-11 | [SAA-23](https://linear.app/saasprojectkdm/issue/SAA-23/notificaciones-de-analisis-completado-o-fallido) | Notificaciones de análisis completado o fallido | Juan Manuel |
| S2-12 | [SAA-24](https://linear.app/saasprojectkdm/issue/SAA-24/aceptacion-integral-y-quality-gates-de-ai-analysis-v02) | Aceptación integral y quality gates de AI Analysis v0.2 | Juan Pablo Castaño Arango |

Los tickets se pueden iniciar con contratos/fixtures desde el primer día. S2-01 entrega el acuerdo mínimo al inicio; sus migraciones y controles completos avanzan junto con las demás capacidades. S2-12 se inicia desde el primer día y solo puede cerrar después de integrar todo el slice.

---

# S2-01 — Contratos, esquema y aislamiento del vertical de análisis

**1. Título del Ticket:** Contratos, esquema y aislamiento del vertical de análisis

**2. Historia de Usuario (Formato Connextra):**

* **Como** Admin
* **Quiero** que los análisis, créditos y hallazgos mantengan permisos y relaciones consistentes
* **Para** proteger la documentación mientras las nuevas capacidades se integran

**3. Criterios de Aceptación (DoD):**

* Publicar contratos mínimos de selección, estimación, Run/Retry, estado de análisis, créditos, findings/evidence y eventos terminales, revisados por Diego y Juan Pablo. Usar ActionResult<T> y errores controlados; los nombres de este slice son propuestas hasta integrar el contrato.
* Añadir migraciones para analyses, analysis_documents, credit_ledger, findings, finding_evidence y notification_events, con índices, GRANT explícitos, RLS y relaciones que impidan referencias entre tenants. Cada autor añade después las RPC/invariantes de su ticket; no reescribir migraciones compartidas.
* analysis_documents conserva documento, versión exacta y relación source/comparison; las dos relaciones pueden existir para una misma versión, pero el límite se calcula por unión de versiones.
* analyses representa tanto ejecución como historial mínimo: initiator, selección, coste fijo, reserva, estado queued/processing/completed/failed, idempotencia, configuración de retrieval/prompt/schema/model, intentos, lease, timestamps y error controlado.
* findings admite contradiction/obsolescence, severity_original y severity_current, confidence interna 0..1, explanation, pending_review inicial y assignee nulo. finding_evidence identifica documento/versión/chunk y snapshot máximo de 2.000 caracteres.
* Admin/QA leen análisis y resultados de su tenant; Member no accede a análisis, findings/evidence no asignados ni ledger detallado. Member puede consultar únicamente el saldo de su workspace mediante una proyección autorizada.
* Las mutaciones de ejecución, saldo, resultados y notificaciones quedan restringidas a operaciones autorizadas del servidor; el navegador no puede escribir esos estados directamente ni modificar tenant/rol.
* Entregar fixtures tipados y SQL locales de dos tenants, roles, análisis terminales/activos, saldo disponible/reservado y hallazgos con evidencia. Incluir scopes de 1, 20 y 21 versiones, paginación, pares repetidos y salida inválida.
* Regenerar database.ts desde la base real y comprobar coherencia con contratos; tipos generados no se editan manualmente.
* Pruebas SQL cubren lectura/mutación cross-tenant y referencias cruzadas, acceso Member/anon y permisos de RPC añadidos por el slice. Instalar y actualizar localmente sin seed/reset remoto.

**4. Escenarios BDD (Gherkin):**

* **Escenario:** Rechazar referencias cruzadas
  * **Dado** existe un análisis de Workspace A y una versión de Workspace B
  * **Cuando** se intenta asociar esa versión al análisis incluso mediante escritura privilegiada
  * **Entonces** la relación es rechazada y no se crea asociación ni evidencia cross-tenant

* **Escenario:** Aislar resultados sin pasar por la UI
  * **Dado** un Member o un Admin de Workspace B conoce un finding de Workspace A
  * **Cuando** consulta tablas/proyecciones directamente
  * **Entonces** no obtiene explicación, evidencia, confidence ni metadatos del análisis

* **Escenario:** Desarrollar con fixtures
  * **Dado** los tres desarrolladores reciben el contrato revisado
  * **Cuando** Diego desarrolla retrieval y Juan Pablo monta Run Analysis con fixtures
  * **Entonces** ambos pueden avanzar sin esperar al ledger o al proveedor real

**5. Notas Técnicas:**

* **Responsable:** Juan Manuel.
* Continuidad: SAA-5/SAA-6; ownership compartido del Día Cero. Dev 1 coordina tipos/migraciones; cada dominio redacta sus cambios y pruebas.
* Inicio independiente: se puede comenzar inmediatamente con el slice y esquema S1. Entrega inicial pequeña de contratos/fixtures; completar RLS e invariantes conforme se integran las RPC.
* Referencias: PRD §§20, 22, 27–29, 32, 47–50, 62 y 66. Consumidores: todos los tickets S2.
* No centralizar toda la lógica de análisis en este ticket ni exigir que finalice completo para que otros desarrolladores empiecen.
* **Acuerdo de trabajo:** contratos y fixtures permiten empezar en paralelo; las integraciones indicadas deben estar disponibles para aceptar el ticket. Un mock no demuestra cierre real.

---

# S2-02 — Créditos promocionales, ledger y saldos transaccionales

**1. Título del Ticket:** Créditos promocionales, ledger y saldos transaccionales

**2. Historia de Usuario (Formato Connextra):**

* **Como** Admin
* **Quiero** recibir 50 créditos promocionales y consultar un saldo consistente
* **Para** probar los análisis y conocer el coste disponible sin duplicaciones

**3. Criterios de Aceptación (DoD):**

* Cada nuevo workspace recibe exactamente una entrada Promotional de 50 créditos; la concesión es idempotente y no caduca. Integrarla al bootstrap de manera consistente.
* Proporcionar una migración de datos idempotente para los workspaces existentes de S1 que todavía no tengan concesión; no utilizar seed remoto ni conceder de nuevo a quien ya recibió la promoción.
* El ledger es append-only y soporta Promotional, Reserved, Consumed y Released con referencias al análisis y unicidad suficiente para evitar dobles efectos. Purchased queda para S4.
* Consultar available y reserved mantiene consistencia transaccional y nunca permite saldo negativo. Reserva mueve available a reserved; consumo reduce reserved sin volver a descontar available; liberación devuelve reserved a available.
* Admin y QA Lead consultan saldo y ledger de su workspace; Member solo obtiene saldo, sin detalle del ledger ni información de otros tenants.
* Entregar las operaciones de reserva/liquidación/liberación que S2-05 y S2-08 puedan ejecutar en la misma transacción que el estado del análisis; no encadenar HTTP independientes para fingir atomicidad.
* La repetición de un evento terminal no consume ni libera dos veces; un análisis no puede tener simultáneamente liquidación exitosa y liberación.
* Upload, procesamiento, estimación, consulta de resultados y correos no generan cargos de análisis.
* Pruebas de fórmula contable, grants duplicados, concurrencia, insuficiencia de saldo y liquidaciones repetidas; SQL real para la atomicidad.

**4. Escenarios BDD (Gherkin):**

* **Escenario:** Conceder promoción una vez
  * **Dado** un workspace nuevo o existente carece de Promotional
  * **Cuando** se ejecuta dos veces su concesión
  * **Entonces** se registra una sola promoción y available suma exactamente 50

* **Escenario:** Rechazar sobregiro concurrente
  * **Dado** el workspace dispone de 5 créditos
  * **Cuando** dos operaciones compiten por reservar 4 créditos cada una
  * **Entonces** solo la operación autorizada y admisible reserva y el saldo nunca es negativo

* **Escenario:** Liberar sin duplicación
  * **Dado** un análisis reservó 7 créditos y termina failed
  * **Cuando** la finalización fallida llega dos veces
  * **Entonces** se devuelven exactamente 7 créditos y queda una sola liberación

**5. Notas Técnicas:**

* **Responsable:** Juan Manuel.
* Continuidad: SAA-5/SAA-6. Dev 1 mantiene workspace y operaciones privilegiadas.
* Inicio independiente: fixtures contables y pruebas del ledger; integración usa el contrato S2-01. La UI de saldo/ledger corresponde a S2-09.
* Referencias: PRD §§31–32, 34 y 66. Consumidores: S2-05, S2-08, S2-09.
* Fuera de alcance: checkout, paquetes, pagos y acreditación Lemon Squeezy de S4.
* **Acuerdo de trabajo:** contratos y fixtures permiten empezar en paralelo; las integraciones indicadas deben estar disponibles para aceptar el ticket. Un mock no demuestra cierre real.

---

# S2-03 — Selección autorizada de documentos y alcance de comparación

**1. Título del Ticket:** Selección autorizada de documentos y alcance de comparación

**2. Historia de Usuario (Formato Connextra):**

* **Como** QA Lead
* **Quiero** seleccionar documentos fuente y documentos de comparación
* **Para** controlar exactamente qué documentación participa en el análisis

**3. Criterios de Aceptación (DoD):**

* Entregar Run Analysis con Documents to analyze y Compare against, en inglés, accesible solo a Admin/QA Lead.
* El backend de selección devuelve exclusivamente versiones active + ready de la sesión verificada; pending_reanalysis sigue siendo elegible. Excluir históricas, rejected, pending_approval, uploaded/processing y processing_failed.
* Permitir búsqueda por nombre y filtros de categoría/Owner/estado aplicables, reutilizando patrones públicos de Repository. Los contadores y opciones permanecen dentro del tenant.
* Exigir al menos una fuente. Permitir comparación vacía para ejecutar solo contradicciones internas; explicitarlo al usuario.
* Aplicar máximo de 20 versiones distintas en la unión source + comparison en UI y backend. Una versión presente en ambas listas cuenta una vez.
* Select all filtered selecciona todos los resultados autorizados del filtro, incluidas otras páginas; si excede el límite rechaza con mensaje controlado, sin truncar silenciosamente.
* Compare against entire repository solo se acepta cuando la unión de elegibles y fuentes cabe en 20; no selecciona silenciosamente una muestra del repositorio.
* Mostrar nombre, versión y pertenencia a source/comparison; cambios en selección invalidan la estimación anterior.
* El servidor revalida IDs, elegibilidad y tenant; no confía en resultados ni contadores del navegador. Mantener la lista general del Repository capaz de mostrar versiones fallidas, sin confundirla con el selector de análisis.
* Pruebas de selección/paginación, 20/21, solapamiento, scope vacío, pending_reanalysis, Member y manipulación cross-tenant.

**4. Escenarios BDD (Gherkin):**

* **Escenario:** Seleccionar todos los filtrados
  * **Dado** existen 12 versiones elegibles de una categoría en varias páginas
  * **Cuando** QA selecciona Select all filtered
  * **Entonces** las 12 se incluyen y se preservan sus IDs exactos

* **Escenario:** Impedir alcance excesivo
  * **Dado** sources y comparisons contienen 21 versiones distintas
  * **Cuando** Admin solicita estimación o Run Analysis
  * **Entonces** la operación se rechaza sin job, reserva ni llamada LLM

* **Escenario:** Analizar solo contradicciones internas
  * **Dado** una fuente active + ready contiene instrucciones incompatibles y no se seleccionan comparisons
  * **Cuando** QA confirma ese scope
  * **Entonces** la fuente sigue siendo válida para detección interna

**5. Notas Técnicas:**

* **Responsable:** Juan Pablo Castaño Arango.
* Continuidad: SAA-9/SAA-10; Juan Pablo conserva consultas, filtros y presentación del Repository.
* Inicio independiente: fixtures tipados de S2-01; contrato de estimación simulado en pruebas/desarrollo, sin bypass productivo.
* Referencias: PRD §§24–26, 35 y 66. Coordinar con S2-04 y S2-09.
* El detalle completo del Run/estado y la UI de créditos se entrega en S2-09.
* **Acuerdo de trabajo:** contratos y fixtures permiten empezar en paralelo; las integraciones indicadas deben estar disponibles para aceptar el ticket. Un mock no demuestra cierre real.

---

# S2-04 — Retrieval semántico acotado y estimación exacta de créditos

**1. Título del Ticket:** Retrieval semántico acotado y estimación exacta de créditos

**2. Historia de Usuario (Formato Connextra):**

* **Como** QA Lead
* **Quiero** ver el coste exacto antes de confirmar un alcance
* **Para** decidir el consumo de créditos con una selección reproducible

**3. Criterios de Aceptación (DoD):**

* Recuperar chunks con pgvector y el espacio gte-small existente de 384 dimensiones exclusivamente dentro de versiones seleccionadas/autorizadas; no volver a inferir embeddings para estimar.
* Por cada chunk fuente, buscar candidatos internos en su misma versión y externos solo en comparison. Excluir el mismo chunk, aplicar similarity >= 0.75 y un máximo total Top K=5 por chunk fuente entre ambas clases.
* Usar orden determinista de similitud y desempate estable por ID, canonizar A/B y eliminar pares repetidos. No incorporar versiones fuera del scope ni comparar fuentes entre sí externamente salvo que estén seleccionadas como comparison.
* Los mismos pares externos pueden evaluarse para contradicción y obsolescencia sin doble conteo; los internos se evalúan para contradicción. Mantener pares temporales en memoria, sin tablas persistentes de candidatos ni texto en logs.
* Definir chunks como número de chunks distintos de la unión source/comparison; candidate_pairs como pares únicos que superan el retrieval. Convención explícita de planificación, porque el PRD no desambigua ese conteo.
* Aplicar credits = ceil(1 + chunks*0.05 + candidate_pairs*0.20), con cálculo que evite errores de punto flotante. Caso de referencia: 10 chunks y 5 pares cuestan 3 créditos; cero pares sigue siendo un análisis válido.
* La UI recibe Estimated cost: X credits; no expone el desglose de chunks/pares, embeddings ni contenido de candidatos.
* Vincular estimación a versiones exactas, revisión de chunks, configuración y versión de tarifa. S2-05 verifica vigencia e integridad; cambios obligan a reestimar antes de confirmar.
* El worker regenera el mismo conjunto con la configuración fijada; una divergencia respecto del conteo/fingerprint estimado impide cobrar un resultado con alcance distinto.
* Pruebas de top-K, umbral, empates, autopares, duplicación A/B, aislamiento, conteo y redondeo. Separar vectores sintéticos de una prueba de relevancia con embeddings reales y corpus controlado.

**4. Escenarios BDD (Gherkin):**

* **Escenario:** Calcular coste conocido
  * **Dado** el scope tiene 10 chunks distintos y retrieval obtiene 5 pares únicos
  * **Cuando** se calcula la estimación
  * **Entonces** se devuelve Estimated cost: 3 credits sin reservar saldo

* **Escenario:** Respetar el scope incluso con un vecino mejor
  * **Dado** un chunk de Workspace B tiene mayor similitud que los del scope de A
  * **Cuando** se ejecuta retrieval para A
  * **Entonces** solo se consideran chunks autorizados del scope y Top K no excede 5

* **Escenario:** Mantener coste reproducible
  * **Dado** se estima un scope con similitudes empatadas
  * **Cuando** el worker recalcula candidatos con la misma configuración
  * **Entonces** obtiene los mismos pares únicos y el mismo conteo

**5. Notas Técnicas:**

* **Responsable:** Diego Alejandro Tolosa Sanchez.
* Continuidad: SAA-8; Diego mantiene embeddings/chunks y añade retrieval.
* Inicio independiente: corpus y adaptador de chunks de prueba bajo contrato S2-01; no esperar a la UI o al ledger.
* Referencias: PRD §§15, 18–19, 25–26, 31.4 y 66. Productor para S2-05 y S2-06.
* El umbral, Top K y fórmula se mantienen como valores iniciales del PRD; calibraciones futuras requieren evidencia y actualización explícita del acuerdo.
* **Acuerdo de trabajo:** contratos y fixtures permiten empezar en paralelo; las integraciones indicadas deben estar disponibles para aceptar el ticket. Un mock no demuestra cierre real.

---

# S2-05 — Run Analysis idempotente con reserva atómica de créditos

**1. Título del Ticket:** Run Analysis idempotente con reserva atómica de créditos

**2. Historia de Usuario (Formato Connextra):**

* **Como** QA Lead
* **Quiero** confirmar un análisis una sola vez por el coste mostrado
* **Para** iniciar el trabajo sin duplicar jobs ni cargos

**3. Criterios de Aceptación (DoD):**

* Implementar comando del servidor validado con Zod y autorización Admin/QA desde sesión/Profile; tenant, rol y coste no se aceptan como autoridad del navegador.
* Consumir una estimación íntegra/vigente del mismo actor/workspace y scope. Revalidar versiones active + ready, límite de 20, configuración y conteo; estimación alterada u obsoleta exige reestimar.
* Crear analyses queued, analysis_documents exactos y Reserved en una única transacción; reserva fallida deja cero análisis/asociaciones.
* Imponer un único análisis queued/processing por workspace mediante control SQL resistente a concurrencia; otro workspace puede continuar de manera independiente.
* Idempotency key scoped al workspace/actor devuelve el mismo análisis ante doble clic/reintento. Reutilizarla con payload distinto produce CONFLICT; no duplica reserva.
* El coste fijo persistido coincide con el que el usuario confirmó y con la reserva. Saldo insuficiente devuelve error controlado sin invocar al worker.
* Invocar el worker después del commit como mejor esfuerzo; job queued queda recuperable si la invocación falla o se pierde la respuesta. La Server Action no realiza el análisis pesado.
* Entregar Retry Analysis de un failed como una ejecución nueva enlazada al intento anterior: reautorizar y reestimar, confirmar coste, nueva key y nueva reserva. Una repetición del retry devuelve la misma ejecución nueva.
* Retries automáticos del mismo job conservan análisis, coste y reserva; Retry manual no vuelve a usar una reserva ya liberada ni sobrescribe el historial failed.
* Pruebas SQL/integración de dobles clics, respuesta perdida, payload diferente, carreras de reserva, un activo por tenant, saldo insuficiente, scope cambiado y permisos.

**4. Escenarios BDD (Gherkin):**

* **Escenario:** Confirmar dos veces
  * **Dado** QA tiene una estimación válida y saldo
  * **Cuando** envía dos Run simultáneos con la misma key y payload
  * **Entonces** recibe un único analysisId y una única reserva del coste mostrado

* **Escenario:** Fallar al reservar
  * **Dado** el coste confirmado supera el saldo disponible
  * **Cuando** Admin ejecuta Run Analysis
  * **Entonces** no se crea análisis ni analysis_documents y el saldo queda intacto

* **Escenario:** Reintentar un failed
  * **Dado** un análisis agotó sus retries y liberó todos sus créditos
  * **Cuando** QA reestima y confirma Retry Analysis con saldo suficiente
  * **Entonces** se crea una ejecución nueva vinculada y se reserva solo su coste confirmado

**5. Notas Técnicas:**

* **Responsable:** Juan Manuel.
* Continuidad: SAA-6; Dev 1 controla transacciones, contexto autorizado y consistencia de créditos.
* Inicio independiente: comandos con estimate/retrieval de prueba y SQL local; integración real requiere S2-02/S2-04 y contrato S2-01.
* Referencias: PRD §§24–32, 49–50 y 66. Consumidores: S2-06 y S2-09.
* La ejecución nueva para retry manual y el rechazo de key/payload diferente son convenciones explícitas de planificación; el PRD no precisa esa representación.
* **Acuerdo de trabajo:** contratos y fixtures permiten empezar en paralelo; las integraciones indicadas deben estar disponibles para aceptar el ticket. Un mock no demuestra cierre real.

---

# S2-06 — Analysis Worker durable, leases y recuperación automática

**1. Título del Ticket:** Analysis Worker durable, leases y recuperación automática

**2. Historia de Usuario (Formato Connextra):**

* **Como** QA Lead
* **Quiero** que mi análisis termine aunque cierre sesión o falle un proceso
* **Para** recibir resultados sin mantener abierta la aplicación

**3. Criterios de Aceptación (DoD):**

* Implementar Analysis Worker como Supabase Edge Function según PRD §30; mantener lógica de negocio compartida sin HTTP entre módulos del núcleo. ADR-002 corresponde a ingesta y no autoriza cambiar este runtime.
* Claim atómico queued → processing, lease renovable y token de fencing; workers concurrentes no pueden publicar ni liquidar la misma ejecución.
* Leer actor/tenant/scope/coste/configuración persistidos y exactos. Credenciales privilegiadas quedan en servidor; payload del invocador no puede expandir scope o falsificar la finalización.
* Ejecutar retrieval S2-04, proveedor S2-07 y finalización S2-08; no hacer parsing/embeddings de documentos ni modificar originales.
* Programar recuperación de queued sin disparo y processing con lease vencido; debe funcionar con navegador cerrado/sesión cerrada y tras reinicio. Definir intervalos/timeout/heartbeat medidos y documentarlos.
* Permitir un intento inicial y exactamente hasta 2 retries automáticos del job, con backoff acotado para errores recuperables. Conservar reserva y coste durante retries; no reservar de nuevo.
* Un worker con lease vencido no puede guardar findings, liquidar ni liberar créditos. La recuperación no deja jobs activos indefinidamente.
* Al agotar retries, terminar failed mediante S2-08: cero resultados parciales visibles, liberación completa y evento terminal. Error controlado en UI y metadatos seguros en Sentry.
* Medir el scope admitido y los límites de Edge con corpus grande; definir ejecución por pasos/checkpoints seguros si se necesita. Si no cabe, proponer ADR revisado antes de cambiar runtime o reducir el guardrail del PRD.
* Pruebas reales de claim concurrente, crash/lease vencido, disparo perdido, salida obsoleta y agotamiento de retries; readiness y runbook local/remoto con configuración privada.

**4. Escenarios BDD (Gherkin):**

* **Escenario:** Recuperar queued sin disparo
  * **Dado** Run hizo commit pero falló la invocación inmediata
  * **Cuando** la recuperación programada revisa la cola
  * **Entonces** claim del job ocurre y el análisis continúa sin nuevo cargo

* **Escenario:** Rechazar worker antiguo
  * **Dado** el worker A perdió lease y B reclamó el job
  * **Cuando** A intenta finalizar después de B
  * **Entonces** su token es rechazado sin findings ni movimiento contable adicional

* **Escenario:** Agotar dos retries
  * **Dado** los proveedores fallan en el intento inicial y en dos retries
  * **Cuando** se alcanza el límite
  * **Entonces** el job queda failed, todos los créditos se liberan y se registra el evento de fallo

**5. Notas Técnicas:**

* **Responsable:** Diego Alejandro Tolosa Sanchez.
* Continuidad: SAA-8 y experiencia del worker durable de S1. Diego conserva procesamiento asíncrono.
* Inicio independiente: implementaciones de prueba para retrieval/proveedor/finalización, jobs de fixtures y RPC acordadas; cierre requiere S2-05/S2-07/S2-08.
* Referencias: PRD §§16, 27–30, 49, 51 y 66; ADR-001/ADR-002.
* La capacidad de Edge y las condiciones de los proveedores se verifican durante implementación. Este ticket no da por validado su despliegue.
* **Acuerdo de trabajo:** contratos y fixtures permiten empezar en paralelo; las integraciones indicadas deben estar disponibles para aceptar el ticket. Un mock no demuestra cierre real.

---

# S2-07 — Detección IA validada con Cerebras y fallback Groq

**1. Título del Ticket:** Detección IA validada con Cerebras y fallback Groq

**2. Historia de Usuario (Formato Connextra):**

* **Como** QA Lead
* **Quiero** obtener candidatos de contradicción y obsolescencia con evidencia válida
* **Para** revisar problemas de documentación sin aceptar decisiones automáticas

**3. Criterios de Aceptación (DoD):**

* Publicar AIProvider con contrato pequeño e independiente de SDK; Cerebras primario y Groq fallback conforme al PRD. Verificar modelos, structured output, disponibilidad y límites vigentes antes de integrar; no prometer condiciones gratuitas actuales.
* Ante error de Cerebras o respuesta estructurada inválida, usar Groq; si falla todo el intento devolver error tipado al worker para su retry. Distinguir salida válida sin hallazgos de respuesta inválida.
* Detectar contradicciones directas, inconsistencias suaves y contradicciones internas de cada fuente; evaluar obsolescencia solo contra comparison selected.
* Obsolescencia propone que un documento más nuevo puede sustituir al anterior con evidencia/fechas disponibles; no modifica version_status, active_version_id ni marca definitivamente un documento obsoleto.
* Validar con Zod type, severity High/Medium/Low, confidence 0..1, explanation y evidencia referenciada. Confidence baja no suprime persistencia y no se devuelve a la UI.
* Verificar que IDs, versiones y referencias de evidencia pertenecen al par autorizado y que las citas existen en el texto; una referencia inventada o fuera del scope invalida la salida y activa fallback/error.
* Enviar solo chunks mínimos del par y metadata necesaria. Documento es dato no confiable: no ejecutar instrucciones, no tools de negocio y no mandar documentos completos ni contexto de otros tenants.
* No persistir ni registrar prompts completos o respuestas crudas; persistir únicamente salida validada y metadata permitida: provider/model/prompt/schema/embedding model, timestamps y latencia/error seguro.
* Preparar corpus con contradicción directa, suave e interna, obsolescencia, par consistente, baja confidence e intento de prompt injection; medir resultados de proveedores reales por separado de pruebas con fakes.
* Documentar la revisión opcional de Azure exigida por PRD §16.3; no añadir dependencia de créditos Azure ni sustituir proveedores sin una decisión explícita.

**4. Escenarios BDD (Gherkin):**

* **Escenario:** Activar fallback por salida inválida
  * **Dado** Cerebras devuelve JSON con severity inválida
  * **Cuando** la validación falla
  * **Entonces** se intenta Groq y solo una salida válida continúa a persistencia

* **Escenario:** No ocultar baja confidence
  * **Dado** el proveedor propone un hallazgo válido con confidence 0.2 y evidencia verificable
  * **Cuando** se normaliza la salida
  * **Entonces** el hallazgo se conserva como pending_review y confidence queda interna

* **Escenario:** Rechazar evidencia inventada
  * **Dado** una respuesta cita un chunk ajeno al par seleccionado
  * **Cuando** se valida su evidencia
  * **Entonces** no se persiste y se ejecuta fallback o error controlado

**5. Notas Técnicas:**

* **Responsable:** Diego Alejandro Tolosa Sanchez.
* Continuidad: SAA-8; Diego amplía el pipeline semántico hacia la evaluación IA.
* Inicio independiente: AIProvider fake, corpus sintético y validación sin credenciales. La aceptación real requiere configuración privada y evidencia de ambos proveedores.
* Referencias: PRD §§16–20, 22, 50–51 y 66. Consumido por S2-06/S2-08.
* Asignación, confirmación humana, cambios de severidad y aprobación son S3. No agregar reasoning_category obligatorio.
* **Acuerdo de trabajo:** contratos y fixtures permiten empezar en paralelo; las integraciones indicadas deben estar disponibles para aceptar el ticket. Un mock no demuestra cierre real.

---

# S2-08 — Hallazgos y evidencia con deduplicación y cierre atómico

**1. Título del Ticket:** Hallazgos y evidencia con deduplicación y cierre atómico

**2. Historia de Usuario (Formato Connextra):**

* **Como** QA Lead
* **Quiero** recibir resultados completos y respaldados por evidencia
* **Para** evaluar los hallazgos sabiendo que el análisis y su cargo finalizaron consistentemente

**3. Criterios de Aceptación (DoD):**

* Persistir únicamente findings/evidence validados de S2-07 con relaciones exactas a análisis, documento, versión y chunk del scope, siempre en el mismo tenant.
* Generar fingerprint determinista por type + IDs de versiones canonizados + evidencia normalizada. Deduplicar solo dentro de analysisId; pares A/B invertidos no duplican el mismo hallazgo.
* Un análisis nuevo puede conservar el mismo hallazgo de otro run; no crear supresión histórica ni clustering semántico.
* Crear findings pending_review, assignee nulo y severity_original = severity_current. Conservar confidence interna 0..1 sin usarla como filtro.
* Cada evidence almacena snapshot exacto de máximo 2.000 caracteres, página/sección/heading disponible y referencias verificadas. Cortar un extracto preserva su texto original; no fabricar ubicaciones ausentes.
* Finalizar éxito en una sola transacción protegida por lease/fencing: findings + evidence + analyses.completed + consumo exacto de Reserved + evento analysis_completed. Actualizar analysis_status de fuentes exactas analizadas, sin cambiar comparación o nuevas versiones ajenas.
* Un resultado válido sin hallazgos finaliza completed y consume el coste confirmado; el usuario verá estado sin hallazgos, no un error.
* En fallo terminal, revertir/eliminar cualquier salida provisional, dejar cero findings parciales visibles, marcar failed, liberar toda la reserva y emitir analysis_failed de manera consistente.
* Consumir/liberar solo mediante operaciones S2-02; repetir la finalización es idempotente y no vuelve a cobrar/notificar. Fallo al guardar evidence impide declarar completed.
* Pruebas de fingerprints, límite de snapshots, FKs tenant/scope, rollback a mitad de persistencia, carrera de workers, cero hallazgos y publicación terminal única.

**4. Escenarios BDD (Gherkin):**

* **Escenario:** Deduplicar el mismo hallazgo
  * **Dado** el modelo devuelve el mismo conflicto como A/B y B/A con evidencia equivalente
  * **Cuando** se persisten los resultados de un run
  * **Entonces** se crea un solo finding; otro run puede crear su propio finding

* **Escenario:** Revertir persistencia parcial
  * **Dado** varios findings son válidos y una escritura de evidence falla
  * **Cuando** se intenta finalizar el job
  * **Entonces** no aparece resultado completed ni cargo definitivo ni findings parciales

* **Escenario:** Completar sin hallazgos
  * **Dado** todos los pares evaluados son consistentes
  * **Cuando** el worker finaliza con una lista vacía válida
  * **Entonces** queda completed y se consume exactamente la reserva confirmada

**5. Notas Técnicas:**

* **Responsable:** Diego Alejandro Tolosa Sanchez.
* Continuidad: SAA-8; Diego mantiene persistencia completa del procesamiento. Dev 1 revisa transacción contable y regenera tipos.
* Inicio independiente: outputs/leases/ledger de fixtures bajo S2-01; integración requiere S2-02/S2-06/S2-07.
* Referencias: PRD §§12.3, 17–23, 30–32, 42–43 y 66. Proveedor de resultados para S2-10 y eventos para S2-11.
* La relación con versión/chunk debe permitir purgar evidencia cuando S5 elimine originales; no implementar la purga ni workflow S3 en este ticket.
* **Acuerdo de trabajo:** contratos y fixtures permiten empezar en paralelo; las integraciones indicadas deben estar disponibles para aceptar el ticket. Un mock no demuestra cierre real.

---

# S2-09 — Confirmación, estados de análisis, créditos y Retry Analysis

**1. Título del Ticket:** Confirmación, estados de análisis, créditos y Retry Analysis

**2. Historia de Usuario (Formato Connextra):**

* **Como** QA Lead
* **Quiero** confirmar el coste y seguir o reintentar mi análisis desde la aplicación
* **Para** trabajar con resultados asíncronos y saldo comprensible

**3. Criterios de Aceptación (DoD):**

* Integrar el selector S2-03 con la estimación S2-04 y mostrar solo Estimated cost: X credits antes de confirmar; selección nueva invalida la confirmación anterior.
* Mostrar saldo available/reserved y ledger en Billing / Credits para Admin/QA; Member accede solo al saldo autorizado de su workspace. No mostrar checkout ni paquetes S4.
* Confirmar Run llama S2-05 con idempotency key estable durante un mismo intento; doble clic, respuesta perdida y reload recuperan el mismo análisis.
* Mostrar Queued, Processing, Completed y Failed desde estado persistido. Evitar que error HTTP equivalga a éxito o que una respuesta perdida genere otro cargo.
* Seguir análisis por ID con control de sesión/RLS y refresco acotado; salir de la página o cerrar sesión no detiene el job. Al volver, recuperar el análisis activo o su estado terminal.
* Después de completed, abrir findings del analysisId correcto; cero hallazgos muestra estado válido sin resultados.
* Ante failed, informar error controlado y liberación confirmada por backend. Retry Analysis obtiene estimación nueva y exige confirmación antes de crear la ejecución enlazada.
* El retry manual conserva el run failed anterior y refleja saldo insuficiente, conflicto por otro run activo, scope ya no elegible y coste nuevo sin cargos inesperados.
* Mostrar contexto mínimo del análisis: iniciador, fechas, fuentes/comparaciones exactas, coste y estado. La pantalla completa de Analysis History queda para S4.
* Pruebas de UI y Playwright: doble clic, reload, logout/reingreso, completed vacío, fallo/release, retry y roles; ningún texto privado, confidence ni URLs firmadas en telemetría.

**4. Escenarios BDD (Gherkin):**

* **Escenario:** Recuperar tras volver a entrar
  * **Dado** QA confirmó un job y cerró sesión
  * **Cuando** vuelve a entrar y abre su análisis
  * **Entonces** consulta el estado persistido y no crea otro job ni reserva

* **Escenario:** Reintentar con coste explícito
  * **Dado** un análisis failed ya liberó 8 créditos
  * **Cuando** QA abre Retry y la nueva estimación muestra 9
  * **Entonces** solo al confirmar se crea el nuevo run y se reservan 9

* **Escenario:** Limitar Member al saldo
  * **Dado** un Member conoce un analysisId y la URL del ledger
  * **Cuando** abre esos recursos directamente
  * **Entonces** se deniega el detalle mientras su consulta de saldo autorizada funciona

**5. Notas Técnicas:**

* **Responsable:** Juan Pablo Castaño Arango.
* Continuidad: SAA-9/SAA-11; Juan Pablo conserva presentación y recuperación.
* Inicio independiente: fixtures de estado/acciones del contrato S2-01. Integración real con S2-02–S2-05/S2-06/S2-08.
* Referencias: PRD §§24, 27–32, 34, 42, 56 y 66. Coordinar rutas/shell compartido con Dev 1.
* Sin reanálisis automático por upload/aprobación ni controles humanos de S3.
* **Acuerdo de trabajo:** contratos y fixtures permiten empezar en paralelo; las integraciones indicadas deben estar disponibles para aceptar el ticket. Un mock no demuestra cierre real.

---

# S2-10 — Lista de hallazgos y detalle seguro de evidencia

**1. Título del Ticket:** Lista de hallazgos y detalle seguro de evidencia

**2. Historia de Usuario (Formato Connextra):**

* **Como** QA Lead
* **Quiero** consultar hallazgos ordenados y sus fragmentos de evidencia
* **Para** evaluar la propuesta IA frente a las versiones que realmente fueron analizadas

**3. Criterios de Aceptación (DoD):**

* Listar únicamente findings publicados por análisis completed autorizados del workspace; navegar desde S2-09 conserva el analysisId.
* Orden predeterminado High → Medium → Low, con desempate estable y paginación; mostrar type, severity_current, pending_review y resumen de explanation.
* Permitir filtros por type/severity/status y assignee con opciones válidas. En S2 los nuevos findings son pending_review/unassigned; no inventar asignaciones ni workflow para dar opciones al filtro.
* Detalle muestra type, severity, explanation, evidence exacta, documento, versión, página/sección/heading disponible y fragmentos side-by-side cuando corresponda.
* Las referencias abren la versión exacta analizada mediante la API autorizada de originales, URL firmada de 300 segundos. No aceptar ruta/bucket del cliente ni sustituir por active_version_id actual.
* Revalidar Admin/QA, tenant y relación finding/evidence en el servidor; Member no accede a findings/evidence sin asignación y en S2 no existe flujo que le conceda una.
* Confidence es interna y no aparece en DTO público, DOM, respuestas de red ni filtros. Provider/raw output, prompts y vectores tampoco se exponen.
* Renderizar texto no confiable como texto seguro; no ejecutar HTML/instrucciones del documento ni inyectar Markdown inseguro.
* Mostrar empty state para completed sin findings y para filtros sin coincidencias; errores controlados para IDs inexistentes/no autorizados.
* Pruebas de orden, filtros, paginación, snapshots, exactitud de versión, XSS y consultas cross-tenant; no incluir botones de confirmar, asignar o resolver hasta S3.

**4. Escenarios BDD (Gherkin):**

* **Escenario:** Ordenar por riesgo
  * **Dado** un análisis contiene findings Low, High y Medium
  * **Cuando** QA abre la lista
  * **Entonces** ve High antes de Medium y Low con orden estable

* **Escenario:** Consultar la versión analizada
  * **Dado** un finding apunta a una versión concreta de un documento
  * **Cuando** Admin abre su evidencia/original
  * **Entonces** se autoriza esa versión exacta y la URL dura 300 segundos

* **Escenario:** No divulgar confidence
  * **Dado** existe un finding con confidence persistida
  * **Cuando** QA consulta lista y detalle
  * **Entonces** confidence no aparece en UI ni en la respuesta pública

**5. Notas Técnicas:**

* **Responsable:** Juan Pablo Castaño Arango.
* Continuidad: SAA-9/SAA-10; Juan Pablo mantiene lectura autorizada y apertura segura.
* Inicio independiente: fixtures de resultados/evidence S2-01; integración real requiere S2-08 y API pública Repository.
* Referencias: PRD §§20–22, 36, 46–48 y 66. Mutaciones humanas se entregan en S3.
* La UI debe permitir inspeccionar evidencia en S2: una lista de títulos sin detalle no satisface el objetivo reviewable del slice.
* **Acuerdo de trabajo:** contratos y fixtures permiten empezar en paralelo; las integraciones indicadas deben estar disponibles para aceptar el ticket. Un mock no demuestra cierre real.

---

# S2-11 — Notificaciones de análisis completado o fallido

**1. Título del Ticket:** Notificaciones de análisis completado o fallido

**2. Historia de Usuario (Formato Connextra):**

* **Como** QA Lead
* **Quiero** recibir un correo al terminar o fallar mi análisis
* **Para** conocer el resultado aunque haya salido de la aplicación

**3. Criterios de Aceptación (DoD):**

* Consumir notification_events analysis_completed/analysis_failed creados junto con el estado terminal por S2-08; el correo va al iniciador autorizado, sin depender de su sesión abierta.
* Usar el proveedor Resend previsto en la arquitectura/PRD, con credenciales privadas, remitente/dominio configurado y enlace a la aplicación autenticada.
* El correo solo incluye estado, contexto mínimo no sensible y enlace autenticado; no envía documentos, chunks, snapshots, prompts, secretos ni URLs firmadas.
* Implementar pending/sent/failed, claim/lease seguro, envío inicial y hasta 2 retries automáticos con backoff; al agotar registrar error saneado en Sentry.
* Unicidad por análisis/evento/destinatario y key idempotente del proveedor cuando esté disponible; recuperación tras respuesta perdida no debe emitir duplicaciones evitables. Documentar los límites externos, sin prometer exactly-once sin evidencia.
* Persistir evento/despachar se separan: un fallo de correo no revierte completed, no cambia findings ni genera consumo/liberación adicional.
* Validar destinatario persistido y asociación al workspace al despachar; no aceptar email arbitrario del navegador ni datos de otro tenant.
* Pruebas de eventos duplicados, envío fallido, crash/retry, payload mínimo, permisos y agotamiento de retries con proveedor fake.
* Demostrar recepción de ambos correos en buzón controlado con el proveedor real; accepted del API por sí solo no acredita entrega.
* Preparar handoff a S4: este ticket solo implementa avisos terminales. High finding, asignación/aprobación y digest de 23:00 UTC pertenecen al alcance posterior de notificaciones.

**4. Escenarios BDD (Gherkin):**

* **Escenario:** Avisar tras cerrar sesión
  * **Dado** QA inició un análisis y cerró sesión
  * **Cuando** el análisis llega a completed
  * **Entonces** se entrega un correo de resultado con enlace que requiere autenticación

* **Escenario:** No alterar análisis por fallo de correo
  * **Dado** un análisis completed ya consumió su reserva
  * **Cuando** el proveedor de correo falla hasta agotar dos retries
  * **Entonces** solo notification_event queda failed; análisis, findings y saldo siguen consistentes

* **Escenario:** Recuperar evento sin duplicar efectos
  * **Dado** un evento terminal se recibe dos veces
  * **Cuando** el despachador lo procesa
  * **Entonces** existe una sola entrega lógica y no se crea otra operación contable

**5. Notas Técnicas:**

* **Responsable:** Juan Manuel.
* Continuidad: SAA-12; Juan Manuel mantiene integraciones transversales, secretos y Sentry.
* Inicio independiente: eventos/destinatarios de fixture y proveedor fake; integración real requiere eventos terminales S2-08 y configuración autorizada.
* Referencias: PRD §§24, 40, 51, 63, 66 y 68. Coordinar contrato terminal con Diego y enlaces con Juan Pablo.
* La disponibilidad, idempotencia y condiciones del API se consultan durante implementación; este planning no afirma entrega real.
* **Acuerdo de trabajo:** contratos y fixtures permiten empezar en paralelo; las integraciones indicadas deben estar disponibles para aceptar el ticket. Un mock no demuestra cierre real.

---

# S2-12 — Aceptación integral y quality gates de AI Analysis v0.2

**1. Título del Ticket:** Aceptación integral y quality gates de AI Analysis v0.2

**2. Historia de Usuario (Formato Connextra):**

* **Como** Admin
* **Quiero** tener evidencia del flujo completo y sus fallos críticos
* **Para** utilizar la segunda versión con seguridad y costes predecibles

**3. Criterios de Aceptación (DoD):**

* Construir desde el inicio corpus y Playwright del recorrido: login Admin/QA → seleccionar ready/active → estimar → confirmar → reserva → queued/processing → completed → findings/evidence → correo.
* Usar un corpus controlado con contradicción directa, suave, interna, obsolescencia y par consistente. Registrar versiones/modelos/configuración y resultados esperados; no tratar vectores mock como validación de calidad IA.
* Ejecutar con proveedores reales el recorrido exitoso, fallback Groq y entrega de correos; distinguir pruebas deterministas con fakes de integración/runtime real.
* Cubrir failed tras intento inicial + 2 retries, liberación total, cero resultados parciales y Retry manual con nueva estimación/reserva; fallo de notificación no altera estado/saldo.
* Cubrir doble clic/respuesta perdida, concurrencia de Run y workers, disparo perdido, crash/lease/reclaim, token obsoleto, 20/21 versiones y logout/reingreso.
* Pruebas RLS reales cubren todas las entidades S2, RPC/proyecciones, cross-tenant, Member, saldo/ledger y originales exactos; confidencialidad de LLM/Sentry/email se comprueba con payloads sintéticos.
* CI incorpora los tests S2 en lint, typecheck, Vitest, SQL RLS, integración y build donde corresponda, preservando checks S1. Diego/Juan Manuel aportan sus suites; cambios de workflows/config raíz los integra Juan Manuel.
* Ejecutar Playwright antes del cierre y verificar los gates del SHA candidato. Build verde, status Done, fakes o documentación de S1 no sustituyen la prueba completa de S2.
* Documentar runbook de arranque/cutover de Analysis Worker, recuperación programada, proveedores y correo; registrar comandos reales, entorno, SHA, resultados y limitaciones sin secretos.
* Cerrar milestone solo cuando el vertical complete el recorrido y todas las pruebas críticas pasen. Crear tracking de fallos encontrados sin ocultarlos mediante skipped o redefinir alcance.

**4. Escenarios BDD (Gherkin):**

* **Escenario:** Demostrar el valor completo
  * **Dado** Admin/QA tiene corpus ready/active y saldo
  * **Cuando** recorre Run Analysis hasta completed
  * **Entonces** ve findings con evidencia exacta, se consume el coste mostrado y llega el correo

* **Escenario:** Bloquear publicación insegura
  * **Dado** un cambio permite leer evidence de otro workspace
  * **Cuando** CI ejecuta la prueba RLS crítica
  * **Entonces** falla el gate y el candidato no se publica

* **Escenario:** Mantener crédito tras fallo
  * **Dado** el análisis agota sus retries y el usuario reintenta
  * **Cuando** se verifican ledger y UI
  * **Entonces** la primera reserva queda totalmente liberada y solo se reserva el retry confirmado

**5. Notas Técnicas:**

* **Responsable:** Juan Pablo Castaño Arango.
* Continuidad: E2E Upload/Repository SAA-9/SAA-11; Juan Pablo coordina aceptación del usuario. Juan Manuel conserva ownership CI/Sentry; Diego, corpus IA y pruebas del worker.
* Inicio independiente: plan/corpus/tests con fixtures desde día 1. Dependencia de cierre: S2-01 a S2-11 integrados; no es una fase de pruebas aplazada al final.
* Referencias: PRD §§48, 51–56, 66 y 71. Publicar evidencia separada de unit/SQL/integración/real-provider/E2E/recepción de correo.
* No ejecutar resets, seeds, migraciones o deployments remotos dentro de una verificación local; cualquier publicación sigue el proceso autorizado del equipo.
* **Acuerdo de trabajo:** contratos y fixtures permiten empezar en paralelo; las integraciones indicadas deben estar disponibles para aceptar el ticket. Un mock no demuestra cierre real.
