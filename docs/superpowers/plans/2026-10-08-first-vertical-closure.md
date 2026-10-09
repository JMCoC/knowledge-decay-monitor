# First Vertical Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** corregir los cinco defectos auditados y certificar S1-01 a S1-08 de inicio a fin en local, Preview y Production.

**Architecture:** conservar el monolito modular y el worker Node existente, con `embed` como auxiliar para `gte-small`. `ingestion` controla intentos, presupuesto y escrituras; `repository` presenta la proyección autorizada y solicita comandos. PostgreSQL bloquea y valida el intento antes de persistir chunks, activar v1 y actualizar el puntero en una sola transacción.

**Tech Stack:** Node.js 24.11.0, pnpm 12.5.1, Next.js 16.3.5, React 19.2.8, TypeScript estricto, Zod 4.6.5, supabase-js 2.117.2, SSR 0.12.7, Supabase CLI instalado 2.117.0, PostgreSQL/pgvector, pgTAP, Vitest 5.0.2, Playwright y Sentry 10.75.0. Conservar el lockfile y las versiones del proyecto.

**Spec:** [diseño aprobado](../specs/2026-10-08-first-vertical-closure-design.md), aprobado el 2026-10-08.

## Global Constraints

- Modelo `gte-small`, embeddings de 384 dimensiones y valores finitos; chunking determinístico 450/50 y ratio `chars/4` existente.
- Máximo de 500 chunks por versión; una entrada por llamada y máximo de dos llamadas simultáneas por intento.
- Presupuesto de 50 segundos desde el claim; los últimos cinco segundos se reservan para cierre. Lease recuperable después de 180 segundos.
- Upload de 1–10 archivos y máximo de 10 MiB por archivo; el éxito de transferencia no equivale a procesamiento exitoso.
- UI en inglés; documento, versión y original se conservan al recuperar o reintentar.
- Tenant y rol desde sesión verificada/Profile; Admin y QA Lead acceden al Repository, Member no obtiene permisos por ser Owner.
- URLs firmadas de 300 segundos; no logs ni artefactos con contenido, chunks, vectores, URLs firmadas, cookies, tokens o respuestas crudas de proveedores.
- Nueva migración; no reescribir migraciones aplicadas. Regenerar `database.ts`, no editarlo manualmente.
- No cola durable, scheduler, análisis LLM, búsqueda semántica ni consumo de créditos.
- Preservar checkout y datos locales; reset/seed/restart solo en CI descartable. Los cuatro objetos huérfanos remotos no se eliminan.
- Preview y Production usan el mismo Supabase: cualquier migración o cambio de `embed` debe ser compatible con las aplicaciones aún desplegadas.

## Review Focus

1. Una señal ya abortada no debe iniciar una llamada al proveedor, aunque el SDK combine timeout y señal; Task 2 incluye el caso previo al primer dispatch.
2. Respuestas fuera de orden o con `dims` incompatible no deben asociar vectores a otro chunk; Task 2 verifica orden, forma y metadatos.
3. Un claim envejecido antes de ejecutar el worker no recibe otros 50 segundos; Task 3 comprueba presupuesto consumido y fechas inválidas/futuras sin extenderlo.
4. Una respuesta perdida después de COMMIT no debe degradar `ready`, y un worker obsoleto no debe marcar fallido al nuevo; Tasks 1 y 3 prueban ambos casos.
5. La protección del deployment Preview puede bloquear el fetch interno aunque la página abra; Tasks 4 y 8 comprueban dispatch autenticado real y recuperación sin duplicación.

## Estado inicial y alcance de ejecución

La revisión parte de `develop` en `4beab01032f836da5aaf40e02f75d5089d587089`. Son ajenos al trabajo `.agents/`, `.claude/`, `skills-lock.json` y `supabase/snippets/`, que estaban sin seguimiento. El diseño y este plan son los únicos documentos nuevos de la fase de diseño; los archivos implementados se enumeran en File Structure. La auditoría temporal está en `.artifacts/vertical-audit/` y no se añade a Git.

Antes de implementar, leer `AGENTS.md`, la spec y las skills del método elegido. Usar `using-git-worktrees` si se crea una rama/check-out aislado; preparar el worktree en la ejecución, no en esta fase de planificación. El stack Supabase no queda aislado por crear un worktree: verificar su project ID antes de migrar o probar.

En esta terminal `pnpm` no está en PATH. Los comandos siguientes usan `npx pnpm@12.5.1`, equivalente permitido por `AGENTS.md`. Para consultar ayuda de Supabase sin resolución de paquetes puede usarse `node node_modules/supabase/dist/supabase.js`.

El usuario aprobó la ejecución nativa de las Tasks 1–9 y commits locales por entregable el 2026-10-08. Task 7 concreta el runbook antes del corte; Tasks 8–9 incluyen las protecciones, migraciones, despliegues y recuperación que ya están descritos en el alcance aprobado. Publicar la rama y completar la promoción Production siguen los gates del workflow, el estado remoto leído al momento y la revisión de la evidencia del candidato. Agrupar commits por entregable con listas explícitas; nunca usar `git add .`.

## File Structure

| Archivos | Responsabilidad | Task |
|---|---|---|
| Nueva migración con sufijo `_first_vertical_processing_guard.sql` | Fencing, deadline SQL y columna nueva al final de la vista Repository | 1 |
| `supabase/tests/database/010_processing.test.sql`, `009_repository_projection.test.sql`, `003_integrity.test.sql`, `006_upload_authorization.test.sql` | Guards, permisos y fixtures acotados/restaurables | 1 |
| `tests/support/local-sql-session.ts`, `processing-fixtures.ts`; `tests/integration/processing-completion.test.ts` | Dos sesiones reales, fixtures propios y timeout por HTTP | 1 |
| `src/types/database.ts` | Tipos regenerados | 1 |
| `src/modules/ingestion/embeddings.ts`; `tests/unit/ingestion-embeddings.test.ts`; `scripts/warm-local-embed.mjs` | Adaptador completo, concurrencia dos y medición representativa | 2 |
| `src/modules/ingestion/processing-budget.ts`, `processing.ts`; `tests/unit/ingestion-processing-budget.test.ts`, `ingestion-processing.test.ts` | Presupuesto y cierre reconciliado | 3 |
| `src/lib/observability/processing-failure.server.ts`; `tests/unit/processing-failure.test.ts` | Capture + flush acotado, solo servidor | 3 |
| `src/modules/ingestion/processing-dispatch.ts`, `actions.ts`, `processing-retry.ts`; `src/app/api/ingestion/process/route.ts` | Dispatch esperado, recuperación y claim | 4 |
| `tests/unit/ingestion-scheduling.test.ts`, `ingestion-processing-retry.test.ts`, `ingestion-retry-action.test.ts`, `ingestion-process-route.test.ts`; `tests/integration/processing-retry.test.ts` | Fallos de dispatch, permisos, duplicados y tres estados recuperables | 4 |
| `src/types/contracts.ts`; Repository repository/service/page/button; nuevos `ui/processing-recovery.ts`, `ui/processing-lease-refresh.tsx` y pruebas | Timestamp en proyección, Start, Retry y refresco de leases | 5 |
| `tests/support/processing-inputs.ts`; `tests/e2e/processing-flow.spec.ts`, `processing-retry.spec.ts`, `upload.spec.ts`; `.github/workflows/s1-01.yml` | Aceptación mantenida y CI | 6 |
| `docs/testing/first-vertical-cutover.md`; `docs/reviews/2026-10-08-first-vertical-acceptance.md` | Runbook y evidencia por entorno | 7–9 |

