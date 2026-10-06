# S1-04 — Especificación del pipeline de procesamiento

**Ticket:** S1-04 — Procesamiento e indexación automática (parsing, chunking, embeddings, activación v1)
**Responsable:** Dev 2 (módulo `ingestion`)
**Estado:** diseño aprobado 2026-10-06; pendiente de implementación
**Fecha:** 2026-10-06
**Depende de:** [tickets.md](../../Tickets/tickets.md) §S1-04, PRD §§10, 12, 13, 14, 15, 25, 49, 51, [arquitectura-base.md](../../architecture/arquitectura-base.md), [day-zero-protocol.md](../../architecture/day-zero-protocol.md), [ADR-001](../..//architecture/adr/ADR-001-monolito-modular.md), spec S1-03 histórica, spec y plan S1-02 vigentes, [hallazgos S1-02](../../reviews/2026-10-02-s1-02-integration-findings.md)

> **Prevalencia:** en áreas que se solapan con S1-02, prevalecen la spec y el plan aprobados de S1-02 (reserva idempotente service-only, intentos temporales, verificación bytes/hash, `upload_state` independiente, recuperación, reconciliación legacy, proyección Repository). S1-04 no reabre esas decisiones. Retry es S1-07; S1-04 solo deja `processing_failed` rescatable.

---

## 1. Propósito y fuera de alcance

**Entrega de Dev 2:**

- El pipeline server-side que lleva una versión de `uploaded` a `ready` o `processing_failed`.
- Parser PDF/DOCX/Markdown, chunking determinístico 450/50, `embeddings.ts` con `embedBatch`, worker `runProcessing` en `processing.ts`, Route Handler `src/app/api/ingestion/process/route.ts`, migración con columnas de procesamiento + RPC `finish_processing`.
- Pruebas Vitest, pgTAP, HTTP local y E2E de su módulo.

**Fuera de alcance:**

| Fuera | Pertenece a |
|---|---|
| Retry manual de `processing_failed` | S1-07 (`retryProcessing` ya reservado en `IngestionApi`, sin implementar aquí) |
| Búsqueda/filtros Repository, apertura con URL firmada | S1-05, S1-06 (Dev 3) |
| Análisis LLM (Cerebras/Groq), TopK/threshold | Sprints posteriores |
| `credit_ledger`, consumo de créditos | No existe; upload/retry/pipeline fallido no consumen (PRD §13) |
| Tabla de cola, Supabase Queues, pg_cron, Vercel Cron, Edge Functions | Explícitamente descartados en S1-04 |
| Re-procesar versiones legacy o del seed | Prohibido (§10, Precisión 3) |
| `pending_approval`, workflow v2+ de Member | Sprint 3; S1-04 solo activa v1 automáticamente |

---

## 2. Task 0 — Verificación previa (bloqueante)

Task 0 responde con evidencia medida antes de implementar el resto. Sin Task 0 cerrado no se elige vía de embeddings ni se fijan caps.

### 2.1 Tres preguntas de embeddings (prioridad estricta)

1. ¿Es `supabase.ai.Session('gte-small')` invocable desde un Route Handler Next.js en Vercel? (Hipótesis: no, Edge-only.)
2. ¿Acepta Hugging Face Inference API `supabase/gte-small` con dims 384, qué rate limits del free tier, qué latencia p50/p95 para batch 32–64, y qué auth (API key propia del proyecto)?
3. ¿Caben `@xenova/transformers` + pesos gte-small en un Route Handler Vercel (~30 MB bundle)? ¿Cold-start aceptable? Self-hosted, cero dependencia externa.

**Decisión por prioridad:** (1) funciona → Edge auxiliar mínimo solo para embed. (2) funciona → HF Inference API (documentar como dependencia nueva, pedir aprobación explícita al equipo). (3) funciona → self-hosted. **Ninguna funciona → ADR-003 obligatorio antes de seguir; el resto de S1-04 se bloquea.**

La spec registra: vía elegida (1/2/3), endpoint/runtime concreto, dims confirmadas (384), latencia p50/p95, tamaño de batch, timeout, fecha de verificación.

**Descartado:** abstracción con N providers/fallback (YAGNI; gte-small HF no es idéntico a self-hosted en tokenizer/quantization/fine-tuning y mezclarlos compromete la consistencia vectorial). Mocks de embeddings prohibidos por el ticket y por spec S1-03 §3.1 (los vectores sintéticos del seed son fixtures de aislamiento, no evidencia de procesamiento).

**Abstracción aceptable:** una sola función `embedBatch(texts: string[]): Promise<string[]>` en `embeddings.ts`, sin jerarquía de interfaces. Cambiar de vía = cambiar el cuerpo.

**Contingencia:** si Task 0 no encuentra vía, documentar limitación, `processing_failed` con código `EMBEDDING_FAILED`, bloquear promoción a `ready`, ADR-003, resto bloqueado hasta ADR aprobado. (`EMBEDDING_UNAVAILABLE` no existe en `safe-event.ts`; el catálogo admite `EMBEDDING_FAILED`, verificado en `src/lib/observability/safe-event.ts:16-25`. No inventar códigos nuevos: ampliar `operation-events.ts`/`safe-event.ts` solo por decisión explícita con Dev 1.)

### 2.2 Caps y mediciones (valores a fijar en Task 0)

| Cap | Valor provisional | Razón |
|---|---|---|
| Max chunks por versión | ej. 3000 | Acota memoria/tx; exceder → `processing_failed` |
| Batch de embeddings | ej. 32–64 | Latencia y rate limits |
| Timeout interno del worker | ej. 50 s | Falla a `processing_failed` antes de que el handler muera sin rastro (presupuesto menor que el timeout de la plataforma) |
| Lease CAS | 180 s en `processing_started_at` | Sin barrido en S1-04 |

Task 0 registra además: versiones de `unpdf` y `mammoth`, bundle size del Route Handler (dynamic import), cold start medido, decisión de tokenizer (real vs `chars/4` + ratio documentado) con justificación.

Si Task 0 mide un cap distinto, la spec se actualiza durante Task 0 y se registra con fecha y justificación. Los valores finales quedan congelados antes de Task 1.

---

## 3. Flujo + diagrama

La "cola" es estado persistido, no infraestructura: `processing_status='uploaded'` + `upload_state='confirmed'`. Sin tabla de cola. Sin cron.

```mermaid
sequenceDiagram
    participant FIN as finalizeUpload (Server Action)
    participant DB as PostgreSQL
    participant AH as after() -> /api/ingestion/process
    participant W as runProcessing (processing.ts)
    participant ST as Storage (canonical)
    participant RPC as finish_processing (RPC)

    FIN->>DB: finalizeUploadRecord (S1-02) -> snapshot
    FIN->>FIN: needsProcessing = confirmed + processing==uploaded?
    alt needsProcessing
        FIN->>AH: after(() => fetch route, x-internal-token)
    end
    AH->>DB: CAS claim (uploaded+confirmed -> processing + operation_id + started_at)
    alt CAS vacío
        AH--AH: ya en processing, no procesa (204)
    else CAS ok
        W->>ST: downloadStorageObject(canonical) (bytes para parsear)
        W->>W: parse -> chunk -> embedBatch
        alt éxito
            W->>RPC: finish_processing(v, op, chunks jsonb)
            RPC->>DB: tx: INSERT chunks + ready/active + active_version_id
        else fallo
            W->>DB: UPDATE processing_failed (fuera de RPC fallida)
        end
    end
```

Orden canónico: parsear antes de generar chunks (ticket). `processing_status` y `version_status` son dimensiones distintas: mientras v1 esté en `uploaded`/`processing`/`processing_failed`, `version_status` permanece `NULL` y `documents.active_version_id` permanece `NULL`.

Camino único a `active`: `uploaded + confirmed → CAS → processing → RPC → ready + active`. Nunca `failed → active`.

---

## 4. RPC `finish_processing` + migración

### 4.1 Migración (timestamp posterior a `20261003214934`, reservado con Dev 1)

```sql
alter table public.document_versions
  add column processing_operation_id uuid,
  add column processing_started_at timestamptz;
```

Sin defaults ni backfill: las filas existentes quedan en `NULL`, lo correcto para CAS (`NULL ≠ p_operation_id` rechaza).

### 4.2 Función (una sola RPC, un solo camino a `active`)

```sql
-- supabase/migrations/<timestamp>_finish_processing.sql
-- Style follows S1-03 §6: qualified references, search_path = '',
-- explicit errcodes, service_role only.
create function public.finish_processing(
  p_version_id uuid,
  p_operation_id uuid,
  p_chunks jsonb
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version public.document_versions%ROWTYPE;
begin
  select * into v_version
    from public.document_versions
   where id = p_version_id;

  if not found then
    raise exception 'Version not found' using errcode = '22023';
  end if;
  if v_version.processing_status <> 'processing' then
    raise exception 'Version is not processing' using errcode = '22023';
  end if;
  if v_version.upload_state is distinct from 'confirmed' then
    raise exception 'Upload is not confirmed' using errcode = '22023';
  end if;
  if v_version.processing_operation_id is distinct from p_operation_id then
    raise exception 'Stale processing operation' using errcode = '22023';
  end if;
  if v_version.version_number <> 1 then
    raise exception 'Only v1 auto-activates' using errcode = '22023';
  end if;
  if v_version.version_status is not null then
    raise exception 'Version already decided' using errcode = '22023';
  end if;
  if p_chunks is null or jsonb_typeof(p_chunks) <> 'array'
     or jsonb_array_length(p_chunks) = 0 then
    raise exception 'Empty chunk set' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_chunks) as c(text_content text)
     where nullif(btrim(c.text_content), '') is null
  ) then
    raise exception 'Empty chunk text' using errcode = '22023';
  end if;

  insert into public.document_chunks
    (workspace_id, version_id, chunk_index, text_content,
     page_number, section_heading, embedding)
  select v_version.workspace_id,
         v_version.id,
         (c.chunk_index)::integer,
         nullif(btrim(c.text_content), ''),
         (c.page_number)::integer,
         nullif(btrim(c.section_heading), ''),
         (c.embedding)::extensions.vector(384)
    from jsonb_to_recordset(p_chunks) as c(
      chunk_index integer,
      text_content text,
      page_number integer,
      section_heading text,
      embedding text
    );

  update public.document_versions
     set processing_status = 'ready',
         version_status = 'active',
         processing_operation_id = null,
         processing_started_at = null
   where id = p_version_id;

  update public.documents
     set active_version_id = p_version_id
   where id = v_version.document_id;
-- The deferrable check_active_version trigger validates
-- ready + active + pointer coherence at commit.
end;
$$;

revoke all on function public.finish_processing(uuid,uuid,jsonb)
  from public, anon, authenticated;
grant execute on function public.finish_processing(uuid,uuid,jsonb)
  to service_role;
```

Sin `p_activate`: en S1-04 siempre es v1 y siempre se activa. Si S1-07 necesita activar v2+, se modifica entonces (YAGNI).

**Por qué una sola RPC:** writes directos del worker (opción 2) son múltiples transacciones; un crash entre `INSERT` y `UPDATE` deja estado inconsistente. Dos RPCs (opción 3) tienen el mismo problema disfrazado (`ready` sin `active`). Una sola transacción + trigger diferido existente cumple el DoD "misma operación de persistencia".

`analysis_status` queda en `pending_reanalysis` (el análisis futuro lo consume).

### 4.3 CAS claim (en el handler, no en `runProcessing`)

El HANDLER hace el CAS con `service_role`. `runProcessing(versionId, operationId)`
recibe ambos y arranca directamente en descarga + parseo; nunca hace el CAS.
Si el CAS devuelve vacío, el handler responde 204 sin invocar `runProcessing`.

```sql
update public.document_versions
   set processing_status = 'processing',
       processing_operation_id = $op,
       processing_started_at = now()
 where id = $1
   and processing_status = 'uploaded'
   and upload_state = 'confirmed'
returning processing_operation_id;
```

`RETURNING` vacío → ya en `processing` → no procesar. Manejo de fallo de la RPC: la tx revierte completa; el worker captura y marca `processing_failed` con `UPDATE` directo (fuera de la RPC fallida).

Tipos: Dev 1 regenera `src/types/database.ts` tras la migración (protocolo: nunca edición manual).

---

## 5. Parser / chunker / embeddings + caps

### 5.1 Stack aceptado

- **PDF:** `unpdf` (moderno, serverless-friendly, sin deps nativas). Superior a `pdf-parse` para PDFs contemporáneos.
- **DOCX:** `mammoth` (estándar de facto; extrae headings + párrafos como HTML estructurado).
- **Markdown:** parser mínimo propio (~30 líneas: headings `#`, `##`, … y párrafos). `remark`+`unified` pesa cientos de KB para lo que el ticket exige.
- **Tokenizer:** atado a la vía de embeddings (§2):
  - a) self-hosted `@xenova/transformers` → tokenizer real de gte-small (gratis con el modelo).
  - b) HF Inference API → cargar solo el tokenizer de gte-small (~200 KB) o `chars/4` con ratio fijo documentado.
  - c) `supabase.ai.Session` vía Edge auxiliar → `chars/4` con ratio fijo documentado.
  
  El determinismo se mantiene con cualquiera; cambia la precisión de "450 tokens". `tiktoken` prohibido como primera opción: es BPE de OpenAI, gte-small usa WordPiece (BERT-style), miden 20–40 % distinto. Bundle: `unpdf + mammoth + tokenizer ≈ 5–10 MB`; dynamic import en el Route Handler; si cold-start es problemático, `chars/4` documentado.

