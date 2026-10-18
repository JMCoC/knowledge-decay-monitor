# Aceptación local — S2-05

**Estado: implementación local completa; aceptación alojada y flujo integral
pendientes.** La reserva/Run/Retry idempotentes, recuperación durable y
snapshot interno de pares están implementados. La matriz local ahora completa
los escenarios grandes dentro del límite de medición. Siguen pendientes la
medición de límites efectivos del worker Edge alojado y las integraciones reales
de S2-07/S2-08; esta acta no afirma aceptación end-to-end de esos componentes.

La ingesta Node continúa en `C:\KDM\kdm-demo-worker`; análisis continúa en
Supabase Edge. Este cambio no modifica el repositorio separado ni copia su
worker. Las pruebas técnicas de esta acta usan solo Supabase local y datos
sintéticos; no invocan un proveedor de IA ni crean Run/reservas.

## Evidencia local

La matriz se ejecutó con Node `v24.11.0` y Supabase CLI `2.117.0`, después de
aplicar localmente las migraciones `20261018021500` y `20261018022500` sin
`db reset`. El checkout estaba dirty y Task 8 aún no tenía commit. Cada salida
JSON registra su propia fecha `measuredAt`.

El runner mide por separado `retrieve_candidate_pairs` en PostgREST como
comparación auxiliar; `private.analysis_retrieval_summary_for_run` en su
primera llamada (materializa el snapshot) y en llamadas cacheadas;
`private.analysis_candidate_pair_snapshot_page`; y 20 ejecuciones del
`runBatch` real en Node con proveedor fake y persistencia sin efectos. Para el
recorrido keyset se usa un tope de 90 s por workspace fixture. No se crea una
Run ni se reserva crédito. La llamada SQL directa mide helpers privados, no
las RPC públicas con validación de lease (`read_analysis_retrieval_summary` y
`read_analysis_pair_batch`) ni el runtime Edge alojado.

| Escenario | Pares del snapshot | Keyset recorrido | Resumen inicial / máximo* | Resumen cacheado máx. | Keyset | `runBatch` p99 | Gate |
|---|---:|---:|---:|---:|---:|---:|---|
| `zero-pairs` | 0 | 0/0, completo | 20.0 ms | — | 0.001 ms | — | `pending` |
| `multi-batch` | 40 | 40/40, 4 páginas | 29.8 ms* | — | 31.4 ms | 1.75 ms | `pending` |
| `over-1000` | 2,500 | 2,500/2,500, 250 páginas | 1,154.4 ms | 10.24 ms | 1.183 s | 2.116 ms | `pending` |
| `twenty-versions` | 5 | 5/5, 1 página | 29.6 ms* | — | 8.0 ms | 1.283 ms | `pending` |
| `max-chunks` | 2,500 | 2,500/2,500, 250 páginas | 16.651 s | 18.04 ms | 1.707 s | 5.282 ms | `pending` |
| `multi-workspace` | 80 | 80/80, 8 páginas | 22.8 ms* | — | 53.7 ms | 1.204 ms | `pending` |

`*` En `zero-pairs`, `multi-batch`, `twenty-versions` y `multi-workspace`, la
salida usada no separó la primera llamada de las llamadas cacheadas; se reporta
el máximo de resumen observado. Solo `over-1000` y `max-chunks` tienen ambas
mediciones separadas.

`max-chunks` conserva los 20×500 chunks (10.000 en total), materializa 2.500
pares y completa las 250 páginas en 1.707 s. Su primera llamada al resumen
toma 16.651 s; las posteriores reutilizan el resultado y alcanzan como máximo
18.04 ms. `over-1000` también completa 250/250 páginas: 1.183 s de recorrido,
con 1.154 s en la primera materialización y 10.24 ms como máximo en caché.
PostgREST auxiliar puede devolver `57014` cerca de su timeout local de 8 s en
`max-chunks`; ese endpoint no forma parte del recorrido del worker y su fallo
no invalida el snapshot ni las páginas internas.

El cambio aprobado guarda solo IDs, orientación y similitud de candidatos en
tablas privadas, sin duplicar texto; cada página carga texto de chunks dentro
del límite del lote. Los retries y continuaciones conservan el snapshot; una
transición terminal lo elimina. El primer resumen crea pares y fingerprint en
una sola evaluación del retrieval; las llamadas siguientes validan scope,
manifiesto y revisión de chunks y no recalculan retrieval. La prueba de
integración cubre caché, scope vacío, continuidad por retry y limpieza
terminal. Esta medición no es una Run completa ni un benchmark del Edge
alojado y no justifica elevar timeouts ni cambiar runtime.

Las muestras de `runBatch` verifican el código real con texto sintético y
proveedor fake; no representan latencia de Edge ni del proveedor. Los gates
permanecen `pending`: faltan límites efectivos de CPU, memoria y wall-clock del
runtime alojado, latencia real del proveedor y un p99 de resumen con suficientes
muestras. El benchmark confirma recorrido local completo bajo el límite de
90 s, pero no el presupuesto de ejecución alojada.

