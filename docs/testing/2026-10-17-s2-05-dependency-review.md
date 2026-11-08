# Revisión de dependencias de S2-05

Fecha: 2026-10-17. Checkout: `feature/idempotent_analysis_run`, HEAD
`252d504f50cfa54f5c7601d0e5b0371819c9103c`. El árbol estaba limpio antes
de la revisión. Este documento registra análisis y pruebas; no es un diseño
aprobado ni autoriza implementar cambios de producto.

## Resultado

S2-03 aporta el selector y S2-04 aporta retrieval/estimaciones. S2-06 aporta
leases y un worker con dependencias pendientes. Hay problemas de precio y
continuidad que impiden afirmar que la integración completa funciona.
S2-05 sigue sin implementar: sus contratos existen, pero no sus comandos Run/Retry.

Fuentes: [tickets S2](../Tickets/sprint-2-ai-analysis.md),
[slice y coordinación](../PRD/sprint-2-ai-analysis-slice.md),
[PRD §§24–32](../PRD/knowledge-decay-monitor-prd-final.md),
[contrato S2-04](../contracts/S2-04-retrieval-estimation.md) y
[runbook S2-06](s2-06-analysis-worker-runbook.md).

## Análisis por merge

| Merge | Entrega | Integración con S2-05 |
|---|---|---|
| `f39e94f3095f734820476b01b9ec0f4ab23cc35a` — PR #18, S2-04 | 20 archivos; RPC de retrieval con umbral 0.75, Top K 5, deduplicación, fórmula entera, fingerprint y estimaciones persistidas con TTL de 30 minutos | Reutilizar retrieval, precio y referencias opacas; corregir el conteo/revisión de chunks antes de basar reservas en ellos |
| `ac0cc1ff3407fbc32505f7b4683b839ed5c6c430` — PR #20, S2-03 | 30 archivos; proyección bajo RLS de versiones active + ready, selección source/comparison, búsqueda/filtros, selección entre páginas y límite de unión de 20 | El selector llama a la estimación real e invalida respuestas obsoletas al cambiar el alcance; el botón final conserva un alert explícito para S2-09 |
| `252d504f50cfa54f5c7601d0e5b0371819c9103c` — PR #21, S2-06 | 41 archivos; claim, renew, complete/fail, fencing, checkpoints, Edge Function, readiness y pruebas con proveedor falso | El disparo posterior al commit puede usar `{ analysisId }`; continuidad, presupuesto de intentos y recuperación requieren corrección para una ejecución durable |

No encontré un bloqueo adicional en la selección de S2-03 dentro del recorrido
revisado. Sus pruebas unitarias están incluidas en la suite ejecutada; no se
ejecutó Playwright durante esta revisión.

## Problemas comprobados

### 1. S2-04 cuenta únicamente chunks presentes en pares

`src/modules/analysis/actions.ts:138` construye `uniqueChunkIds` desde los
pares devueltos. `src/modules/analysis/worker/context.ts` reproduce ese conteo.
El ticket y el slice exigen todos los chunks de la unión source/comparison.

Caso comprobado con los helpers actuales: 20 chunks y cero pares dan un
conteo de 0 y precio de 1 crédito. La fórmula para el alcance real da 2.
La revisión tampoco cambia al añadir un chunk que no participe en pares.
Esto afecta al precio confirmado y a la detección de estimaciones obsoletas.

Corrección necesaria: obtener los IDs de todos los chunks del alcance y usar
el mismo conteo/revisión en estimación, validación de Run y worker. Los pares
siguen contándose una sola vez. Añadir pruebas con chunks sin vecinos.

### 2. S2-06 no continúa automáticamente mientras el lease está vigente

`runBatch` renueva el lease. La Edge Function hace self-fetch cuando quedan
pares, pero `runAnalysisJob` vuelve a llamar a `claim_analysis`, que solo
admite queued o processing con lease vencido. La continuación inmediata
queda idle, sin procesar el siguiente lote.

La integración existente reconoce esta situación: en
`tests/integration/analysis-worker.test.ts:327` vence manualmente el lease
para poder continuar. Eso prueba reanudación forzada, no continuidad autónoma.

La reproducción SQL local devolvió `freshContinuationClaims: 0` tras una
renovación exitosa. Se ejecutó dentro de una transacción terminada con ROLLBACK.

Corrección necesaria: distinguir continuar el intento dueño del lease de
reclamar un intento nuevo; conservar fencing y avanzar con checkpoints.

### 3. S2-06 consume los retries al avanzar lotes