### 5.2 Reglas de chunking (ticket + PRD §14)

Determinístico (mismo input → mismos chunks byte-idénticos), prioriza headings y párrafos, bloques sobredimensionados se dividen solo cuando sea necesario, target ~450 tokens, overlap 50 tokens. Cada chunk persiste: `texto`, referencia a versión, orden (`chunk_index`), página/sección (`page_number`, `section_heading`), heading cuando disponible, `embedding` (vector 384 validado: 384 números finitos, serializado a string pgvector en `extensions.vector(384)`; `database.ts` representa vector como `string`, no cambiar DTO a `number[]`).

Para Markdown sin páginas: `page_number NULL`, `section_heading` con el heading más cercano. Chunks vacíos no se persisten.

### 5.3 Casos de fallo de parsing

`unpdf` devuelve `""` o solo whitespace (PDF escaneado sin texto extraíble / requiere OCR) → `ParseError("NO_TEXT")` → el worker mapea a `processing_failed`. Sin OCR en S1 (PRD §10). Un `.docx` que sea un ZIP renombrado pasa el prefijo `PK` pero `mammoth` falla al extraer → `processing_failed`. Markdown no textual se acepta en carga pero si no produce chunks válidos → `processing_failed`.

### 5.4 Precisión 1 — Canonical path (obligatorio)

