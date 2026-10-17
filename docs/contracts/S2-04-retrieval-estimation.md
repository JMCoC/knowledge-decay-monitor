# Contrato operacional — S2-04 Retrieval semántico acotado y estimación exacta de créditos

**Ticket:** S2-04
**Módulo:** `src/modules/analysis/` (nuevo)
**Responsable:** Diego Alejandro Tolosa Sanchez
**Estado:** Especificación previa a implementación
**Depende de:** S2-01 (contratos + tablas), S2-02 (créditos ledger), S1-04 (chunks + embeddings)
**Fecha:** 2026-10-12

---

## 1. Firma de la operación

Firma TypeScript:

    estimateAnalysis(input: AnalysisSelectionInput): Promise<ActionResult<AnalysisEstimate>>

- Comando implementado como Server Action.
- Vive en src/modules/analysis/actions.ts.
- Contrato declarado en AnalysisApi.estimateAnalysis (contracts.ts:322).
- No existe endpoint REST paralelo.
- No expone workspaceId ni role; se derivan de la sesión.
- No expone chunkCount, candidatePairCount, embeddings ni contenido.

---

## 2. Entrada y salida

### 2.1 AnalysisSelectionInput

    { sourceVersionIds: string[]; comparisonVersionIds: string[] }

- Ambos arrays de UUIDs.
- sourceVersionIds: 1..20.
- comparisonVersionIds: 0..20.
- Sin duplicados dentro de la misma lista (D4a).
- Solapamiento cruzado (mismo id en source y comparison): permitido (D4b).
- Todos existen, processing_status='ready', version_status='active', del workspace del actor.

### 2.2 AnalysisEstimate

    extends AnalysisSelectionInput {
      estimateRef: string;    // UUID de la fila en analysis_estimates
      fixedCost: number;      // >= 1
      expiresAt: string;      // ISO 8601 (created_at + 30 min)
    }

---

## 3. Decisiones cerradas

| # | Decisión | Valor |
|---|---|---|
| D1 | Estructura de analysis_estimates | Columnas explícitas |
| D2 | TTL de la estimación | 30 minutos |
| D3 | estimateRef | UUID de la fila en analysis_estimates |
| D4a | Duplicado intra-lista | INVALID_INPUT |
| D4b | Solapamiento source/comparison | Permitido |
| D5 | Retrieval SQL vs TS | RPC PostgreSQL única |
| D6 | Orden umbral/TopK | Filtrar 0.75 primero, Top 5 después |
| D7 | Canonicalización de pares | (least(id_a,id_b), greatest(id_a,id_b)) |
| D8 | Fingerprint | SHA-256 de JSON canónico |

---

## 4. Migración

### 4.1 Tabla analysis_estimates

    create table public.analysis_estimates (
      id uuid primary key default gen_random_uuid(),
      workspace_id uuid not null references public.workspaces(id) on delete cascade,
      initiator_id uuid not null,
      -- coalesce porque array_length('{}', 1) devuelve NULL y NULL >= 1
      -- no es falso: sin coalesce, '{}' pasaría el CHECK.
      source_version_ids uuid[] not null check (coalesce(array_length(source_version_ids, 1), 0) >= 1),
      comparison_version_ids uuid[] not null,
      request_fingerprint text not null check (char_length(btrim(request_fingerprint)) > 0),
      retrieval_config jsonb not null check (jsonb_typeof(retrieval_config) = 'object'),
      chunk_count integer not null check (chunk_count >= 0),
      candidate_pair_count integer not null check (candidate_pair_count >= 0),
      fixed_cost integer not null check (fixed_cost >= 1),
      pricing_version text not null check (char_length(btrim(pricing_version)) > 0),
      expires_at timestamptz not null,
      created_at timestamptz not null default now(),
      foreign key (initiator_id, workspace_id) references public.profiles(id, workspace_id)
    );

### 4.2 Índices

    create index analysis_estimates_workspace_created_idx
      on public.analysis_estimates (workspace_id, created_at desc);

    create index analysis_estimates_expires_idx
      on public.analysis_estimates (expires_at);

    create index document_chunks_embedding_hnsw
      on public.document_chunks
      using hnsw (embedding extensions.vector_cosine_ops)
      with (m = 16, ef_construction = 64);

### 4.3 RLS + GRANTs

- enable row level security en analysis_estimates.
- Policy select: Admin/QA del mismo workspace.
- Policy insert: initiator_id = auth.uid() + rol Admin/QA.
- Sin update, sin delete para authenticated.
- grant select, insert on analysis_estimates to authenticated.

---

## 5. RPC retrieve_candidate_pairs

### 5.1 Firma

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
    language sql stable security invoker set search_path = ''

### 5.2 Algoritmo

