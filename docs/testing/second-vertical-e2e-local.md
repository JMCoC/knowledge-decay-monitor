# Segundo vertical: guía E2E local con UI, Supabase y workers

Guía del checkout con S2-03, S2-04, S2-05 y S2-06, revisada contra el código
de `9a3bfff`. Los pasos siguientes son un procedimiento de prueba; este
documento no constituye evidencia de que se haya ejecutado manualmente el recorrido.

## 1. Qué puedes probar hoy

**Puedes usar la interfaz para registrar una cuenta, subir documentos, esperar
su procesamiento, seleccionar el alcance y calcular una estimación real.**
El botón `Proceed to Run Analysis` todavía muestra este aviso:

> Proceeding to analysis confirmation (Ticket S2-09 integration).

Por tanto, aún no existe un recorrido completo de análisis iniciado desde la
UI. Para comprobar S2-05 y S2-06 hoy, esta guía continúa con un **puente técnico
local**: ejecutar la RPC de Run en Studio y enviar el disparo al Edge worker.
Ese puente omite la Server Action, su autorización de sesión y su disparo
automático; esos puntos se cubren mediante las pruebas de integración.

| Etapa | Componente que se utiliza | Qué demuestra |
| --- | --- | --- |
| Upload → chunks y embeddings | UI + `C:\KDM\kdm-demo-worker` | Ingesta real de los documentos locales |
| Selección → estimación | UI + Supabase local | Elegibilidad, alcance, retrieval y costo persistido |
| Run → reserva | RPC de S2-05 desde Studio | Creación atómica, alcance e idempotencia en PostgreSQL |
| Claim → checkpoint → estado terminal | Edge `analyze` de este repo, con dobles locales | Ejecución y persistencia técnica del worker |
| Recuperación por scheduler | Prueba de integración específica | Camino real local `pg_cron → pg_net → analyze` |

El worker separado **sigue siendo el de ingesta**. No reemplaza a `analyze`.
El proveedor de IA real corresponde a S2-07; findings, liquidación de créditos
y eventos corresponden a S2-08; la conexión completa con la UI corresponde a
S2-09. El proveedor falso devuelve cero hallazgos por defecto: un estado
`completed` en este ejercicio no prueba detección de contradicciones.

## 2. Preparación y terminales

Usa PowerShell, Docker Desktop iniciado, Node.js compatible con el proyecto
(el desarrollo se verificó con Node 24.11.0), dependencias instaladas y pnpm
12.5.1. Los comandos emplean `npx pnpm@12.5.1`; puedes sustituirlo por `pnpm`
si tienes esa versión.

Usa una cuenta y un workspace **descartables**, con documentos sintéticos.
El Run de este ejercicio reserva créditos locales reales, pero el finalizador
de prueba no los consume ni libera. Evita repetirlo en un workspace que quieras
conservar para trabajo cotidiano. No uses `db reset`, seed, `--linked` ni
migraciones remotas.

| Terminal | Directorio | Proceso |
| --- | --- | --- |
| A | `C:\KDM\knowledge-decay-monitor` | Preparación y servidor web |
| B | `C:\KDM\kdm-demo-worker` | Worker de ingesta |
| C | `C:\KDM\knowledge-decay-monitor` | Edge worker de análisis |
| D | `C:\KDM\knowledge-decay-monitor` | Disparo HTTP y verificaciones |

### 2.1. Terminal A: Supabase y migraciones

```powershell
Set-Location C:\KDM\knowledge-decay-monitor
git status --short
npx pnpm@12.5.1 install --frozen-lockfile
node scripts/local-supabase-lifecycle.mjs start
npx pnpm@12.5.1 exec supabase migration up --local
npx pnpm@12.5.1 exec supabase migration list --local
```

Detente si algún comando falla. La lista debe incluir como aplicada
`20261018022500_s2_05_empty_comparison_candidate_snapshot` y cualquier
migración posterior que ya exista en tu checkout. Migra siempre desde este
repositorio; el checkout del worker separado puede tener migraciones anteriores.

Direcciones locales:

- Aplicación: <http://127.0.0.1:3000>.
- Studio: <http://127.0.0.1:54323> → **SQL Editor** para las consultas de esta guía.
- Correo de desarrollo: <http://127.0.0.1:54324>.
- API y Edge: `http://127.0.0.1:54321`.

### 2.2. Terminal A: configuración temporal y servidor web