## Dependencias de integración

| Gate | Estado | Evidencia faltante |
|---|---|---|
| Worker Edge alojado | `pending` | Deploy/configuración autorizada y medición de sus límites efectivos |
| S2-07 proveedor real | `pending S2-07` | Adapter real y latencias controladas con proveedor |
| S2-08 finalización | `pending S2-08` | Staging de findings, liquidación/liberación y evento terminal reales |
| S2-09 UI/estado | `pending S2-09` | Lectura/RLS del estado y proyección pública `AnalysisSnapshot.canRetry` |
| Capacidad máxima local | `complete local / hosted pending` | 20×500 obtuvo 2.500/2.500 pares y recorrió 250/250 páginas; faltan CPU/memoria/wall-clock efectivos del Edge alojado |

`retry_analysis` es la autoridad del servidor: prueba el failed padre, el
ledger completamente `Released` y la ausencia de otro análisis `queued` o
`processing` en el workspace. La proyección `AnalysisSnapshot.canRetry` es una
lectura de presentación para S2-09; no existe aún la consulta/UI que la
consume. Se aclaró esta división en el contrato y en el runbook S2-06. La
finalización real que genera Released depende de S2-08.

## Migraciones, CI y seguridad del entorno

`supabase migration list --local` confirmó la base alineada hasta
`20261018022500_s2_05_empty_comparison_candidate_snapshot`, incluida la
migración de materialización de candidatos. No se usó `db reset`. Cada fixture
de capacidad comprobó su propia limpieza; al terminar la suite global no había
usuarios/workspaces sintéticos huérfanos recientes (ventana de 30 minutos),
snapshots terminales ni un job de recovery activo. No se limpió el histórico
local ajeno a esta ejecución.

Las migraciones de recovery y de snapshot de pares están clasificadas en el
stage `s2_06`; las pruebas aseguran que no entran en stages anteriores.
`.github/workflows/s1-01.yml` ya
ejecuta las suites genéricas `test:unit`, `test:db` y `test:integration`; esta
última incluye automáticamente `tests/integration/**/*.test.ts`, incluida la
recuperación por cron. No hace falta duplicar pasos en el workflow. CI remoto
no se ejecutó porque esta rama aún no se publica.

El modo `--target hosted` del runner solo imprime `pending` y no hace llamadas
remotas ni despliegues.

## Verificación de código y suite local

En esta revisión pasaron `test:db` (26 archivos/778 pruebas),
`check:database-types`, `test:fixtures`, `typecheck`, `lint` (0 errores y 3
warnings preexistentes), `test:unit` (91 archivos/654 pruebas), el build local,
la política/inventario/fixtures focalizados (23/23), el snapshot materializado
(3/3), recovery (4/4), `processing-completion` (3/3) y la suite global de
integración (28 archivos/64 pruebas, 818.21 s). Durante el diagnóstico se
corrigió el harness SQL para leer el SQLSTATE antes del marcador de fin; la
limpieza Auth local ahora reintenta solo errores de transporte y verifica por
SQL la existencia del usuario sintético exacto antes de repetir el borrado.
La integración contra Edge alojado y los providers reales sigue pendiente por
S2-06/S2-07 y configuración autorizada.

## Cómo repetir la matriz local

Requiere Docker y el Supabase local iniciado con las migraciones aplicadas.
Cada comando crea y elimina únicamente sus workspaces/chunks sintéticos; no
resetea la base, ejecuta el seed ni crea un análisis o una reserva.

```powershell
npx pnpm@12.5.1 run analysis:capacity --target local --scenario zero-pairs
npx pnpm@12.5.1 run analysis:capacity --target local --scenario multi-batch
npx pnpm@12.5.1 run analysis:capacity --target local --scenario over-1000
npx pnpm@12.5.1 run analysis:capacity --target local --scenario twenty-versions
npx pnpm@12.5.1 run analysis:capacity --target local --scenario max-chunks
npx pnpm@12.5.1 run analysis:capacity --target local --scenario multi-workspace
```

La salida JSON incluye `gate` y `reasonCodes`. `pending` retorna el código de
salida 2 y `failed`, el 1; PNPM puede envolver el código no cero como fallo de
ciclo de vida, así que para interpretar la medición se lee el JSON emitido.
`postgrestFailureCode` es auxiliar y no representa el resultado del worker.
Revisa `workerSummaryFailureCode`, `workerPageFailureCode`,
`keysetPairCount/keysetRetrievalComplete` y `workerBatchMeasured`. Un corte por
90 s informa traversal incompleto y mantiene el gate `pending`; no aprueba ni
fallará el análisis solo por ese tope de medición. El runner requiere Docker y
Supabase local con las migraciones aplicadas. No usa `db reset` ni llamadas
hosted.
