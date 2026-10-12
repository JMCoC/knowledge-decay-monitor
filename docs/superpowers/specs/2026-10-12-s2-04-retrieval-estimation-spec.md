# S2-04 — Retrieval semántico acotado y estimación exacta de créditos

**Ticket:** S2-04 — Retrieval semántico acotado + estimación exacta de créditos
**Módulo:** `src/modules/analysis/` (nuevo, Dev 2 / Diego Alejandro Tolosa Sanchez)
**Estado:** especificación escrita 2026-10-12, rev.2 alineada al contrato operacional completo; pendiente de revisión del usuario. No autoriza implementación, commits ni cambios remotos.
**Fecha:** 2026-10-12 (rev.2: mismo día, tras completar el contrato)
**Depende de:** S2-01 (contratos + tablas, mergeado), S2-02 (ledger de créditos, mergeado), S1-04 (chunks + embeddings 384d, mergeado)
**Contrato operacional:** `docs/contracts/S2-04-retrieval-estimation.md` (completo: 265 líneas, 12 secciones — ver §2.9)

> **Prevalencia:** el contrato operacional rige; este spec lo desarrolla sin contradecirlo. `src/types/contracts.ts` está congelado por S2-01 — S2-04 no lo modifica. S1-04 (`src/modules/ingestion/**`) y S2-02 (`src/modules/credits/**`) son de solo lectura: se importan, no se tocan. No se reescriben migraciones anteriores. Todo lo que este spec afirma cita tipo/línea/migración o sección del contrato.

---

## 1. Propósito y fuera de alcance

**Entrega de Dev 2:**

- La Server Action `estimateAnalysis(input: AnalysisSelectionInput): Promise<ActionResult<AnalysisEstimate>>` (`src/types/contracts.ts:322`; contrato §1: vive en `src/modules/analysis/actions.ts`, sin endpoint REST paralelo), primera operación del módulo nuevo `src/modules/analysis/`.
- Retrieval semántico acotado sobre `document_chunks.embedding` (`extensions.vector(384)`): una única RPC `retrieve_candidate_pairs` en `language sql stable security invoker` (contrato §5.1) que por cada chunk source une pares internos (misma versión) y externos (versiones comparison) con similitud ≥ 0.75, ordena por similitud desc y corta en Top-K, con canonicalización `(least, greatest)` + `DISTINCT ON` (contrato §5.2).
- Estimación exacta con fórmula integer-safe congelada (contrato §6), fingerprint SHA-256 del JSON canónico con la forma exacta del contrato §7, y persistencia de la estimación en la tabla nueva `analysis_estimates` con TTL de 30 min. `estimateRef` = UUID de la fila (contrato §§2.2, 3 D2/D3).
- Migración nueva (tabla + índices + HNSW con `(m = 16, ef_construction = 64)` + RLS + GRANTs, contrato §4), pruebas Vitest + pgTAP + integración (contrato §10).

**Fuera de alcance (contrato §8):**

| Fuera | Pertenece a |
|---|---|
| Reserva de créditos / creación de `analyses` | S2-05 (S2-04 solo hace `INSERT en analysis_estimates. Nada más.`) |
| Invocación al LLM | S2-06 (S2-06 corre el retrieval de nuevo y compara fingerprints, contrato §12) |
| UI de selección/estimación | S2-09 |
| Selección de documentos elegibles (`listEligibleDocuments`) | S2-03 |
| Modificar `contracts.ts`, `ingestion/**`, `credits/**`, migraciones anteriores | Prohibido (contrato §10) |
| Persistir pares temporales de retrieval | Prohibido: contrato §1 no expone pares; §8 solo inserta la estimación |

---

## 2. Estado previo verificado (reporte de hechos 2026-10-12, checkout local)

### 2.1 Módulo `src/modules/analysis/` — NO existe

`src/modules/` contiene exactamente `credits/`, `identity/`, `ingestion/`, `repository/`, `workspace/`. S2-04 crea `src/modules/analysis/` con los seis archivos del contrato §10 (`index.ts`, `actions.ts`, `retrieval.ts`, `pricing.ts`, `schemas.ts`, `queries.ts`). El módulo nuevo importa solo interfaces públicas (`@/modules/identity`, `@/types/*`), según ADR-001.

### 2.2 Tabla `analysis_estimates` — NO existe

Ninguna migración en `supabase/migrations/` la crea (los de análisis son `20261010192119_s2_01_analysis_tables.sql`, `20261010193514_s2_01_analysis_integrity.sql`, `20261010194238_s2_01_analysis_security.sql`, `20261010195500_s2_01_finding_initial_state.sql`; los de créditos son `20261011013954_s2_02_credit_operations.sql`, `20261011014828_s2_02_credit_reads.sql`, `20261011020726_s2_02_workspace_promotion.sql`). `src/types/database.ts` no contiene `analysis_estimates`. La crea la Task 1 con el SQL verbatim del contrato §4.1; Dev 1 regenera `database.ts` (nunca edición manual).

