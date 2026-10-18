# S2-05 — Run/Retry idempotentes y prerrequisitos del worker

Fecha: 2026-10-17. Estado: diseño aprobado por el usuario el 2026-10-17.
Base inspeccionada: rama `feature/idempotent_analysis_run`, HEAD `252d504`.
Esta entrega contiene el diseño aprobado. Posteriormente, el usuario aprobó
la ejecución inline en la rama actual y autorizó un commit local al completar
cada tarea con sus verificaciones aprobadas; no autorizó push ni despliegues.
Revisión independiente de planificabilidad: completada, sin preguntas
importantes pendientes. La revisión no sustituye pruebas de implementación.

## 1. Propósito y decisiones del usuario

Admin y QA Lead deben confirmar el precio mostrado una sola vez y obtener
un análisis durable, sin duplicar reservas, incluso con doble clic,
concurrencia, respuesta perdida o interrupción del worker.

El usuario pidió cumplir los criterios de S2-05 y aprobó:

- Corregir los problemas de S2-04/S2-06 como prerrequisitos de esta entrega.
- Conservar ingesta en el worker Node de `C:\KDM\kdm-demo-worker` y análisis
  en Supabase Edge Functions, con ejecuciones independientes.
- Evaluar en este desarrollo continuidad, recuperación y capacidad de Edge.
  Si no hay evidencia suficiente, la condición queda abierta; no se aplaza
  silenciosamente como si ya estuviera cumplida.
- Separar esa comprobación técnica de la aceptación completa con proveedores,
  hallazgos y liquidación reales, que requiere S2-07/S2-08.

Fuentes: [S2-05 y dependencias](../../Tickets/sprint-2-ai-analysis.md),
[slice S2](../../PRD/sprint-2-ai-analysis-slice.md),
[PRD](../../PRD/knowledge-decay-monitor-prd-final.md),
[ADR-001](../../architecture/adr/ADR-001-monolito-modular.md),
[ADR-002 de ingesta](../../architecture/adr/ADR-002-durable-ingestion-worker.md),
[revisión y evidencia actual](../../testing/2026-10-17-s2-05-dependency-review.md).

## 2. Alcance y límites

Incluye estimaciones correctas e íntegras, Run/Retry de servidor, transacción
de análisis/scope/reserva, idempotencia, autorización, disparo posterior al
commit, correcciones de continuidad/intentos/recovery y pruebas de capacidad.
Incluye corregir el guard de imports Deno en Windows y estabilizar la prueba
de crash mediante sincronización observable del job, sin esperas fijas como
única prueba de que empezó a procesar.

S2-07 conserva la implementación productiva de Cerebras/Groq y validación de
su salida. S2-08 conserva staging/finalización de findings/evidence,
consumo/liberación y eventos terminales. S2-09 conserva confirmación visual,
saldo, polling y presentación de Retry. S2-11 conserva correo.
El botón actual del selector no se convierte en una UI parcial de S2-09.

No se duplican repositorios, proveedores ni colas externas. No se cambia el
runtime ni la configuración del worktree de ingesta, que está en `c1a1e6e`
y apunta a Supabase remoto. Las migraciones nuevas se verifican localmente
sin reset ni seed remoto. No se reescriben migraciones compartidas.

Resultados que harían fallar esta entrega: cobro distinto del confirmado,
reserva duplicada, saldo negativo, referencias cross-tenant, Run a partir de
una estimación manipulada, trabajo truncado por paginación, un lote exitoso
contado como retry, o declarar recovery probado mediante una invocación manual.

## 3. Contratos públicos y autorización

Se conservan las firmas de `AnalysisApi` y `ActionResult<T>` existentes:

- `estimateAnalysis({ sourceVersionIds, comparisonVersionIds })` devuelve
  scope exacto, `estimateRef`, `fixedCost` y `expiresAt`.
- `runAnalysis({ estimateRef, idempotencyKey })` devuelve `analysisId/status`.
- `retryAnalysis({ failedAnalysisId, estimateRef, idempotencyKey })` añade
  `retryOfAnalysisId` a la respuesta.

Entradas Zod estrictas: UUIDs, key opaca de 1–128 caracteres sin espacios en
los extremos y sin campos adicionales. No exigir UUID para la key mantiene
el contrato actual de string. Las decisiones de longitud y rechazo de
campos adicionales son propuestas técnicas del agente.