Este bloque obtiene las claves del stack local en memoria. No imprime sus
valores ni modifica `.env.local`. Las variables solo aplican a esta terminal y
a sus procesos hijos. Ejecuta el bloque completo antes de iniciar la web.

```powershell
$kdmS2RuntimeJson = node node_modules/supabase/dist/supabase.js status -o json 2>$null
if ($LASTEXITCODE -ne 0) { throw 'Supabase local no está disponible.' }
$kdmS2Runtime = $kdmS2RuntimeJson | ConvertFrom-Json
if ($kdmS2Runtime.API_URL -ne 'http://127.0.0.1:54321') {
  throw 'Se esperaba exclusivamente Supabase local.'
}
$kdmS2PublicKey = $kdmS2Runtime.PUBLISHABLE_KEY
if (-not $kdmS2PublicKey) { $kdmS2PublicKey = $kdmS2Runtime.ANON_KEY }
if (-not $kdmS2PublicKey -or -not $kdmS2Runtime.SERVICE_ROLE_KEY) {
  throw 'Faltan claves del stack local.'
}

$env:NEXT_PUBLIC_SUPABASE_URL = $kdmS2Runtime.API_URL
$env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = $kdmS2PublicKey
$env:NEXT_PUBLIC_SUPABASE_ANON_KEY = ''
$env:SUPABASE_SERVICE_ROLE_KEY = $kdmS2Runtime.SERVICE_ROLE_KEY
$env:APP_ORIGIN = 'http://127.0.0.1:3000'
$env:KDM_DISABLE_SENTRY = '1'
$env:NEXT_PUBLIC_KDM_DISABLE_SENTRY = '1'
$env:ANALYSIS_EXECUTION_MANIFEST = '{"fingerprintVersion":"s2-05-v2","pricingVersion":"s2-04-v1","promptVersion":"local-e2e-v1","outputSchemaVersion":"local-e2e-v1","providers":{"primary":{"provider":"local-fake","model":"fake"},"fallback":{"provider":"local-fake","model":"fake"}}}'
$env:ANALYSIS_INTERNAL_TOKEN = [guid]::NewGuid().ToString()

$kdmS2Dir = Join-Path ([IO.Path]::GetTempPath()) 'kdm-s2-05-manual'
New-Item -ItemType Directory -Path $kdmS2Dir -Force | Out-Null
$kdmS2EdgeEnv = Join-Path $kdmS2Dir 'analyze.env'
@(
  'ANALYSIS_SUPABASE_URL=http://127.0.0.1:54321'
  "ANALYSIS_SUPABASE_SERVICE_ROLE_KEY=$($kdmS2Runtime.SERVICE_ROLE_KEY)"
  "ANALYSIS_INTERNAL_TOKEN=$env:ANALYSIS_INTERNAL_TOKEN"
  'ANALYSIS_FAKE_PROVIDER=1'
  'ANALYSIS_FAKE_LATENCY_MS=1000'
) | Set-Content -LiteralPath $kdmS2EdgeEnv -Encoding utf8

npx pnpm@12.5.1 dev
```

El manifiesto contiene referencias para esta prueba local; no configura una
integración real con un proveedor. El archivo temporal contiene secretos
locales: no lo muestres, adjuntes ni subas a Git. Su ruta es determinista para
que las terminales C y D puedan localizarlo. No ejecutes dos sesiones de esta
guía simultáneamente.

### 2.3. Terminal B: worker separado de ingesta

```powershell
Set-Location C:\KDM\kdm-demo-worker
npx pnpm@12.5.1 install --frozen-lockfile
npx pnpm@12.5.1 worker:warm
npx pnpm@12.5.1 worker:local
```

El primer warm puede descargar el modelo. `worker:local` obtiene las claves
del stack local mediante su helper. Ambos repositorios tienen actualmente
`project_id = "knowledge-decay-monitor-s1-02"`. No arranques además el worker
de ingesta del repositorio principal: competirían por la misma cola.

