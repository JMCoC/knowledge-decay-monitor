# Primer vertical — corte del runtime durable

Este runbook prepara el cambio remoto. No se ejecutaron migraciones, despliegues, push ni cambios de datos/configuración remotos en esta implementación. El cierre local y la aceptación remota son gates distintos; registrar el SHA candidato y el digest de la imagen después de los checks y la revisión.

## Inventario y delta

Inventario remoto refrescado por MCP el 2026-10-09: proyecto `cdyjtoheovbvewewicaa`, 14 migraciones hasta `20261003214934`, cuatro documentos confirmados/uploaded y ningún puntero activo. Los originales se conservan. Refrescar estado y dry-run justo antes de ejecutar.

Migraciones pendientes respecto a ese inventario, en este orden:

1. `20261006172303_finish_processing.sql`
2. `20261009024630_first_vertical_processing_guard.sql`
3. `20261009024913_first_vertical_repository_lease_read.sql`
4. `20261009120000_durable_ingestion_jobs.sql`
5. `20261009120100_durable_repository_projection.sql`
6. `20261009124615_guard_legacy_processing_claims.sql`
7. `20261009134833_enqueue_lock_budget.sql`

Supabase local tiene las 21 migraciones aplicadas sin reset. El runtime activo ahora es un worker Node; no desplegar `embed` ni provisionar `INGESTION_INTERNAL_TOKEN` para el nuevo candidato. La ruta HTTP anterior devuelve 410. La tabla privada de jobs no se expone a navegadores y la migración no encola los cuatro documentos anteriores.

La migración `20261009124615` añade una guarda para deployments web anteriores que aún intenten reclamar trabajo mediante un `UPDATE` directo. La base devuelve `22023` y deja intactos la versión y el job cuando no existe un lease durable vigente. Esas solicitudes antiguas pueden mostrar un error durante el corte; el estado queda recuperable con la web y el worker compatibles. La última migración (`20261009134833`) ajusta los timeouts de enqueue.

Para el arranque local, diagnóstico de puertos Windows y pasos concretos con un Supabase compartido, consultar la [guía local a producción](first-vertical-local-to-production.md). Con Preview/Production compartiendo DB, usar un único worker compatible: la etiqueta de telemetría no aísla jobs por ambiente. El presupuesto confirmado es cero servicios de pago; la guía prepara la ejecución Node en un equipo existente. Este runbook también describe la opción de imagen Docker cuando se elija esa modalidad, sin exigir un hosting contratado.

## Preparación del candidato