Las Server Actions verifican la sesión y el Profile mediante identidad.
Las RPC privilegiadas vuelven a consultar Profile y derivan workspace/rol
del usuario verificado que les pasa el servidor. Solo Admin/QA pueden
estimar, Run o Retry; Member/anon no acceden a estas mutaciones. Actor,
workspace, rol, coste y configuración no son entradas públicas del comando.
Funciones privilegiadas: EXECUTE exclusivo para service_role, search_path
vacío, validaciones internas y salida controlada. Una llamada directa del
navegador no obtiene los privilegios del servidor.

Decisión técnica propuesta para Retry: cualquier Admin/QA del mismo workspace
puede reintentar un failed; la nueva ejecución registra al actor que confirma
como initiator. No se exige ser el iniciador del failed anterior.

## 4. Estimación y snapshot verificable

Una rutina SQL de retrieval compartida produce el resumen completo, sin
dependencia del límite HTTP `max_rows = 1000`:

- `chunkCount`: todos los chunks distintos de la unión source/comparison.
- `candidatePairCount`: todos los pares elegibles únicos del retrieval.
- Revisión de todos los IDs de chunks; fingerprint de scope, revisión,
  pares canonizados, tarifa y configuración de ejecución.
- Precio entero: `ceil((100 + 5*chunkCount + 20*candidatePairCount)/100)`.

Mantener Top K total 5 por chunk fuente, umbral 0.75 y fuentes/comparaciones
exactas. Orden de pares canónico, determinista y total; empates no pueden
cambiar la orientación del fingerprint o el cursor entre consultas.
El resumen se calcula en PostgreSQL sin devolver textos a Next.js. El worker
lee únicamente los pares del lote mediante cursor estable/paginación; no
materializa todos los textos de todo el análisis en cada invocación.
No se persisten tablas de pares candidatos ni se eleva globalmente max_rows.

La estimación se crea mediante una operación privilegiada que deriva el
actor, valida elegibilidad y calcula el resumen. Se retira el INSERT directo
de authenticated en `analysis_estimates`; la Server Action ya no inserta
agregados arbitrarios con el cliente de sesión. Mantener lecturas únicamente
de las columnas que necesite la proyección autorizada.

Persistir un snapshot de configuración controlado por servidor: revisión de
retrieval/fingerprint, tarifa, prompt, schema y referencias provider/model.
La forma exacta SQL queda al builder; debe ser compatible con la
`AnalysisConfiguration` que lee el worker. El manifiesto de ejecución se
resuelve desde configuración privada, nunca desde el navegador. Su ausencia
o invalidez devuelve INTERNAL_ERROR sin crear estimación ni reservar.
Los nombres/modelos productivos los fija S2-07; no se inventa un modelo ni
se habilita un proveedor falso como fallback productivo.

El snapshot es inmutable, ligado a actor/workspace/scope y con TTL de 30
minutos establecido por el reloj SQL. Un cambio de revisión de fingerprint
invalida estimaciones anteriores para un Run nuevo con ESTIMATE_STALE;
no repricia silenciosamente lo ya mostrado. Las pruebas usan manifiestos
sintéticos explícitos aislados del entorno productivo.

El cambio de conteo y snapshot se documenta como revisión del contrato
operacional S2-04 y sus consumidores; las firmas públicas no cambian.

## 5. Run atómico e idempotencia

Una RPC crea o recupera el Run dentro de una sola transacción. Usa el bloqueo
de workspace compatible con S2-02, un orden estable de bloqueos y los índices
existentes `analyses_one_active` y `(workspace_id, initiator_id, idempotency_key)`.
El bloqueo de un workspace no serializa todos los Run de otros workspaces.

Orden observable del comando:

1. Reautorizar actor y resolver workspace desde Profile persistido.
2. Adquirir el control transaccional del workspace y buscar la key del actor.
3. Si existe, comparar identidad exacta del comando: Run/Retry, estimateRef
   y, cuando corresponda, failedAnalysisId. Misma identidad devuelve el mismo
   analysisId y su estado actual; identidad distinta devuelve CONFLICT.
4. Solo para un comando nuevo: validar propiedad de la estimación,
   caducidad, snapshot vigente, fuentes no vacías, unión máxima de 20 y
   versiones active + ready del mismo tenant, incluidos los punteros activos.