### 2.3 Índice HNSW en `document_chunks` — NO existe

`00001_initial_schema.sql:102` define `embedding extensions.vector(384) not null`; `00001_initial_schema.sql:107` crea solo `document_chunks_workspace_idx`; `00001_initial_schema.sql:108` declara explícitamente `-- No approximate vector index yet: Sprint 1 searches names, not embeddings.` Grep sobre `supabase/migrations/` confirma cero ocurrencias de `hnsw`/`ivfflat`. La extensión `vector` vive en el esquema `extensions` (`00001_initial_schema.sql:3`, patrón reused en `finish_processing.sql:61`). La Task 1 crea el índice verbatim del contrato §4.2 (`document_chunks_embedding_hnsw`, `vector_cosine_ops`, `m = 16, ef_construction = 64`); la Task 0 mide su latencia antes.

> **Verdict Task 0 (medido en local 2026-10-12, stack Supabase local corriendo, `supabase status` OK).**
>
> - **pgvector:** `0.8.2` (`select extversion from pg_extension where extname = 'vector'`).
> - **Corpus sintético:** tabla temporal `spike_s2_04.chunks_synth` (id uuid, chunk_index int, `embedding extensions.vector(384)`; nunca se tocó `public.document_chunks`), 3000 vectores uniformes aleatorios 384d (insert 0.19 s) ampliados a 10000 (insert +7k en 4.34 s).
> - **Build del índice verbatim** (`using hnsw (embedding extensions.vector_cosine_ops) with (m = 16, ef_construction = 64)`): **0.32 s** sobre 3000 vectores. Sin errores con los parámetros del contrato.
> - **Query Top-5 del contrato** (filtro `1 - (embedding <=> q) >= 0.75`, `ORDER BY similarity DESC, id ASC`, `LIMIT 5`; `id` como análogo de `chunk_id` en la tabla sintética): 20 corridas server-side (`clock_timestamp()`): run 1 frío 2.12 ms; runs 2–20 **p50 ≈ 0.34 ms, p95 ≈ 0.44 ms** sobre 3000 filas.
> - **Plan a 3000 y 10000 filas: Seq Scan** (filtro no selectivo con vectores uniformes: las 3000/10000 filas pasan ≥ 0.75 — la similitud coseno de vectores uniformes [0,1) se concentra en ~0.75). `EXPLAIN (ANALYZE, BUFFERS)` a 10000: `Seq Scan`, Execution 9.08 ms. No hay punto de cruce a 10k: con filtro no selectivo el planner prefiere seq scan a cualquier tamaño.
> - **El índice sí funciona:** query KNN pura (`ORDER BY embedding <=> q LIMIT 5`) usa `Index Scan using chunks_synth_hnsw`, 0.59 ms. La forma filtro+sort del contrato §5.2 no usa HNSW por construcción del planner (el `ORDER BY` va sobre la expresión `1 - distancia`, no sobre el operador KNN) — limitación conocida de pgvector, no un fallo de parámetros.
> - **`vector_cosine_ops` matchea `1 - (a <=> b)`:** el vector de consulta provenía de una fila existente y su self-match devolvió similitud `1` en primer lugar.
> - **Tie-break determinista:** dos corridas idénticas, output byte-idéntico (`diff` limpio).
> - **dims ≠ 384:** insert de `vector(383)` rechaza con SQLSTATE **`22000`** (`expected 384 dimensions, not 383`) — mismo código medido en S1-04. Task 1 lo aserta en pgTAP como `throws_ok ... '22000'`.
> - **Escala real:** el peor caso del producto es ≤ 10000 chunks por workspace (20 versiones × cap S1-04 de 500 chunks); seq scan medido a 10k = ~9 ms. Muy por debajo de cualquier timeout.
> - **Conclusión: HNSW usable tal como está. Sin blocker.** Se mantienen los parámetros del contrato sin cambios. El índice se crea igual (valor asegurador cuando el corpus crezca o el filtro sea selectivo con embeddings reales normalizados de gte-small); la latencia del contrato está dominada por un seq scan de un dígito de ms a escala real.
>
> Limpieza verificada: `drop schema spike_s2_04 cascade`; `pg_tables` para ese schema = 0 filas.

### 2.4 Firma exacta de `estimateAnalysis` (`src/types/contracts.ts:322`)

```typescript
estimateAnalysis(input: AnalysisSelectionInput): Promise<ActionResult<AnalysisEstimate>>;
```