En la terminal D:

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:8788/health'
```

Espera `status: ready`; un HTTP 200 sin revisar el cuerpo no basta.

### 2.4. Terminal C: Edge worker de análisis

```powershell
Set-Location C:\KDM\knowledge-decay-monitor
$kdmS2EdgeEnv = Join-Path (Join-Path ([IO.Path]::GetTempPath()) 'kdm-s2-05-manual') 'analyze.env'
if (-not (Test-Path -LiteralPath $kdmS2EdgeEnv)) { throw 'Ejecuta primero el bloque de la terminal A.' }
npx pnpm@12.5.1 exec supabase functions serve analyze --no-verify-jwt --env-file $kdmS2EdgeEnv
```

`--no-verify-jwt` permite que el handler valide su propio Bearer interno.
La función sigue rechazando un token ausente o incorrecto. Supabase inyecta
sus variables `SUPABASE_*`; las variables `ANALYSIS_*` habilitan los dobles
exclusivamente locales. Sin ese modo, los adaptadores pendientes pueden
responder 503 antes del claim.

## 3. Recorrido desde la interfaz

### 3.1. Cuenta y workspace

1. Abre <http://127.0.0.1:3000/register> en un perfil de navegador de prueba.
2. Completa `Email address`, `Password` y `Confirm password`; pulsa `Create account`.
3. Si se solicita confirmar el correo, usa Mailpit local.
4. En el onboarding completa `Your name` y `Workspace name`; pulsa `Create workspace`.
5. Guarda el email utilizado. En todas las consultas sustituye
   `s2-05-manual@example.test` por ese email exacto.

El primer usuario del workspace será Admin. También puede operar un QA Lead;
Member no puede ejecutar análisis. No cambies roles ni uses IDs de otro tenant
para completar el ejercicio.

En Studio verifica la identidad y el saldo inicial:

```sql
select p.id as actor_id, p.workspace_id, p.role, w.name as workspace_name
from public.profiles p
join public.workspaces w on w.id = p.workspace_id
where p.email = 's2-05-manual@example.test';

select b.available, b.reserved
from public.profiles p
cross join lateral private.credit_balances(p.workspace_id) b
where p.email = 's2-05-manual@example.test';
```

Para un workspace recién creado espera una fila, rol Admin y 50 disponibles,
0 reservados. Studio usa privilegios administrativos: estas consultas no
demuestran aislamiento RLS de la sesión del navegador.

### 3.2. Crear y subir dos originales sintéticos

En la terminal D crea dos Markdown con el mismo texto. Esto favorece un par
semántico elegible y permite comprobar ejecución sin depender de que una IA
interprete una contradicción:

```powershell
$kdmS2Dir = Join-Path ([IO.Path]::GetTempPath()) 'kdm-s2-05-manual'
$kdmS2Body = @'
# Synthetic retention policy

Support records must be retained for thirty days after case closure.
The support manager reviews retention compliance every month.
Only the security team may approve access to archived records.
This document is synthetic and contains no customer information.
'@
$kdmS2Body | Set-Content -LiteralPath (Join-Path $kdmS2Dir 's2-05-manual-a.md') -Encoding utf8
$kdmS2Body | Set-Content -LiteralPath (Join-Path $kdmS2Dir 's2-05-manual-b.md') -Encoding utf8
```

1. Ve a <http://127.0.0.1:3000/repository> y localiza `Upload documents`.
2. En `Choose files` selecciona los dos archivos de la carpeta temporal.
3. Usa los nombres `S2-05 Manual A` y `S2-05 Manual B`, categoría `Policy` y
   tu usuario como `Owner` en cada fila.
4. Pulsa `Upload files` y espera el procesamiento. Refresca el Repository si
   hace falta. Ambos documentos deben quedar `ready`, con su versión activa.
5. Si hay un fallo, revisa el worker de ingesta antes de continuar. Que el
   original esté en Storage no significa que ya existan chunks y embeddings.

Verifica en Studio, sin consultar el texto ni los vectores completos:

```sql
select d.name, d.id as document_id, v.id as version_id,
       v.version_number, v.processing_status, v.version_status,
       (d.active_version_id = v.id) as is_active_pointer,
       count(c.id) as chunks,
       min(extensions.vector_dims(c.embedding)) as embedding_dimensions
from public.profiles p
join public.documents d on d.workspace_id = p.workspace_id
join public.document_versions v on v.document_id = d.id and v.workspace_id = d.workspace_id
left join public.document_chunks c on c.version_id = v.id and c.workspace_id = v.workspace_id
where p.email = 's2-05-manual@example.test'
  and d.name in ('S2-05 Manual A', 'S2-05 Manual B')