5. Recalcular y contrastar resumen, fingerprint y coste dentro del contexto
   transaccional protegido. Impedir que una mutación concurrente de las
   versiones/chunks invalide la comprobación antes de confirmar la reserva.
6. Rechazar si existe otro queued/processing. Crear analyses queued,
   analysis_documents source/comparison exactos y ejecutar
   `private.reserve_analysis_credits` con el coste confirmado.
7. Commit único. Cualquier error revierte análisis, asociaciones y reserva.

Persistir la identidad del comando separada del fingerprint de retrieval:
el worker ya usa `request_fingerprint` para este último. Añadir referencia a
la estimación y la información mínima necesaria para comparar replays.
No sustituir un fingerprint por el otro. La estimación referenciada por un
Run no se elimina ni modifica como parte de limpieza por TTL.

Un replay confirmado funciona tras caducar la estimación, cambiar documentos
o terminar el análisis. Se exige que el actor conserve autorización actual.
Una petición nueva con otra key pasa todas las comprobaciones actuales.
Una transacción fallida no consume la key. El servidor nunca convierte un
error posterior al commit en una segunda reserva.

## 6. Retry manual

El failed debe pertenecer al workspace, conservar su historial y tener una
reserva previa completamente Released, sin Consumed ni efecto pendiente.
Si falta esa liberación, devolver CONFLICT; no intentar repararla en Retry.
La liquidación terminal corresponde a S2-08.

Para un Retry nuevo se exige una estimación vigente del actor actual y una
key distinta de la del intento anterior. El scope confirmado es el de esa
nueva estimación; puede cambiar respecto del failed porque algunas versiones
pueden haber dejado de ser elegibles. Esta es una propuesta técnica explícita
para el diseño. No se ejecutan automáticamente versiones históricas.

Crear un Run nuevo enlazado con `retry_of_analysis_id`, nueva reserva y la
misma atomicidad de Run. La repetición del Retry devuelve la ejecución nueva
ya creada antes de comprobar condiciones que hayan cambiado después.
Un actor no puede reutilizar una key propia de Run como Retry ni cambiar el
failedAnalysisId manteniendo la misma key.

## 7. Errores y disparo posterior al commit

| Situación | Resultado público |
|---|---|
| Sin sesión / Member | UNAUTHENTICATED / FORBIDDEN |
| UUID/key/estructura inválidos | INVALID_INPUT |
| Estimación o failed ajenos/inexistentes | NOT_FOUND |
| Estimación caducada / alterada o snapshot cambiado | ESTIMATE_EXPIRED / ESTIMATE_STALE |
| Otra ejecución activa, key con otro payload, failed sin Released | CONFLICT |
| Saldo insuficiente | INSUFFICIENT_CREDITS |
| Configuración inválida, fallo inesperado o timeout SQL | INTERNAL_ERROR con correlationId |

Mensajes de producto en inglés y controlados. Sin texto del proveedor,
consultas SQL, documentos, chunks, tokens o URLs firmadas en respuesta/logs.

Después de un commit exitoso, usar `after()` de Next.js para intentar la
invocación autenticada con `{ analysisId }`, timeout corto de 2 segundos y
`ANALYSIS_INTERNAL_TOKEN` independiente del worker de ingesta. Solo errores
sanitizados; fallo, timeout o 503 de readiness no revierten el Run. Un replay
puede repetir el disparo como mejor esfuerzo sin crear otro job/reserva.
La cola en PostgreSQL y el scheduler sostienen la durabilidad.

## 8. Corrección de lotes, leases e intentos

El intento inicial incrementa attempt_count a 1. Continuaciones exitosas de
ese intento conservan ese valor aunque haya más de tres lotes. Un retry por
error recuperable o recuperación tras lease vencido incrementa el contador,
con máximo 3 intentos totales. Mantener backoffs de 30 segundos y 2 minutos
hasta que las mediciones justifiquen un cambio documentado.

Handoff propuesto: terminar un lote mediante una transición SQL atómica que
guarda su checkpoint, cede la operación y deja el job queued con una marca
interna de continuación. El siguiente claim distingue continuación de retry,
rota el token de fencing y no incrementa attempt_count en la continuación.
queued/processing siguen ocupando el mismo slot del workspace. No se libera
una reserva en una cesión entre lotes ni se pierde el enlace del análisis.