- `AnalysisSelectionInput` (`contracts.ts:221-224`): `{ sourceVersionIds: string[]; comparisonVersionIds: string[] }`. Contrato §2.1: ambos arrays de UUIDs, sources 1..20, comparisons 0..20.
- `AnalysisEstimate` (`contracts.ts:235-239`): extiende el input con `{ estimateRef: string; fixedCost: number; expiresAt: string }`. Contrato §2.2: `estimateRef` UUID de la fila, `fixedCost >= 1`, `expiresAt` ISO (`created_at + 30 min`).
- `src/types/analysis-contracts.typecheck.ts:74` aserta que el cliente NO puede enviar `workspaceId`, `role` ni `fixedCost` (contrato §1: "No expone workspaceId ni role; se derivan de la sesión"); `typecheck.ts:70` aserta que la elegibilidad la define el servidor. Contrato §1: "No expone chunkCount, candidatePairCount, embeddings ni contenido."
- Errores controlados disponibles: `ActionErrorCode` incluye `INSUFFICIENT_CREDITS`, `ESTIMATE_EXPIRED`, `ESTIMATE_STALE` (`contracts.ts:39-40`); el contrato §9 fija el mapa de S2-04 (UNAUTHENTICATED, FORBIDDEN, INVALID_INPUT, NOT_FOUND, INTERNAL_ERROR).

### 2.5 `analyses.request_fingerprint` ↔ `AnalysisEstimate.estimateRef`

Son dos piezas distintas conectadas por el fingerprint, no por FK:

- `analyses.request_fingerprint` es `text not null` (`20261010192119_s2_01_analysis_tables.sql:29`). S2-05 lo escribirá al crear el `analysis` y lo comparará contra la estimación (mismatch → `ESTIMATE_STALE`).
- `AnalysisEstimate.estimateRef` (`contracts.ts:236`) es el UUID de la fila en `analysis_estimates` (contrato §3 D3). La fila guarda el fingerprint con la forma exacta del contrato §7; S2-05 relee la fila por `estimateRef`, verifica TTL y fingerprint (contrato §12), y recién entonces crea el `analysis`.
- Configuración congelada relacionada: `AnalysisConfiguration.retrieval = { topK: 5; similarityThreshold: 0.75; chunksRevision; embeddingRevision; fingerprint }` (`src/types/analysis-internal.ts:13-28`); `PreparedRetrieval` (`analysis-internal.ts:50-57`) es la forma interna que S2-06 reusará al correr el retrieval de nuevo (contrato §12).

### 2.6 `analysis_documents` — un `analysis` con N sources y N comparisons

PK `(analysis_id, version_id, role)` (`20261010192119_s2_01_analysis_tables.sql:66-77`) con `role ∈ ('source','comparison')`. La misma `version_id` puede aparecer dos veces con distinto rol — es exactamente lo que D4b permite y el contrato §2.1 confirma ("Solapamiento cruzado … permitido"). Integridad diferida (`20261010193514_s2_01_analysis_integrity.sql:50-58`): ≥ 1 source y ≤ 20 versiones distintas por análisis — coherente con los caps 1..20/0..20 del contrato §2.1. S2-04 no escribe esta tabla (lo hace S2-05).

### 2.7 Cómo se llama a `credits`/`identity` desde otro módulo (patrón a reusar)

`src/modules/credits/queries.ts` es el patrón canónico: `import "server-only"` (`queries.ts:1`); `getIdentityContext(client)` de `../identity` con cliente de `createReadOnlyClient()` de `@/lib/supabase/server` (`queries.ts:6,71`); estados `anonymous → UNAUTHENTICATED`, `onboarding → FORBIDDEN` (`queries.ts:72-77`); RBAC Admin/QA Lead para lecturas sensibles (`queries.ts:108-110`); validación Zod en frontera (`queries.ts:94`); `captureOperationFailure({ module, operation, code })` sin filtrar contenido (`queries.ts:33-40`); `src/modules/credits/index.ts` reexporta solo queries. S2-04 replica este patrón y NO importa nada transaccional de `credits` (contrato §8: no reserva).

### 2.8 Resolución de scope en `ingestion` (patrón a reusar)

`src/modules/ingestion/actions.ts:3` importa `requireDocumentActor` de `@/modules/identity`; `actions.ts:89-97` lo envuelve (`documentActor`) mapeando `UNAUTHENTICATED → UNAUTHENTICATED`, `FORBIDDEN/WORKSPACE_REQUIRED → FORBIDDEN`. `requireDocumentActor` (`src/modules/identity/session.ts:80-82`) = `requireActor()` (sesión verificada + Profile persistido, `session.ts:16-45`) + `assertDocumentActor` (solo Admin/QA Lead, `session.ts:73-78`). El `workspaceId` del Actor es el scope de la elegibilidad, la RPC (`p_workspace_id`, contrato §5.1) y el INSERT (policy `initiator_id = auth.uid()` + rol Admin/QA, contrato §4.3). Diferencia con S2-01: como la RPC es `security invoker` y la tabla admite insert autenticado por policy, S2-04 opera íntegramente con el cliente de sesión — sin `service_role`.