group by d.id, d.name, d.active_version_id, v.id
order by d.name, v.version_number;
```

Espera dos versiones con `processing_status = ready`, `version_status = active`,
`is_active_pointer = true`, al menos un chunk por versión y dimensión 384.
En Studio → Storage → `documents` puedes comprobar que existen los dos
originales bajo sus IDs de workspace/documento/versión. No compartas rutas,
contenido ni URLs firmadas como evidencia.

### 3.3. Seleccionar y estimar

1. En Repository pulsa `Run Analysis`, o abre <http://127.0.0.1:3000/analysis/run>.
2. En `1. Documents to analyze`, busca `S2-05 Manual A` usando
   `Search documents by name…` y marca su checkbox.
3. En `2. Compare against`, busca y marca `S2-05 Manual B`.
4. Revisa `Scope Summary`: dos versiones distintas de un máximo de 20.
   Los filtros `All Categories` y `All Owners` permiten comprobar el listado.
5. Pulsa `Calculate Estimated Cost`. Debe terminar mostrando
   `Estimated cost: … credits` y habilitar `Proceed to Run Analysis`.
6. No cambies la selección después de estimar: hacerlo invalida la estimación
   de la pantalla. Para esta prueba usa una estimación reciente y conserva el alcance.

Busca la estimación persistida:

```sql
select e.id as estimate_ref, e.workspace_id, e.initiator_id,
       e.source_version_ids, e.comparison_version_ids,
       e.chunk_count, e.candidate_pair_count, e.fixed_cost,
       e.fingerprint_version, e.created_at, e.expires_at
from public.analysis_estimates e
join public.profiles p on p.id = e.initiator_id and p.workspace_id = e.workspace_id
where p.email = 's2-05-manual@example.test'
order by e.created_at desc
limit 5;
```

Anota el `estimate_ref` de esta selección. Comprueba que sus UUID corresponden
a las versiones verificadas arriba y que `candidate_pair_count > 0`. Si es 0,
puedes validar una ejecución vacía, pero no demostrarás procesamiento de pares.
No alteres chunks, embeddings ni el snapshot para forzar un resultado.

La estimación no reserva créditos ni crea un análisis. En un workspace nuevo,
esta consulta todavía debe devolver 0:

```sql
select count(*) as analyses_before_run
from public.analyses a
join public.profiles p on p.id = a.initiator_id and p.workspace_id = a.workspace_id
where p.email = 's2-05-manual@example.test';
```

Pulsa `Proceed to Run Analysis`: aparecerá el aviso de S2-09 mencionado al
inicio. **Este es el límite actual del recorrido de análisis desde la UI.**
No esperes un modal de confirmación, progreso, hallazgos o Retry conectado.

## 4. Puente técnico: ejecutar Run y comprobar S2-05

La siguiente consulta **sí crea un análisis y reserva créditos** en el workspace
local de prueba. Sustituye el UUID por el `estimate_ref` verificado y usa una
clave única para este recorrido. Guarda esa clave: la reutilizaremos tal cual.
No ejecutes este puente sobre un proyecto remoto.

```sql
with selected_estimate as (
  select e.id, e.initiator_id, e.execution_manifest
  from public.analysis_estimates e
  join public.profiles p on p.id = e.initiator_id and p.workspace_id = e.workspace_id
  where e.id = '00000000-0000-4000-8000-000000000001'::uuid
    and p.email = 's2-05-manual@example.test'
)
select r.*
from selected_estimate e
cross join lateral public.run_analysis(
  e.initiator_id,
  e.id,
  's2-05-manual-20261017-01',
  e.execution_manifest
) r;
```

Espera exactamente una fila con `analysis_id` y `status = queued`. Cero filas
significa que no encontraste la estimación de ese usuario: no continúes.
La RPC revalida vigencia, versiones, créditos y concurrencia. Si caducó la
estimación, vuelve a calcularla en la UI. El manifiesto de esta prueba se toma
del registro que la web creó con la configuración local; este uso administrativo
no verifica por sí solo la detección de cambios en la configuración del servidor.

Antes de disparar el worker, **repite exactamente el mismo SQL**, incluido
estimate y clave. Debe devolver el mismo `analysis_id`. Esto verifica el replay
idempotente; no debe aparecer otra reserva. No uses una clave nueva para el replay.

En las consultas siguientes sustituye el UUID de ejemplo por ese `analysis_id`:

```sql
select id, workspace_id, initiator_id, estimate_id, status,
       fixed_cost, reserved_credits, attempt_count, created_at
