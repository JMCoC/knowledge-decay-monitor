# Primer vertical: probar en local y llevar a producción

Verificado el 2026-10-09 sobre `fix/adjustment_vertical_slice`, candidato previo a esta guía `656a6fd`. Los comandos remotos de este documento son instrucciones para el operador: no se ejecutaron push, PRs, migraciones ni despliegues remotos durante este diagnóstico.

## 1. Diagnóstico y recuperación local

Actualización del 2026-10-09: el stack volvió a arrancar y publica sus puertos; DB conserva los 7 documentos anteriores y tiene 21 migraciones. El worker local responde Ready. Se reprodujo `This file cannot be uploaded.` en la web con un Markdown sintético, sin crear reserva. Añadiendo únicamente la service role local a `.env.local`, el mismo recorrido llegó a Ready/Active. También pasó un PDF textual de fixtures con chunks de 384 dimensiones. Los datos sintéticos se limpiaron; quedaron 96 usuarios y 7 documentos. No se probó el PDF privado del usuario. El diagnóstico de puertos siguiente explica la incidencia anterior y sirve si reaparece.

Next responde en `http://127.0.0.1:3000/login`, pero Auth, Studio y Mailpit no eran accesibles. Los contenedores tenían puertos configurados sin publicación efectiva al host. Al intentar recrearlos conservando los volúmenes, Docker informó:

```text
ports are not available ... 0.0.0.0:54322 ... bind:
Intento de acceso a un socket no permitido por sus permisos de acceso.
```

Windows tiene reservado el intervalo TCP **54262–54361**, tanto en IPv4 como en IPv6. Incluye API 54321, PostgreSQL 54322, Studio 54323 y Mailpit 54324. Una prueba de bind confirmó `EACCES` en los cuatro. Ese bloqueo explica el fallo general de conectividad; el texto de recovery es un mensaje controlado de la aplicación, no un diagnóstico del proveedor.

Se ejecutó `stop` sin `--no-backup`; los volúmenes de DB, Storage y Edge del proyecto `knowledge-decay-monitor-s1-02` siguen presentes. Supabase quedó **detenido**, pendiente de resolver el bloqueo de Windows. Antes de detenerlo había **95 usuarios, 7 documentos y 21 migraciones**; comprobar estos conteos al recuperar el stack, antes de crear datos de prueba. No se hizo reset ni seed.

Antes de la corrección, `.env.local` tenía URL/publishable key locales, pero no `SUPABASE_SERVICE_ROLE_KEY`. Se añadió la clave del stack local, sin imprimirla ni versionarla. Esa clave es necesaria para upload/retry y procesamiento. Recovery utiliza la clave pública; su fallo anterior requería recuperar la conectividad.

## 2. Recuperar los puertos de Windows

1. Guarda trabajo y detén Next/worker con `Ctrl+C` en sus terminales. No elimines volúmenes, no hagas factory reset de Docker ni cambies `project_id`.
2. Reinicia Windows y abre Docker Desktop. Espera a que su engine esté listo.
3. Comprueba las exclusiones:

```powershell
netsh interface ipv4 show excludedportrange protocol=tcp
netsh interface ipv6 show excludedportrange protocol=tcp
```

Los puertos 54320–54324 deben quedar fuera de las reservas. 54320 es el puerto auxiliar de DB. Que `netstat` no muestre un proceso no demuestra que Windows permita usar el puerto.

4. Si siguen reservados, cierra Docker Desktop y otras tareas de contenedores. Abre **PowerShell como administrador** y prueba:

```powershell
Restart-Service -Name winnat -ErrorAction Stop
netsh interface ipv4 show excludedportrange protocol=tcp
netsh interface ipv6 show excludedportrange protocol=tcp
```

