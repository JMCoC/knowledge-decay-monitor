# ADR-002 — Worker de ingesta con trabajos persistidos

Fecha: 2026-10-09. Estado: aceptado por la solicitud de implementación del runtime recomendado.

La suite completa del primer vertical falló con HTTP 546/WORKER_LIMIT en la inferencia de Edge, aunque pruebas aisladas pasaban. Aumentar el tiempo de HTTP no resuelve el límite de CPU ni la pérdida de ejecuciones aceptadas cuando cae el servidor.

La confirmación de upload registra un trabajo privado en PostgreSQL dentro de la misma transacción. Un worker Node comparte el módulo ingestion y ejecuta el modelo ONNX fuera de Next/Edge. Las RPCs imponen capacidad global de uno, lease renovable de 180 segundos, heartbeat cada 30, límite de 15 minutos por intento y hasta tres intentos automáticos. La finalización sigue siendo atómica y queda protegida por operación/lease.

Un trigger verifica el job y su lease antes de aceptar una nueva operación `processing`. Así, deployments web anteriores que aún hagan el CAS directo fallan de forma controlada y no pueden dejar una versión `processing` separada de la cola durable.

La finalización comparte un advisory lock global con las operaciones cortas de cola. Enqueue espera hasta tres segundos y tiene un timeout total de cinco, por encima del límite de dos segundos de la finalización. La prueba de integración mantiene el lock 1,5 segundos y confirma que una solicitud concurrente sigue respondiendo sin `55P03`; la espera continúa acotada.

Se usa una tabla específica de ingestion en vez de incorporar una extensión o una cola externa: permite confirmar, encolar, reintentar y activar con las transacciones/relaciones existentes, sin otro servicio de datos. No se promete ejecución exactamente una vez; se permiten entregas repetidas y se garantiza finalización idempotente por operación.

Se conserva `Supabase/gte-small`, 384 dimensiones, pooling medio y normalización L2; revisión de modelo y runtime fijados. La limitación a inglés y 512 tokens sigue vigente. Cambiar el modelo o su espacio vectorial requiere una decisión y migración de datos independientes.

Consecuencias: hay un deployment y credenciales de servidor adicionales, cola persistente y recuperación automática. El worker debe tener recursos adecuados, readiness, Sentry seguro y reinicio automático. La capacidad inicial sacrifica throughput para hacer el consumo predecible. Si crece la cola, medir antes de aumentar capacidad. No se introducen microservicios por módulo ni se modifica ADR-001.

La inferencia nativa no admite cancelación inmediata. Al abortar el intento, un watchdog termina el proceso si no completa su limpieza en diez segundos; el hosting debe reiniciarlo. El lease y el fencing siguen siendo la autoridad para aceptar la finalización.

Las migraciones no procesan automáticamente documentos históricos. El cutover requiere detener el worker, pausar nuevos uploads y recuperar explícitamente las versiones existentes después de validar el candidato. Véase el [runbook](../../testing/first-vertical-cutover.md).