from public.analyses
where id = '00000000-0000-4000-8000-000000000002'::uuid;

select document_id, version_id, role
from public.analysis_documents
where analysis_id = '00000000-0000-4000-8000-000000000002'::uuid
order by role, version_id;

select event_type, count(*) as events, sum(amount) as amount
from public.credit_ledger
where analysis_id = '00000000-0000-4000-8000-000000000002'::uuid
group by event_type;
```

Espera `queued`, `attempt_count = 0`, el estimate correcto, dos versiones en
sus roles y **un solo `Reserved`**, cuyo importe sea igual a `fixed_cost` y
`reserved_credits`. Si habilitaste previamente el recovery scheduler, puede
reclamar antes que tú; revisa su estado en la sección 6. No lo deshabilites si
pertenece a otra prueba en curso.

## 5. Disparar el worker y observar la ejecución

En la terminal D, con la terminal C activa, reemplaza el UUID:

```powershell
$kdmS2AnalysisId = '00000000-0000-4000-8000-000000000002'
$kdmS2EdgeEnv = Join-Path (Join-Path ([IO.Path]::GetTempPath()) 'kdm-s2-05-manual') 'analyze.env'
$kdmS2TokenLine = Get-Content -LiteralPath $kdmS2EdgeEnv |
  Where-Object { $_.StartsWith('ANALYSIS_INTERNAL_TOKEN=') } |
  Select-Object -First 1