El worker lee del **canonical path** `<workspace_id>/<document_id>/<version_id>/original.<ext>`, nunca del temporal (`.../attempts/<attempt_id>/...`). Usa `downloadStorageObject` de `src/modules/ingestion/storage.ts` (S1-02), no el SDK directo.

El worker lee `storage_path` directamente de la fila `document_versions`
que carga con `service_role`. No usa RPCs user-scoped. La ruta nunca se
construye en la app.

```ts
// processing.ts — lectura del canonical con service_role (esquema mínimo).
const { data: row, error } = await service
  .from("document_versions")
  .select("id, storage_path, processing_status, upload_state")
  .eq("id", versionId)
  .single();
if (error || !row) throw new ProcessingError("PERSISTENCE_FAILED");
if (row.processing_status !== "processing" || row.upload_state !== "confirmed") {
  throw new ProcessingError("PERSISTENCE_FAILED");
}
const response = await downloadStorageObject(row.storage_path, signal);
if (!response) throw new ProcessingError("PERSISTENCE_FAILED");
```

### 5.5 Precisión 2 — No re-verificar SHA-256 (obligatorio)

S1-02 ya verificó el hash al promover a canónico (`verification.ts`). El worker descarga los bytes para parsear pero **NO recomputa SHA-256**: confía en la verificación previa. Recomputarlo sería descargar dos veces el objeto, gastando timeout sin ganancia.

