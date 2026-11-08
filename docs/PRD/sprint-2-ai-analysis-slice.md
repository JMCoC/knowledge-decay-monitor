# Sprint 2 — AI Analysis v0.2

Fecha: 2026-10-10. Documento del segundo vertical y acuerdo inicial para tickets. Fuente de alcance: [PRD §66](knowledge-decay-monitor-prd-final.md#66-sprint-2--ai-analysis-v02). Tickets: [Sprint 2](../Tickets/sprint-2-ai-analysis.md). Referencia de formato: [Sprint 1](../Tickets/tickets.md).

## 1. Objetivo y recorrido

Entregar el primer valor central del producto: detectar candidatos de contradicción y obsolescencia con evidencia que Admin/QA puedan inspeccionar.

> select ready documents → see credit estimate → run asynchronous analysis → receive contradiction/obsolescence findings with evidence.

El recorrido incluye 50 créditos promocionales, selección source/comparison, precio fijo confirmado, reserva transaccional, ejecución recuperable, resultado completo o fallo con liberación total y correo al iniciador aunque cierre sesión.

La IA propone; la evidencia demuestra; las personas deciden. En S2 los hallazgos quedan en `pending_review`. La confirmación humana, asignación, severidad editable y corrección/aprobación de versiones se entregan en S3.

## 2. Base observada y límites

- Linear tiene la milestone **Sprint 1 — Secure Document Repository v0.1**, con sus ocho tickets SAA-5 a SAA-12 en Done y progreso 100%, consultados el 2026-10-10.
- El checkout contiene identity/workspace/ingestion/repository, worker de ingesta durable, Vitest, Playwright, migraciones y scripts de integración. La descripción de base pendiente de AGENTS.md y partes del Día Cero son históricas y no describen íntegramente este checkout.
- No se encontraron módulos implementados de análisis, créditos, findings o notificaciones. Los tipos/contratos S1 no implican APIs S2 disponibles.
- El [acta local del primer vertical](../testing/first-vertical-acceptance.md) del 2026-10-09 registra límites de imagen final y aceptación remota. El usuario declara completado S1; este planning respeta ese cierre y no intenta volver a certificarlo. Done en Linear no demuestra por sí solo ejecución remota.
- [ADR-002](../architecture/adr/ADR-002-durable-ingestion-worker.md) cambió la inferencia/ejecución de **ingesta** a un worker persistente. PRD §30 exige **Supabase Edge Function** para análisis. S2-06 debe verificar su capacidad y registrar un ADR si la evidencia exige otro runtime.
- No se implementa código ni se aplican migraciones/despliegues en esta entrega de planificación.

## 3. Alcance completo y trazabilidad

| Requisito de PRD §66 | Ticket propietario | Integración visible |
|---|---|---|
| 50 créditos promocionales, concesión única | S2-02 | S2-09 muestra saldo; workspaces S1 sin grant se migran idempotentemente |
| Credit ledger foundation | S2-02 | S2-05 reserva; S2-08 consume/libera; S2-09 lee |
| Pricing formula y cost estimation | S2-04 | S2-09 muestra precio; S2-05 revalida |
| Source/comparison selection y máximo 20 | S2-03 | S2-04/S2-05 revalidan en servidor |
| Select all filtered, comparación repository dentro del límite | S2-03 | S2-12 prueba paginación y 20/21 |
| Reserva atómica, analysis entity, analysis_documents | S2-05 | Esquema/RLS S2-01; contabilidad S2-02 |
| Run Analysis idempotente y uno activo por workspace | S2-05 | UI S2-09; concurrencia SQL/integración |
| Analysis Worker, claim atómico, lease, recovery y 2 retries | S2-06 | S2-08 protege finalización y liberación |
| Top K=5 y similarity threshold=0.75 | S2-04 | Mismo retrieval fijado para estimar/ejecutar |
| Cerebras, Groq fallback, AIProvider | S2-07 | Runtime S2-06 y evidencia real S2-12 |
| Zod output validation y privacidad | S2-07 | S2-08 valida referencias antes de persistir |
| Contradicción directa, suave e interna | S2-07 | Corpus/retrieval S2-04; UI S2-10 |
| Candidatos de obsolescencia | S2-07 | Solo comparación elegida; no cambia estado funcional |
| Deduplicación determinista dentro del run | S2-08 | Fingerprint y unicidad por analysisId |
| findings, finding_evidence, snapshot máximo 2.000 caracteres | S2-08 | Esquema/RLS S2-01; detalle S2-10 |
| Findings list, orden High/Medium/Low y evidencia inspeccionable | S2-10 | Redirección completed desde S2-09 |
| Correo completed/failed | S2-11 | Evento terminal S2-08 y recepción real S2-12 |
| Liberación completa al fallar; cero éxito parcial | S2-08 | S2-02/S2-06; UX S2-09 |
| Retry Analysis | S2-05 | Reestimación y confirmación S2-09; nunca doble reserva |
| UI, seguridad, persistencia, fallos y tests (§71) | S2-01 y S2-12 | Cada ticket aporta sus pruebas, E2E integra el conjunto |

Fuera de S2: workflow humano y corrected versions (S3); invitaciones/roles editables, pagos Lemon Squeezy, Analysis History completo/Audit Log/digest/notificaciones de colaboración (S4); purga permanente (S5). S2 guarda contexto mínimo del análisis para seguir un job, sin construir todavía la pantalla completa de History. High finding como correo inmediato queda en el alcance amplio de notificaciones de S4; S2 entrega los dos eventos terminales explícitos de §66.

## 4. Responsabilidad y paralelismo

| Persona | Evidencia de asignaciones S1 | Tickets S2 |
|---|---|---|
| Juan Manuel, Dev 1 | SAA-5, SAA-6, SAA-12 | S2-01, S2-02, S2-05, S2-11 |
| Diego Alejandro Tolosa Sanchez, Dev 2 | SAA-7, SAA-8 | S2-04, S2-06, S2-07, S2-08 |
| Juan Pablo Castaño Arango, Dev 3 | SAA-9, SAA-10, SAA-11 | S2-03, S2-09, S2-10, S2-12 |

La propuesta prioriza continuidad por dominio. Separar por capas técnicas o repartir tickets sin relación con S1 aumentaría handoffs y edición concurrente de archivos. Los tres trabajan sobre contratos y fixtures compartidos, y luego integran capacidades pequeñas.

### Secuencia de trabajo

| Ventana orientativa | Juan Manuel | Diego | Juan Pablo |
|---|---|---|---|
| Inicio, día 1 | Entrega mínima contratos/fixtures S2-01; inicia ledger | Corpus/retrieval/precio S2-04; prueba AIProvider S2-07 | Selector S2-03; corpus/Playwright S2-12 |
| Días 2–4 | S2-02 y Run SQL S2-05; completa RLS base | S2-04/S2-07; inicia worker con adaptadores de prueba | S2-03/S2-09 con acciones de fixture; inicia detalle S2-10 |
| Días 5–7 | Integra Run real y notificaciones S2-11; revisa RPC terminal | S2-06/S2-08 y proveedores reales | Integra Run/estado/resultados; negativos E2E |
| Días 8–10 | Ledger/concurrencia/privacidad/email y CI | Recovery, leases, capacidad Edge/corpus IA | E2E integral S2-12 y evidencia del cierre |

Las ventanas son una guía para la cadencia de dos semanas, no fechas comprometidas. La milestone no recibe targetDate inventada.

**Dependencias reales:** contratos de integración sí son necesarios; nadie puede probar el flujo real completo antes de tener sus productores. Se distingue poder comenzar/desarrollar con fixtures de poder cerrar integrado. Un contrato pequeño al inicio sustituye una espera por toda la base de datos; no elimina las dependencias reales.

### Entregas y ownership

- Dev 1 coordina `src/types/**`, tipos SQL generados, seed local, raíz/dependencias/lockfile, shell y CI. Cada autor entrega sus migraciones nuevas y pruebas por dominio, con timestamp coordinado; Dev 1 revisa orden y regenera tipos.
- Dev 2 controla núcleo de análisis/retrieval/provider/finalización y Analysis Worker. Dev 3 controla rutas/componentes de selección/estado/results y consultas públicas de presentación.
- Nuevos límites por negocio: `analysis` para estimar/ejecutar/resultados; `credits` para saldo/ledger; `notifications` para entrega terminal. Crear carpetas solo cuando exista implementación. Dentro de analysis, núcleo servidor/worker corresponde a Diego; queries/UI de usuario a Juan Pablo; Run/reserva a Juan Manuel según ticket.
- `src/app` compone. Los módulos consumen identidad verificada; Repository solicita acciones a analysis como ya solicita retry a ingestion. Ningún barrel cliente expone provider, secretos o workers.
- Analysis solicita operaciones transaccionales a credits; finalización emite evento outbox. Notifications consume eventos terminales sin cambiar el análisis ni el ledger. Mantener grafo sin ciclos y funciones internas directas.
- `document_versions.analysis_status` es la dimensión que escribe analysis al finalizar fuentes exactas; ingestion conserva processing/version_status y activación. Esta extensión de ownership se revisa con los tres en S2-01, antes de implementar.
- Los mocks/adaptadores de fixture solo se usan en desarrollo/pruebas. No publicar endpoints ficticios, auth bypasses ni worker que simule avance.
- Integrar PR pequeños y revisar contratos entre productor/consumidor. S2-12 coordina aceptación; Dev 1 sigue integrando workflows, Diego aporta pruebas de núcleo/worker.

## 5. Acuerdo mínimo para empezar sin esperar

Estas formas describen responsabilidades y datos, no firmas ya implementadas. S2-01 fija nombres/tipos finales con los consumidores y mantiene `ActionResult<T>`.

| Operación / dato | Productor | Entrada mínima | Salida pública |
|---|---|---|---|
| Eligible selection | S2-03 | Nombre, filtros, paginación desde sesión | IDs documento/versión, nombre/category/Owner y total autorizado |
| Estimate | S2-04 | sourceVersionIds, comparisonVersionIds | Identificador/garantía opaca de estimación, coste entero y versiones exactas; sin pares/texto/desglose |
| Run | S2-05 | Estimación íntegra y vigente, idempotencyKey | analysisId y queued, o error controlado |
| Analysis snapshot | S2-09 | analysisId | Estado persistido, selección exacta, coste, fechas/initiator, error seguro y capacidad de retry |
| Retry | S2-05 | failedAnalysisId, nueva estimación confirmada y key | Nuevo analysisId enlazado; ejecución anterior permanece failed |
| Credit snapshot / ledger | S2-02 | Sesión y paginación permitida | Available/reserved; ledger solo Admin/QA |
| Findings list / detail | S2-10 | analysisId/findingId, filtros/paginación | Severidad, explicación, evidencia, referencias exactas; nunca confidence |
| AIProvider | S2-07 | Par mínimo autorizado y configuración | Resultado validado con findings o lista vacía, o error tipado |
| Terminal finalization | S2-08 | Job/lease, resultados estructurados validados | Estado terminal y liquidación/evento atómicos, idempotentes |
| Notification event | S2-08 → S2-11 | analysisId, tipo terminal, iniciador persistido | pending/sent/failed sin contenido del documento |

Fixtures de arranque: dos tenants/roles, sin saldo/saldo reservado, 1/20/21 versiones, selección en varias páginas y solapada, output válido/vacío/inválido, confidence baja, snapshot largo, par repetido/invertido, queued/processing/lease vencido/completed/failed y eventos de correo. Mantener credenciales y corpus sintético locales.

No introducir HTTP interno entre módulos. La Edge Function es una frontera técnica de ejecución autorizada, no una API genérica que reemplace funciones del núcleo.

## 6. Convenciones que el PRD no detalla

Son decisiones iniciales del planning, identificadas explícitamente para revisión en S2-01/S2-04/S2-05. No modifican silenciosamente el texto del PRD.

1. **Comparación vacía:** al menos una fuente; comparación opcional para contradicción interna. Una versión puede figurar en ambas listas y cuenta una vez en la unión máxima de 20.
2. **Conteo de chunks:** contar chunks distintos de la unión source/comparison. Contar pares únicos elegibles y canonizados, sin cobrar dos veces A/B y B/A ni separar cargos para contradicción y obsolescencia del mismo par.
3. **Retrieval:** cada chunk fuente consulta su versión para contradicción interna y comparison para análisis externo. Combinar candidatos con Top K total máximo 5 por chunk y umbral 0.75; no usar todas las fuentes como comparación implícita. Desempates por ID estable. La búsqueda interna siempre se ejecuta aunque comparison esté vacío.
4. **Estimación reproducible:** fijar IDs/versiones, revisión de chunks, configuración y versión de tarifa. No persistir pares. Guardar únicamente agregados/fingerprint/configuración permitidos y recomputar con orden estable. Una estimación alterada o desactualizada se rechaza antes de reservar; divergencia durante ejecución provoca fallo controlado/liberación, sin variar el cargo confirmado.
5. **Coste cero pares:** fórmula todavía incluye base/chunks. Un run válido sin hallazgos queda completed y consume el coste confirmado.
6. **Retry manual:** después de failed/release, crear run nuevo enlazado, con nueva estimación/confirmación/key/reserva. Retries automáticos son hasta dos dentro del mismo run y conservan la reserva. Ningún retry automático implica consentimiento a otro precio.
7. **Destinatario terminal:** correo al iniciador persistido, con autorización comprobada al despachar. Eventos son únicos por run/tipo/destinatario; correo fallido no revierte resultado ni contabilidad.
8. **Créditos para S1:** grant idempotente a workspaces previos sin Promotional, mediante migración versionada, para que el vertical nuevo sea usable desde la base existente.
9. **Estado analizado:** al completar, marcar analyzed únicamente en fuentes/versiones exactas analizadas. No borrar pending_reanalysis de versiones posteriores ni asumir que una versión comparison tuvo análisis interno.

Valores que sí fija el PRD: 50 créditos promocionales una vez; `ceil(1 + chunks*0.05 + candidate_pairs*0.20)`; coste mostrado = reservado = consumido si éxito; Top K 5; similarity 0.75; máximo 20 versiones; un job queued/processing por tenant; dos retries automáticos; snapshot máximo 2.000 caracteres; confianza interna 0..1 sin filtrar persistencia.

## 7. Integraciones que permiten cerrar cada capacidad

| Consumidor | Productores necesarios para aceptación real |
|---|---|
| S2-03 selección | S1 identidad/Repository + elegibilidad/contrato S2-01 |
| S2-04 estimación | Chunks reales S1 + contrato S2-01 |
| S2-05 Run | S2-01/S2-02/S2-04 |
| S2-06 worker | S2-05/S2-04/S2-07/S2-08 |
| S2-08 finalización | S2-01/S2-02/S2-06/S2-07 |
| S2-09 UI ejecución | S2-02/S2-03/S2-04/S2-05/S2-06/S2-08 |
| S2-10 evidencia | S2-01/S2-08 + apertura original S1 |
| S2-11 correo | Evento terminal S2-08 + proveedor/configuración real |
| S2-12 cierre | S2-01 a S2-11 integrados |

S2-06 y S2-08 colaboran por interfaces de claim/finalización; su integración mutua no implica que ninguno deba esperar sin trabajar. En Linear usar relaciones **related** para estas integraciones; el único bloqueo global es el cierre S2-12 por las once capacidades restantes. No marcar todos los tickets como bloqueados por el cierre completo de S2-01.

## 8. Seguridad, recuperación y validación

- Tenant/rol derivados de sesión y Profile persistido. RLS/GRANT/FKs siguen protegiendo tablas/proyecciones/RPC si se evita la UI.
- No exponer prompts, salida cruda, documentos, chunks, embeddings, confidence pública, credenciales ni URLs firmadas en logs/Sentry/email/artefactos.
- Claim/lease/fencing protegen contra workers tardíos. Cron/recovery recoge queued sin disparo y processing abandonados. Medir límites Edge con hasta 20 versiones admitidas; no asumir que el runtime de ingesta o un mock prueban análisis.
- Éxito publica todo y consume la reserva en una transacción; fallo terminal publica cero resultados parciales y libera el 100%. Reintentos y delivery repetido no duplican cargos/resultados.
- Dependencias externas nuevas se documentan durante implementación mediante Context7 y se verifica disponibilidad de modelos/limits/proveedores; no hay promesa de free tier vigente en este planning.
- Cada ticket incluye unit/SQL/integración/Playwright según su riesgo. S2-12 integra corpus real, fallback y recepción de correo. CI preserva controles S1.

## 9. Criterios de salida

Sprint 2 queda cerrado cuando:

1. Admin y QA seleccionan correctamente dentro del tenant; Member no ejecuta ni lee resultados/ledger detallado. Scope elegible, paginación y 20/21 se verifican en backend.
2. Grant único, fórmula, reserva y liquidación son correctos bajo concurrencia; el coste confirmado coincide con el consumido y nunca existe sobregiro.
3. El análisis termina fuera de la sesión del navegador; recovery, dos retries, lease vencido y worker obsoleto están probados.
4. Cerebras/Groq y Zod entregan candidatos reales de contradicción directa/suave/interna y obsolescencia sobre corpus controlado; no hay decisiones automáticas de workflow.
5. Findings completos/deduplicados muestran evidencia exacta y versiones autorizadas; cero hallazgos es un resultado válido; fallo no muestra éxito parcial.
6. Retry manual tiene consentimiento de coste y nueva reserva tras la liberación del run fallido.
7. Completed/failed generan correo recibido en buzón controlado; fallo de delivery no altera el análisis.
8. Gates S2/S1 y Playwright pasan para el candidato; evidencia diferencia pruebas sintéticas, proveedores reales, correo y aceptación en el entorno de publicación.

La preparación de documentos y tickets no demuestra esos resultados. El acta de S2 registrará entorno, SHA/configuración, comandos ejecutados, resultados, límites pendientes y vínculos a evidencia saneada.

## 10. Registro de Linear

La milestone usa el mismo patrón que S1: **Sprint 2 — AI Analysis v0.2**, en el proyecto Knowledge Decay Monitor, equipo SaaS Project KDM.

Milestone creada: `bc123ddc-ff45-4cec-a87a-ec118d371bd3`, en el [proyecto Knowledge Decay Monitor](https://linear.app/saasprojectkdm/project/knowledge-decay-monitor-de9ff4258960). [Documento de coordinación en Linear](https://linear.app/saasprojectkdm/document/sprint-2-ai-analysis-v02-slice-y-coordinacion-88b07a921439).

Los doce tickets están en **Todo**, asignados según la tabla de responsabilidad, con historia/DoD/BDD/notas. SAA-24 (S2-12) tiene bloqueos de cierre por SAA-13 a SAA-23. Los demás permiten inicio paralelo; sus notas documentan las integraciones necesarias para aceptación. No se asignaron fechas, puntos ni cycle.

| Código local | Linear | Responsable |
|---|---|---|
| S2-01 | [SAA-13](https://linear.app/saasprojectkdm/issue/SAA-13/contratos-esquema-y-aislamiento-del-vertical-de-analisis) | Juan Manuel |
| S2-02 | [SAA-14](https://linear.app/saasprojectkdm/issue/SAA-14/creditos-promocionales-ledger-y-saldos-transaccionales) | Juan Manuel |
| S2-03 | [SAA-15](https://linear.app/saasprojectkdm/issue/SAA-15/seleccion-autorizada-de-documentos-y-alcance-de-comparacion) | Juan Pablo Castaño Arango |
| S2-04 | [SAA-16](https://linear.app/saasprojectkdm/issue/SAA-16/retrieval-semantico-acotado-y-estimacion-exacta-de-creditos) | Diego Alejandro Tolosa Sanchez |
| S2-05 | [SAA-17](https://linear.app/saasprojectkdm/issue/SAA-17/run-analysis-idempotente-con-reserva-atomica-de-creditos) | Juan Manuel |
| S2-06 | [SAA-18](https://linear.app/saasprojectkdm/issue/SAA-18/analysis-worker-durable-leases-y-recuperacion-automatica) | Diego Alejandro Tolosa Sanchez |
| S2-07 | [SAA-19](https://linear.app/saasprojectkdm/issue/SAA-19/deteccion-ia-validada-con-cerebras-y-fallback-groq) | Diego Alejandro Tolosa Sanchez |
| S2-08 | [SAA-20](https://linear.app/saasprojectkdm/issue/SAA-20/hallazgos-y-evidencia-con-deduplicacion-y-cierre-atomico) | Diego Alejandro Tolosa Sanchez |
| S2-09 | [SAA-21](https://linear.app/saasprojectkdm/issue/SAA-21/confirmacion-estados-de-analisis-creditos-y-retry-analysis) | Juan Pablo Castaño Arango |
| S2-10 | [SAA-22](https://linear.app/saasprojectkdm/issue/SAA-22/lista-de-hallazgos-y-detalle-seguro-de-evidencia) | Juan Pablo Castaño Arango |
| S2-11 | [SAA-23](https://linear.app/saasprojectkdm/issue/SAA-23/notificaciones-de-analisis-completado-o-fallido) | Juan Manuel |
| S2-12 | [SAA-24](https://linear.app/saasprojectkdm/issue/SAA-24/aceptacion-integral-y-quality-gates-de-ai-analysis-v02) | Juan Pablo Castaño Arango |