Cada claim incrementa `attempt_count`, limitado a 3. Como cada lote vuelve a
reclamar, los lotes exitosos consumen el presupuesto de intentos. Con N=10,
un alcance de más de 30 pares no puede completarse por este recorrido,
incluso si se fuerza el vencimiento entre lotes y el proveedor siempre responde.

Reproducción SQL local: tres renovaciones exitosas, cero filas en el cuarto
claim, estado `failed`, `attempt_count = 3`. No se invocó proveedor ni se
persistieron estos cambios: ROLLBACK. La especificación S2-06 §4.4 exige que
el contador mida intentos del análisis y no lotes.

Corrección necesaria: avanzar lotes dentro del mismo intento; incrementar
el contador solo al iniciar o recuperar un intento. Probar más de tres lotes
sin fallo y, por separado, un intento inicial con dos retries por errores.

### 4. No existe recuperación programada del worker

El runbook S2-06 §7 y su especificación documentan que v1 usa sweep
oportunista. No hay scheduler que invoque el worker cuando se pierde el
disparo y no llega otra petición. Una vez reservado el saldo, ese análisis
puede permanecer queued y ocupar el único slot del workspace.

Es una limitación reconocida por S2-06; contradice la recuperación programada
del PRD §30. Para aceptar la durabilidad integrada hace falta un mecanismo
independiente del navegador y probar disparo perdido sin invocación manual.
Su tecnología y configuración todavía no se han decidido en esta revisión.

### 5. El guard de imports Deno falla en Windows

`tests/unit/deno-import-extensions.test.ts:35` compara las rutas nativas de
Windows con un prefijo terminado en `/`. El recorrido queda en un solo
archivo y falla `expected 1 to be greater than or equal to 14`.
La segunda aserción de extensiones puede pasar sin recorrer los módulos.

Reproducción aislada: persiste el fallo. Una comprobación de rutas mostró
`currentPrefixCheck: false` y `nativePrefixCheck: true` para un hijo válido.
Corregir el cálculo de pertenencia con rutas nativas/relativas y volver a
comprobar que se recorre el grafo completo.

## Límites de integración y precauciones para el diseño

- `createProvider()` y `createFinalization()` lanzan explícitamente hasta
  integrar S2-07/S2-08. El handler devuelve 503 sin reclamar el job; los
  dobles solo se habilitan en pruebas locales. No habilitarlos en producción.
- Las RPC terminales actuales no consumen/liberan reservas ni publican
  findings/eventos; está documentado como trabajo de S2-08. Un `failed`
  actual no demuestra por sí solo que se hayan liberado créditos.
- La prueba SQL concurrente real de claim está omitida en
  `020_s2_06_analysis_leases.test.sql:412`. El resultado PASS no demuestra esa
  concurrencia; S2-05 necesita sus propias carreras con sesiones reales.
- Admin/QA tienen INSERT directo en `analysis_estimates` bajo RLS. Eso aísla
  tenant/iniciador, pero no garantiza precio, TTL o fingerprint auténticos.
  Run debe validar íntegramente la estimación; leer esa tabla no basta.
- La base S2-01 ya aporta unicidad de key por workspace/actor, índice de un
  único análisis activo y relaciones exactas del scope. S2-02 aporta
  `private.reserve_analysis_credits`, que bloquea el workspace. Reutilizarlos
  dentro de una sola transacción, sin reservas mediante HTTP separado.
- Recuperar una petición idempotente ya confirmada debe funcionar aunque
  después caduque la estimación o cambien las versiones; distinguirla de un
  Run nuevo. Una key con payload distinto debe devolver CONFLICT.
- Retry manual necesita nueva estimación/reserva y enlace al failed previo;
  verificar liquidación anterior y slot disponible. Los retries automáticos
  conservan análisis y reserva. La UI completa corresponde a S2-09.
- S2-04 fija prompt/schema como `none` en su fingerprint. S2-05 debe acordar
  cómo congela la configuración que leerá S2-07; cambiar versiones después
  de confirmar no puede producir cargos con configuración distinta.

## Supabase local actualizado

Proyecto local: `knowledge-decay-monitor-s1-02`. CLI instalada: 2.117.0.
Se consultó documentación vigente de Supabase CLI mediante Context7 y se
ejecutó `npx pnpm@12.5.1 exec supabase migration up --local`.

Migraciones aplicadas:

1. `20261011030000_s2_03_eligible_documents_projection.sql`.
2. `20261012233545_s2_04_retrieval_estimation.sql`.
3. `20261015221607_s2_06_analysis_leases.sql`.

Historial local final: 31 migraciones. No se ejecutaron reset, seed ni
migraciones remotas. Recuentos verificados antes y después de migrar y de
las pruebas: 112 usuarios, 58 workspaces, 78 perfiles, 11 documentos,
11 versiones, 42 chunks, 11 objetos Storage, 2 análisis y 60 entradas del
ledger. Al terminar no había análisis queued/processing.