El timestamp de la migración lo genera la CLI durante Task 1. `$closureMigration` identifica ese archivo exacto; no es una decisión pendiente ni permiso para editar otras migraciones. `embed/index.ts` conserva su contrato compatible de arrays y su autenticación; solo se modifica si una regresión de la política nueva demuestra una corrección necesaria, sin introducir otro proveedor.

## Interfaces compartidas

```ts
// embeddings.ts: adaptador completo de una versión, no una única invocación.
export function embedBatch(
  texts: string[],
  options?: { signal?: AbortSignal; assertCanStart?: () => void },
): Promise<string[]>;

// processing-budget.ts: señales de trabajo y cierre independientes.
export interface ProcessingBudget {
  workSignal: AbortSignal;
  remainingMs(): number;
  assertWorkRemaining(): void;
  closeSignal(maxMs: number): AbortSignal;
  dispose(): void;
}
export function createProcessingBudget(
  startedAt: string,
  now?: () => number,
  enteredAtMs?: number,
): ProcessingBudget;

// processing-dispatch.ts: servidor interno; no convierte el resultado en estado DB.
export function dispatchProcessing(input: {
  versionId: string;
  operationId?: string;
  operation: "process" | "retry";
}): Promise<"accepted" | "failed">;

// processing-failure.server.ts
export function reportProcessingFailure(
  input: { operation: "process" | "retry"; code: "PARSING_FAILED" |
    "CHUNKING_FAILED" | "EMBEDDING_FAILED" | "PERSISTENCE_FAILED" |
    "PROCESSING_FAILED"; versionId: string; attemptId?: string },
  flushMs: number,
): Promise<void>;
```

Conservar `runProcessing(versionId, operationId, operation = "process"): Promise<void>`, `claimProcessingRetry(...)` y el resultado público de `retryProcessing(versionId)`. La ampliación pública es `RepositoryItem.latestVersion.processingStartedAt: string | null` y la precondición de recuperación de `uploaded`. Los helpers de fixture son solo para tests; no se exportan desde módulos del producto.

### Task 1: Finalización SQL bloqueada, deadline y proyección

**Files:** nueva migración, SQL 003/006/009/010, `src/types/database.ts`, nuevos helpers locales y `tests/integration/processing-completion.test.ts`.
**Consumes:** `finish_processing(uuid,uuid,jsonb)`, campos de claim y vista `repository_documents` existentes.
**Produces:** misma RPC corregida y `latest_processing_started_at` añadido al final de la vista, conservando las columnas existentes.

- [x] **Step 1: Escribir primero las regresiones SQL y de concurrencia.** En 010 crear un caso con inicio hace 51 s y exigir `22023`, cero chunks y puntero nulo. Mantener los casos de vector inválido, índice duplicado y rollback. En 009 exigir columna nueva y `security_invoker=true`. Crear `createProcessingFixture({status, startedAt?})` que genere cuenta/workspace/documento/v1/attempt propios con upload confirmado y devuelva `{workspaceId, documentId, versionId, operationId, storagePath, chunks, service, dispose}`. `dispose` elimina solo sus rutas e IDs, documentos antes del workspace y finalmente su cuenta.

  El helper `openLocalSqlSession(applicationName)` valida loopback/project ID `knowledge-decay-monitor-s1-02`, descubre exactamente `supabase_db_knowledge-decay-monitor-s1-02` y usa `spawn("docker", ["exec", "-i", container, "psql", "-XAt", "-U", "postgres", "-d", "postgres"], {windowsHide:true})`. Expone `query(sql): Promise<string>`, `close()` y PID de sesión; usa marcadores propios, timeout de test y errores saneados. No imprime SQL ni credenciales. Dos sesiones transaccionales son suficientes: B puede observar la espera de A desde `pg_stat_activity` antes de confirmar.

  ```ts
  it("rejects A after B commits a replacement claim", async () => {
    const fixture = await createProcessingFixture({ status: "processing" });
    const a = await openLocalSqlSession("kdm_finish_a");
    const b = await openLocalSqlSession("kdm_claim_b");
    try {
      const replacement = randomUUID();
      await b.query("begin");
      await b.query(`update public.document_versions
        set processing_operation_id='${replacement}', processing_started_at=clock_timestamp()
        where id='${fixture.versionId}'`);
      const finishing = a.query(`select public.finish_processing(
        '${fixture.versionId}', '${fixture.operationId}',
        '${JSON.stringify(fixture.chunks)}'::jsonb)`);
      const rejected = expect(finishing).rejects.toMatchObject({ sqlState: "22023" });
      await waitForSqlLock(b, a.pid); // pg_stat_activity: wait_event_type='Lock'.
      await b.query("commit");
      await rejected;
      const version = await fixture.service.from("document_versions")
        .select("processing_status,processing_operation_id,version_status")
        .eq("id", fixture.versionId).single();
      expect(version.data).toMatchObject({ processing_status: "processing",
        processing_operation_id: replacement, version_status: null });
      const chunks = await fixture.service.from("document_chunks")
        .select("id", { count: "exact", head: true }).eq("version_id", fixture.versionId);
      expect(chunks.count).toBe(0);
    } finally { await a.close(); await b.close(); await fixture.dispose(); }
  });
  ```

  Definir `waitForSqlLock(observer, pid)` con polls acotados de `pg_stat_activity`, sin un sleep fijo que suponga el intercalado. Adjuntar handlers a ambas promises inmediatamente para evitar rechazos sin manejar. Los UUID y chunks anteriores son sintéticos, validados, sin comillas en su texto de fixture. El helper general usa parámetros psql o escapes SQL seguros para cualquier otro dato.

- [x] **Step 2: Ejecutar RED sobre el esquema anterior.** `npx pnpm@12.5.1 test:integration tests/integration/processing-completion.test.ts` y `npx pnpm@12.5.1 test:db`. Guardar solo nombres/estado del fallo: deadline y carrera deben reproducir el defecto; los fallos globales 003/006 se identifican por separado.