if (-not $kdmS2TokenLine) { throw 'No se encontró el token local.' }
$kdmS2Token = $kdmS2TokenLine.Substring('ANALYSIS_INTERNAL_TOKEN='.Length)
try {
  $kdmS2Response = Invoke-WebRequest `
    -Uri 'http://127.0.0.1:54321/functions/v1/analyze' `
    -Method Post `
    -Headers @{ Authorization = "Bearer $kdmS2Token" } `
    -ContentType 'application/json' `
    -Body (@{ analysisId = $kdmS2AnalysisId } | ConvertTo-Json -Compress)
  $kdmS2Response.StatusCode
  $kdmS2Response.Content
} finally {
  Remove-Variable kdmS2Token, kdmS2TokenLine -ErrorAction SilentlyContinue
}
```

Espera HTTP 202 y `{"ok":true,"accepted":true}`. Eso confirma aceptación del
trabajo en segundo plano, **no su finalización**. No imprimas el objeto completo
de la petición ni las cabeceras. Consulta Studio varias veces:

```sql
select id, status, attempt_count,
       checkpoint ->> 'processedPairs' as processed_pairs,
       checkpoint ->> 'totalPairs' as total_pairs,
       continuation_pending, next_attempt_at, lease_expires_at,
       error_code, started_at, finished_at
from public.analyses
where id = '00000000-0000-4000-8000-000000000002'::uuid;

select s.analysis_id, s.is_complete, s.chunk_count, s.candidate_pair_count,
       (select count(*) from private.analysis_candidate_pair_rows r
        where r.analysis_id = s.analysis_id and r.workspace_id = s.workspace_id) as materialized_pairs
from private.analysis_candidate_pair_snapshots s
where s.analysis_id = '00000000-0000-4000-8000-000000000002'::uuid;
```

Resultado esperado:

- El análisis pasa de `queued` a `processing` y termina en `completed` con el
  proveedor falso. Una ejecución pequeña puede finalizar antes de que veas `processing`.
- El primer intento normal tiene `attempt_count = 1`; el checkpoint de un caso
  con pares debe llegar a `processedPairs = totalPairs`.
- El snapshot materializado se crea durante el trabajo; una vez completo,
  `materialized_pairs = candidate_pair_count`. Se reutiliza entre páginas.
- Al terminar se eliminan sus filas privadas y cabecera. Que la segunda consulta
  no devuelva filas después de `completed` es correcto, no evidencia de un fallo.
- No se esperan hallazgos de negocio, eventos ni liquidación del ledger con
  estos dobles. Repite la consulta del ledger: seguirá existiendo la reserva.

Para verificar de manera reproducible el snapshot durante varias páginas y su
limpieza, usa `analysis-materialized-candidates.test.ts` en la sección siguiente.
No robes leases ni cambies timestamps para intentar detener el worker manualmente.

## 6. Verificaciones técnicas que completan la cobertura local

El recorrido anterior no cubre por sí solo concurrencia, Retry, aislamiento,
reinicios ni recuperación de un disparo perdido. Las pruebas existentes cubren
esos casos con fixtures controlados.

**Antes de ejecutarlas**, detén con `Ctrl+C` el Edge manual (C) y el worker de
ingesta (B). Los harnesses gestionan sus procesos y comparten las colas locales.
No los ejecutes en paralelo con otro desarrollador/prueba sobre el mismo stack.
Mantén Docker y Supabase encendidos. Ejecuta desde el repositorio principal:

```powershell
Set-Location C:\KDM\knowledge-decay-monitor
node scripts/with-local-supabase.mjs integration tests/integration/analysis-run.test.ts tests/integration/analysis-run-concurrency.test.ts tests/integration/analysis-isolation.test.ts tests/integration/analysis-retrieval-snapshot.test.ts tests/integration/analysis-materialized-candidates.test.ts --no-file-parallelism --maxWorkers=1
if ($LASTEXITCODE -ne 0) { throw 'Falló la cobertura de Run/snapshot/aislamiento.' }

node scripts/with-local-supabase.mjs integration tests/integration/analysis-recovery.test.ts --no-file-parallelism --maxWorkers=1
if ($LASTEXITCODE -ne 0) { throw 'Falló la cobertura de recuperación.' }
```

Espera `PASS` y salida 0. Recovery puede tardar varios minutos porque espera
leases y ticks reales; no es una prueba instantánea. Comprueba en los nombres
de casos qué escenarios se ejecutaron. Se usan proveedores/finalizadores falsos,
pero el claim, PostgreSQL, Edge, scheduler y transiciones locales son reales.
El harness de recovery configura sus secretos y scheduler de prueba y realiza
su limpieza; no requiere pegar secretos en Studio.

Consultas opcionales para observar el scheduler, sin exponer Vault:

```sql
select jobid, jobname, schedule, active
from cron.job
where jobname = 'kdm-analysis-recovery';

select jobid, status, start_time, end_time
from cron.job_run_details
where jobid in (select jobid from cron.job where jobname = 'kdm-analysis-recovery')
order by start_time desc limit 10;

select id as request_id, status_code
from net._http_response
order by id desc limit 10;
```

Un cron instalado pero inactivo es el estado inicial esperado sin configuración.
El historial HTTP puede contener otras llamadas; no atribuyas cualquier 202 a
tu análisis sin correlacionar horario y estado del job. El runbook de
[S2-06](s2-06-analysis-worker-runbook.md) detalla la configuración manual del scheduler.

**Retry manual:** hoy no hay botón conectado. La RPC exige un análisis fallido
con su reserva completamente liberada, estimate vigente y clave nueva. El
finalizador falso no escribe `Released`, por lo que provocar un fallo falso y
llamar Retry no reproduce el flujo final del producto. Usa los fixtures de las
pruebas de Run para verificar el contrato; no insertes eventos de ledger a mano
para presentar ese recorrido como E2E.

La capacidad máxima es otro gate técnico. No se demuestra subiendo estos dos
archivos. Usa los pasos y los límites de [aceptación S2-05](s2-05-acceptance.md)
si necesitas repetir esa medición. El gate de capacidad en entorno alojado
permanece separado de esta guía local.

## 7. Si algo no coincide

| Síntoma | Qué comprobar |
| --- | --- |
| Uploads se quedan pendientes | Salud `ready` en 8788, terminal B, mismo project_id y modo de `private.upload_control`. No levantes dos workers para compensar. |
| Upload pausado | Consulta `select mode from private.upload_control where singleton;`. Resuelve la pausa deliberadamente antes de probar; no cambies controles de otra sesión. |
| Documentos no aparecen en Analysis | Rol Admin/QA Lead, mismo workspace, versión `ready` y activa, chunks existentes y filtros de la tabla. |
| Estimación temporalmente no disponible | `ANALYSIS_EXECUTION_MANIFEST` válido en la terminal que inició la web. Reinicia la web después de corregirlo. |
| Proceed solo muestra un aviso | Es el límite actual de S2-09; continúa por el puente técnico. |
| Run rechaza la operación | Vigencia del estimate, versiones activas sin cambios, créditos disponibles y ausencia de otro análisis activo en el workspace. No cambies la clave para eludir un conflicto de payload. |
| HTTP 401 | Token de D distinto al archivo que cargó C. Si regeneraste el archivo, reinicia Edge para cargarlo. |
| HTTP 503 y job queued | Readiness: C debe cargar el env-file local con `ANALYSIS_FAKE_PROVIDER=1` y URL loopback. No interpretes esto como un intento procesado. |
| HTTP 202 pero no completed | Consulta estado, intentos, checkpoint, leases y `error_code`; revisa C y su conexión al stack. 202 solo es un ACK. |
| No alcanzo a ver el snapshot | Puede haberse limpiado al finalizar. Usa la prueba de materialización para observar sus invariantes. |
| Completed sin findings y con Reserved | Resultado previsto del finalizador de prueba; falta el flujo real de S2-07/S2-08. |
| Recovery no hace nada fuera del test | El scheduler está deshabilitado o no configurado; no se activa por iniciar `functions serve`. |

No compartas respuestas crudas de proveedores, tokens, claves, documentos,
chunks, vectores, cabeceras HTTP, valores de Vault ni URLs firmadas en logs o capturas.

## 8. Evidencia y cierre de la prueba

Guarda de manera privada los IDs de workspace, versiones, estimate y análisis;
el costo; número de candidatos; resultado del replay; estados y checkpoint;
conteo/importe del ledger; y salida resumida de los tests. Para compartir una
captura usa datos sintéticos y oculta correos e identificadores si corresponde.

- [ ] Supabase local tiene todas las migraciones del checkout aplicadas.
- [ ] El worker separado procesó dos originales subidos desde la UI.
- [ ] Ambas versiones quedaron activas, con chunks y embeddings de 384 dimensiones.
- [ ] La UI guardó una estimación del alcance correcto, con al menos un par.
- [ ] Se observó el límite real del botón Proceed, sin atribuirle un Run.
- [ ] La RPC creó un solo análisis y una sola reserva; el replay devolvió el mismo ID.
- [ ] El Edge aceptó el disparo y la base confirmó el estado terminal y checkpoint.
- [ ] Las pruebas técnicas de Run/snapshot/aislamiento/recovery terminaron en PASS.
- [ ] Se registró que IA real, findings, liquidación, eventos y confirmación UI siguen fuera de este recorrido.

Esto permite afirmar **“integración local de los componentes disponibles
verificada, con puente técnico y proveedor falso”**. El cierre E2E del segundo
vertical desde la UI requiere conectar y verificar S2-07, S2-08 y S2-09; este
procedimiento no demuestra despliegue ni funcionamiento alojado.

Al finalizar, detén la web y ambos workers con `Ctrl+C`. Borra únicamente los
archivos temporales de este ejercicio, cuando ya no los necesites:

```powershell
$kdmS2Dir = Join-Path ([IO.Path]::GetTempPath()) 'kdm-s2-05-manual'
foreach ($kdmS2File in @('analyze.env', 's2-05-manual-a.md', 's2-05-manual-b.md')) {
  $kdmS2Path = Join-Path $kdmS2Dir $kdmS2File
  if (Test-Path -LiteralPath $kdmS2Path) { Remove-Item -LiteralPath $kdmS2Path }
}
```

Cierra las terminales de prueba para descartar sus variables de entorno.
Los datos de demostración y la reserva quedan en el workspace descartable;
esta limpieza no los elimina ni modifica el ledger. No hagas un reset global
para limpiar un ejercicio que comparte stack con tus otros datos.

## Referencias

- [Aceptación y capacidad S2-05](s2-05-acceptance.md).
- [Operación y recuperación del worker S2-06](s2-06-analysis-worker-runbook.md).
- [Tickets Sprint 2](../Tickets/sprint-2-ai-analysis.md).
- [Selector y límite actual de Proceed](../../src/modules/analysis/ui/run-analysis-view.tsx).
- [Server Actions de Run/Retry](../../src/modules/analysis/application/run-actions.ts).
- [Handler Edge y puerta de pruebas locales](../../supabase/functions/analyze/index.ts).
- Documentación vigente consultada mediante Context7: [Supabase CLI](https://github.com/supabase/cli/blob/develop/README.md),
  [referencia de comandos y migraciones locales](https://github.com/supabase/cli/blob/develop/apps/cli/docs/go-cli-reference.md)
  y [carga del env-file de funciones](https://github.com/supabase/cli/blob/develop/apps/cli/src/shared/functions/serve.ts).
