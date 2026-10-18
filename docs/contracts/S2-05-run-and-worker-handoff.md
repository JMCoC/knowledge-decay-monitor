# Contrato operacional — S2-05 Run/Retry idempotente y handoff al worker

**Ticket:** S2-05

**Módulo:** `src/modules/analysis/` y migraciones Supabase

**Depende de:** contratos S2-01, ledger S2-02 y estimación S2-04

**Estado:** Run/Retry SQL, Server Actions y disparo post-commit implementados; la UI de S2-09 y la ejecución productiva siguen en sus tickets propietarios.

## 1. Límite de responsabilidad

S2-05 crea o recupera una ejecución durable en PostgreSQL, sus versiones exactas
y una reserva de créditos. La RPC deja el análisis en `queued`; no procesa
documentos ni llama proveedores.

El procesamiento continúa a cargo del worker en el repositorio separado
`KDM/kdm-demo-worker`. Esta entrega no copia su código, cambia su configuración
ni añade una cola o un endpoint de proveedor alternativo. La app dispara la
Edge Function de análisis después del commit; la durabilidad se mantiene en el
job almacenado en PostgreSQL.

Las RPC de este contrato son privadas para el servidor de la aplicación. No
constituyen endpoints para el navegador ni un API REST nuevo.

## 2. RPC transaccionales

```sql
public.run_analysis(
  p_actor_id uuid,
  p_estimate_ref uuid,
  p_idempotency_key text,
  p_current_manifest jsonb
) returns table (analysis_id uuid, status public.analysis_job_status)

public.retry_analysis(
  p_actor_id uuid,
  p_failed_analysis_id uuid,
  p_estimate_ref uuid,
  p_idempotency_key text,
  p_current_manifest jsonb
) returns table (
  analysis_id uuid,
  status public.analysis_job_status,
  retry_of_analysis_id uuid
)
```

Ambas delegan en `private.create_analysis_run(...)`. Esa implementación no
tiene permiso `EXECUTE` para `service_role`, `authenticated` ni `anon`; las dos
RPC públicas solo se conceden a `service_role`. El servidor pasa el actor de la
sesión verificada. PostgreSQL vuelve a resolver su Profile, workspace y rol;
solo `Admin` y `QA Lead` pueden ejecutar el comando.

La key tiene entre 1 y 128 caracteres y no admite espacios en los extremos.
Workspace, rol, coste, arrays de versiones y manifiesto no vienen del cliente:
se derivan del actor o de la estimación S2-04 persistida.

## 3. Orden y replay

Una operación nueva valida al actor, bloquea la fila del workspace, busca la
key del actor y compara la identidad exacta del comando. La huella de comando
SHA-256 representa `{ kind, estimateRef, failedAnalysisId }`; permanece
separada de `request_fingerprint`, que identifica el snapshot de retrieval.

Si coinciden key e identidad, la RPC devuelve el mismo análisis y su estado
actual antes de revisar TTL, configuración o elegibilidad documental. Esto
permite recuperar una respuesta perdida después de caducar la estimación o
cambiar el puntero del documento. El actor todavía debe conservar permiso en
el workspace. La misma key con otro tipo de comando, estimate o failed devuelve
conflicto. Las filas históricas sin huella de comando nunca se consideran un
replay exitoso.

Para una key nueva, Run comprueba que la estimación pertenezca al actor y al
workspace, no haya caducado y conserve manifiesto y fingerprint versionados.
Revalida versiones `ready` y `active`, punteros, unión de máximo 20 versiones,
fingerprint, conteos y coste con el resumen SQL bloqueado. Un snapshot cambiado
se rechaza como stale.

Después de validar, una única transacción crea el análisis `queued`, sus filas
`analysis_documents` para los roles source/comparison y la reserva por el coste
confirmado. Incluye ambas filas si una versión ocupa los dos roles. Si la
reserva falla, se revierten análisis y scope; la key queda disponible.

La fila del workspace serializa comandos dentro del tenant y deja avanzar
otros workspaces. Las funciones imponen `lock_timeout = 3s` y
`statement_timeout = 30s`.

## 4. Retry manual