- Obtener CI verde del mismo SHA: lint, tipos, unit, SQL, tipos generados, fixtures, integración con worker real, build, imagen y E2E. Exigir el contexto `Quality gates` en `main` y `develop` conservando revisores/protecciones.
- Construir `docker build -f Dockerfile.ingestion -t <registry>/kdm-ingestion:<sha> .`, publicar por un canal autorizado y desplegar por digest. La imagen incorpora el modelo fijado y arranca en modo offline. Usar un servicio de contenedores persistente con reinicio automático; no un runtime de Edge ni un job ligado a la respuesta web.
- Capacidad inicial: un worker, recursos iniciales a medir en el hosting elegido; comenzar con 2 vCPU/2 GiB como presupuesto de despliegue y validar RSS/latencia allí. SQL mantiene un solo job activo incluso si el servicio solapa instancias durante un rollout. No es una certificación de recursos del proveedor.
- Para el equipo existente con Node directo, usar checkout probado dedicado, modelo preparado, configuración privada `.env.worker` y health local según la guía. El uso acordado permite arranque manual durante pruebas/demos; un supervisor con reinicio es opcional hasta que se requiera disponibilidad continua. Registrar SHA del checkout en lugar de digest si no se despliega imagen. El worker solo requiere conexiones salientes; no publicar su puerto.
- Variables privadas del worker: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SENTRY_DSN`, `INGESTION_ENVIRONMENT` (`vercel-preview` o `vercel-production`) e `INGESTION_RELEASE_SHA` (40 caracteres SHA del candidato). Puerto/host vienen de la imagen: 8788/0.0.0.0. No necesita tokens de HF ni acceso externo para inferencia.
- Credenciales separadas por entorno. Preview debe usar un proyecto Supabase independiente cuando se quiera aislar datos; usar el proyecto compartido exige una ventana de corte explícita y no constituye una prueba aislada.
- `/health` debe responder 200 y `{"status":"ready"}` solo tras cargar modelo y contactar DB. Probar procesamiento real; un health verde no demuestra ingesta completa. No exponer endpoints de depuración ni servir los originales desde el worker.
- Aplicar autenticación/callbacks exactos de la web (`APP_ORIGIN`, URL/publishable key, service-role solo servidor). Sentry debe recibir un evento manual saneado con environment/release; no documentos ni excepciones crudas. El token de upload de sourcemaps permanece exclusivamente en build.

## PRs y automatización de la web

Publicar primero un draft PR `fix/adjustment_vertical_slice` → `develop`. El [texto del PR](first-vertical-pr.md) describe el cambio y enlaza evidencia. Mantenerlo draft hasta preparar un DB/worker compatible: retirar draft habilita el job Preview si pasa Quality gates. Si Preview comparte Supabase, coordinar también los deployments web anteriores que leen ese proyecto.

```powershell
git push -u origin fix/adjustment_vertical_slice
gh pr create --repo JMCoC/knowledge-decay-monitor --draft --base develop --head fix/adjustment_vertical_slice --title "feat(ingestion): complete first vertical with durable processing" --body-file docs/testing/first-vertical-pr.md
```

Los comandos quedan preparados para una ejecución posterior. Tras aceptación Preview y revisión, integrar en develop y preparar el PR develop → main con SHA probado, digest y evidencia del entorno. Preparar Production antes de ese merge: el workflow de push a main puede desplegar/promover automáticamente la web. No abrir el PR de promoción reutilizando evidencia histórica como aceptación actual.

## Ventana de corte

1. Registrar responsable, inicio/fin, SHA web, digest worker, proyecto DB y deployment web anterior. La versión anterior de HTTP/Edge no es un rollback compatible tras cambiar el RPC: preparar antes un candidato web/worker durable conocido o aceptar que el rollback funcional es pausa + forward fix.
2. Detener cualquier worker anterior y pausar nuevos uploads:

```sql
update private.upload_control set mode='paused',updated_at=now() where singleton;
select mode from private.upload_control where singleton;
```

La pausa de uploads no cancela jobs. Durante mantenimiento detener el worker; las solicitudes de Retry pueden quedar persistidas para el siguiente arranque. No borrar la cola ni originales.

3. Verificar project ref y el conjunto exacto de siete migraciones:

```powershell
pnpm exec supabase migration list --linked
pnpm exec supabase db push --linked --dry-run
```

Si cambia el conjunto, detener el corte y revisar. No usar `--include-all`, seed ni reset. Aplicar únicamente después de revisión de SQL y backup/punto de recuperación confirmado:

```powershell
pnpm exec supabase db push --linked
pnpm exec supabase migration list --linked
```

4. Desplegar web del candidato y worker por digest. Confirmar variables por nombre/target sin imprimir valores. Verificar health y acceso DB; el worker no necesita `APP_ORIGIN` ni llamadas internas a Next.
5. Activar uploads, ejecutar un documento sintético nuevo por la UI y comprobar original/hash, chunks384, ready/active/puntero, categoría/owner, apertura firmada, filtros y aislamiento Admin/QA Lead/Member. Ejecutar también PDF textual, DOCX, Markdown de 9/32/500 chunks, lote de diez documentos de 32 chunks, contenido inválido y retry. El límite superior de 10 MiB valida bytes de upload, no garantiza que cualquier contenido quepa en 500 chunks.
6. Probar caída del worker y redelivery tras 180 segundos, heartbeat de una ejecución larga, ausencia de duplicados y evento Sentry. Verificar recovery Auth mediante buzón controlado en el dominio real. Solo entonces aceptar el entorno.

## Recuperar los cuatro documentos existentes

Tras aceptar el candidato, inventariar sin imprimir contenido/URLs:

```sql
select id,workspace_id,processing_status,upload_state,version_number,version_status
from public.document_versions
where upload_state='confirmed' and processing_status='uploaded' and version_number=1 and version_status is null;
```

Revalidar que son exactamente los cuatro IDs revisados; registrar IDs autorizados para esta operación. Usar Start Processing desde la UI como Admin/QA Lead, uno por uno. Alternativamente, un operador puede invocar con IDs explícitos y revisados:

```sql
select public.enqueue_ingestion_job('<workspace-id>'::uuid,'<version-id>'::uuid,true);
```

Esperar ready/active y puntero coherente antes del siguiente. Mantener los mismos document/version IDs y original/hash. No hacer un UPDATE masivo ni crear versiones nuevas. Un rechazo de contenido exige revisión humana; no forzar ready.

## Rollback y verificación

Si falla un gate, pausar uploads y detener el worker. Conservar jobs y originales; esperar expiración de leases antes de reiniciar el candidato compatible. No revertir migraciones destructivamente ni volver al runtime HTTP de 50 segundos. Los jobs aceptados siguen disponibles; la operación vieja queda fenced al reclamar otra nueva.

```sql
select status,count(*) from private.ingestion_jobs group by status;
select count(*) as inconsistent_active from public.documents d
join public.document_versions v on v.id=d.active_version_id
where v.workspace_id<>d.workspace_id or v.processing_status<>'ready' or v.version_status<>'active';
```

El segundo resultado debe ser cero. Revisar el age de la cola y jobs running vencidos; procesos caídos se recuperan al volver un worker. No guardar cuerpos de proveedores, documentos, vectores ni URLs firmadas en evidencia. La evidencia remota debe identificar SHA/digest, entorno, resultados y correlation IDs seguros.