### 2.9 Contrato operacional completo + residuo a limpiar (no modificado)

`docs/contracts/S2-04-retrieval-estimation.md` está completo desde rev.2 de este spec: 265 líneas, 12 secciones `##` (§§1–12), con firma, decisiones, migración, RPC, fórmula, fingerprint, errores, archivos, DoD y handoff. Este spec está alineado a él sección por sección.

Residuo flaggeado (NO modificado, a decisión del equipo): las líneas 257–263 del contrato contienen meta-instrucciones de redacción ("Escribí este contenido TAL CUAL…", "Al terminar: 1. Reportá wc -l… 2. Reportá grep -c… 3. No commitees…") que no son contenido del contrato. Verificación pedida allí: `wc -l` real = 265 (no ~180); `grep -c "^## "` = 12 (coincide). Se propone eliminar esas 7 líneas en una pasada editorial del equipo.

---

## 3. Decisiones (cerradas por el equipo — no se reabren)

Fuente: contrato operacional §3 (tabla) + §2.1. Redacción confirmada por el usuario 2026-10-12.

- **D1 — Columnas explícitas en `analysis_estimates`.** El SQL verbatim del contrato §4.1: `id`, `workspace_id` (FK `on delete cascade`), `initiator_id` (FK compuesta a `profiles`), `source_version_ids uuid[]` (check `>= 1`), `comparison_version_ids uuid[]`, `request_fingerprint`, `retrieval_config jsonb`, `chunk_count`, `candidate_pair_count`, `fixed_cost` (check `>= 1`), `pricing_version`, `expires_at`, `created_at`. Sin pares temporales, sin texto de chunks, sin embeddings. Los caps superiores (20/20) se enforcing en Zod (contrato §2.1), no en SQL.
- **D2 — TTL 30 min.** `expires_at = created_at + interval '30 minutes'`; `AnalysisEstimate.expiresAt` ISO (contrato §2.2). Expirada → S2-05 responde `ESTIMATE_EXPIRED` (contrato §12).
- **D3 — `estimateRef` = UUID de la fila.** `AnalysisEstimate.estimateRef` es `analysis_estimates.id` serializado (contrato §2.2). Opaque para el cliente; S2-05 lo reautoriza (contrato §12).
- **D4a — Duplicado DENTRO de la misma lista (mismo versionId repetido en sourceVersionIds, o repetido en comparisonVersionIds) → INVALID_INPUT.** (Contrato §2.1: "Sin duplicados dentro de la misma lista (D4a)"; contrato §9: "duplicados intra-lista" → INVALID_INPUT.)
- **D4b — El mismo versionId puede aparecer en source Y en comparison simultáneamente → permitido. Coherente con S2-01 (analysis_documents PK = (analysis_id, version_id, role)).** (Contrato §2.1: "Solapamiento cruzado (mismo id en source y comparison): permitido (D4b)"; contrato §3: "Solapamiento source/comparison | Permitido".)
- **D5 — RPC PostgreSQL única `retrieve_candidate_pairs`.** `language sql stable security invoker`, `set search_path = ''` (contrato §5.1). Sin lecturas de embeddings al cliente de la Action, sin N+1.
- **D6 — Filtrar 0.75 antes del Top 5.** Orden del algoritmo (contrato §5.2): similitud ≥ 0.75 → `ORDER BY similarity DESC, chunk_id ASC` → `LIMIT p_top_k`. El umbral es `similarityThreshold: 0.75` y el K es `topK: 5` (`analysis-internal.ts:14-15`).
- **D7 — Canonicalización por `(least, greatest)` de chunk ids + `DISTINCT ON (least, greatest)`.** Cada par no ordenado aparece una vez (contrato §5.2). Autopares (`id != S.id` en ambas ramas) se excluyen.
- **D8 — Fingerprint SHA-256 de JSON canónico** con la forma exacta del contrato §7 (claves ordenadas alfabéticamente, sin espacios). Ver §8.

---

## 4. Arquitectura y flujo

Nuevo módulo `src/modules/analysis/` (monolito modular, ADR-001) con los seis archivos del contrato §10: `schemas.ts` (Zod en frontera) → `actions.ts` (`estimateAnalysis`) → `queries.ts` (elegibilidad + llamada RPC + insert, todo con cliente de sesión) → `retrieval.ts` (fingerprint + canonicalización espejo para tests) → `pricing.ts` (fórmula exacta del contrato §6) → `index.ts` (export público `estimateAnalysis`).

