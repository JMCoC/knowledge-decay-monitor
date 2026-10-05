# S1-08 — Contrato de observabilidad para S1-04 y S1-07

Este documento deja a los responsables de ingesta una interfaz segura para integrar Sentry cuando implementen el procesamiento y el retry. S1-08 define el contrato; S1-04 conserva la propiedad del pipeline y S1-07 la del retry. Este handoff no afirma que exista un worker ni modifica esos tickets.

## API disponible

En el runtime Next.js actual, el helper está en `src/lib/observability/capture.ts`:

```ts
import { captureSafeFailure } from "@/lib/observability/capture";
```

El tipo de entrada `SafeFailureInput` y `CaptureReceipt` están definidos en `src/lib/observability/safe-event.ts`. El catálogo permite `ingestion` con las operaciones `reserve`, `verify`, `resume`, `recover`, `cleanup`, `reconcile`, `process` y `retry`.

Los códigos de etapa `PROCESSING_FAILED`, `PARSING_FAILED`, `CHUNKING_FAILED`, `EMBEDDING_FAILED` y `PERSISTENCE_FAILED` solo se aceptan para `ingestion/process` o `ingestion/retry`. `INTERNAL_ERROR` sirve para otros fallos inesperados. No se deben agregar códigos o etapas sin coordinar el contrato compartido.

## Uso desde el pipeline

El pipeline persiste primero el resultado de negocio. Después puede intentar emitir el fallo técnico con una referencia de correlación creada en la frontera confiable:

```ts
import { captureSafeFailure } from "@/lib/observability/capture";

const correlationId = crypto.randomUUID();

// Llamar después de persistir el resultado; authorizedVersion viene del servidor.
const receipt = captureSafeFailure({
  module: "ingestion",
  operation: "process",
  code: "EMBEDDING_FAILED",
  correlationId,
  versionId: authorizedVersion.id,
});
```

Para un retry, usa `operation: "retry"` y agrega `attemptId` solo si el intento persistido pertenece a la operación ya autorizada. El helper no recibe ni necesita el objeto `Error`. Si Sentry falla o devuelve `undefined`, el estado de la versión, el resultado del retry y el mensaje controlado al usuario siguen siendo los mismos. `CaptureReceipt` acredita la referencia y, cuando existe, el ID local del evento; no demuestra que Sentry lo haya almacenado.

## Datos que pueden salir

El evento reconstruido solo incluye mensaje fijo, entorno/release/runtime confiables, módulo, operación, código, correlación y los UUID opcionales autorizados de versión/intento. No enviar contenido, fragmentos, nombre o ruta del archivo, título, URL firmada, usuario, workspace, request, cuerpo HTTP, cabeceras, excepción, stack, breadcrumbs ni respuesta cruda del proveedor. No registrar esos valores como alternativa en logs.

No emitir fallos esperados como `FORBIDDEN`, entradas inválidas o una versión que ya no existe. Un fallo de parsing puede registrar el código `PARSING_FAILED`, pero no el texto que lo causó ni una muestra del documento.

## Responsabilidades de los tickets

S1-04 implementa parsing de PDF textual, DOCX y Markdown, chunking determinístico, persistencia e indexación según sus criterios; solo activa la versión cuando el procesamiento completo se persiste correctamente. Una versión fallida no queda lista para análisis. Las pruebas comprueban las transiciones por etapa y que un fallo de telemetría no cambie la transición.

S1-07 conserva documento, versión y original al reintentar; reautoriza al Admin o QA Lead, controla concurrencia, evita duplicados y no consume créditos. El Member no puede iniciar retry. Cada fallo técnico seguro puede emitir el código correspondiente a la etapa, sin dar a Sentry el contenido del documento.

Si el worker usa otro runtime, comparte la lógica pura de `safe-event.ts` y escribe un adaptador pequeño para su SDK. No importe `@sentry/nextjs` ni módulos de presentación de Next.js al worker. Prueba su adaptador con transporte interceptado y añade una aceptación independiente de recepción real en Sentry cuando el entorno esté habilitado.