### 5.6 Precisión 3 — No procesar versiones legacy (obligatorio)

El CAS solo deja pasar `uploaded + confirmed`. Las versiones del seed (`ready + active + vectores sintéticos`) **NUNCA** se tocan. S1-04 no re-procesa legacy (`upload_state IS NULL` rechazado por el CAS y por la RPC).

---

## 6. Handler + `after()` + CAS

### 6.1 Disparo condicionado (primera defensa)

`finalizeUpload` NO agenda `after()` en cada llamada. `finalizeUploadRecord`
devuelve `UploadSnapshot`, que no contiene `processing_status`
(`src/types/contracts.ts:83-90`), así que antes de agendar se re-lee la fila
mínima con `service_role` (sin cambiar el contrato; YAGNI frente a ampliar
`finalizeUploadRecord`):

```ts
const snapshot = await finalizeUploadRecord(userId, versionId, attemptId); // S1-02
let processing: string | null = null;
if (snapshot.uploadState === "confirmed") {
  const { data } = await service
    .from("document_versions")
    .select("processing_status")
    .eq("id", versionId)
    .single();
  processing = data?.processing_status ?? null;
}
if (snapshot.uploadState === "confirmed" && processing === "uploaded") {
  after(() => fetch("/api/ingestion/process", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-token": process.env.INGESTION_INTERNAL_TOKEN ?? "",
    },
    body: JSON.stringify({ versionId }),
  }));
}
return snapshot;
```