```mermaid
sequenceDiagram
    participant UI as Client (S2-09)
    participant A as estimateAnalysis (Server Action)
    participant DB as PostgreSQL

    UI->>A: AnalysisSelectionInput (ids)
    A->>A: requireDocumentActor (tenant/rol del Profile)
    A->>A: Zod + D4a/D4b + caps 1..20/0..20
    A->>DB: elegibilidad: ready/active del workspace (RLS sesión)
    A->>DB: retrieve_candidate_pairs (security invoker, RLS sesión)
    DB-->>A: pares (se cuentan y descartan; §8: nada más que el INSERT)
    A->>A: fixedCost (contrato §6) + fingerprint (contrato §7)
    A->>DB: INSERT analysis_estimates (policy initiator=auth.uid())
    A-->>UI: AnalysisEstimate (ref + costo + expiry)
```

La elegibilidad (contrato §2.1: todo id existe, `processing_status = 'ready'`, `version_status = 'active'`, del workspace del actor) se verifica vía RLS con sesión (patrón `credits/queries.ts:100-116`). La RPC es `security invoker`: ve solo los `document_chunks` que la RLS `chunk_read` (Admin/QA mismo tenant, S1) permite al caller — aislamiento aun sin `service_role`. El INSERT lo ampara la policy del contrato §4.3 (`initiator_id = auth.uid()` + rol Admin/QA). Efectos por éxito: solo el INSERT (contrato §8).

---

## 5. Contrato público (firmas + tipos — sin modificar `contracts.ts`)

```typescript
// Congelado por S2-01 — se consume, no se edita.
estimateAnalysis(input: AnalysisSelectionInput): Promise<ActionResult<AnalysisEstimate>>; // contracts.ts:322
```

Entrada `AnalysisSelectionInput` (`contracts.ts:221-224`); salida `AnalysisEstimate` (`contracts.ts:235-239`) con listas normalizadas (ordenadas; duplicado intra-lista ya rechazado por D4a), `fixedCost >= 1` (contrato §2.2), `expiresAt` ISO (= created + 30 min), `estimateRef` = id de la fila. La Action devuelve exactamente las listas que persistió (S2-05 compara fingerprint para `ESTIMATE_STALE`, contrato §12). Sin tenant/rol/costo/pares/contenido en la entrada-salida (`typecheck.ts:70-74`, contrato §1).

---

## 6. Migración (verbatim contrato §4 + GRANT de ejecución derivado)

Archivo nuevo `supabase/migrations/<timestamp>_s2_04_retrieval_estimation.sql` (timestamp reservado por Dev 1, posterior a `20261011020726`; nunca reescribir anteriores). Tabla e índices verbatim §§4.1–4.2:

```sql
-- Tabla: verbatim contrato §4.1 (on delete cascade, checks >= 1 en sources y costo).
-- Índices: verbatim contrato §4.2:
--   analysis_estimates_workspace_created_idx (workspace_id, created_at desc),
--   analysis_estimates_expires_idx (expires_at),
--   document_chunks_embedding_hnsw using hnsw (embedding extensions.vector_cosine_ops)
--     with (m = 16, ef_construction = 64).
-- RLS verbatim contrato §4.3:
--   enable row level security; policy select Admin/QA mismo workspace;
--   policy insert initiator_id = auth.uid() + rol Admin/QA;
--   sin update/delete para authenticated.
-- GRANTs verbatim contrato §4.3:
--   grant select, insert on analysis_estimates to authenticated.
```

Derivado explícito (no está en el contrato, requerido para operar): `grant execute on function public.retrieve_candidate_pairs(uuid,uuid[],uuid[],integer,double precision) to authenticated;` — con `security invoker` y llamada desde el cliente de sesión, sin este grant la Action recibe `42501`. Se incluye en la migración y se aserta en pgTAP (positivo para `authenticated`, negativo para `anon`); el equipo lo confirma en revisión.

Sin `service_role` en este ticket: lecturas, RPC e insert van con sesión + RLS/policies. Las estimaciones son inmutables; expiran por TTL, sin purga en este ticket.

---

## 7. Retrieval (RPC verbatim contrato §5)

Firma verbatim contrato §5.1 (orden de parámetros: `p_top_k` antes que `p_threshold`):

```sql
create function public.retrieve_candidate_pairs(
  p_workspace_id uuid,
  p_source_version_ids uuid[],
  p_comparison_version_ids uuid[],
  p_top_k integer,
  p_threshold double precision
) returns table (
  source_chunk_id uuid,
  source_version_id uuid,
  source_document_id uuid,
  source_text text,
  comparison_chunk_id uuid,
  comparison_version_id uuid,
  comparison_document_id uuid,
  comparison_text text,
  similarity double precision
)
language sql stable security invoker set search_path = '';
```

