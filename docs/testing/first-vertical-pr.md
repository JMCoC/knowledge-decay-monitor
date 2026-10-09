# PRs del primer vertical

La rama `fix/adjustment_vertical_slice` corrige la ingesta que agotaba CPU en Edge y perdía ejecuciones aceptadas al caer el servidor. Upload y Retry registran trabajos persistidos; un worker Node ejecuta el modelo fijado y PostgreSQL activa v1 junto con los chunks y el puntero. La web puede reiniciarse después de confirmar el upload sin perder el trabajo.

## Texto del PR de implementación hacia develop

**Título:** `feat(ingestion): complete first vertical with durable processing`

### Comportamiento

- Upload confirmado y enqueue comparten transacción. Repository muestra Queued y refresca Processing/Ready; Retry reautoriza la sesión y registra un nuevo ciclo sin sustituir originales.
- Worker independiente con `Supabase/gte-small` fijado, 384 dimensiones, ONNX q8, inferencia secuencial y capacidad SQL global de uno. Leases renovables y fencing permiten recuperación automática tras caída y finalización idempotente.
- Errores de contenido son terminales; fallos técnicos tienen hasta tres intentos. Una inferencia que no termina después de abortar fuerza salida del worker tras diez segundos para permitir reinicio.
- Se mantienen aislamiento por tenant/rol, originales privados, URLs firmadas de 300 segundos, metadatos de owner/category, límites de upload y activación atómica. El endpoint HTTP antiguo devuelve 410.

### Esquema y operación

Cuatro migraciones nuevas añaden la cola privada, su proyección segura, la guarda contra deployments web antiguos y un presupuesto de espera para enqueues concurrentes con la finalización de lotes grandes. El corte remoto incluye también las tres migraciones anteriores aún pendientes: siete en total según el inventario revisado. La guarda deja intactos los jobs cuando una versión anterior intenta reclamar mediante un `UPDATE` directo. Los tipos SQL están generados desde el esquema local. La migración no inicia los cuatro documentos remotos existentes.

Hay que desplegar un servicio persistente del worker, con reinicio automático, además de la web. La imagen carga el modelo offline como usuario `node`; CI construye y ejecuta la imagen final contra Supabase local. Ya no se necesita desplegar `embed` ni configurar `INGESTION_INTERNAL_TOKEN` para este candidato.

### Validación y aceptación

Resultados, tiempos, comandos y límites: [reporte de aceptación](first-vertical-acceptance.md). Las suites local SQL, integración, unitarias, build web, fixtures, recovery tras restart y E2E 33/33 pasan. El build local de la imagen terminó por timeout del registry npm; el job `Quality gates` aún debe construir y probar la imagen para el SHA publicado. La suite real recorre registro/workspace, formatos PDF/DOCX/Markdown, 9/32/500 chunks, batch diez, fallos controlados, Retry, caída, permisos, filtros y originales. La recepción remota de Sentry y la aceptación en Preview/Production se ejecutan durante el corte; las pruebas locales desactivan Sentry.

Diseño: [ADR-002](../architecture/adr/ADR-002-durable-ingestion-worker.md). Ejecución y rollback: [runbook](first-vertical-cutover.md).
