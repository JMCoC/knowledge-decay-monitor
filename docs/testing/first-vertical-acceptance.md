# Primer vertical — aceptación del runtime durable

Fecha: 2026-10-09. Rama `fix/adjustment_vertical_slice`. El [diseño durable](../superpowers/specs/2026-10-09-durable-ingestion-design.md) y [ADR-002](../architecture/adr/ADR-002-durable-ingestion-worker.md) sustituyen el runtime HTTP/Edge que agotaba CPU.

**Veredicto: aplicación, base local y recorridos E2E verificados; falta validar la imagen final del worker.** Su build local falló al descargar un paquete de npm por timeout, así que no se ejecutó el smoke de imagen. La aceptación remota requiere las siete migraciones, worker persistente y recorridos reales en Preview/Production. No hubo push, apertura de PR, merge, deployment ni escrituras remotas durante esta implementación.

## Evidencia local del candidato

| Control | Resultado | Alcance |
|---|---|---|
| Unit | 410/410 (57 archivos) | Embeddings, parsers, límites, sesión, cola, reconciliación y watchdog. |
| SQL | 263/263 (11 archivos) | Privilegios/RLS, enqueue, capacidad, heartbeat, reclaim, intentos, activación e incompatibilidad con CAS antiguo. |
| Integración | 23/23 (15 archivos) | Auth/PostgREST/Storage, worker real, carrera de finalización y espera acotada de enqueue bajo contención. |
| Tipos SQL | Pasa | Tipos generados coinciden con las 21 migraciones locales aplicadas. |
| TypeScript | Pasa | Incluye tipos de rutas Next. El SDK de Sentry mostró su aviso de instrumentación de navegación. |
| Lint | 0 errores, 4 warnings | Warnings `no-unused-vars` en tres archivos de tests. |
| Build web | Pasa | Build de producción Next.js. |
| E2E completo | 33/33, 1 worker | Auth, formatos, 9/32/500 chunks, lotes, retry, crash/reclaim, roles, URLs de 300 s y Storage real. |
| Imagen final | No verificada | `docker build` se detuvo después de 1930 s al expirar la descarga de `@sentry/browser-utils@10.75.0`; smoke de imagen pendiente. |
| Fixtures HTTP | Pasa | Auth, aislamiento REST y URLs Storage firmadas/denegadas. |
| Recovery tras restart | Pasa | Template local y datos Auth disponibles después de reiniciar el stack; usuario sintético eliminado. |

Los checks locales usan el stack local y datos sintéticos; no se hizo reset. Las suites restauran el modo upload que encontraron y eliminan sus documentos/originales/usuarios propios. No se eliminaron datos ajenos.

## Recorridos y límites que se verifican

- Registro, bootstrap Admin, interrupción de onboarding, login/logout, recovery en otro browser y denegación anónima/Member.
- Upload de PDF textual, DOCX y Markdown hasta Ready con vectores finitos de 384 dimensiones, índices consecutivos, v1 activa, puntero, categoría/owner y original/hash conservados. Casos de 9 y 32 chunks y lote de diez documentos de 32 chunks.
- Recuperación automática después de matar el worker mientras procesa un documento de 500 chunks: lease real de 180s, nuevo intento, 500 chunks únicos, operación anterior rechazada y Ready visible sin Retry manual.
- Confirmación sin worker conserva Queued; arranque consume la cola. Retry Admin/QA Lead conserva documento/versión/original; contenido inválido termina controladamente con cero chunks/puntero.
- Un enqueue concurrente espera un lock global retenido 1,5s, sin fallar con `55P03`; el timeout sigue acotado a cinco segundos.
- Archivo de 10 MiB transferido directamente a Storage; los POST de Next llevan metadatos. Más de diez archivos o más de 10 MiB se rechazan. Un original de 10 MiB que excede 500 chunks puede terminar processing_failed: límite de bytes y límite de contenido son distintos.
- Upload incompleto recuperado por otra QA del mismo workspace; otro workspace/Member no accede a documentos, chunks, versiones ni originales. Owner no concede permisos.
- Filtros, búsqueda por nombre, paginación, versiones no activas, apertura y URL firmada vencida tras 300s con nueva URL emitida por UI.

La capacidad inicial es un trabajo global; los documentos de un lote esperan su turno. Un intento admite hasta 15min, con heartbeat de 30s y lease de 180s. Al abortar, el watchdog permite 10s de limpieza antes de forzar reinicio si una inferencia nativa sigue pendiente. El hosting debe reiniciar el proceso; un estado unhealthy de Docker no lo reinicia por sí solo.

## Diagnóstico preservado