- [x] **Step 3: Crear la migración y corregir la RPC.**

  ```powershell
  npx pnpm@12.5.1 exec supabase migration new first_vertical_processing_guard
  $closureMigrations = @(Get-ChildItem supabase/migrations -Filter '*_first_vertical_processing_guard.sql')
  if ($closureMigrations.Count -ne 1) { throw 'Expected one closure migration.' }
  $closureMigration = $closureMigrations[0].FullName
  ```

  Copiar la definición completa de `finish_processing` de `20261006172303_finish_processing.sql` en el archivo nuevo usando `CREATE OR REPLACE`. Conservar sus guards, INSERT y actualizaciones; sustituir su lectura inicial por el bloqueo y añadir el mismo chequeo de deadline tras insertar y al final, antes de retornar:

  ```sql
  select * into v_version from public.document_versions
    where id = p_version_id for update;
  -- Tras not-found y los guards existentes de estado/operation_id:
  if v_version.processing_started_at is null
     or clock_timestamp() >= v_version.processing_started_at + interval '50 seconds' then
    raise exception 'Processing deadline exceeded' using errcode = '22023';
  end if;
  if jsonb_array_length(p_chunks) > 500 then
    raise exception 'Chunk limit exceeded' using errcode = '22023';
  end if;
  ```

  Guardar `SET search_path = ''`, `SET statement_timeout = '2s'` y `SET lock_timeout = '1s'` como atributos de la función. `statement_timeout` se aplica por PostgREST antes de ejecutar la RPC; `lock_timeout` dentro de la función acota cada bloqueo. Conservar revocación de PUBLIC/anon/authenticated y EXECUTE solo service_role. No modificar roles ni configuración global. Añadir `NOTIFY pgrst, 'reload schema'`.

  Recrear la vista copiando el SELECT y joins completos de `20261003150154_s1_02_repository_projection.sql`: añadir `v.processing_started_at` al SELECT lateral y, después de `latest.upload_state as latest_upload_state`, añadir `latest.processing_started_at as latest_processing_started_at`. Conservar `security_invoker=true`, GRANT y nombres/orden de todas las columnas previas; no eliminar/recrear la vista.

- [x] **Step 4: Hacer las pruebas SQL independientes de datos ajenos.** En 003 restringir las aserciones de conteos a los cuatro document IDs del seed y los tres chunk IDs `40000000-0000-4000-8000-000000000001`, `40000000-0000-4000-8000-000000000002`, `40000000-0000-4000-8000-000000000003`. La comprobación de punteros nulos usa los documentos `20000000-0000-4000-8000-000000000002` y `20000000-0000-4000-8000-000000000003`; debe seguir exigiendo dos. En 006 fijar `private.upload_control.mode='paused'` al comienzo de su transacción y conservar el rollback final. No cambiar el estado fuera de esa transacción ni reducir las expectativas.

- [x] **Step 5: Aplicar solo en local, regenerar y verificar GREEN.**

  ```powershell
  npx pnpm@12.5.1 exec supabase migration up --local
  node -e "const {execFileSync}=require('node:child_process');const {writeFileSync}=require('node:fs');writeFileSync('src/types/database.ts',execFileSync(process.execPath,['node_modules/supabase/dist/supabase.js','gen','types','typescript','--local'],{encoding:'utf8',stdio:['ignore','pipe','ignore'],windowsHide:true}))"
  npx pnpm@12.5.1 test:db
  npx pnpm@12.5.1 check:database-types
  npx pnpm@12.5.1 test:integration tests/integration/processing-completion.test.ts
  ```

  Añadir un caso HTTP real a la RPC mientras otra sesión bloquea la fila: debe responder con fallo controlado dentro del límite y no insertar nada incluso después de liberar el bloqueo. Verificar `proconfig`, permisos y columna de vista. Si PostgREST no aplica el timeout en este runtime, detener esta tarea y resolverlo antes de confiar en la cancelación HTTP. Entregable independiente: carrera/deadline cerrados, tipos y vista coherentes. Commit candidato autorizado: `fix(ingestion): fence processing completion and expose lease timestamp`.

### Task 2: Embeddings completos con una entrada y concurrencia dos

**Files:** `embeddings.ts`, su test unitario y `warm-local-embed.mjs`.
**Consumes:** textos de la versión y opciones de cancelación de las interfaces compartidas.
**Produces:** un vector por entrada, en orden, o `EmbeddingError("EMBEDDING_FAILED")`; no persiste.

- [x] **Step 1: Sustituir la expectativa de rechazo de nueve por éxito completo.** Añadir out-of-order, concurrencia, señal preabortada, fallo del primer par sin iniciar todo el backlog, mismatch `dims`, respuestas vacías y 501 entradas rechazadas antes de invocar.

  ```ts
  it("embeds 9 texts individually, at most two in flight, preserving order", async () => {
    let live = 0; let peak = 0;
    mocks.invoke.mockImplementation(async (_name, options) => {
      expect(options.body.inputs).toHaveLength(1);
      const index = Number(options.body.inputs[0]);
      peak = Math.max(peak, ++live);
      await new Promise((resolve) => setTimeout(resolve, index % 2 ? 1 : 8));
      live -= 1;
      return { data: { embeddings: [vec(384, index)], dims: 384 }, error: null };
    });
    const result = await embedBatch(Array.from({ length: 9 }, (_, i) => String(i)));
    expect(peak).toBe(2);
    expect(mocks.invoke).toHaveBeenCalledTimes(9);
    expect(result.map((value) => JSON.parse(value)[0])).toEqual([0,1,2,3,4,5,6,7,8]);
  });
  ```

- [x] **Step 2: Ejecutar RED.** `npx pnpm@12.5.1 test:unit tests/unit/ingestion-embeddings.test.ts`. Debe fallar por el rechazo de nueve o las llamadas con múltiples entradas; no aceptar un fallo de setup como evidencia.

- [x] **Step 3: Implementar el adaptador con dos runners y resultados por índice.** Validar 1–500 strings, crear controller local enlazado a la señal recibida y comprobar `signal.aborted` antes de iniciar. No combinar un timeout del SDK con una señal ya abortada. La invocación es:

  ```ts
  const { data, error } = await service.functions.invoke("embed", {
    body: { inputs: [texts[index]] }, signal: controller.signal,
  });
  if (error || data?.dims !== 384 || !Array.isArray(data.embeddings)
      || data.embeddings.length !== 1) throw new EmbeddingError();
  results[index] = toPgvector(data.embeddings[0]);
  ```

  Cada runner comprueba `assertCanStart` y aborto antes de incrementar el índice compartido. `Promise.all` tiene handlers para los dos runners; ante fallo abortar el controller y esperar su asentamiento acotado por señal, sin retornar un array parcial. Liberar listeners en `finally`. Mantener el error externo saneado y validar las 384 cifras finitas con el helper actual.