Algoritmo verbatim contrato §5.2 — para cada chunk S en versiones source:

- **Internos:** chunks de la misma `version_id` que S, `id != S.id`, similitud ≥ 0.75.
- **Externos:** chunks de `p_comparison_version_ids`, `id != S.id`, similitud ≥ 0.75.
- `UNION`, `ORDER BY similarity DESC, chunk_id ASC`, `LIMIT p_top_k`.
- Canonicalización: cada par se ordena `(least(id_a, id_b), greatest(id_a, id_b))`.
- Deduplicación: `DISTINCT ON (least, greatest)`.

La Action invoca con `p_top_k = 5`, `p_threshold = 0.75` (congelados de `AnalysisConfiguration.retrieval`, `analysis-internal.ts:14-15`, registrados en `retrieval_config`). Comparación vacía → rama de externos vacía, solo internos; 0 pares totales es válido (contrato §11: "Cero pares sigue siendo válido (1 credit)"). Similitud = `1 - (embedding <=> embedding)` con el operador coseno del índice §4.2. La función NUNCA escribe. Los pares devueltos se cuentan (`candidate_pair_count`) y se descartan: el único efecto es el INSERT de §8 (contrato §8). `chunk_count` = nº de chunks de las versiones source elegibles.

Nota de exposición: la RPC devuelve `source_text`/`comparison_text` (contrato §5.1). La Action los usa solo para `pairHashes` del fingerprint (§8) y los descarta sin loguearlos (§9). S2-06 los reusará al correr el retrieval de nuevo (contrato §12).

Nota de rendimiento (Task 0, 2026-10-12): con la forma filtro+sort del contrato §5.2 el planner elige Seq Scan (~9 ms a 10000 chunks sintéticos; veredicto completo en §2.3) y solo usa el HNSW en forma KNN pura. Correctitud intacta en ambos casos; a escala real del producto (≤ 10000 chunks/workspace) la latencia es de un dígito de ms. Sin cambios al contrato.

---

## 8. Fórmula + fingerprint (verbatim contrato §§6–7)

`src/modules/analysis/pricing.ts` (TS puro, sin I/O), verbatim contrato §6:

```typescript
function computeFixedCost(chunkCount: number, candidatePairCount: number): number {
  const numerator = 100 + 5 * chunkCount + 20 * candidatePairCount;
  return Math.floor((numerator + 99) / 100);
}
```

- Enteros únicamente: todas las entradas son conteos; `Math.floor` sobre enteros es exacto. La `similarity` (double) solo ordena/filtra en SQL y jamás entra en la fórmula.
- Casos de referencia del contrato §6 (tests Vitest pineados): 10 chunks + 5 pares → 3; 0 + 0 → 1; 100 + 0 → 6. El caso del ticket (contrato §11): 10 chunks + 5 pares = 3 credits.
- `pricing_version` (p. ej. `"s2-04-v1"`) se persiste en la fila para que S2-05 detecte `ESTIMATE_STALE` ante cualquier cambio de coeficientes.

`src/modules/analysis/retrieval.ts`: `computeRequestFingerprint` con la forma exacta del contrato §7 (claves ordenadas alfabéticamente, sin espacios):

```json
{
  "candidatePairCount": "M",
  "chunkCount": "N",
  "embeddingRevision": "gte-small-384-v1",
  "outputSchemaVersion": "<valor>",
  "pairHashes": ["sha256(src_id|comp_id)", "..."],
  "pricingVersion": "<valor>",
  "promptVersion": "<valor>",
  "retrieval": {
    "chunksRevision": "sha256(sorted_chunk_ids)",
    "similarityThreshold": 0.75,
    "topK": 5
  },
  "sortedComparisonVersionIds": ["..."],
  "sortedSourceVersionIds": ["..."]
}
```

- `pairHashes` ordenados por `(source_chunk_id, comparison_chunk_id)` — orden por rol, no canonicalizado D7: D7 deduplica pares no ordenados, el fingerprint hashea pares con rol. Ambas reglas coexisten (§7: `DISTINCT ON (least, greatest)` primero; hash `src|comp` después).
- `chunksRevision` = SHA-256 de todos los chunk ids del scope ordenados.
- `outputSchemaVersion` / `promptVersion` / `pricingVersion` figuran como `<valor>` en el contrato: se congelan en implementación (`pricingVersion "s2-04-v1"`; prompt/output schema tomados de `AnalysisConfiguration`, `analysis-internal.ts:22-23`) y quedan registrados en `retrieval_config` + columnas para la comparación de S2-05/S2-06. Punto a confirmar en revisión (§12).