Sin este check, cada `finalizeUpload` idempotente de S1-02 agendaría un worker distinto (trabajo desperdiciado aunque el CAS lo resolviera).

### 6.2 Handler (segunda defensa = CAS)

- Ruta: `src/app/api/ingestion/process/route.ts`.
- El handler valida el token (§6.3), valida `versionId` UUID (Zod) y ejecuta
  el CAS de §4.3 con `service_role`. `RETURNING` vacío → 204, no procesa,
  sin invocar `runProcessing`.
- Exige `upload_state='confirmed'` antes del CAS; nunca legacy `NULL`; lee canonical, nunca attempt.
- Un CAS, un lease (180 s en `processing_started_at`, sin barrido), una RPC (§4).
- `runProcessing(versionId: string, operationId: string): Promise<void>` vive en `processing.ts` (reemplaza el stub `startProcessing` no-op); el handler la invoca solo tras CAS exitoso; S1-07 la invocará desde su Server Action tras su propio CAS. `runProcessing` no hace el CAS ni sabe quién la llama.

Escenarios: doble click en `finalizeUpload` → solo una agenda; `after()` duplicado (raro) → CAS deja pasar a uno; cierre del navegador durante/después de `finalizeUpload` → la Server Action sigue y `after()` ya agendado sigue valiendo.

### 6.3 Precisión 4 — Token interno (obligatorio)

- Env var `INGESTION_INTERNAL_TOKEN` (sin `NEXT_PUBLIC_`, solo servidor).
- `fetch` de `after()` envía header `x-internal-token`.
- El handler compara con `crypto.timingSafeEqual`.
- Devuelve `401` si falta o no coincide.
- La env var nunca se loguea ni se expone en respuestas.

---

## 7. Errores y observabilidad

`captureOperationFailure` de `src/lib/observability/operation-events.ts`. Nunca `Sentry.captureException` crudo (filtro seguro + H06/H15).

| Situación | Código Sentry | `processing_status` |
|---|---|---|
| Sin token / token inválido en handler | no aplica (401, sin Sentry) | sin cambio |
| CAS vacío (ya en `processing`) | no aplica (204) | sin cambio |
| CAS vacío porque `upload_state != 'confirmed'` | no aplica (204) | sin cambio, distinta de la fila anterior: el worker nunca arranca sin `confirmed` |
| Parse sin texto (`NO_TEXT`) | `PARSING_FAILED` | `processing_failed` |
| Chunker excede max chunks / sin chunks válidos | `CHUNKING_FAILED` | `processing_failed` |
| Embeddings no disponibles / fallo provider | `EMBEDDING_FAILED` | `processing_failed`, bloquea `ready` |
| RPC `finish_processing` rechaza / trigger falla | `PERSISTENCE_FAILED` | `processing_failed` |
| Timeout interno (~50 s) | código de la fase activa | `processing_failed` antes de morir sin rastro |