- [x] **Step 4: Actualizar warm-up y medir el runtime.** Reemplazar el request de ocho entradas por ocho requests de una entrada con máximo dos simultáneos, textos sintéticos de aproximadamente 1.800 caracteres y chequeo de 384 dimensiones finitas. Registrar solo conteo, duración y categoría de resultado; mantener la guardia de loopback y claves en memoria. Calentar el modelo es preparación de tests, no una prueba de cold start.

- [x] **Step 5: Ejecutar GREEN y medición real.** `npx pnpm@12.5.1 test:unit tests/unit/ingestion-embeddings.test.ts`; servir únicamente `embed` durante la medición y ejecutar `node scripts/warm-local-embed.mjs`. Probar también la primera invocación en frío cuando el runtime sea propio/descartable; no reiniciar un runtime ajeno. Si aparece 546 con la política nueva, documentar el resultado y bloquear la aceptación, sin subir el timeout o cambiar modelo. Commit candidato: `fix(ingestion): embed every chunk with bounded concurrency`.

  **Resultado:** tests 13/13 y typecheck pasan. La petición individual representativa respondió 200; la medición con concurrencia 2 devolvió HTTP 546 (`WORKER_LIMIT`) y el Edge Runtime registró agotamiento de CPU. Aceptación de extremo a extremo bloqueada hasta resolver capacidad del worker.

### Task 3: Presupuesto desde el claim y cierre reconciliado

**Files:** `processing-budget.ts`, `processing.ts`, helper de telemetría de servidor y sus tests.
**Consumes:** adaptador Task 2, RPC Task 1 e inicio persistido del claim.
**Produces:** mismo `runProcessing`, con éxito/fallo seguro y sin escrituras de un intento obsoleto.

- [x] **Step 1: Escribir pruebas de presupuesto y worker.** Añadir `processing_started_at` a los mocks de fila existentes. Usar reloj fake para claim hace 40 s, embeddings que nunca resuelven hasta aborto, parse que retorna después de 45 s, RPC que responde con error tras COMMIT, actualización de fallo que encuentra operation ID nuevo y base indisponible. Probar todos los puntos de Review Focus 3–4.

  ```ts
  it("reserves five seconds and does not restart an old claim budget", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-08T12:00:40Z"));
    const budget = createProcessingBudget("2026-10-08T12:00:00Z");
    expect(budget.remainingMs()).toBe(10_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(budget.workSignal.aborted).toBe(true);
    expect(() => budget.assertWorkRemaining()).toThrow();
    expect(budget.closeSignal(1_000).aborted).toBe(false);
    budget.dispose(); vi.useRealTimers();
  });
  ```

  El test de respuesta perdida configura `rpc` como error de transporte y la relectura como `ready/active` con puntero correcto; exige cero UPDATE de fallo. El caso de otro operation ID exige cero chunks y cero cambio del claim nuevo. El test de telemetría exige capture con datos allowlisted y flush dentro del tiempo asignado, aun si capture/flush lanza.

- [x] **Step 2: Ejecutar RED.** `npx pnpm@12.5.1 test:unit tests/unit/ingestion-processing-budget.test.ts tests/unit/ingestion-processing.test.ts tests/unit/processing-failure.test.ts`. Los archivos nuevos deben existir antes de esta ejecución; el fallo relevante es el comportamiento temporal, no un import ausente.

- [x] **Step 3: Implementar el presupuesto y propagarlo.** El deadline efectivo no supera `worker-entry + 50s` y usa el inicio persistido si es anterior. Una fecha inválida produce fallo controlado; una futura no amplía el presupuesto local. Señal de trabajo vence a 45 s desde el claim; señales de cierre son independientes, limitadas por `remainingMs`, y no reutilizan la señal de trabajo ya abortada.

  ```ts
  const budget = createProcessingBudget(row.processing_started_at, Date.now, workerEnteredAt);
  budget.assertWorkRemaining();
  const response = await downloadStorageObject(row.storage_path, budget.workSignal);
  // Conservar parsing/chunking; comprobar presupuesto después de cada fase.
  const embeddings = await embedBatch(drafts.map((draft) => draft.text_content), {
    signal: budget.workSignal, assertCanStart: budget.assertWorkRemaining,
  });
  budget.assertWorkRemaining();
  const completion = await service.rpc("finish_processing", {
    p_version_id: versionId, p_operation_id: operationId, p_chunks: chunks,
  }).abortSignal(budget.closeSignal(2_000));
  ```

  Capturar `const workerEnteredAt = Date.now()` al entrar al worker, antes de la consulta. La consulta inicial también tiene señal acotada a dos segundos y su tiempo cuenta en el deadline efectivo. El helper usa `Math.min(enteredAtMs, Date.parse(startedAt))` como inicio después de validar la fecha, sin permitir que un timestamp futuro amplíe el presupuesto. Declarar constantes de etapas de cierre: RPC hasta 2.000 ms, reconciliación hasta 500 ms, marca de fallo hasta 1.500 ms y flush hasta 500 ms; cada una queda limitada además por el presupuesto restante. No empezar una finalización con trabajo agotado. Una cancelación HTTP no reemplaza los guards/timeout SQL de Task 1.

- [x] **Step 4: Reconciliar y reportar.** Si falla la RPC, reconsultar versión y puntero bajo señal de cierre: `ready/active` coherente permanece exitoso; `processing` con ID distinto se deja intacto; mismo ID puede marcar `processing_failed` mediante UPDATE con filtros de estado e ID. Si no hay base para persistir, reportar `PERSISTENCE_FAILED` sin atribuir una marca exitosa y dejar recuperación por lease.

  ```ts
  await service.from("document_versions").update({
    processing_status: "processing_failed", processing_operation_id: null,
    processing_started_at: null,
  }).eq("id", versionId).eq("processing_status", "processing")
    .eq("processing_operation_id", operationId).select("id")
    .abortSignal(budget.closeSignal(1_500));
  ```

  `reportProcessingFailure` llama a `captureOperationFailure` con correlation UUID, version ID y attempt ID seguro, y espera `Sentry.flush` hasta `min(flushMs, 500)`. Capture/flush fallidos se absorben; no se registra el error crudo. Disposal de timers/listeners ocurre en `finally`.