La implementación anterior terminó 31/33 con HTTP 546/WORKER_LIMIT en Edge. Su warmup aislado no demostraba capacidad suficiente. Se conservó el modelo y se cambió la ejecución a ONNX en un worker persistente con cola SQL.

Durante la nueva aceptación, la aserción de upload reanudado omitía Queued y se corrigió. El caso de caída esperaba 240s: después de la lease de 180s solo dejaba 60s para 500 chunks; la consulta diagnóstica mostró reclaim y heartbeat vivo. La prueba ahora espera el límite real del diseño y registra la duración; no se aumentaron intentos ni se reemplazó inferencia por mocks. Un check de fixtures lanzado mientras E2E mantenía un documento sintético falló por conteo; se repite en serie tras la limpieza, sin modificar la aserción.

En la ejecución E2E final, el assert del puntero comparaba versiones leídas después del procesamiento con documentos leídos antes. Se volvió a consultar los documentos tras alcanzar estados terminales; la repetición focalizada y la suite completa pasaron. El intento local de build de imagen expiró descargando una dependencia del registry; el job `Quality gates` conserva el build y smoke como gate del SHA que se publique.

La revisión independiente detectó y se corrigieron el watchdog para una inferencia pendiente, la ejecución E2E serial, la URL vacía de worker:local, un bloque retirado y la codificación del runbook. La revisión estática no sustituye los resultados de runtime.

## Reproducción

Preparar Docker, dependencias congeladas y Supabase local según el protocolo; aplicar migraciones con `pnpm exec supabase migration up --local`, sin reset. Detener cualquier worker de desarrollo antes de las suites: integración y E2E administran el suyo. Ejecutar en serie las pruebas que comparten DB:

```powershell
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm test:db
pnpm check:database-types
pnpm test:fixtures
pnpm test:integration
node scripts/with-local-supabase.mjs build
docker build -f Dockerfile.ingestion -t kdm-ingestion:verified .
$env:KDM_WORKER_IMAGE = 'kdm-ingestion:verified'
pnpm test:worker:image
pnpm test:e2e:local
pnpm test:auth:restart
```

El smoke de imagen comparte únicamente el namespace de red del gateway local y usa URLs loopback. La clave de servicio se transmite por nombre de variable, sin argumentos/archivos ni logs. Las pruebas desactivan Sentry; no demuestran recepción real de eventos en el servicio.

## Estado remoto y gates de PR/corte

Inventario refrescado por MCP el 2026-10-09: proyecto `cdyjtoheovbvewewicaa`, 14 migraciones hasta `20261003214934`, upload activo, cuatro documentos confirmados/uploaded y cero punteros activos. Local tiene 21 migraciones aplicadas sin reset. No se procesaron ni alteraron los cuatro documentos remotos.

| Gate remoto | Pendiente |
|---|---|
| PR/CI del SHA final | Publicar rama mediante el canal autorizado, draft PR hacia develop, revisión y Quality gates del SHA candidato. CI configurado no equivale a un run verde remoto. |
| Supabase | Revisar/dry-run y aplicar las siete migraciones enumeradas en el runbook bajo la ventana acordada. No seed/reset. |
| Worker | Elegir hosting persistente, publicar imagen por digest, credenciales privadas, restart automático y validar recursos/latencia/RSS allí. Presupuesto inicial de 2vCPU/2GiB sujeto a medición. |
| Preview/Production | Coordinar DB/worker compatibles antes de habilitar despliegues automáticos; ejecutar formatos, lotes, Retry, caída, roles y originales en cada entorno. |
| Auth | Callback/origen exactos y recovery por buzón controlado del dominio real. |
| Sentry | Evento saneado persistido con correlation ID, environment y release en los tres entornos; ningún contenido ni URL firmada. |
| Protecciones | Verificar y exigir Quality gates en main/develop, preservando revisores y protecciones existentes. |
| Rollback | Identificar candidato web/worker durable compatible por SHA/digest; el runtime HTTP anterior no es compatible con el nuevo guard de finalización. Pausa y forward fix si no hay candidato compatible. |
| Documentos históricos | Revalidar cuatro IDs y procesar uno por uno mediante Start/RPC autorizado después de aceptar el candidato, conservando IDs y original/hash. |

El [runbook](first-vertical-cutover.md) contiene el orden exacto, comandos, controles y rollback; el [cuerpo del PR](first-vertical-pr.md) queda preparado. No hacen falta embed ni INGESTION_INTERNAL_TOKEN para este candidato. Las lecturas remotas y los inventarios anteriores de Vercel/GitHub no certifican configuración o funcionamiento actual del nuevo runtime.
