# Contrato operacional — S2-05 Run/Retry idempotente y handoff al worker

**Ticket:** S2-05

**Módulo:** `src/modules/analysis/` y migraciones Supabase

**Depende de:** contratos S2-01, ledger S2-02 y estimación S2-04

**Estado:** Run/Retry SQL implementados; Server Actions y disparo al worker quedan en la tarea siguiente.

## 1. Límite de responsabilidad

S2-05 crea o recupera una ejecución durable en PostgreSQL, sus versiones exactas
y una reserva de créditos. La RPC deja el análisis en `queued`; no procesa
documentos ni llama proveedores.

El procesamiento continúa a cargo del worker en el repositorio separado
`KDM/kdm-demo-worker`. Esta entrega no copia su código, cambia su configuración
ni añade una cola o un endpoint de proveedor alternativo. La llamada al worker
después del commit se implementa en la tarea S2-05 siguiente; la durabilidad se
mantiene en el job almacenado en PostgreSQL.

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

La Server Action asignará estos códigos a `ActionResult<T>` y mensajes de
producto controlados. Nunca debe exponer errores SQL crudos, manifiestos,
versiones privadas o datos de retrieval. Una violación de unicidad `23505` no
equivale por sí sola a replay exitoso.

## 6. Verificación local

`supabase/tests/database/023_s2_05_run_commands.test.sql` cubre permisos,
reserva única, replay, expiración, scope, Retry y rollback. Las pruebas de
integración `analysis-run.test.ts` y `analysis-run-concurrency.test.ts`
ejercitan PostgREST y sesiones PostgreSQL concurrentes contra Supabase local.
No prueban la interfaz ni una ejecución end-to-end con el worker separado;
esos gates pertenecen a las tareas posteriores.