- [x] **Step 5: Ejecutar GREEN y regresión conjunta.** Repetir los tres archivos unitarios, `tests/unit/operation-privacy.test.ts` y `tests/unit/operation-error.test.ts`; repetir la integración de finalización para comprobar que los resultados HTTP/DB coinciden. Commit candidato: `fix(ingestion): enforce processing deadline and reconcile completion`.

  **Resultado:** 36/36 unit tests, typecheck y lint dirigido pasan; integración local 14 archivos/20 tests pasa. El lint global también incluyó el artefacto ignorado `.artifacts/vertical-audit/probes.cjs` y falló por sus cuatro `require()`; no se modificó. La suite amplia dejó `upload_control.mode=paused`; se restauró a `active`, su valor observado antes de ejecutarla. Task 6 debe preservar el modo inicial al cerrar suites.

### Task 4: Dispatch esperado y recuperación de los tres estados

**Files:** dispatch nuevo, actions/retry/handler existentes, cuatro tests unitarios e integración de retry.
**Consumes:** `runProcessing` y captura segura de Task 3; contrato público `ActionResult` actual.
**Produces:** dispatch acotado y `retryProcessing` válido para uploaded confirmado, fallo y lease vencida.

- [x] **Step 1: Añadir tests que observen la promise de after.** Cambiar el mock para almacenar el callback sin ejecutarlo inmediatamente. Probar callback pendiente mientras fetch está pendiente, rechazo controlado, HTTP 500/401, token/origen ausentes, fallo en relectura y upload exitoso inalterado. Añadir prueba de retry cuyo fetch falla después de que DB haya quedado `ready` y exigir resultado exitoso reconciliado.

  ```ts
  it("returns a promise from after and awaits dispatch", async () => {
    let callback: () => Promise<void> = async () => {};
    mocks.after.mockImplementation((task) => { callback = task; });
    let finish!: (response: Response) => void;
    mocks.fetch.mockReturnValue(new Promise<Response>((resolve) => { finish = resolve; }));
    const result = await finalizeUpload({ versionId: VERSION_ID, attemptId: ATTEMPT_ID });
    expect(result).toEqual({ ok: true, data: snapshot("confirmed") });
    const pending = callback();
    expect(pending).toBeInstanceOf(Promise);
    finish(new Response(null, { status: 200 }));
    await pending;
  });
  ```

- [x] **Step 2: Ejecutar RED.** `npx pnpm@12.5.1 test:unit tests/unit/ingestion-scheduling.test.ts tests/unit/ingestion-retry-action.test.ts tests/unit/ingestion-processing-retry.test.ts tests/unit/ingestion-process-route.test.ts`.

- [x] **Step 3: Implementar el helper de dispatch y esperarlo.** Resolver token/origen desde configuración del servidor, timeout de 60 s compatible con handler de 90 s y worker de 50 s. Nunca leer `response.text()` para logs ni marcar `uploaded` como efecto de un fallo de red.

  ```ts
  after(async () => {
    await dispatchProcessing({ versionId, operation: "process" });
  });
  // Dentro del helper: origin y token provienen de configuración verificada.
  const response = await fetch(`${origin}/api/ingestion/process`, {
    method: "POST", headers: { "content-type": "application/json", "x-internal-token": token },
    body: JSON.stringify(input), signal: AbortSignal.timeout(60_000),
  });
  ```

  Enviar `operationId` solo para `retry`, conforme al schema del handler. Capturar fallos de configuración, lectura o HTTP como fallo seguro de procesamiento. El caller conserva el snapshot confirmado. Guardar una sola implementación del fetch interno y usarla también desde retry; no introducir una capa HTTP entre módulos.

- [x] **Step 4: Ampliar claim y reconciliar retry.** Añadir elegibilidad de `processing_status==='uploaded'` al claim actual con v1, confirmed y version_status NULL. Mantener CAS sobre estado observado y, para reclaim, ID e inicio vencido. Handler de process exige también v1 y estado funcional NULL. Reautorizar con sesión/Profile antes del claim; devolver NOT_FOUND para otro tenant y FORBIDDEN para Member. Siempre releer después del dispatch, incluso si se perdió la respuesta; devolver ready solo tras comprobar estado persistido coherente, processing solo para el ID propio y fallos/conflictos controlados en los demás casos.

  ```ts
  const waiting = version.processing_status === "uploaded";
  if (!waiting && !failed && !staleProcessing) return { kind: "conflict" };
  ```

  Añadir en integración dos claims simultáneos sobre uploaded, failed y lease vencida; exactamente uno gana. Probar lease vigente y v1 ya activa denegadas, mismo ID de documento/versión/ruta y conteos sin duplicación.

- [x] **Step 5: Ejecutar GREEN.** Repetir los cuatro unitarios y `npx pnpm@12.5.1 test:integration tests/integration/processing-retry.test.ts`. Revisar que la respuesta HTTP 200 del handler no se trate como prueba de éxito del pipeline. Commit candidato: `fix(ingestion): await dispatch and recover confirmed pending versions`.

  **Resultado Task 4:** 44/44 unit tests, `typecheck`, ESLint dirigido, la integración local focalizada (1 archivo/1 test) y `git diff --check` pasan. `upload_control.mode` estaba y sigue `active`. La suite quedó limitada al test de retry; no se modificó la configuración ni los datos remotos.

### Task 5: Start Processing y Retry visible para leases vencidas

**Files:** contratos, Repository infrastructure/service, `src/app/(workspace)/repository/page.tsx`, botón y tests cercanos; crear `src/modules/repository/ui/processing-recovery.ts`, `tests/unit/processing-recovery.test.ts` y el componente cliente `src/modules/repository/ui/processing-lease-refresh.tsx`.
**Consumes:** `latest_processing_started_at` de Task 1 y comando autorizado Task 4.
**Produces:** campo nullable nuevo y etiquetas correctas, sin permisos concedidos por UI.

- [ ] **Step 1: Escribir casos de matriz UI y mapping.** Uploaded confirmado muestra Start; fallo y lease >180 s muestran Retry; vigente, ready, pending, v2 y Member no muestran acción. El server sigue rechazando aunque se manipule el botón. Probar timestamp nulo/inválido y avance del tiempo tras permanecer en la página.

  ```ts
  expect(processingRecoveryAction({ version_number: 1, uploadState: "confirmed",
    version_status: null, processing_status: "uploaded", processingStartedAt: null }, Date.now()))
    .toBe("start");
  expect(processingRecoveryAction({ version_number: 1, uploadState: "confirmed",
    version_status: null, processing_status: "processing",
    processingStartedAt: new Date(Date.now() - 181_000).toISOString() }, Date.now()))
    .toBe("retry");
  ```

  Definir `processingRecoveryAction(version: NonNullable<RepositoryItem["latestVersion"]>, nowMs: number): "start" | "retry" | null`; es una decisión de presentación y no una autorización.

- [ ] **Step 2: Ejecutar RED.** Tests `processing-recovery`, `repository.service.test.ts` y `src/app/(workspace)/repository/page.test.ts`, citando rutas con paréntesis en PowerShell.