Códigos verificados en `src/lib/observability/safe-event.ts:16-25` (`PROCESSING_FAILED`, `PARSING_FAILED`, `CHUNKING_FAILED`, `EMBEDDING_FAILED`, `PERSISTENCE_FAILED` para `ingestion.process/retry`). No usar `EMBEDDING_UNAVAILABLE` ni inventar códigos nuevos.

Sentry recibe solo: `operation` (`ingestion.process`), `workspace_id`, `user_id`, `role`, `document_id`, `version_id`, `batch_size`/`chunk_count`, `item_index`, código SQLSTATE, latencia. Nunca: texto del documento, chunks, embeddings, `storage_path`, `fileName`, firmas, bytes, URLs firmadas, tokens.

---

## 8. Seguridad y RBAC

1. **Cero clave en cliente.** Todo el pipeline usa `service_role` solo en servidor (`createServiceClient`). El navegador nunca ve token interno, `service_role`, paths ni hashes.
2. **Tenant derivado, nunca inyectado.** El worker re-resuelve `workspace_id` desde la versión autorizada (`authorized_document_workspace`-style como las RPCs S1-02); el body del handler solo trae `versionId` (+ token), nunca `workspaceId`/`role`/`Actor`.
3. **Puerta S1-02 intacta.** `upload_state='confirmed'` exigido en disparo, CAS y RPC. Sin `confirmed` no hay procesamiento.
4. **Roles:** el pipeline solo procesa versiones reservadas por Admin/QA (garantizado por S1-02). `Member` no reserva, luego nada suyo llega a `processing`. Lectura de chunks sigue RLS `Admin/QA Lead` mismo tenant (`chunk_read`); `Member` sin lectura en S1.
5. **Aislamiento aun con privilegio.** `document_chunks.workspace_id` + FK compuesta `(version_id, workspace_id)` impiden cross-tenant incluso con `service_role`. BDD de aislamiento se prueba (§9).
6. **Inmutabilidad.** El worker solo lee el canónico; jamás `upsert` ni `UPDATE/DELETE` en Storage; cleanup nunca borra canónico ni filas de negocio (invariante S1-02).
7. **Entradas validadas en frontera.** `versionId` UUID (Zod) en el handler; `p_chunks` validado en worker (384 finitos por embedding) y en RPC (`jsonb` con forma esperada); rechazos con `22023`.
8. **Sin filtraciones.** Sin contenido en logs/Sentry/artefactos; `trace`/video/screenshots Playwright desactivados (H15); signed URLs de 300 s solo las emite Repository (S1-05), no el pipeline.

---

## 9. Pruebas

### 9.1 Vitest — puras, sin DB (`src/modules/ingestion/*.test.ts` o `tests/unit/ingestion-*.test.ts` según convención vigente)

| Caso | Evidencia |
|---|---|
| Chunker determinístico: mismo MD → mismos chunks byte-idénticos | doble pasada, `toEqual` |
| Headings/párrafos priorizados; bloque sobredimensionado se divide solo si excede | MD con `#` + párrafo largo |
| 450/50 con tokenizer real o `chars/4` documentado | conteo por chunk + overlap |
| `page_number`/`section_heading` para MD sin páginas (`NULL` + heading cercano) | aserción de campos |
| Embedding 384 finitos → string pgvector; rechaza NaN/Inf/dims ≠ 384 | validador |
| `ParseError(NO_TEXT)` con PDF vacío/whitespace | `unpdf` mock vacío |
| Token interno: falta → 401, incorrecto → 401, correcto → pasa (timingSafe) | handler con token falso |
| Disparo condicionado: `confirmed+uploaded` agenda, `processing`/`failed`/`ready`/legacy no agenda | `finalizeUpload` mock |

### 9.2 pgTAP — `supabase/tests/database/010_processing.test.sql` (Dev 2)

Siguiente libre verificado: `ls supabase/tests/database/` muestra `001`–`009`; `010` es el siguiente real.