Retry exige que el padre exista en el workspace actual y siga `failed`. Su
ledger debe tener un `Reserved` y un `Released` por el coste completo, sin
ningún `Consumed`. Una liberación faltante o inconsistente devuelve conflicto;
Retry no intenta reparar el ledger.

El actor actual necesita su propia estimación vigente. Puede ser otro Admin o
QA Lead del mismo workspace, y el nuevo scope puede diferir del padre. La nueva
ejecución conserva el vínculo `retry_of_analysis_id`, crea una reserva propia y
empieza con key nueva. Repetir el mismo comando devuelve el nuevo análisis
antes de volver a validar el estado del padre.

La RPC también rechaza el Retry mientras el workspace tenga otro análisis
`queued` o `processing`; esa condición es autoritativa junto con el ledger
completamente `Released`. `AnalysisSnapshot.canRetry` es una proyección de
lectura para la experiencia S2-09: debe reflejar el estado persistido, el ledger
y el slot activo, pero nunca reemplaza la validación de `retry_analysis`.
S2-05 no añade la consulta de estado ni la UI que S2-09 consume.

## 5. SQLSTATE de dominio

| SQLSTATE | Significado para la frontera de aplicación |
|---|---|
| `P0002` | Actor, estimación o failed no encontrado en el tenant autorizado |
| `42501` | Actor sin permiso o llamada directa sin privilegio |
| `22023` | Estructura o key inválida |
| `P2001` | Saldo insuficiente; el comando y la reserva se revierten |
| `P2002` | Key conflictiva, análisis activo o Retry sin reserva liberada |
| `P2101` | Estimación caducada para un comando nuevo |
| `P2102` | Estimación o snapshot stale |
| `55P03`, `57014` | Lock/statement timeout; se trata como fallo interno recuperable por la aplicación |

Las Server Actions asignan estos códigos a `ActionResult<T>` y mensajes de
producto controlados. Nunca exponen errores SQL crudos, manifiestos, versiones
privadas o datos de retrieval. Una violación de unicidad `23505` no equivale
por sí sola a replay exitoso.

## 6. Server Actions y consumo desde S2-09

La frontera pública del módulo conserva los DTO compartidos:

```ts
runAnalysis(input: RunAnalysisInput): Promise<ActionResult<RunAnalysisResult>>
retryAnalysis(input: RetryAnalysisInput): Promise<ActionResult<RetryAnalysisResult>>
```

`RunAnalysisInput` contiene solo `estimateRef` e `idempotencyKey`; Retry agrega
`failedAnalysisId`. La Action revalida sesión/Profile y rol Admin/QA, valida
UUIDs, una key opaca de 1–128 caracteres sin espacios extremos y rechaza campos
adicionales. El actor y el manifiesto provienen del servidor; la UI no puede
enviar workspace, rol, coste o configuración.

El cliente interpreta `ActionResult` y los códigos controlados:
`UNAUTHENTICATED`, `FORBIDDEN`, `INVALID_INPUT`, `NOT_FOUND`, `CONFLICT`,
`INSUFFICIENT_CREDITS`, `ESTIMATE_EXPIRED`, `ESTIMATE_STALE` e
`INTERNAL_ERROR`. Si pierde la respuesta de un Run/Retry, reenvía exactamente
la misma key y payload para recuperar el mismo `analysisId`; no crea otra key
por timeout de red. Un Retry manual nuevo sí requiere una nueva estimación y
una key distinta.

Solo después de que el RPC confirme su commit, la Action registra `after()`
para hacer POST a la URL configurada de Supabase en `/functions/v1/analyze`,
con el cuerpo exacto `{ "analysisId": "<uuid>" }`, Bearer
`ANALYSIS_INTERNAL_TOKEN` y timeout de 2 segundos. El token es server-only e
independiente de `INGESTION_INTERNAL_TOKEN`. El dispatch es best-effort: timeout,
401, 503, fallo de red o error de registro no cambian el resultado confirmado.
La cola SQL conserva el trabajo durable y las fallas de dispatch solo admiten
telemetría segura, sin token, cuerpo, URL ni respuesta cruda. Un replay puede
repetir el disparo sin crear otro job ni reserva.

## 7. Verificación local