## Validación ejecutada

| Control | Resultado |
|---|---|
| `test:db` | PASS: 21 archivos, 641 pruebas declaradas; incluye 1 omitida de claim concurrente |
| `check:database-types` | PASS; no fue necesario modificar tipos |
| `test:fixtures` | PASS: Auth, REST, descargas firmadas y denegaciones |
| `typecheck` | PASS; Next.js generó tipos y TypeScript terminó con salida 0 |
| `lint` | PASS con 4 advertencias existentes y 0 errores |
| `test:unit` | 579 aprobadas, 2 fallidas, total 581 |
| Reejecución aislada de los dos archivos unitarios con `--testTimeout=20000` | 18 aprobadas, 1 fallida: persiste solo el guard de rutas Deno |
| Integración `analysis-estimation` + `analysis-worker` | 7 aprobadas, 1 fallida, total 8; proveedor/finalización falsos para worker |
| Reejecución aislada de crash de Edge | Sigue fallando; no demuestra recuperación tras crash |
| Diagnóstico SQL de continuación/intentos | Reproduce claims vacíos y agotamiento tras tres lotes; ROLLBACK |

El segundo fallo unitario inicial fue timeout de 5 segundos al parsear
fixtures DOCX/PDF con parsers reales. Pasó en aislamiento con margen de
20 segundos, sin cambios de código. No se atribuye a estos merges.

El test de crash falló primero al intentar detener el contenedor Edge y,
en aislamiento, porque la petición no terminó rechazada ni con el 502
esperado. El test usa una espera fija de 2,5 segundos antes de matar el
contenedor; no verifica previamente que el job haya comenzado. Hace falta
diagnosticar esa sincronización y conservar el estado HTTP observado antes
de atribuir el fallo al algoritmo de recuperación.

Build, Playwright, proveedores reales, despliegue y aceptación remota no se
ejecutaron. El contenedor local `supabase_vector` ya estaba reiniciándose
antes de aplicar migraciones; no bloqueó SQL/fixtures y no se cambió su
configuración en esta tarea.

## Continuación propuesta, pendiente de definir con el usuario

El usuario aprobó incluir las correcciones como prerrequisitos de S2-05 y
recordó que utiliza `C:\KDM\kdm-demo-worker` para ejecutar el worker.

### Aclaración del worker existente

Inspección actual de esa carpeta:

- Es un worktree del mismo repositorio, con HEAD separado en `c1a1e6e`
  (merge PR #12 del primer vertical), y estaba limpio.
- Su entrypoint es `scripts/ingestion-worker.ts`: consulta
  `claim_ingestion_job`, renueva mediante `heartbeat_ingestion_job` y procesa
  archivos, chunks y embeddings hasta `finish_processing`.
- No contiene el módulo `analysis` ni los merges S2 revisados. El entrypoint,
  el núcleo del worker de ingesta y `Dockerfile.ingestion` coinciden con los
  del checkout actual; no se encontró una divergencia de esos archivos.
- Su configuración `.env.worker` apunta a Supabase remoto. Solo se
  inspeccionaron nombres de variables y la clasificación del destino;
  no se copiaron valores secretos ni se inició o modificó el proceso.
- ADR-002 cubre ese runtime Node de ingesta. El ticket S2-06 y su código
  actual siguen asignando el análisis a Supabase Edge Function.

Usar el worker de ingesta existente no implica que esté ejecutando análisis
S2 ni que resuelva la recuperación de `public.analyses`. Antes de cerrar el
diseño hay que aclarar si el recordatorio conserva esa separación o pide
ampliar el worker Node para análisis. La segunda opción necesita documentar
explícitamente el cambio de runtime respecto de S2-06/PRD §30, sin alterar
silenciosamente los contratos. No se cambió ni actualizó el worktree del worker.

Decisión posterior del usuario: conservar ingesta Node y análisis Edge
separados y evaluar la condición técnica de capacidad en este desarrollo.
La propuesta completa queda en el
[diseño S2-05](../superpowers/specs/2026-10-17-s2-05-idempotent-analysis-run-design.md),
pendiente de aprobación del documento antes del plan y la implementación.

Corregir el conteo/revisión compartido y la continuidad/recuperación del
worker como cambios identificables de S2-04/S2-06; después implementar
S2-05 con autorización, validación de estimaciones, transacción Run/reserva,
idempotencia, Retry manual y disparo posterior al commit. Mantener la
finalización real y la UI completa en S2-08/S2-09, con sus límites de
aceptación explícitos. No implementar hasta acordar y aprobar el diseño.