- [ ] **Step 3: Propagar timestamp y presentar acciones.** Añadir columna al SELECT de infrastructure y mapping `processingStartedAt: document.latest_processing_started_at`. Actualizar todos los builders de `RepositoryItem`. Añadir al botón prop `action: "start" | "retry"`; ambos llaman `retryProcessing`, con copy Start/Retry, pendiente Starting y resultado Processing started/Processing completed. No mostrar éxito si `ActionResult` contiene PROCESSING_FAILED.

  ```tsx
  {action ? <RetryProcessingButton versionId={version.id} action={action} /> : null}
  ```

  `ProcessingLeaseRefresh({enabled}: {enabled: boolean})` se renderiza desde la página con enabled cuando haya versiones processing. El componente usa `router.refresh()` cada 15 s y al foco/visibilidad, limpia timer/listeners al desmontar y pausa polls en pestaña oculta. Así la lease vencida aparece sin depender de un reloj del navegador como permiso. Un caso E2E inicia una lease sintética con 179 s de edad y exige que Retry aparezca tras el refresco sin recargar manualmente. Conservar Open Original según upload confirmado, filtros, accesibilidad y popup fallback existentes.

- [ ] **Step 4: Ejecutar GREEN y E2E de tres estados.** Repetir los tests afectados y `npx pnpm@12.5.1 test:e2e:local tests/e2e/processing-retry.spec.ts --workers=1`. Fixture de uploaded usa original pequeño válido y debe llegar ready; fallo sin texto vuelve a fallo controlado; lease vencida con original válido llega ready, conservando IDs y hash.

- [ ] **Step 5: Revisar contrato y límites de módulo.** `npx pnpm@12.5.1 typecheck`, `npx pnpm@12.5.1 lint`, revisar imports públicos e inexistencia de servicio privilegiado en bundle cliente. Commit candidato: `feat(repository): expose pending and expired processing recovery`.

### Task 6: Recorrido completo mantenido y gates limpios

**Files:** inputs sintéticos, `processing-flow.spec.ts`, retry/upload tests, workflow; fixture PDF textual nuevo `tests/fixtures/processing/pdf-text/original.pdf` generado con estructura válida y texto sintético, no una dependencia nueva.
**Consumes:** Tasks 1–5 y helpers Auth existentes `registerThroughUi`, `loginThroughUi`.
**Produces:** prueba de inicio a fin hasta persistencia/original y CI completo del candidato.

