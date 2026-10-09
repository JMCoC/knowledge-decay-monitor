# Ingesta durable para cerrar el primer vertical

La solicitud de implementación del 9 de octubre autoriza sustituir la ejecución HTTP/Edge que falló por CPU, manteniendo la ejecución inline y commits locales coherentes. Este documento actualiza la decisión de runtime del diseño de cierre del 8 de octubre; no cambia permisos, formatos, créditos ni la activación atómica.

## Diseño

- PostgreSQL conserva un trabajo por versión en `private.ingestion_jobs`, con RLS y sin acceso de navegador. No se necesita una extensión adicional: RPCs acotadas implementan claim, heartbeat y fallo usando locks y fencing.
- Un trigger registra el trabajo en la misma transacción que confirma un upload v1. La versión permanece `uploaded` mientras espera; Repository muestra `Queued` y no ofrece Start para trabajos existentes.
- La capacidad inicial es un trabajo activo global, impuesta por SQL incluso con varios workers. Claim usa un advisory lock transaccional y `FOR UPDATE SKIP LOCKED`. El worker procesa embeddings secuencialmente. No hay inferencia ni trabajo pesado en Next/Edge.
- Lease de 180 segundos renovado cada 30 segundos; máximo 15 minutos por intento, tres intentos automáticos con backoff de 5 y 15 segundos. El heartbeat no extiende el límite total. Una caída permite reclamar al expirar el lease; una operación vieja nunca finaliza otra nueva.
- Si una inferencia nativa permanece pendiente después de abortar un intento, un watchdog permite diez segundos de limpieza y termina el proceso para que el servicio lo reinicie. La salida de shutdown tiene su propio límite; una señal de aborto no implica que ONNX haya cancelado su trabajo.
- Errores de contenido son terminales; errores técnicos tienen reintentos acotados. Retry manual reautoriza tenant/rol y registra un nuevo ciclo solo si falló, falta el trabajo o expiró una ejecución. Un trabajo pendiente o un lease vivo devuelve conflicto.
- `finish_processing` conserva su firma, transacción y límites de chunks, reemplaza la fecha fija de 50 segundos por validación del job/lease/operación y completa también el job. RPC fallida se reconcilia antes de reportar fallo.
- Enqueue tolera hasta tres segundos esperando el advisory lock compartido y limita la RPC a cinco segundos. Esto cubre la finalización, cuyo statement queda limitado a dos segundos, sin convertir la contención en espera indefinida; la integración lo verifica con un lock concurrente retenido 1,5 segundos.
- Worker Node independiente comparte parsers/chunker del módulo ingestion. Transformers.js ejecuta `Supabase/gte-small`, revision `93b36ff09519291b77d6000d2e86bd8565378086`, ONNX q8, mean pooling, normalización L2 y 384 dimensiones. Cache y calentamiento preceden a claim. El modelo continúa siendo inglés y trunca a 512 tokens; no se introduce cambio de modelo ni reembedding histórico.
- Solo metadatos controlados en logs; nunca documentos, vectores, tokens, URLs ni excepciones crudas. Un health endpoint confirma modelo y acceso DB y publica solo estado.

## Despliegue y compatibilidad

Dockerfile y arranque local reproducibles, shutdown con abandono seguro del lease, readiness y CI con inferencia real. Las migraciones son nuevas; no se reescriben las compartidas. Los trabajos anteriores se recuperan mediante una operación explícita bajo pausa: la migración no inicia los cuatro documentos remotos existentes.

Los PRs y cambios remotos se preparan, sin push/merge ni migración remota en esta ejecución. El cierre local requiere SQL, unit, integración, typecheck, lint, build y E2E completos; el cierre remoto requiere desplegar un worker compatible, aplicar migraciones bajo pausa y ejecutar aceptación real allí.

## Pruebas de aceptación

Upload confirmado sin servidor vivo conserva trabajo; multiworker claim respeta capacidad; heartbeat impide Retry vivo; reclaim cerca/tras expiración respeta fencing; fallo técnico llega al máximo de intentos; finalización perdida es reconciliable e idempotente; contenidos rechazados no dejan chunks. Browser prueba Auth/workspace → upload → ready → Repository → original, formatos prometidos, 9/32/500 chunks, lote de diez, recuperación y aislamiento.