`supabase/tests/database/023_s2_05_run_commands.test.sql` cubre permisos,
reserva única, replay, expiración, scope, Retry y rollback. Las pruebas de
integración `analysis-run.test.ts` y `analysis-run-concurrency.test.ts`
ejercitan PostgREST y sesiones PostgreSQL concurrentes contra Supabase local.
No prueban la interfaz ni una ejecución end-to-end con el worker separado;
esos gates pertenecen a las tareas posteriores.

## 8. Handoff SQL, intentos y deadlines

La migración `20261017205245_s2_05_worker_handoff.sql` separa
`attempt_started_at`, `attempt_deadline_at` y `analysis_deadline_at`. El primer
claim fija el presupuesto total de 90 minutos; cada intento admite hasta 30
minutos y cada lease hasta 180 segundos, siempre limitados por el deadline
total. Renew y continuación nunca mueven esos deadlines. Filas que ya estaban
`processing` reciben límites derivados de sus timestamps actuales, sin tiempo
adicional; una retry `queued` conserva el deadline total y obtiene uno de
intento al reclamarse.

```sql
public.yield_analysis_batch(
  p_analysis_id uuid,
  p_operation_id uuid,
  p_expected_processed_pairs integer,
  p_checkpoint jsonb
) returns boolean

public.read_analysis_retrieval_summary(p_analysis_id uuid, p_operation_id uuid)
public.read_analysis_pair_batch(
  p_analysis_id uuid, p_operation_id uuid,
  p_after_low uuid, p_after_high uuid, p_limit integer
)

public.renew_analysis_lease(
  p_analysis_id uuid, p_operation_id uuid,
  p_expected_processed_pairs integer, p_checkpoint jsonb
)
```

`yield_analysis_batch` requiere avance estricto, checkpoint esperado actual,
operation_id vigente, lease y deadlines activos. Guarda el checkpoint, mueve
`processing → queued` con `continuation_pending = true`, libera el token anterior
y no fija backoff ni consume otro intento. El siguiente claim rota
`operation_id`, mantiene la reserva, slot, checkpoint, contador y deadlines. Un
fallo recuperable limpia la marca de continuación y programa el backoff; un
crash con lease vencido inicia otro intento. Una continuación vencida termina
en `failed/TIMEOUT`; el intento 3 vencido termina en
`failed/ATTEMPTS_EXHAUSTED`.

Las dos RPC de lectura son exclusivas de `service_role`. Derivan workspace,
scope y configuración desde el análisis, sus roles persistidos y la estimación
inmutable enlazada; no aceptan IDs de versiones ni parámetros de retrieval del
caller. El resumen recalcula fingerprint, conteos y coste; ambas lecturas
requieren la operación, el lease y los deadlines vigentes. La página limita el
lote a 1–10 pares, bloquea las versiones activas mientras lee y rechaza una
revisión de chunks distinta del snapshot. La firma anterior de
`renew_analysis_lease(analysis_id, operation_id, checkpoint)` se mantiene para
compatibilidad; las dos variantes limitan el lease y rechazan un checkpoint
regresivo.

Para evitar recalcular los candidatos en cada lote, la primera lectura de
resumen del worker materializa atómicamente una cabecera y los IDs orientados
de pares en `private.analysis_candidate_pair_snapshots` y
`private.analysis_candidate_pair_rows`. Las lecturas posteriores validan el
scope y la revisión completa de chunks y reutilizan esa lista; la página une
solo los IDs solicitados con el texto vigente en `document_chunks`. No se
duplica texto en el snapshot ni se concede acceso directo a esas tablas. La
lista se conserva mientras el análisis siga `queued`/`processing` para soportar
continuaciones y retries automáticos, y se elimina en la transición terminal a
`completed` o `failed`. Esta es la excepción explícita aprobada en S2-05 a la
regla S2-04 de no persistir candidatos; la estimación no cambia.

La cesión y la terminalización por deadline no liquidan créditos ni emiten
eventos. Esa unidad atómica, junto con el staging durable de hallazgos, sigue
siendo responsabilidad de S2-08. La migración de handoff no modifica el worker
del repositorio separado `KDM/kdm-demo-worker`.