Solamente una invocación puede reclamar cada continuación. RPC de handoff,
heartbeat y cierre verifican lease vigente, operation_id y cursor esperado;
una repetición no retrocede el cursor. Un worker antiguo pierde derecho a
escribir al ceder o expirar su operación. Heartbeat real durante llamadas
lentas, timeouts de proveedor y límites de intento/tiempo total medidos;
exportar constantes no equivale a aplicar los límites.

El inicio de cada intento y del análisis se registra por separado: started_at
no se reinicia en cada lote. El presupuesto total no se extiende mediante
renovaciones o claims. Base inicial para medir: lease 180s, heartbeat 30s,
lote 60s, intento 30 minutos y análisis 90 minutos.

S2-08 debe hacer durable la salida validada de cada lote antes de confirmar
su checkpoint, y protegerla con el mismo fencing. El contrato del handoff
se documenta para ese consumidor. Esta entrega prueba el control de lotes
con dobles explícitos, pero no habilita ejecución productiva con staging o
finalización ausentes. La firma actual de `AnalysisFinalization.finalize`
se conserva; el punto de persistencia por lote es una responsabilidad
adicional de S2-08, no un cierre que descarte hallazgos previos.

## 9. Recuperación programada

Añadir un scheduler PostgreSQL con pg_cron/pg_net que invoque el sweep cada
minuto. URL y token internos se resuelven de configuración privada/Vault;
no quedan embebidos en migraciones, seed o logs. La migración instala las
funciones/grants; la habilitación valida configuración antes de programar.
La falta de configuración no se presenta como un scheduler operativo.

La Edge admite un modo sweep autenticado sin analysisId y sigue aceptando
el disparo dirigido de Run. El payload de sweep no transporta actor, scope,
coste ni finalizaciones. Hacer como máximo un claim por invocación; el
arranque, las continuaciones y cron pueden coincidir sin duplicar el lote.
Registrar últimos disparos/resultados mediante metadatos técnicos seguros.

La continuación inmediata usa la API de tareas de fondo del runtime y queda
acotada. Cron recupera una continuación perdida, queued sin disparo, retries
cuyo backoff terminó y leases vencidos. No depender de self-fetch como único
mecanismo ni de que llegue actividad de otro usuario. Evitar mantener abierta
una cadena recursiva ilimitada de funciones.

El sweep y la marca terminal actual de claim no pueden publicar un failed
productivo sin la liberación/evento de S2-08: preservar readiness cerrada y
registrar este requisito de integración. Los tests con transiciones falsas
no prometen liberación real.

## 10. Comprobación de capacidad en esta entrega

Evaluar Edge antes de aceptar la integración del desarrollo. La matriz cubre
cero pares, más de 30 pares, más de 1.000 pares, varios workspaces y hasta
20 versiones, incluyendo el límite S1 de 500 chunks por versión. No basta
una prueba con veinte archivos de un chunk cada uno. Medir por separado
retrieval completo, resumen/fingerprint, tamaño transferido, lote y retries.

Primero corpus/vectores controlados y llamadas de latencia controlada. Es
evidencia técnica de mecanismos y presupuesto; no mide calidad del proveedor.
Completar contraste con latencias de un proveedor real cuando exista su
adaptador/configuración; no afirmar capacidad productiva a partir de fakes.
No implementar S2-07 ni registrar prompts/documentos para obtener esa medida.

Criterios técnicos propuestos por el agente:

- Todas las pruebas funcionales anteriores pasan sin backdating manual para
  hacer avanzar lotes, ni llamadas manuales para simular al scheduler.
- Lotes con p99 observado dentro de 60s y presupuesto de invocación completo
  como máximo 70% del límite wall-clock efectivo del entorno medido.
- CPU y memoria con al menos 30% de margen respecto de los límites efectivos;
  si el entorno no permite observarlos, esos indicadores quedan pendientes.
- El alcance completo cabe en los presupuestos de intento/90 minutos y los
  límites efectivos del proveedor, sin reducir silenciosamente los 20 ni
  truncar chunks/pares. Una extrapolación se etiqueta como tal y no sustituye
  ejecutar el recorrido admitido cuando se reclame aceptación completa.
- Tras perder un disparo, queued/continuación se reclama en el siguiente
  ciclo de cron; tras crash, después del lease/backoff correspondiente más
  un ciclo. Conservar análisis, coste y reserva.