Para cada chunk S en versiones source:

- Internos: chunks de la misma version_id que S, id != S.id, similitud >= 0.75.
- Externos: chunks de p_comparison_version_ids, id != S.id, similitud >= 0.75.
- UNION, ORDER BY similarity DESC, chunk_id ASC, LIMIT p_top_k.

Canonicalización: cada par se ordena (least(id_a, id_b), greatest(id_a, id_b)).

Deduplicación: DISTINCT ON (least, greatest).

### 5.3 Handoff operacional S2-05

La consulta pública conserva su firma, seguridad invoker, permisos y reglas de
Top K. El orden final desempata por versiones y chunks source/comparison, para
que los pares solapados mantengan la misma orientación entre lecturas.

El resumen que usan las nuevas estimaciones cuenta **todos** los chunks de la
unión de versiones source/comparison, también los que no formaron ningún par.
`chunk_count`, `chunks_revision`, precio y fingerprint se calculan en una RPC
privada dentro de PostgreSQL, sin depender del máximo HTTP de 1.000 filas. El
fingerprint v2 incluye el manifiesto de ejecución inmutable de S2-05 además de
los campos v1 y conserva `pricing_version = s2-04-v1`.

El worker lee pares por páginas keyset de hasta diez, ordenadas por los IDs
canónicos `(least(chunk_id), greatest(chunk_id))`. La versión de cada página
se valida contra el resumen completo antes de procesar. Un trigger bloquea
las filas de versión al insertar, actualizar o borrar chunks; el resumen
toma esos mismos bloqueos en orden UUID y vuelve a comprobar estado y puntero
activo después de esperarlos. Así una mutación no puede cruzar el snapshot.

---

## 6. Fórmula integer-safe

    function computeFixedCost(chunkCount: number, candidatePairCount: number): number {
      const numerator = 100 + 5 * chunkCount + 20 * candidatePairCount;
      return Math.floor((numerator + 99) / 100);
    }

Casos de referencia:
- 10 chunks + 5 pares -> 3 credits
- 0 chunks + 0 pares -> 1 credit
- 100 chunks + 0 pares -> 6 credits

---

## 7. Fingerprint

SHA-256 de JSON canónico (claves ordenadas alfabéticamente, sin espacios):

    {
      "candidatePairCount": M,
      "chunkCount": N,
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

- pairHashes ordenados por (source_chunk_id, comparison_chunk_id).
- chunksRevision = SHA-256 de todos los chunk_id del scope ordenados.

---

## 8. Efectos por operación exitosa

INSERT en public.analysis_estimates. Nada más.

- NO reserva créditos (S2-05).
- NO crea analyses (S2-05).
- NO llama al LLM (S2-06).

---

## 9. Códigos de error

| Situación | Código |
|---|---|
| Sin sesión | UNAUTHENTICATED |
| Rol Member | FORBIDDEN |
| Input inválido (Zod, duplicados intra-lista, tamaños) | INVALID_INPUT |
| Algún versionId no existe / no ready / no active / de otro workspace | NOT_FOUND |
| Fallo del retrieval RPC | INTERNAL_ERROR |
| Fallo de INSERT | INTERNAL_ERROR |

---

## 10. Archivos a tocar

Crear:

- src/modules/analysis/index.ts
- src/modules/analysis/actions.ts
- src/modules/analysis/retrieval.ts
- src/modules/analysis/pricing.ts
- src/modules/analysis/schemas.ts
- src/modules/analysis/queries.ts
- supabase/migrations/<ts>_s2_04_retrieval_estimation.sql
- supabase/tests/database/019_s2_04_retrieval.test.sql
- tests/unit/analysis-pricing.test.ts
- tests/unit/analysis-fingerprint.test.ts
- tests/unit/analysis-retrieval.test.ts
- tests/integration/analysis-estimation.test.ts

NO tocar:

- src/types/contracts.ts (S2-01).
- src/modules/ingestion/** (S1-04).
- src/modules/credits/** (S2-02).
- Migraciones anteriores.

---

## 11. Criterio de Done

- Migración aplicada (analysis_estimates + HNSW).
- RPC retrieve_candidate_pairs implementada y testeada.
- Fórmula integer-safe.
- Fingerprint determinista.
- estimateAnalysis implementado.
- Caso del ticket: 10 chunks + 5 pares = 3 credits.
- Cero pares sigue siendo válido (1 credit).
- Cross-tenant bloqueado por RLS + validación de scope.
- Gates verdes.

---

## 12. Handoff

- S2-05 lee analysis_estimates por estimateRef, verifica TTL y fingerprint, crea analyses, reserva créditos.
- S2-06 corre el retrieval de nuevo y compara fingerprints.

---