| Afirmación | Mecanismo |
|---|---|
| `finish_processing` con CAS válido inserta chunks + `ready` + `active` + `active_version_id` | `lives_ok` + `is` sobre las tres tablas |
| Sin `confirmed` rechaza (`22023`) | `throws_ok` |
| `operation_id` distinto rechaza (`22023`) | `throws_ok` |
| Segunda llamada (ya `active`, `version_status NOT NULL`) rechaza — idempotencia | `throws_ok` |
| `version_number != 1` rechaza | `throws_ok` |
| `authenticated`/`anon` sin `EXECUTE` | `not has_function_privilege(role, 'public.finish_processing(uuid,uuid,jsonb)', 'EXECUTE')` (patrón de `006_upload_authorization.test.sql:39-45`; pgTAP no expone `hasnt_function_privilege`, se niega `has_function_privilege`) |
| Trigger diferido: `ready` sin `active` + puntero inconsistente revierte | transacción que viola `check_active_version` |
| `document_chunks` hereda `workspace_id` de la versión; cross-tenant imposible por FK | intento de insert con `workspace` ajeno → `23503` |
| `embedding` con dims ≠ 384 rechaza (pgvector) | `throws_ok` (código exacto a confirmar en Task 0 con un test local; probable `22P02`; anotar el medido antes de Task 1) |
| `chunk_index` duplicado en `p_chunks` viola `unique(version_id, chunk_index)` | fallback `23505` (no bloqueante; el worker genera índices 0..n-1) |
| Columnas `processing_operation_id/started_at` existen y son nulables | consulta a `information_schema` |

### 9.3 HTTP local (`scripts/check-local-fixtures.mjs`, escenario Dev 2, Dev 1 integra)

Tarea explícita de fixtures (sin ella la evidencia no se puede producir):
agregar en `supabase/fixtures/storage/` un DOCX real mínimo y un PDF vacío
(sin texto extraíble) para los casos BDD.

Reservar → subir MD real → `finalize` → `POST /api/ingestion/process` con token → `ready + active + active_version_id`; PDF vacío (fixture) → `processing_failed`; DOCX real (fixture) → `ready + active`; versión ajena → 401/404 sin filtración; legacy `NULL` → nunca procesada.

### 9.4 Playwright (Dev 3 coordina, Dev 2 aporta estados)

Sin E2E nuevo obligatorio en S1-04 salvo verificar que Repository muestra `processing → ready/failed` con labels en inglés ya existentes; el flujo `upload → processing → repository → secure open` completo es S1-05.

---

## 10. Límites conocidos

1. **Crash antes de `after()`:** la versión queda en `uploaded + confirmed` sin worker. Sin cron que la barra en S1-04. Mismo enfoque que la reserva huérfana de S1-03: se declara, no se construye infraestructura paralela.
2. **Lease vencido sin barrido:** `processing_operation_id` + `processing_started_at` se escriben pero nadie los barre en S1-04. Un lease vencido queda en `processing`; S1-07 lo rescata con retry manual.
3. **Crash entre CAS y RPC:** la versión queda en `processing` con `processing_operation_id` seteado, sin chunks. S1-07 la rescata (re-lee el estado, detecta lease vencido, reintenta). (Precisión 5.)
4. **Sin cron, sin cola explícita, sin Edge Functions en S1-04.** La "cola" es el estado `uploaded + confirmed`.
5. **Legacy nunca procesado.** Filas con `upload_state IS NULL` y seed `ready + active + vectores sintéticos` quedan intactas.
6. **`upload_mode=paused` en cloud** bloquea nuevas subidas hasta el cutover; S1-04 local no lo cambia.
7. **Vercel:** body 4.5 MB y timeouts obligan a bytes por Storage directo + `downloadStorageObject` acotado; timeout interno (~50 s) falla a `processing_failed` con rastro en vez de morir en silencio.

---

## 11. Trazabilidad de los criterios de aceptación (DoD S1-04)