- [ ] **Step 1: Crear fixtures y asserts estrictos.** `markdownSections(count)` genera headings y párrafos de aproximadamente 1.600 chars; prueba con parser/chunker reales que nueve y 32 producen esos conteos y 501 supera el cap. Leer DOCX y PDF de fixtures; no guardar archivos del usuario.

  ```ts
  export function markdownSections(count: number): Buffer {
    return Buffer.from(Array.from({ length: count }, (_, index) =>
      `# Synthetic section ${index}\n\n${"Controlled recovery procedure. ".repeat(50)}`
    ).join("\n\n"), "utf8");
  }
  ```

  En `processing-flow.spec.ts`, registrar por UI una cuenta propia, crear workspace y cargar los tres formatos, nueve y 32 chunks; seleccionar categoría/owner mediante controles reales. Poll por version ID obtenido con una consulta acotada al workspace recién creado:

  ```ts
  await expect.poll(async () => {
    const row = await service.from("document_versions")
      .select("processing_status,version_status").eq("id", versionId).single();
    return row.data;
  }, { timeout: 65_000 }).toEqual({ processing_status: "ready", version_status: "active" });
  const chunks = await service.from("document_chunks").select("chunk_index,embedding")
    .eq("version_id", versionId).order("chunk_index");
  expect(chunks.data).toHaveLength(expectedChunks);
  expect(chunks.data?.map((chunk) => chunk.chunk_index))
    .toEqual(Array.from({ length: expectedChunks }, (_, index) => index));
  for (const chunk of chunks.data ?? []) {
    const vector = JSON.parse(chunk.embedding);
    expect(vector).toHaveLength(384);
    expect(vector.every(Number.isFinite)).toBe(true);
  }
  ```

  Exigir también puntero activo igual al version ID, metadata correcta, hash de Storage igual al cargado y original abierto mediante UI. Cada valor del ejemplo se obtiene del fixture propio; cualquier error de consulta falla el test, nunca se convierte en array vacío aceptado.

- [ ] **Step 2: Añadir fallos, límites y limpieza exacta.** PDF vacío y 501 chunks dejan cero chunks/puntero; los originales siguen abriendo. Batch real de diez archivos pequeños válidos debe procesarse completo bajo concurrencia real. El caso de 10 MiB prueba transferencia y límite; si excede cap de procesamiento exige fallo controlado y nunca se usa como caso happy path. Mantener lectura/mutación cross-tenant, Member-owner, owner ajeno y restricciones de sesión existentes. `finally` retira solo Storage/rutas y documentos creados por el test antes de su workspace/cuenta.

- [ ] **Step 3: Verificar URLs y fallo de proceso abrupto.** Abrir el original y conservar la URL solo en memoria; después de 300 s comprobar que la URL anterior falla y una nueva funciona. Separar el caso lento con timeout de test de 360 s, sin cambiar globalmente los 90 s de Playwright. Simular caída solo en proceso/runtime propio, dejar lease vencer y recuperar por UI; no matar un proceso del usuario.

- [ ] **Step 4: Ejecutar suite local completa sin reset.**

  ```powershell
  npx pnpm@12.5.1 lint
  npx pnpm@12.5.1 typecheck
  npx pnpm@12.5.1 test:unit
  npx pnpm@12.5.1 test:db
  npx pnpm@12.5.1 check:database-types
  npx pnpm@12.5.1 test:integration
  node scripts/with-local-supabase.mjs build
  npx pnpm@12.5.1 test:e2e:local --workers=1
  git diff --check
  ```

  Servir `embed` durante E2E; confirmar que el servidor que Playwright reutiliza es el build candidato, con origen/DB/token local correctos. No dar por válida una instancia anterior por responder `/login`. Guardar/restaurar el upload mode inicial; serializar pruebas que lo cambian y no dejar `paused`. No ejecutar fixtures/restart locales que mutan el stack existente.

- [ ] **Step 5: CI y revisión de rama.** Asegurar que el workflow actual incluye el test de carrera en `test:integration`, nuevo full-flow en E2E y warm-up Task 2. En el runner descartable ejecutar reset/fixtures/restart existentes; detener únicamente el runtime propio. Investigar el timeout previo de `playwright-config.test.ts`: medir import en suite completa y aislar dependencias/configuración costosas o fijar un presupuesto específico medido si corresponde; no aumentar indiscriminadamente todos los timeouts. Exigir un run completo verde del SHA candidato y revisión según método elegido. Commit candidato: `test(vertical): certify processing and recovery end to end`.

### Task 7: Runbook concreto y preflight del corte

**Files:** `docs/testing/first-vertical-cutover.md`, reporte de aceptación nuevo y referencias de arquitectura/S1-08 que deban actualizarse por las decisiones aprobadas.
**Consumes:** spec, CI candidato y configuración vigente leída con MCP/gh.
**Produces:** lista exacta de cambios remotos, inventario previo y recuperación verificable, lista para autorizar el corte.

- [ ] **Step 1: Inventario de solo lectura.** Con MCP Supabase revisar URL/ref, migrations, funciones, upload mode, nombres de columnas/RPC/permisos y conteos de pending/huérfanos. Con Vercel revisar proyectos/deployments/SHA y nombres/targets de variables, sin emitir valores. Con gh revisar protecciones y rulesets:

  ```powershell
  gh api repos/JMCoC/knowledge-decay-monitor/branches/develop/protection --jq '{required_status_checks,enforce_admins,required_pull_request_reviews}'
  gh api repos/JMCoC/knowledge-decay-monitor/branches/main/protection --jq '{required_status_checks,enforce_admins,required_pull_request_reviews}'
  gh api repos/JMCoC/knowledge-decay-monitor/rulesets --jq '.[] | {id,name,enforcement}'
  npx pnpm@12.5.1 exec supabase db push --project-ref cdyjtoheovbvewewicaa --dry-run --skip-vault
  ```

  Esperado desde la auditoría: migración `20261006172303_finish_processing` más la nueva, cero funciones antes del corte y cuatro uploads confirmed/uploaded. Si cambió el inventario, revisar el conjunto real; no añadir `--include-all` para forzar una historia divergente.

- [ ] **Step 2: Preparar gates/configuración con valores secretos fuera del documento.** Añadir el check exacto `Quality gates` a los required_status_checks de main/develop conservando contextos y reglas existentes. Usar PATCH del subrecurso `protection/required_status_checks` o ruleset vigente; no reemplazar toda la protección. Documentar el payload con `strict=true` y la lista calculada; después de aplicar en Task 8, GET verifica que lo añadió sin borrar otros checks.

  Inventario de configuración requerida: token interno de servidor para ambos deployments; service role/publishable URL correcto; `APP_ORIGIN` efectivo; allowlist Auth para callbacks elegidos; correo de aceptación controlado; configuración de Sentry que resuelva `development`, `vercel-preview`, `vercel-production` y release SHA. Identificar si Preview necesita un mecanismo oficial de bypass de protección para dispatch interno; cualquier secreto de bypass queda solo en servidor. No desactivar autenticación del endpoint ni exponer secretos para sortear un 401.

- [ ] **Step 3: Escribir pausa, migración y rollback con datos reales.** Registrar upload mode inicial, deployment compatible previo por ID/SHA y propietario de la ventana. Pausa con MCP SQL sobre el único registro:

  ```sql
  update private.upload_control set mode = 'paused', updated_at = clock_timestamp()
    where singleton returning mode;
  ```

  El SQL se ejecuta solo en Tasks 8–9 autorizadas. Runbook identifica cómo restaurar `active` si era el estado previo y qué hacer ante fallo. Antes de pausar, preparar dry-run revisado, secretos y paquete candidato para reducir la ventana. Rollback conserva nuevas migraciones y datos; restaura un deployment compatible, mantiene pausa y entrega corrección aditiva si hace falta. No restaura una aplicación incompatible con la nueva RPC.

- [ ] **Step 4: Preparar matriz de evidencia y buzón.** Reporte con una fila por criterio de la spec y entorno: estado `pendiente`, `aprobado` o `fallido`, SHA, fecha, resultado/tiempo y referencia segura. No completar filas con evidencia vieja. Obtener acceso a un buzón controlado y sus aliases para registro/recovery remotos; si falta, solicitar ese dato sin bloquear correcciones locales y mantener ese criterio abierto. Documentar aceptación manual/remota contra la URL real sin reutilizar la configuración Playwright local que fuerza loopback y desactiva Sentry.

- [ ] **Step 5: Revisar el paquete de corte.** Verificar enlaces/`git diff --check`, correspondencia exacta de migraciones y compatibilidad del candidato; confirmar que la autorización de ejecución cubre los cambios preparados antes de la primera escritura remota. Entregable: runbook revisable, no un despliegue. Commit de docs separado solo si está autorizado.

### Task 8: Gates, Supabase y aceptación de Preview

**Files:** runbook y reporte; operaciones remotas revisadas en Task 7.
**Consumes:** autorización del corte, CI verde, inventario refrescado y secrets configurables.
**Produces:** backend compatible y Preview comprobado con el SHA validado.

- [ ] **Step 1: Aplicar gates y configuración preparada.** Conservar protecciones y añadir Quality gates; verificar por GET. Configurar secrets por MCP/canal seguro, nunca mediante argumentos con valores literales o archivos versionados. Verificar targets de Preview sin limitar arbitrariamente a develop cuando el runner despliega un PR. Registrar solo presencia/target. Auth debe permitir callback del Preview realmente seleccionado.

- [ ] **Step 2: Pausar y aplicar únicamente el conjunto revisado.** Confirmar identidad del proyecto y dry-run de nuevo si hubo cambios. Ejecutar pausa de Task 7 y:

  ```powershell
  npx pnpm@12.5.1 exec supabase db push --project-ref cdyjtoheovbvewewicaa --skip-vault
  npx pnpm@12.5.1 exec supabase functions deploy embed --project-ref cdyjtoheovbvewewicaa
  ```

  No `--include-seed`, `--include-roles`, `--prune`, reset remoto ni `--no-verify-jwt`. Confirmar historial, RPC/permisos/vista, autenticación de embed y medición de una entrada/concurrencia dos sin guardar vectores. Si algo falla, mantener pausa y seguir rollback; no promover.

- [ ] **Step 3: Ejecutar el despliegue Preview por el mecanismo existente.** Con push/PR autorizados, usar PR no draft del mismo repositorio hacia develop o main; Quality gates y job preview deben ejecutarse sobre el SHA del candidato. No invocar un despliegue manual que eluda los gates. `gh pr checks` y `gh run view --json headSha,conclusion,jobs` verifican revisión y jobs; MCP Vercel confirma proyecto, READY, meta SHA y URL. Un job skipped no cuenta como deployment.

- [ ] **Step 4: Aceptar el flujo real de Preview.** Habilitar uploads durante aceptación coordinada sobre el backend compartido. Crear dos workspaces sintéticos y usuarios Admin/QA/Member propios; ejecutar cada fila de la matriz: Auth/recovery por email, tres formatos, nueve/32 chunks, batch de diez, filtros/paginación, originals/TTL real, roles y cross-tenant en ambas direcciones, límite/cap, Start/Retry/lease. Prueba de stale lease solo sobre ID sintético anotado. Cada éxito exige consulta acotada de `ready/active`, puntero/chunks/dimensiones/hash; los fallos exigen cero chunks/puntero.

- [ ] **Step 5: Confirmar Sentry y registrar resultado.** Provocar fallo real con PDF vacío sintético, verificar evento persistido por correlation ID, environment `vercel-preview` y release SHA, y revisar saneamiento. Si el dispatch es bloqueado por protección Preview, corregir la configuración preparada sin alterar los permisos del producto y repetir el recorrido. Retirar solo fixtures propios por IDs exactos; conservar evidencia segura. Production solo continúa si toda aceptación Preview está aprobada.

### Task 9: Production, recuperación de pendientes y cierre

**Files:** reporte y runbook con resultados, sin contenidos privados.
**Consumes:** Preview aprobado, integración/Production autorizadas y mismos cambios ya migrados en Supabase compartido.
**Produces:** Production aceptado, pendientes procesados conservando identidad y veredicto basado en evidencia.

- [ ] **Step 1: Integrar y desplegar Production por gates.** Con integración autorizada, llevar el candidato a main mediante PR y protecciones. Si el merge genera otro SHA, este debe pasar Quality gates y es el SHA que Production servirá. No afirmar que el SHA de Preview y el de merge son idénticos: comprobar contenido candidato y repetir controles del SHA final. El workflow actual publica solo por push a main, después de quality; confirmar job production ejecutado y metadatos del deployment servido por el dominio de Production.

- [ ] **Step 2: Ejecutar la misma aceptación en Production.** Usar cuentas sintéticas separadas de Preview aunque compartan backend. Todas las filas de la spec, incluida recuperación de correo y expiración real de 300 s, requieren resultados del dominio público de Production. Una sesión válida en Preview no demuestra una cookie/callback correcto en Production. Fallo previsto de PDF vacío debe llegar a Sentry con environment `vercel-production` y release SHA final.

- [ ] **Step 3: Completar Sentry local sin usar el runner que lo desactiva.** Preparar una instancia local propia del build candidato con `NEXT_PUBLIC_KDM_SENTRY_TARGET=development`, `NEXT_PUBLIC_KDM_SENTRY_LOCAL_ENABLED=1`, `NEXT_PUBLIC_KDM_RELEASE` del commit final y flags disable en cero; DSN existente cargado solo en proceso. Provocar fallo real de pipeline sintético y comprobar evento development. Construir de nuevo si las variables públicas quedaron fijadas en un build sin telemetría. No sustituirlo por `sentry-local-smoke` manual ni reutilizar un servidor ajeno.

- [ ] **Step 4: Recuperar únicamente los documentos existentes aprobados.** Reconsultar las cuatro versiones confirmed/uploaded identificadas, capturar IDs/estado sin contenido y verificar que siguen elegibles. Ejecutar Start Processing con Admin/QA autorizado del workspace propietario; si no existe sesión operable, usar solo el endpoint interno autenticado, después de confirmar proyecto/tenant/versión y la autorización de esa operación. Un documento por vez, mismo version ID/ruta; comprobar ready/active o fallo controlado honesto, conteos y ausencia de versiones nuevas. No tocar documentos adicionales ni borrar los cuatro huérfanos. Restaurar upload mode acordado y verificarlo por lectura.

- [ ] **Step 5: Emitir cierre con evidence gates.** Completar el reporte por entorno con CI/SHA, deployment, estados/chunks/hash/tiempos y eventos Sentry saneados. Retirar únicamente cuentas/workspaces/Storage sintéticos creados por esta aceptación, respetando el orden Storage → documentos → workspace/cuentas y verificando el inventario exacto. Revisar cambios ajenos preservados y `git diff --check`. Declarar cerrado solo si todas las filas están aprobadas; cualquier buzón, callback, timeout, runtime o permiso pendiente mantiene el vertical abierto con condición concreta. Registrar advisors preexistentes por separado; un aislamiento vulnerado bloquea cierre aunque el advisor sea antiguo.

## Fuentes verificadas para la implementación

- [PostgREST: transacciones y function settings](https://docs.postgrest.org/en/stable/references/transactions.html): `statement_timeout` de función puede aplicarse antes de la RPC. [Configuración de hoisting](https://docs.postgrest.org/en/stable/references/configuration.html#db-hoisted-tx-settings): `lock_timeout` no forma parte de la allowlist predeterminada; se verifica su efecto dentro de la función y no se asume hoisting.
- [Supabase: retries y abortSignal](https://supabase.com/docs/guides/api/automatic-retries-in-supabase-js): acotar también consultas GET; las escrituras/RPC POST no se reintentan automáticamente por ese mecanismo. `signal` de functions.invoke y `.abortSignal()` se contrastaron con el código instalado de SDK 2.117.2 bajo `node_modules/.pnpm`.
- [Next.js after](https://nextjs.org/docs/app/api-reference/functions/after) y guía instalada `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md`: callback async esperado dentro de la duración del segmento. Leer guía instalada relevante antes de escribir código Next.
- Ayuda local de CLI 2.117.0: `migration up --local`, `db push --project-ref --dry-run --skip-vault` y `functions deploy embed --project-ref`; no cambiar versiones para ejecutar este plan.

## Cobertura de la spec y revisión del plan

| Requisito de la spec | Tasks |
|---|---|
| Cinco defectos auditados | 1–4 |
| Recuperación uploaded/failed/stale y original preservado | 4–6, 8–9 |
| Presupuesto, fencing y respuesta perdida | 1, 3–4 |
| Auth/Workspace, roles, upload, Repository y filtros | 6, 8–9 |
| SQL independiente de datos ajenos y tipos generados | 1, 6 |
| Sentry real y privacidad en tres entornos | 3, 8–9 |
| CI requerido, SHA y deployments ejecutados | 6–9 |
| Migraciones remotas, compatibilidad, pausa y rollback | 7–9 |
| Cuatro pending existentes y huérfanos separados | 7, 9 |
| Reporte con límites y evidencia por entorno | 7–9 |

Revisión inline: comprobar que no haya marcadores incompletos, que los helpers y firmas coincidan entre tareas, que los cinco puntos de Review Focus tengan tests y que no se añada infraestructura descartada. Los scripts/pruebas descritos se implementarán en la ejecución; escribir este plan no constituye una prueba de que ya existan o pasen.

## Handoff

El usuario aprobó este plan y eligió ejecución nativa en esta sesión. Usar `executing-plans`, avanzar en orden, crear commits locales por entregable y hacer una revisión independiente de toda la rama al final.