---

## 9. Errores y observabilidad (verbatim contrato §9)

| Situación | `ActionResult` | Observabilidad |
|---|---|---|
| Sin sesión | `UNAUTHENTICATED` | sin Sentry (patrón `credits/queries.ts:73`) |
| Rol Member | `FORBIDDEN` | sin Sentry |
| Input inválido (Zod, duplicados intra-lista D4a, tamaños 1..20/0..20) | `INVALID_INPUT` controlado, inglés | sin Sentry |
| Algún versionId no existe / no ready / no active / de otro workspace | `NOT_FOUND` ("The selected documents are no longer available." — mismo mensaje exista o no, §10) | sin Sentry |
| Fallo del retrieval RPC | `INTERNAL_ERROR` + `correlationId` | `captureOperationFailure({ module: "analysis", operation: "estimate", code: "INTERNAL_ERROR", correlationId })` (patrón `credits/queries.ts:33-40`) |
| Fallo de INSERT | `INTERNAL_ERROR` + `correlationId` | idem anterior |

Nunca en logs/Sentry/artefactos: texto de chunks (aunque la RPC lo devuelva, §7), embeddings, `storage_path`, ids de otros tenants, URLs, tokens. El fingerprint es hash opaco. Mensajes de producto en inglés (contrato S2-01 §errores).

---

## 10. Seguridad y RBAC

1. **Tenant derivado, nunca inyectado.** `requireDocumentActor()` (`identity/session.ts:80-82`); `workspaceId` del Actor parametriza elegibilidad, `p_workspace_id` de la RPC y el INSERT (policy `initiator_id = auth.uid()`). Entrada sin tenant/rol/costo (`typecheck.ts:70-74`, contrato §1).
2. **Roles.** Solo Admin/QA Lead (`assertDocumentActor`, `session.ts:73-78`; policy select/insert del contrato §4.3); Member recibe `FORBIDDEN` (contrato §9).
3. **IDOR ciego.** Versión ajena/inexistente/no-elegible → mismo `NOT_FOUND` (contrato §9); la elegibilidad se lee con RLS de sesión, no con `service_role` abierto.
4. **Doble enforcement.** RLS `chunk_read` (S1, Admin/QA mismo tenant) limita la RPC `security invoker` aunque el SQL sea correcto; la policy de insert limita la escritura a filas propias del workspace/usuario. Sin `service_role` en S2-04: el privilegio máximo es el del rol persistido.
5. **Firmas efímeras.** `estimateRef` UUID aleatorio (no secuencial); TTL 30 min; S2-05 reautoriza + verifica fingerprint antes de crear el `analysis` (contrato §12).
6. **Sin filtraciones.** Cero texto/embeddings/paths en respuestas (la Action devuelve listas normalizadas, costo, ref y expiry — nunca pares ni snapshots; contrato §1).

---

## 11. Pruebas

### 11.1 Vitest — puras, sin DB (`tests/unit/analysis-*.test.ts`, contrato §10)

| Caso | Evidencia |
|---|---|
| `computeFixedCost` verbatim §6: 10+5 → 3; 0+0 → 1; 100+0 → 6; siempre entero ≥ 1 | casos de referencia + 50 conteos aleatorios `Number.isInteger` |
| `computeRequestFingerprint` forma §7: reordenado → mismo hash; un id distinto → distinto; threshold/topK/version distintos → distinto; 64 hex | doble pasada + mutación |
| `pairHashes` ordenados por `(source, comparison)`; `chunksRevision` de ids ordenados | unit de `retrieval.ts` |
| Canonicalización D7 espejo: `(a,b)/(b,a)` colapsan; autopares excluidos | unit de `retrieval.ts` (`tests/unit/analysis-retrieval.test.ts`) |
| Schemas Zod: rechazan UUID malformado, sources vacío, > 20 ids, duplicado intra-lista (D4a); aceptan comparison vacío y cross-list (D4b) | `safeParse` |
| Action con actor Member → `FORBIDDEN`; sin sesión → `UNAUTHENTICATED` (mocks de `identity`) | integración ligera sin DB |

### 11.2 pgTAP — `supabase/tests/database/019_s2_04_retrieval.test.sql` (nombre del contrato §10; `001`–`018` ocupados)