Registrar versión SHA, runtime, plan/límites, corpus y tamaños, número de
ejecuciones/muestras, tiempos, errores y origen de cada medida. p99 de una
muestra pequeña se presenta como observación limitada, sin garantía estadística.
Las mediciones locales no prueban límites alojados. La verificación alojada
es parte de este trabajo técnico, pero requiere una acción de despliegue
explícitamente autorizada cuando exista un candidato revisable. No se aplica
ningún cambio remoto como parte del diseño ni de la migración local.

Salida del gate: cumplido con evidencia, incumplido o pendiente por evidencia
faltante. Incumplido implica proponer una corrección o un ADR para un proceso
Node de análisis separado de ingesta. No cambiar de runtime ni ampliar
presupuestos/reducir alcance automáticamente. Pendiente impide afirmar que
la condición se cumplió; no se traslada como cierre ficticio a S2-12.

## 11. Pruebas y aceptación por responsabilidad

| Área | Evidencia exigida en este desarrollo |
|---|---|
| Estimación | 20 chunks/0 pares = 2 créditos; 10/5 = 3; revisión detecta chunks sin pares; recuperación íntegra de más de 1.000 pares; fingerprint determinista |
| Seguridad | Admin/QA del tenant; Member/anon denegados; estimación de otro actor/tenant; INSERT directo denegado; inputs extra/coste/rol ignorados o rechazados sin autoridad |
| Atomicidad | Fallo de reserva o inserción de scope deja cero análisis, asociaciones y movimientos; coste persistido = reservado = confirmado |
| Idempotencia | Doble clic concurrente, respuesta perdida, replay tras caducidad/cambio documental, misma key con payload distinto, Run versus Retry |
| Concurrencia | Sesiones SQL reales: mismo workspace/keys distintas y actores distintos, misma key, sobre-reserva y dos workspaces independientes; no sustituir por una prueba omitida |
| Retry manual | Failed Released, nueva ejecución enlazada y reserva; rechazo de queued/completed/ajeno/no liquidado; repetición devuelve el mismo Retry |
| Worker | Más de tres lotes en un intento, dos continuaciones concurrentes, heartbeat, crash sincronizado, fencing, backoff y exactamente dos retries por fallo |
| Recovery | Cron real local, navegador sin actividad, disparo/continuación perdidos, lease vencido y ausencia de doble reserva |
| Capacidad | Matriz y evidencia del §10, separando local, alojado, fake y real |
| Regresión | test:db, fixtures, tipos SQL regenerados, unitarias/integración pertinentes, typecheck, lint y build por los cambios de Server Actions/Edge |

S2-05 puede demostrar sus comandos y contabilidad con SQL real y fixtures de
failed/Released sin implementar el proveedor ni la finalización de S2-08.
El informe de cierre distingue: comandos S2-05, prerrequisitos corregidos,
estado del gate Edge y aceptación del vertical S2-07/S2-08 todavía pendiente.
La entrega conjunta no se declara completa con el gate técnico sin resolver.

## 12. Decisiones técnicas aprobadas y trabajo del builder

El usuario aprobó con este documento las propuestas del agente: RPC privilegiada con
actor verificado y reautorizado; resumen SQL completo y lectura paginada de
pares; key 1–128; Retry permitido a Admin/QA del tenant con scope de la nueva
estimación; token de análisis independiente; after con 2s; handoff queued
distinto de retry; cron cada minuto y márgenes de capacidad del §10.

El builder decide nombres de RPC/campos, distribución mínima de archivos,
reutilización concreta de helpers, forma del cursor/SQL y división de
migraciones. Debe mantener el orden de bloqueos y contrato productor/consumidor,
regenerar tipos y actualizar documentación S2-04/S2-06 afectada. No introducir
capas genéricas, endpoints REST paralelos ni tablas de candidatos.

## 13. Documentación técnica consultada

- Guía instalada de Next.js 16.3.5:
  `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md`.
- Context7, Next.js: [after y duración del host](https://nextjs.org/docs/app/api-reference/functions/after).
- Context7, Supabase: [scheduler con pg_cron/pg_net/Vault](https://supabase.com/docs/guides/functions/schedule-functions),
  [límites de Edge](https://supabase.com/docs/guides/functions/limits) y
  [tareas de fondo](https://supabase.com/docs/guides/functions/background-tasks).

Los límites consultados son una referencia para diseñar la medición, no
evidencia de que este worker o este despliegue los cumplan.