Esto reinicia la red NAT de Windows y puede interrumpir redes de otros contenedores/VMs. Es una medida de recuperación, no una garantía: comprueba nuevamente los rangos y luego abre Docker Desktop. Esta sesión de diagnóstico no tiene privilegios de administrador, por eso no se ejecutó. El conflicto y una recuperación mediante WinNAT están descritos en el [repositorio de Microsoft Aspire](https://github.com/microsoft/aspire/issues/9634); la sintaxis de consulta está en [Microsoft Learn](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/netsh-interface).

5. Si persiste, detén aquí el arranque y revisa la reserva con el administrador del equipo. Cambiar puertos requiere actualizar también los helpers/tests que fijan 54321/54324; cambiar solo `config.toml` dejaría una configuración inconsistente. No borres exclusiones de Windows a ciegas.

## 3. Arrancar Supabase conservando datos

En PowerShell normal, desde la raíz:

```powershell
Set-Location C:\KDM\knowledge-decay-monitor
node -v
docker info --format '{{.ServerVersion}}'
npx pnpm@12.5.1 install --frozen-lockfile
node scripts/local-supabase-lifecycle.mjs start
```

Node del CI es 24.11.0 y pnpm está fijado en 12.5.1. El helper de arranque evita imprimir las claves. Si informa fallo, no continúes con Next ni intentes resolverlo con un reset.

```powershell
docker ps --filter name=knowledge-decay-monitor-s1-02 --format '{{.Names}} {{.Status}} {{.Ports}}'
Invoke-WebRequest http://127.0.0.1:54323 -UseBasicParsing | Select-Object StatusCode
Invoke-WebRequest http://127.0.0.1:54324 -UseBasicParsing | Select-Object StatusCode
docker exec supabase_db_knowledge-decay-monitor-s1-02 psql -XAt -U postgres -d postgres -c "select 'users='||(select count(*) from auth.users)||', documents='||(select count(*) from public.documents)||', migrations='||(select count(*) from supabase_migrations.schema_migrations);"
npx pnpm@12.5.1 exec supabase migration list --local
npx pnpm@12.5.1 exec supabase migration up --local
```

Studio y Mailpit deben responder 200; Docker debe mostrar mappings al host como `54321->8000/tcp`. En este checkout ya había 21 migraciones, así que `migration up --local` no debería aplicar ninguna nueva. En otra copia atrasada aplica solo las pendientes y conserva los datos.

## 4. Arrancar la web con las claves del stack correcto

Usa esta misma terminal para cargar variables **sin imprimirlas**:

```powershell
$kdmLocal = node node_modules/supabase/dist/supabase.js status -o json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Supabase local no está listo' }
if ($kdmLocal.API_URL -ne 'http://127.0.0.1:54321') { throw 'URL local inesperada' }
if (-not $kdmLocal.SERVICE_ROLE_KEY) { throw 'Falta service role local' }
$env:NEXT_PUBLIC_SUPABASE_URL = $kdmLocal.API_URL
$env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = if ($kdmLocal.PUBLISHABLE_KEY) { $kdmLocal.PUBLISHABLE_KEY } else { $kdmLocal.ANON_KEY }
$env:SUPABASE_SERVICE_ROLE_KEY = $kdmLocal.SERVICE_ROLE_KEY
$env:APP_ORIGIN = 'http://127.0.0.1:3000'
$env:KDM_DISABLE_SENTRY = '1'
$env:NEXT_PUBLIC_KDM_DISABLE_SENTRY = '1'
Invoke-WebRequest "$($kdmLocal.API_URL)/auth/v1/settings" -Headers @{ apikey=$env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY } -UseBasicParsing | Select-Object StatusCode
Remove-Variable kdmLocal
npx pnpm@12.5.1 dev
```

Auth settings debe responder 200. Las variables `$env:` solo afectan esa terminal y sus procesos hijos; reiniciar Next desde otra terminal no las conserva. Alternativamente, guarda los mismos valores **locales** en `.env.local`, que Git ignora. La clave de servicio nunca lleva prefijo `NEXT_PUBLIC_`. No hay `.env.example` en este checkout.

Abre siempre `http://127.0.0.1:3000`, también para recovery. Usa ese host durante todo el recorrido para conservar cookies/callbacks coherentes. Studio es `http://127.0.0.1:54323` y el buzón local es `http://127.0.0.1:54324`.

## 5. Arrancar el worker en otra terminal

El worker es un proceso que lee trabajos de PostgreSQL, descarga el original privado, lo parsea, genera embeddings y finaliza la versión. Next sirve la web; no mantiene este proceso. Sin worker puedes tener Auth funcional y documentos que permanecen Queued.

```powershell
Set-Location C:\KDM\knowledge-decay-monitor
npx pnpm@12.5.1 worker:warm
npx pnpm@12.5.1 worker:local
```

La primera preparación descarga el modelo fijado. `worker:local` obtiene las claves locales por su cuenta; no necesita que copies la service role en esa terminal. Déjalo ejecutándose. En una tercera terminal:

```powershell
Invoke-RestMethod http://127.0.0.1:8788/health
```

Debe devolver `status: ready` después de cargar el modelo y contactar la DB. Un worker consume la cola; abrir la página no lo arranca.

## 6. Recorrido manual completo

Antes de probar upload, consulta en el SQL Editor **local**:

```sql
select mode from private.upload_control where singleton;
```

Si está `paused` y quieres habilitar uploads en tu local:

```sql
update private.upload_control set mode='active',updated_at=now() where singleton;
```

1. **Registro/bootstrap:** crea un email único local y contraseña; completa la creación de workspace. Debes llegar al Repository como Admin. Sal y vuelve a entrar. El registro local no exige confirmación de email.
2. **Recovery:** pide reset para ese usuario. Abre Mailpit 54324, busca el mensaje y usa el enlace en el mismo navegador. Cambia contraseña, cierra sesión y comprueba login con la nueva. El SMTP local captura correo; no lo entrega a tu inbox real. Un enlace usado/expirado debe rechazarse controladamente.
3. **Upload:** crea `prueba-vertical.md` con varias frases de texto, súbelo con categoría y owner válidos. Debe pasar por Queued/Processing y llegar a Ready. Con un archivo pequeño puedes no alcanzar a ver estados intermedios. Repite con PDF textual y DOCX reales; un PDF escaneado sin texto no prueba el caso admitido.
4. **Lectura:** busca por nombre, aplica filtros, abre el original y comprueba metadata. La URL firmada dura 300 segundos; abre una nueva desde la UI después de vencer. No guardes esas URLs en evidencia.
5. **Durabilidad:** detén solo el worker, sube otro Markdown y confirma Queued. Reinicia `worker:local`; debe terminar Ready sin volver a subir el archivo. Para probar reclamación tras caída durante Processing, usa un documento suficientemente largo, detén el worker, espera al menos 180 segundos y reinícialo. No hagas un reset para acelerar la prueba.
6. **Retry:** con fixtures disponibles, entra como Admin A y reintenta `Recovery drill`, que simula fallo con contenido válido. Debe conservar documento/versión/original y terminar Ready. Un documento realmente inválido puede fallar otra vez: Retry no corrige su contenido. Esta prueba cambia un fixture; ejecuta primero `test:fixtures` si quieres verificar el seed original.
7. **Permisos:** en sesiones separadas prueba Admin A/QA A, Member A y Admin B. Admin/QA ven su tenant; Member no accede al Repository ni originales y Admin B no ve documentos de A. Owner no añade permisos.

Fixtures existentes, solo si el seed ya está presente: `admin.a@example.test`, `qa.a@example.test`, `member.a@example.test`, `admin.b@example.test`; contraseña pública local `LocalOnly-KDM-2026!`. Si no existen, no hagas reset de tus datos para obtenerlos: usa un entorno descartable para las pruebas de roles. No envíes recovery a esos usuarios si necesitas conservar su contraseña para `test:fixtures`.

Comprobación SQL local de una versión nueva; sustituye el UUID por el de tu prueba:

```sql
select v.id,v.processing_status,v.version_status,d.active_version_id,
  count(c.id) as chunks,min(extensions.vector_dims(c.embedding)) as dimensions
from public.document_versions v
join public.documents d on d.id=v.document_id
left join public.document_chunks c on c.version_id=v.id
where v.id='<version-id>'::uuid
group by v.id,v.processing_status,v.version_status,d.active_version_id;
```

Esperado: `ready`, `active`, puntero igual al ID de versión, al menos un chunk y dimensions 384.

## 7. Certificación automatizada e imagen Docker

Ejecuta en serie; detén Next y el worker manual antes. Playwright reutiliza un servidor existente fuera de CI: dejar tu `dev` vivo puede hacer que pruebes variables incorrectas. Integración y E2E administran su propio worker y cambian temporalmente controles globales locales; no uses la aplicación mientras corren. Crean/limpian datos propios, pero `test:fixtures` reconcilia fixtures legacy y exige su estado original. No uses suites locales contra Supabase remoto.

```powershell
npx pnpm@12.5.1 lint
npx pnpm@12.5.1 typecheck
npx pnpm@12.5.1 test:unit
npx pnpm@12.5.1 test:db
npx pnpm@12.5.1 check:database-types
npx pnpm@12.5.1 test:fixtures
npx pnpm@12.5.1 test:integration
node scripts/with-local-supabase.mjs build
npx pnpm@12.5.1 exec playwright install chromium
npx pnpm@12.5.1 worker:warm
$kdmSha = git rev-parse HEAD
docker build --platform linux/amd64 -f Dockerfile.ingestion -t "kdm-ingestion:$kdmSha" .
if ($LASTEXITCODE -ne 0) { throw 'No continuar: falló la imagen' }
$env:KDM_WORKER_IMAGE = "kdm-ingestion:$kdmSha"
npx pnpm@12.5.1 test:worker:image
if ($LASTEXITCODE -ne 0) { throw 'No publicar: falló el smoke de imagen' }
npx pnpm@12.5.1 test:e2e:local
npx pnpm@12.5.1 test:auth:restart
```

Cada comando debe terminar con exit 0 antes del siguiente. El smoke prueba la imagen final como usuario `node`, inferencia offline y un original local hasta Ready. No sustituye E2E. Si alteraste fixtures manualmente, ejecuta la certificación completa en CI o en otro Docker host/VM descartable; otro directorio con el mismo `project_id` sigue compartiendo volúmenes. No hagas reset de esta base para conseguir checks verdes.

La [aceptación histórica](first-vertical-acceptance.md) registra suites locales previas; la imagen Docker quedó pendiente por timeout de npm. En el diagnóstico posterior se probaron upload Markdown y PDF textual contra el Next/worker locales activos, después de corregir la configuración. No se volvieron a ejecutar las suites completas ni el build/smoke Docker.

## 8. Topología remota y hosting recomendado

Con tu decisión actual, la topología es:

```text
Vercel Preview ─────┐
                   ├── Supabase compartido: Auth + DB + Storage + cola
Vercel Production ─┘                       ↑
                              UN worker persistente
```

Ese worker puede procesar cualquier job de la cola, venga de Preview o Production. `INGESTION_ENVIRONMENT` solo etiqueta telemetría; no separa trabajos. No crees un worker experimental Preview conectado a esta DB. Las migraciones/Auth/Storage afectan a ambos ambientes. Prueba con workspaces sintéticos y acceso Preview restringido; no hay aislamiento real. La opción que recomiendo para evolución del producto es un segundo Supabase para Preview, aunque este corte puede coordinarse con el compartido.

**Restricción confirmada: no contratar servicios de pago.** La recomendación es alojar el worker en un PC/servidor que ya tengan, conectado al Supabase remoto. El proceso hace conexiones HTTPS salientes: no necesita dominio, túnel ni puertos públicos. El modelo corre en esa máquina; no se paga una API de embeddings. Mientras esté apagada, los documentos permanecen Queued y se retoman al volver. Electricidad, conexión y operación siguen siendo recursos necesarios, aunque no haya tarifa de hosting. Retiramos Railway de la propuesta.

Una VM Oracle Always Free es una alternativa condicional: depende de capacidad en la región y las instancias ociosas pueden recuperarse. La variante Ampere es ARM, así que requiere construir/probar la imagen en esa arquitectura; el smoke AMD64 anterior no la certifica. No basar el cierre en que esa VM estará disponible. [Always Free](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).

Supabase Free incluye actualmente DB de 500 MB, Storage de 1 GB y egress de 5 GB; no incluye backups automáticos y puede pausarse por inactividad. Preparar una copia recuperable propia dentro de los recursos existentes. [Límites del plan](https://supabase.com/pricing). Para el hosting web, Vercel Hobby limita el uso a proyectos personales no comerciales. Si se lanza el SaaS comercial con presupuesto cero, también debe decidirse una alternativa web permitida o autoalojar Next con HTTPS; ese despliegue no está cubierto por el workflow Vercel actual. [Vercel Hobby](https://vercel.com/docs/plans/hobby).

Volver a Edge no resuelve el presupuesto de cómputo: Supabase publica 256 MB y 2 segundos de CPU por request, y ese runtime ya falló en la aceptación anterior. Usar cola + worker en hardware existente conserva el vertical sin reescribir el pipeline. [Límites de Edge](https://supabase.com/docs/guides/functions/limits).

## 9. Preparación de GitHub, Vercel y Auth

1. Conserva cambios ajenos y define el SHA candidato. Esta rama tiene exclusiones locales sin commit (`.agents/`, `.claude/`, `skills-lock.json`, `supabase/snippets/`); no uses `git add .`.
2. En protecciones de `develop` y `main`, exige **Quality gates** conservando aprobación/revisores. En la lectura de hoy ninguna rama tenía required status checks.
3. En GitHub environment Production, configura aprobación manual si el plan lo permite. Hoy solo tiene una restricción de ramas, sin required reviewers. Si no puedes poner esa barrera, no hagas merge a main hasta que todo el backend esté preparado y aceptado: el push dispara Production.
4. Ya existen por nombre en los environments Preview/Production `VERCEL_TOKEN`, `SENTRY_AUTH_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`; Production también tiene `APP_ORIGIN`. No se verificaron los valores privados.
5. En Vercel verifica por target URL/publishable key del Supabase compartido y `SUPABASE_SERVICE_ROLE_KEY` privada. Los nombres existen en ambos targets; eso no certifica valores válidos. APP_ORIGIN Production debe coincidir con el dominio HTTPS real y con la variable GitHub Production. El script asigna Preview a `https://kdm-pr-<numero>-kdm17.vercel.app` y configura su origin. Hay un APP_ORIGIN Preview limitado a `develop`: no dependas de ese valor para otros PRs.
6. Verifica Sentry de web y worker, environment/release y sourcemaps privados dentro de la cuota gratuita. El worker requiere `SENTRY_DSN`; no asumas que una integración Vercel lo configura en tu PC/servidor. No actives flags locales que deshabilitan Sentry en remoto.
7. En **Supabase remoto**, Auth URL Configuration: Site URL del dominio Production y redirect permitido exacto `<origin-production>/auth/callback`. Tras conocer el número del PR añade también el callback exacto de su alias Preview. La configuración TOML local no configura el servicio hosted.
8. Configura SMTP existente o un plan gratuito con remitente/dominio que ya controlen, credenciales privadas y límites adecuados; prueba recepción en un buzón controlado. Si no hay remitente autorizado gratuito disponible, recovery remoto sigue pendiente: Mailpit solo sirve en local. El SMTP incluido de Supabase no es para producción y restringe destinatarios. [Documentación de SMTP](https://supabase.com/docs/guides/auth/auth-smtp).
9. En plantilla Reset Password remota usa el enlace del archivo `supabase/templates/recovery.html`: `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&amp;type=recovery`. No añadas otra vez `/auth/callback`. Prueba cambio de contraseña completo desde ambos dominios y rechazo de enlace reutilizado.
10. Decide el alcance del registro: S1 usa confirmación desactivada y sesión inmediata. `register` devuelve error si Auth exige confirmar el email. Para un piloto privado conserva la configuración acordada y limita acceso. Para registro público recomiendo implementar y probar confirmación/onboarding antes de habilitarla; activar el toggle remoto por sí solo rompe el recorrido actual. Es trabajo adicional al despliegue, no una migración pendiente que lo resuelva.

## 10. Primer PR y preparar el worker probado

Desde la rama candidata, después de revisar el diff y terminar los checks locales posibles:

```powershell
git push -u origin fix/adjustment_vertical_slice
gh pr create --repo JMCoC/knowledge-decay-monitor --draft --base develop --head fix/adjustment_vertical_slice --title "feat(ingestion): complete first vertical with durable processing" --body-file docs/testing/first-vertical-pr.md
gh pr checks --repo JMCoC/knowledge-decay-monitor <numero>
```

El draft ejecuta Quality gates, pero no despliega Preview. Exige CI verde del HEAD final: hoy no hay PR abierto ni ejecución CI del último candidato. El job de CI **construye y prueba** la imagen, pero **no la publica ni despliega**. En un único equipo existente puedes ejecutar el checkout probado mediante Node (paso 11), o la imagen Docker local que acabas de construir/probar. No necesitas registry para la modalidad Node ni para una imagen construida en el mismo host. Si cambió código, repite los checks correspondientes. Vigila los minutos gratuitos de GitHub Actions: CI no es el servicio persistente del worker.

Solo si necesitas trasladar la imagen a otro host y eliges GHCR dentro de su cuota disponible, autentica Docker con un token `write:packages` por el prompt de contraseña; no lo pongas en el comando ni en el repo:

```powershell
docker login ghcr.io -u <usuario-github>
$kdmSha = git rev-parse HEAD
$kdmRegistryImage = "ghcr.io/jmcoc/kdm-ingestion:$kdmSha"
docker tag "kdm-ingestion:$kdmSha" $kdmRegistryImage
docker push $kdmRegistryImage
if ($LASTEXITCODE -ne 0) { throw 'No continuar: no se publicó la imagen' }
docker image inspect $kdmRegistryImage --format '{{json .RepoDigests}}'
```

Registra el digest `sha256:...`; confirma paquete privado y acceso del operador. No uses `latest` para liberar. El host que descarga el paquete solo necesita lectura `read:packages`; no publiques el código para evitar configurar acceso.

## 11. Preparar un equipo existente sin iniciar otro consumidor

1. Elige un PC/servidor disponible, con Node 24.11.0, memoria suficiente y conexión estable. Usa un checkout del SHA probado dedicado al worker remoto, separado del desarrollo local; no ejecutes tests/seed contra ese backend. Mantén **un único consumidor remoto**.
2. Instala dependencias congeladas y prepara el modelo con `npx pnpm@12.5.1 worker:warm` desde esa copia. Comprueba los casos largos y RSS en ese equipo. La preparación usa `.artifacts/models` por defecto; conservar esa carpeta permite inferencia offline.
3. Crea `.env.worker`, ignorado por Git, solo para ese proceso. Variables privadas: `SUPABASE_URL=https://cdyjtoheovbvewewicaa.supabase.co`, `SUPABASE_SERVICE_ROLE_KEY` del proyecto remoto y `SENTRY_DSN`. No copies valores al comando ni a la web. Variables no secretas: `INGESTION_ENVIRONMENT=vercel-production`, `INGESTION_RELEASE_SHA=<sha-del-checkout>`, `INGESTION_MODEL_OFFLINE=1`, `INGESTION_WORKER_PORT=8788`, `INGESTION_WORKER_HOST=127.0.0.1`. Si otro worker local ocupa 8788 en la misma máquina, usa por ejemplo 8789 para este proceso remoto. El tag production refleja la cola compartida; no aísla jobs.
4. No inicies todavía: espera las migraciones del paso 12. Después, desde la raíz de ese checkout, ejecuta:

```powershell
node --env-file=.env.worker --conditions=react-server --import tsx scripts/ingestion-worker.ts
```

Node da prioridad a variables heredadas del proceso sobre el archivo: usa una terminal sin overrides locales `SUPABASE_URL`/service role, o un supervisor con ambiente dedicado. `worker:local` siempre selecciona el stack local y **no sirve para consumir la cola remota**.

5. En Windows configura el Programador de tareas para iniciar Node al iniciar sesión, directorio de trabajo del checkout, argumentos anteriores con ruta absoluta a `.env.worker` y reinicio ante fallo. Para servicio sin sesión usa un supervisor del sistema adecuado al host elegido; no se instaló ninguno en este diagnóstico. En Linux usa un servicio del sistema. Antes de aceptar, prueba reinicio de máquina/proceso, evita suspensión automática y verifica health desde ese host. La modalidad al iniciar sesión necesita que el operador efectivamente inicie sesión.
6. Verifica `http://127.0.0.1:<puerto>/health`, cola y Sentry desde el equipo. No abras el puerto al público; el worker solo necesita HTTPS saliente hacia Supabase. Prueba pérdida de conexión y recuperación sin duplicados. El monitor debe detectar que el equipo/worker se apagó, además de fallos de jobs.
7. Si eliges Docker en lugar de Node directo, usa el CMD de la imagen probada, variables privadas por archivo y reinicio automático. En ese caso fija digest/ID probado. Ninguna modalidad requiere Edge Function `embed` ni un servicio de embeddings de pago.

## 12. Corte remoto: un Supabase para ambos ambientes

Sigue el [runbook de corte](first-vertical-cutover.md) para SQL, inventario, rollback y recuperación de documentos. El MCP confirmó hoy 14 migraciones, upload activo y cuatro v1 confirmadas/uploaded sin puntero activo. Faltan estas siete:

```text
20261006172303_finish_processing.sql
20261009024630_first_vertical_processing_guard.sql
20261009024913_first_vertical_repository_lease_read.sql
20261009120000_durable_ingestion_jobs.sql
20261009120100_durable_repository_projection.sql
20261009124615_guard_legacy_processing_claims.sql
20261009134833_enqueue_lock_budget.sql
```

1. Fija ventana/responsable, verifica backup recuperable de DB y conservación de originales Storage. Restringe el uso de las webs antiguas durante todo el corte. No hay una pantalla de mantenimiento completa implementada: pausar uploads no bloquea Auth, lectura ni Retry. Con usuarios activos necesitas un control de acceso/mantenimiento efectivo antes de empezar.
2. Pausa uploads mediante el SQL del runbook y detén workers/consumidores anteriores. No borres jobs ni originales.
3. En una terminal de operador, verifica login/link del CLI al ref **cdyjtoheovbvewewicaa**, sin imprimir credenciales:

```powershell
npx pnpm@12.5.1 exec supabase login
npx pnpm@12.5.1 exec supabase link --project-ref cdyjtoheovbvewewicaa
npx pnpm@12.5.1 exec supabase migration list --linked
npx pnpm@12.5.1 exec supabase db push --linked --dry-run
```

4. Deben ser exactamente las siete pendientes. Si hay drift, para y revisa. Después del backup/revisión, aplica:

```powershell
npx pnpm@12.5.1 exec supabase db push --linked
npx pnpm@12.5.1 exec supabase migration list --linked
```

No uses seed, reset ni `--include-all` en este proyecto. Las nuevas migraciones no encolan automáticamente los cuatro documentos históricos. La guarda de legacy es la penúltima; la última ajusta el presupuesto de locks.

5. Arranca el worker compatible en el equipo existente. Espera `/health` Ready y DB accesible; registra SHA del checkout, digest/ID si usa Docker y RSS. Mantén el acceso antiguo restringido.
6. Retira draft al PR (`gh pr ready --repo JMCoC/knowledge-decay-monitor <numero>`). Quality gates debe pasar y Preview desplegar el SHA correcto. Verifica alias/origin, allowlist Auth y una cuenta sintética en workspace propio.
7. Activa uploads para aceptación controlada en Preview; prueba todo el paso 6 más lotes/500 chunks, límites de bytes/contenido y un reinicio del worker. Estas operaciones van a la DB compartida y reiniciar el worker afecta ambos ambientes. No ejecutes aquí scripts locales con fixtures/reset.
8. Registra aceptación Preview/revisión y merge a develop. Crea PR develop → main con evidencia, SHA y digest worker; revisa posibles cambios nuevos. Un push a develop no despliega Preview en este workflow: Preview se obtiene por PR no draft.
9. Prepara/valida la pareja final web/worker compatible. Si cambió código del worker, prueba el nuevo checkout/imagen y reemplaza coordinadamente el único proceso remoto. Un merge puede cambiar el SHA de la web: registra el SHA real de ambas piezas y no etiquetes una imagen antigua como si se hubiera construido con código nuevo.
10. Merge a main solo con backend preparado. Espera Quality gates del SHA main y aprueba Production cuando corresponda. El workflow despliega/promueve la web; comprueba dominio final y release. Repite registro/login, recovery con entrega real, formatos hasta Ready, original, filtros y roles en Production. Reabre acceso a usuarios después de aceptar el entorno.
11. Revalida los cuatro IDs históricos y usa Start Processing uno por uno como Admin/QA Lead según el runbook. Deben conservar IDs/original/hash y terminar coherentemente; el contenido inválido necesita revisión, no forzar Ready.

## 13. Cuándo darlo por terminado

Registra para la liberación SHA web real, SHA worker (digest/ID si usa Docker), 21 migraciones remotas aplicadas, CI verde final, health y prueba de procesamiento real, receipt de recovery/cambio de contraseña, aislamiento de roles, originales privados, métricas de recursos y evidencia del reinicio/reclamación. Con presupuesto cero, registrar también host existente elegido, horario/disponibilidad aceptada, cuotas gratuitas y backup propio recuperable. No guardes documentos, claves, tokens ni URLs firmadas.

Ante fallo, pausa uploads, detén el worker y conserva jobs/originales. Usa un candidato durable compatible o forward fix. La web HTTP/Edge anterior no es un rollback compatible con el RPC nuevo; no reviertas SQL destructivamente. Con un solo Supabase, recuperas un backend compartido, no un ambiente aislado.

Para un piloto privado, esos gates cierran el vertical operativo acordado. Para registro público, añade antes el flujo de confirmación descrito en el paso 9.10 y su aceptación real. Esta guía no acredita producción por sí sola.