| Criterio del ticket | Evidencia |
|---|---|
| Procesamiento se inicia del lado servidor tras upload válido | §6 disparo condicionado + CAS; test Vitest + HTTP |
| PDF textual, DOCX, Markdown parseados | §5.1–5.3; Vitest por formato + HTTP con archivos reales |
| `uploaded → processing → ready \| processing_failed` | §3–§4; pgTAP + HTTP lee `processing_status` |
| Se parsea antes de generar chunks | §3 diagrama; test de orden |
| Chunking determinístico, headings/párrafos, split solo si necesario, ~450/50 | §5.2; Vitest determinismo + conteo |
| Chunk con texto, ref versión, orden, página/sección, heading, embedding | §5.2; pgTAP `is` sobre `document_chunks` |
| Embeddings Supabase gte-small en pgvector | §2 Task 0 + §5; HTTP verifica dims 384 reales |
| `ready` solo tras parsing + chunking + embeddings + persistencia completos | §4 RPC única; pgTAP atomicidad |
| Chunks/embeddings aíslan tenant; nada de otro Workspace | §8.5; pgTAP FK + HTTP cross-tenant bloqueado |
| Error nunca deja `ready` | §7; tests de cada fase → `processing_failed` |
| Fallo de parsing → `processing_failed` | §5.3 `NO_TEXT`; Vitest + HTTP PDF vacío |
| Fallos no consumen créditos | Sin `credit_ledger` en migración; aserción de ausencia |
| No invoca Cerebras/Groq/LLM | Grep: sin imports de LLM en `ingestion/`; revisión |
| v1 no completa → `version_status NULL`, `active_version_id NULL` | §4 precondiciones; pgTAP |
| v1 completa → `version_status=active` + `active_version_id=v1` en misma operación | §4.2 tx única; pgTAP las tres tablas |
| v1 `processing_failed` nunca `active` ni asignada | §4.2 `version_status NOT NULL` rechaza; pgTAP idempotencia |
| BDD DOCX v1 OK con chunks/embeddings/ready/active | HTTP E2E local con DOCX real (fixture §9.3) |
| BDD v1 en `processing` no activa, no lista para análisis | HTTP lee `processing + NULL + NULL` |
| BDD PDF sin texto → `failed`, no active, no créditos, no analizable | HTTP con PDF escaneado/OCR (fixture §9.3) |
| BDD aislamiento chunks B vs A bloqueado por RLS | HTTP/pgTAP cross-tenant |

---

## 12. Handoff a Dev 3

El pipeline es asíncrono; las versiones pasan por `processing` antes de `ready`. Implicaciones para Repository/UI (S1-05, Dev 3):

1. **`finalizeUpload` no devuelve `ready`.** Devuelve el snapshot S1-02 (`confirmed` + `processing=uploaded`); el worker transita después. La UI no espera `ready` en la respuesta de cierre.
2. **Estados a mostrar:** `uploaded — processing pending`, `processing`, `ready`, `processing_failed` (labels en inglés ya existentes en `processing-status-badge.tsx`). `canOpen` sigue atado a `upload_state='confirmed'` (el original es legible aun en `processing_failed`).
3. **Refresco:** la lista (`listDocuments` / vista `repository_documents`) ya expone `latest_processing_status`; S1-05 decide polling (`getUploadState`/`listDocuments`) — S1-04 no emite Realtime ni notificaciones.
4. **Sin retry en S1-04.** `retryProcessing` sigue reservado para S1-07; la UI no ofrece reintento de procesamiento en este ticket (solo `resume`/`recover` de subida S1-02).
5. **Contratos intactos.** S1-04 no rompe `UploadSnapshot` ni `RepositoryItem.latestVersion`; solo hace transitar `processing_status`/`version_status`/`active_version_id` por detrás.
6. **Observabilidad compartida.** `captureOperationFailure({ module: "ingestion", operation: "process" })` ya admite `PARSING_FAILED`/`CHUNKING_FAILED`/`EMBEDDING_FAILED`/`PERSISTENCE_FAILED`; Dev 3 no necesita nuevo filtro Sentry.

---

## Fuentes

- Task 0: verificación `supabase.ai.Session` / HF Inference `supabase/gte-small` / `@xenova/transformers` + `unpdf` + `mammoth` (versiones, bundle, cold start y latencias se registran aquí al cerrar Task 0; usar find-docs/Context7 para sintaxis vigente, nunca conocimiento previo para firmas).
- Patrón service-only y CAS: `supabase/migrations/20261003044516_s1_02_upload_expand.sql`, `src/modules/ingestion/upload-store.ts`, `storage.ts`, `verification.ts`.
- Invariantes: `00001_initial_schema.sql:75-83,126-158` (constraints + triggers diferidos), `arquitectura-base.md:170-179,304-338`.