| Afirmación | Mecanismo |
|---|---|
| HNSW `document_chunks_embedding_hnsw` existe (`vector_cosine_ops`, `m = 16, ef_construction = 64`) | `pg_indexes` (`indexdef ilike '%hnsw%cosine%'`) |
| `analysis_estimates`: columnas/checks/FK del contrato §4.1 verbatim | `information_schema` + inserts de prueba |
| RPC happy-path con fixtures de similitud conocida: internos + externos ≥ 0.75 dentro; < 0.75 fuera; Top-K por source; autopares fuera; `DISTINCT ON (least, greatest)` único | `is` sobre el set con vectores sintéticos ortogonales/paralelos/frontera 0.749/0.751 |
| Empates: `ORDER BY similarity DESC, chunk_id ASC` determinista | doble llamada `is` idéntico |
| `anon` sin `EXECUTE` en la RPC; `authenticated` CON `EXECUTE` (derivado §6: invoker + cliente de sesión) | `has_function_privilege` positivo/negativo (patrón `006_upload_authorization.test.sql:39-45`) |
| RLS: otro workspace no lee estimaciones ajenas; insert ajeno rechazado por policy | `set role authenticated` + JWT tenant B → 0 filas / `42501` |
| `fixed_cost < 1` y `source_version_ids` vacío rechazan | `throws_ok ... '23514'` |

### 11.3 Integración (`tests/integration/analysis-estimation.test.ts`, nombre del contrato §10, vía `test:integration`)

Reserva → subida → `finalize` → procesamiento (fixtures S1-04) → `estimateAnalysis` con actor Admin → `ok` con `fixedCost` entero ≥ 1, `estimateRef` UUID, `expiresAt ≈ now+30min`; caso ticket 10+5 → 3; cross-tenant → `NOT_FOUND`; Member → `FORBIDDEN`; duplicado intra-lista → `INVALID_INPUT`; comparison vacío → `ok` con `candidatePairCount = 0` y costo 1 (si 0 chunks).

---

## 12. Trazabilidad DoD (contrato §11) + handoff (contrato §12)

| Criterio (contrato §11) | Evidencia |
|---|---|
| Migración aplicada (`analysis_estimates` + HNSW) | §6 + pgTAP 019 |
| RPC implementada y testeada | §7 + pgTAP (internos/externos, Top-K, canonicalización, DISTINCT ON) |
| Fórmula integer-safe | §8 + Vitest casos de referencia |
| Fingerprint determinista | §8 forma §7 + Vitest |
| `estimateAnalysis` implementado | §§4–5 + unit + integración |
| Caso del ticket: 10 chunks + 5 pares = 3 credits | §8 + integración |
| Cero pares válido (1 credit) | §8 (0+0 → 1) + integración comparison vacío |
| Cross-tenant bloqueado por RLS + validación de scope | §10 + pgTAP RLS + integración |
| Gates verdes | plan Task 5 |

**Handoff a S2-05 (contrato §12):** lee `analysis_estimates` por `estimateRef`, verifica TTL y fingerprint, crea `analyses` con `request_fingerprint`, reserva créditos. **Handoff a S2-06 (contrato §12):** corre el retrieval de nuevo y compara fingerprints (`pairHashes` + `chunksRevision` permiten detectar re-embebidos de S1-04 → `ESTIMATE_STALE`).

**Pendientes del equipo en revisión:** (a) limpiar residuo líneas 257–263 del contrato (§2.9); (b) confirmar `grant execute … to authenticated` derivado (§6); (c) congelar `<valor>` de `outputSchemaVersion`/`promptVersion`/`pricingVersion` (§8); (d) Dev 1 reserva timestamp de migración y regenera `database.ts`.

---

## Fuentes

- Contrato operacional `docs/contracts/S2-04-retrieval-estimation.md` §§1–12 (265 líneas; prevalece).
- `src/types/contracts.ts:221-244,322` (input, estimate, firma); `src/types/analysis-internal.ts:13-28,50-57` (config + retrieval interno); `src/types/analysis-contracts.typecheck.ts:60-74` (límites del cliente); `src/types/database.ts` (sin `analysis_estimates`).
- `supabase/migrations/20261010192119_s2_01_analysis_tables.sql:21-103` (tablas + checks); `..._integrity.sql:50-58` (1 source / ≤ 20 versiones); `..._security.sql:3-7,47-72` (RLS + GRANTs); `00001_initial_schema.sql:3,94-108` (vector 384, sin HNSW); `20261006172303_finish_processing.sql:7-15,85-88` (estilo RPC + grants S1).
- `src/modules/credits/queries.ts:1-12,33-40,68-116` + `src/modules/credits/index.ts` (patrón de módulo); `src/modules/ingestion/actions.ts:3,89-97` + `src/modules/identity/session.ts:16-82` (scope por Actor); `src/modules/ingestion/worker/embeddings.ts:1-10` (384 dims).
- Spec S2-01 (`docs/superpowers/specs/2026-10-10-s2-01-analysis-foundation-design.md` §§3-4) para cross-list, comparación vacía y errores.
