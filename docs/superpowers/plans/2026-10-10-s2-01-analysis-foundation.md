# S2-01 Analysis Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Entregar contratos, esquema, permisos y fixtures de análisis que se puedan aceptar independientemente de las operaciones de los otros tickets S2.

**Architecture:** Mantener el monolito modular y las seis tablas en public, protegidas por RLS, GRANT de columnas y relaciones compuestas. Serializar las modificaciones de alcance/evidencia por análisis y validar su estado final con triggers diferidos. Los contratos públicos y los internos permanecen separados; ningún adaptador de prueba se publica como API.

**Tech Stack:** Next.js 16.3.5, TypeScript estricto, Supabase CLI instalada 2.117.0, PostgreSQL con pgvector/pgTAP, supabase-js 2.117.2, Vitest 5.0.2 y pnpm 12.5.1. No actualizar dependencias para este ticket.

**Spec:** [Especificación aprobada de S2-01](../specs/2026-10-10-s2-01-analysis-foundation-design.md). El ejecutor lee ambos documentos antes de editar.

Estado: plan aprobado; implementación local inline completada. Revisión de consumidores y clean upgrade ejecutado en CI permanecen pendientes.

## Global Constraints

- «Se conserva ActionResult<T>, Actor y el enum existente AnalysisStatus»; la ejecución usa `AnalysisJobStatus`.
- «Las entradas públicas no aceptan Actor, tenant, rol, precio confiable, destinatario, lease ni configuración del proveedor».
- «El alcance contiene al menos una fuente y como máximo 20 versiones distintas en la unión».
- «La versión puede aparecer con ambos roles»; no duplicar una relación del mismo rol.
- «El snapshot es texto no vacío con máximo 2.000 caracteres, medidos por longitud de caracteres SQL».
- «El número de intentos va de 0 a 3: intento inicial y hasta dos retries automáticos».
- «Los hallazgos nacen pending_review, sin asignatario y con ambas severidades iguales».
- «reserved_credits registra la cantidad originalmente reservada y coincide con fixed_cost»; el saldo actual es del ledger.
- «Las nuevas referencias utilizan ON DELETE RESTRICT»; no añadir cascadas analíticas ni vías de purga.
- «Los movimientos persistidos son append-only; UPDATE/DELETE de aplicación se rechazan también con el rol de servidor».
- «Notification_events no concede lectura a authenticated».
- «No se aplican migraciones remotas, seed, despliegues ni cambios de datos compartidos para certificar la base local».
- Preservar cambios ajenos, migraciones compartidas y permisos S1. Owner no concede acceso a Member.
- No introducir módulos vacíos, Zod de operaciones aún inexistentes, proveedores, RPC ficticias ni HTTP interno.
- No hacer commit, push, merge, edición de Linear o despliegue como efecto automático de ejecutar tareas. Los puntos de revisión de cada tarea son locales; commits requieren alcance explícito adicional.

## Review Focus

1. Unicode suplementario: 2.000 caracteres SQL se aceptan aunque su representación UTF-16 ocupe 4.000 unidades; 2.001 se rechazan — tarea 3.
2. Cambio de rol con la misma sesión: un QA degradado a Member pierde las lecturas sin depender de actualizar claims JWT — tarea 5.
3. Eliminación concurrente de scope e inserción de evidencia: tras esperar el lock se revalida el alcance confirmado, sin escritura huérfana — tarea 6.
4. Consultas wildcard: SELECT * de tablas restringidas falla; SELECT * de una proyección segura funciona y no añade columnas internas — tareas 4 y 5.
5. Limpieza fallida: no borrar un workspace ajeno, no desactivar triggers globales y no dejar que RESTRICT o ledger inmutable rompan cleanup de fixtures — tarea 5.

## Archivos y orden

| Archivo | Responsabilidad |
|---|---|
| `src/types/contracts.ts` | Contratos públicos S2 y nuevos errores, conservando S1 |
| `src/types/analysis-internal.ts` | Tipos servidor/worker, sin implementación |
| `src/types/analysis-contracts.typecheck.ts` | Casos positivos/negativos de compatibilidad |
| `src/types/database.ts` | Generado desde la base, nunca editado manualmente |
| `tests/fixtures/analysis/public.ts` | DTO y escenarios públicos sintéticos |
| `tests/fixtures/analysis/internal.ts` | Salidas del proveedor, pares, leases y configuración sintéticos |
| `supabase/tests/database/analysis-fixtures.psql` | Helpers pg_temp transaccionales para pruebas SQL |
| `supabase/tests/database/012_analysis_schema.test.sql` | Tablas, relaciones, valores y unicidades |
| `supabase/tests/database/013_analysis_integrity.test.sql` | Alcance y pertenencia de evidencia |
| `supabase/tests/database/014_analysis_security.test.sql` | RLS, columnas, views y GRANT |
| `supabase/migrations/20261010195500_s2_01_finding_initial_state.sql` | Forma inicial válida de findings insertados |
| `supabase/tests/database/015_analysis_finding_initial_state.test.sql` | Rechazo de severidad distinta/asignatario inicial y actualización posterior |
| `tests/support/analysis-fixtures.ts` | Fixtures persistidos solo en loopback, con limpieza acotada |
| `tests/integration/analysis-isolation.test.ts` | Data API real, roles y columnas |
| `tests/integration/analysis-concurrency.test.ts` | Transacciones concurrentes reales |
| `scripts/check-analysis-upgrade.mjs` | Upgrade S1 → S2 exclusivamente en CI descartable |
| `tests/unit/analysis-upgrade-guard.test.ts` | Rechazo del runner de upgrade fuera de CI |
| `.github/workflows/s1-01.yml` | Ejecutar upgrade sin sustituir los gates S1 |
| `docs/testing/s2-01-analysis-foundation-acceptance.md` | Evidencia real y revisión de consumidores |

Las tareas 2, 3 y 4 crean migraciones mediante `supabase migration new`, con nombres `s2_01_analysis_tables`, `s2_01_analysis_integrity` y `s2_01_analysis_security`. El timestamp lo devuelve la CLI; el ejecutor registra la ruta exacta en la tarea antes de editar. No se inventan timestamps ni se reescribe una migración compartida. Una vez aplicada una migración local, las correcciones se añaden en otra migración, preservando el orden de integración.

## Preparación al ejecutar

- [x] Revisar `git status --short`, `git diff` y `git diff --cached`; preservar `.agents/`, `.claude/`, `skills-lock.json` y `supabase/snippets/` preexistentes.
- [x] Si se necesita aislamiento, aplicar using-git-worktrees al comenzar la ejecución, no durante esta planificación. Los documentos aprobados deben estar disponibles en el checkout de ejecución sin incluir cambios ajenos.
- [x] Confirmar Node, pnpm 12.5.1, Docker y el stack loopback correcto. Utilizar los guards de `scripts/local-supabase.mjs`, `scripts/with-local-supabase.mjs` y `tests/support/local-sql-session.ts`; no imprimir status con claves.
- [x] Confirmar que las migraciones pendientes locales corresponden al trabajo autorizado. No aplicar por accidente migraciones ajenas que aparezcan durante la ejecución.
- [x] Consultar los AGENTS.md aplicables y los guides locales de Next antes de cambiar código específico del framework. Este plan no modifica rutas ni componentes Next.

Comandos verificados contra la ayuda de la CLI instalada:

```powershell
npx pnpm@12.5.1 exec supabase migration new s2_01_analysis_tables
npx pnpm@12.5.1 exec supabase migration up --local
npx pnpm@12.5.1 exec supabase test db --local supabase/tests/database/012_analysis_schema.test.sql
```

No ejecutar estos comandos durante la revisión del plan. En tareas posteriores sustituir únicamente el nombre exacto de la migración o del archivo de prueba indicado.

### Task 1: Contratos y fixtures que permitan empezar a los consumidores

**Files:** Modify `src/types/contracts.ts`; create `src/types/analysis-internal.ts`, `src/types/analysis-contracts.typecheck.ts`, `tests/fixtures/analysis/public.ts` y `tests/fixtures/analysis/internal.ts`.

**Interfaces:** Consume `ActionResult<T>`, `DocumentCategory` y `EligibleOwner` existentes. Produce `AnalysisApi`, `CreditsApi`, `AnalysisResultsApi`, `EligibleDocumentsQuery`, DTO públicos y tipos internos descritos a continuación. La consulta de selección expone solo nombre, categoría, owner y paginación; ready/active lo determina el servidor. No produce funciones invocables de negocio.

- [x] **Step 1: Añadir checks de tipos que fallen antes de definir contratos.**

En `analysis-contracts.typecheck.ts`, importar los nuevos tipos y comprobar:

```ts
import type { AnalysisApi, AnalysisJobStatus, FindingSummary } from "./contracts";
const _status: AnalysisJobStatus = "queued";
const _run: AnalysisApi["runAnalysis"] = async () => ({
  ok: true, data: { analysisId: "synthetic-analysis", status: "queued" },
});
declare const finding: FindingSummary;
// @ts-expect-error confidence is not a public property
void finding.confidence;
declare const api: AnalysisApi;
// @ts-expect-error tenant is derived from the verified identity
void api.runAnalysis({ estimateRef: "synthetic-estimate", idempotencyKey: "key", workspaceId: "foreign" });
void [_status, _run];
```

- [x] **Step 2: Ejecutar `npx pnpm@12.5.1 typecheck`.** Esperado: nuevos imports inexistentes; conservar la salida como evidencia del fallo esperado, sin confundir errores preexistentes con la regresión nueva.

- [x] **Step 3: Añadir las formas públicas mínimas.**

```ts
export type AnalysisJobStatus = "queued" | "processing" | "completed" | "failed";
export type AnalysisScopeRole = "source" | "comparison";
export type FindingType = "contradiction" | "obsolescence";
export type FindingSeverity = "High" | "Medium" | "Low";
export type FindingStatus = "pending_review";
export type CreditEventType = "Promotional" | "Reserved" | "Consumed" | "Released";
export interface AnalysisPage<T> { items: T[]; total: number; page: number; pageSize: number }
export interface AnalysisSelectionInput { sourceVersionIds: string[]; comparisonVersionIds: string[] }
export interface AnalysisSelectionItem {
  documentId: string; versionId: string; versionNumber: number;
  name: string; category: DocumentCategory; owner: EligibleOwner | null;
}
export interface AnalysisEstimate extends AnalysisSelectionInput {
  estimateRef: string; fixedCost: number; expiresAt: string;
}
export interface RunAnalysisInput { estimateRef: string; idempotencyKey: string }
export interface RunAnalysisResult { analysisId: string; status: AnalysisJobStatus }
export interface RetryAnalysisInput extends RunAnalysisInput { failedAnalysisId: string }
export interface RetryAnalysisResult extends RunAnalysisResult { retryOfAnalysisId: string }
export interface AnalysisSnapshot {
  analysisId: string; status: AnalysisJobStatus; fixedCost: number;
  initiator: { id: string; fullName: string };
  sources: AnalysisSelectionItem[]; comparisons: AnalysisSelectionItem[];
  createdAt: string; startedAt: string | null; finishedAt: string | null;
  retryOfAnalysisId: string | null; error: ActionError | null; canRetry: boolean;
}
export interface CreditSnapshot { available: number; reserved: number }
export interface CreditLedgerItem {
  id: string; type: CreditEventType; amount: number;
  analysisId: string | null; createdAt: string;
}
export interface FindingSummary {
  id: string; analysisId: string; type: FindingType; explanation: string;
  severityOriginal: FindingSeverity; severityCurrent: FindingSeverity; status: FindingStatus;
}
export interface FindingEvidence {
  id: string; documentId: string; versionId: string; chunkId: string;
  pageNumber: number | null; section: string | null;
  sectionHeading: string | null; snapshot: string;
}
export interface FindingDetail extends FindingSummary { evidence: FindingEvidence[] }
export interface FindingsQuery {
  analysisId: string; type?: FindingType; severity?: FindingSeverity;
  page?: number; pageSize?: number;
}
export interface EligibleDocumentsQuery {
  name?: string; category?: DocumentCategory; ownerId?: string | null;
  page?: number; pageSize?: number;
}
export interface AnalysisApi {
  listEligibleDocuments(query: EligibleDocumentsQuery): Promise<ActionResult<AnalysisPage<AnalysisSelectionItem>>>;
  estimateAnalysis(input: AnalysisSelectionInput): Promise<ActionResult<AnalysisEstimate>>;
  runAnalysis(input: RunAnalysisInput): Promise<ActionResult<RunAnalysisResult>>;
  retryAnalysis(input: RetryAnalysisInput): Promise<ActionResult<RetryAnalysisResult>>;
  getAnalysis(analysisId: string): Promise<ActionResult<AnalysisSnapshot>>;
  getActiveAnalysis(): Promise<ActionResult<AnalysisSnapshot | null>>;
}
export interface CreditsApi {
  getCreditSnapshot(): Promise<ActionResult<CreditSnapshot>>;
  listCreditLedger(query: { page?: number; pageSize?: number }): Promise<ActionResult<AnalysisPage<CreditLedgerItem>>>;
}
export interface AnalysisResultsApi {
  listFindings(query: FindingsQuery): Promise<ActionResult<AnalysisPage<FindingSummary>>>;
  getFinding(findingId: string): Promise<ActionResult<FindingDetail>>;
}
```

Añadir a `ActionErrorCode` los cuatro códigos de la spec. Los valores numéricos públicos se validarán en las operaciones propietarias; el tipo number no implica validación.

- [x] **Step 4: Definir los tipos internos sin exportarlos desde contracts.ts.**

```ts
import type { Actor, AnalysisScopeRole, FindingSeverity, FindingType } from "./contracts";
export type AnalysisFailureCode = "RETRIEVAL_FAILED" | "ESTIMATE_STALE" |
  "PROVIDER_UNAVAILABLE" | "INVALID_PROVIDER_OUTPUT" | "PERSISTENCE_FAILED" |
  "TIMEOUT" | "ATTEMPTS_EXHAUSTED" | "INTERNAL_ERROR";
export interface AnalysisConfiguration {
  retrieval: { topK: 5; similarityThreshold: 0.75; chunksRevision: string; embeddingRevision: string; fingerprint: string };
  pricingVersion: string; promptVersion: string; outputSchemaVersion: string;
  providers: { primary: { provider: string; model: string }; fallback: { provider: string; model: string } };
}
export interface AnalysisLease {
  analysisId: string; workspaceId: string; operationId: string;
  attemptCount: number; leaseExpiresAt: string;
}
export interface AnalysisChunkReference {
  documentId: string; versionId: string; chunkId: string; role: AnalysisScopeRole;
}
export interface AnalysisCandidatePair {
  source: AnalysisChunkReference & { text: string };
  comparison: AnalysisChunkReference & { text: string };
}
export interface PreparedRetrieval {
  actor: Actor; configuration: AnalysisConfiguration;
  chunkCount: number; candidatePairCount: number; fingerprint: string;
  pairs: AnalysisCandidatePair[];
}
export interface InternalFinding {
  type: FindingType; severity: FindingSeverity; confidence: number; explanation: string;
  evidence: Array<AnalysisChunkReference & {
    snapshot: string; pageNumber: number | null; section: string | null; sectionHeading: string | null;
  }>;
}
export type AIProviderResult = { ok: true; findings: InternalFinding[] } |
  { ok: false; error: { code: AnalysisFailureCode } };
export interface AIProvider {
  analyzePair(input: { pair: AnalysisCandidatePair; configuration: AnalysisConfiguration }): Promise<AIProviderResult>;
}
export interface AnalysisFinalizationInput { lease: AnalysisLease; findings: InternalFinding[] }
export interface CreditEffectInput { actor: Actor; analysisId: string; fixedCost: number }
export interface TerminalNotification {
  analysisId: string; workspaceId: string; recipientId: string;
  type: "analysis_completed" | "analysis_failed";
}
```

`CreditEffectInput` es la forma de datos para SQL transaccional, no una función HTTP ni una implementación de reserva. Los arrays de pares/texto son exclusivamente internos y no se persisten en analyses.

- [x] **Step 5: Crear fixtures tipados.** Usar IDs UUID sintéticos estables y nombres en inglés; `public.ts` exporta selecciones de 1/20/21, selección solapada, dos páginas, snapshots queued/processing/completed/failed, resultados vacíos y saldos `{available: 0, reserved: 0}` / `{available: 42, reserved: 8}`. `internal.ts` exporta configuración, lease vivo/vencido, par repetido/invertido, finding confidence 0.1 y snapshots Unicode de 2.000/2.001 caracteres. La salida inválida se declara `unknown`, no se fuerza mediante casts al tipo válido.

Ejemplo de generador de selección válido para el corpus de desarrollo:

```ts
const ids = Array.from({ length: 21 }, (_, i) =>
  `90000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`);
export const scope20 = { sourceVersionIds: ids.slice(0, 1), comparisonVersionIds: ids.slice(1, 20) }
  satisfies import("../../../src/types/contracts").AnalysisSelectionInput;
export const scope21 = { sourceVersionIds: ids.slice(0, 1), comparisonVersionIds: ids.slice(1) }
  satisfies import("../../../src/types/contracts").AnalysisSelectionInput;
```

- [ ] **Step 6: Ejecutar typecheck y lint.** Añadir checks negativos para confidence/lease/configuración pública y contexto recibido del cliente. Revisar estos contratos con los dos consumidores; registrar recepción/revisión real, sin enviar mensajes por herramientas sin instrucciones del usuario.

**Salida revisable:** consumidores pueden compilar con fixtures, sin saldo, proveedor ni endpoints reales. Registrar diff explícito; no hacer commit automático.

### Task 2: Seis tablas, relaciones y tipos SQL generados

**Files:** Create migración `s2_01_analysis_tables` con ruta generada por CLI, `012_analysis_schema.test.sql`, `supabase/tests/database/analysis-fixtures.psql`; regenerate `src/types/database.ts`. La regla de forma inicial de findings vive en `20261010195500_s2_01_finding_initial_state.sql` con `015_analysis_finding_initial_state.test.sql`.

**Interfaces:** Consume tablas S1 workspaces/profiles/documents/document_versions/document_chunks. Produce tablas y enums públicos; las siguientes tareas consumen `analyses.id`, claves `(id, workspace_id)`, scope con role y evidence con analysisId. La forma inicial de findings se añade en una migración incremental porque las tres primeras migraciones ya están aplicadas al stack local.

- [x] **Step 1: Escribir la prueba de esquema ausente.**

```sql
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();
select has_table('public', 'analyses', 'Analysis table exists');
select has_table('public', 'finding_evidence', 'Evidence table exists');
select ok((select count(*) = 6 from pg_class where relnamespace='public'::regnamespace
  and relname in ('analyses','analysis_documents','credit_ledger','findings','finding_evidence','notification_events')
  and relrowsecurity), 'All six tables enforce RLS');
select * from finish();
rollback;
```

- [x] **Step 2: Ejecutar la prueba focalizada; confirmar FAIL por objetos ausentes.** No aplicar migraciones antes de observar ese fallo.
- [x] **Step 3: Crear la migración con la CLI y añadir DDL.** Usar nombres de enums `analysis_job_status`, `analysis_scope_role`, `finding_type`, `finding_severity`, `finding_status`, `credit_event_type`, `notification_type`, `notification_status` y `analysis_failure_code`, con los valores de tarea 1. Los enums futuros de S3/S4 se añaden en sus migraciones.

DDL central:

```sql
create table public.analyses (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  initiator_id uuid not null,
  status public.analysis_job_status not null default 'queued',
  fixed_cost integer not null check (fixed_cost > 0),
  reserved_credits integer not null check (reserved_credits = fixed_cost),
  idempotency_key text not null check (char_length(btrim(idempotency_key)) > 0),
  request_fingerprint text not null check (char_length(btrim(request_fingerprint)) > 0),
  retry_of_analysis_id uuid,
  retrieval_config jsonb not null check (jsonb_typeof(retrieval_config) = 'object'),
  pricing_version text not null, prompt_version text not null, output_schema_version text not null,
  provider_config jsonb not null check (jsonb_typeof(provider_config) = 'object'),
  provider_used text, model_used text,
  attempt_count integer not null default 0 check (attempt_count between 0 and 3),
  operation_id uuid, lease_expires_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  started_at timestamptz, finished_at timestamptz, error_code public.analysis_failure_code,
  unique(id,workspace_id), unique(workspace_id,initiator_id,idempotency_key),
  check (retry_of_analysis_id is distinct from id),
  foreign key(initiator_id,workspace_id) references public.profiles(id,workspace_id) on delete restrict,
  foreign key(retry_of_analysis_id,workspace_id) references public.analyses(id,workspace_id) on delete restrict
);
create unique index analyses_one_active on public.analyses(workspace_id)
  where status in ('queued','processing');
create table public.analysis_documents (
  analysis_id uuid not null, workspace_id uuid not null,
  document_id uuid not null, version_id uuid not null, role public.analysis_scope_role not null,
  primary key(analysis_id,version_id,role),
  foreign key(analysis_id,workspace_id) references public.analyses(id,workspace_id) on delete restrict,
  foreign key(version_id,document_id,workspace_id)
    references public.document_versions(id,document_id,workspace_id) on delete restrict
);
create table public.credit_ledger (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  event_type public.credit_event_type not null, amount integer not null check(amount > 0),
  analysis_id uuid, created_at timestamptz not null default now(),
  check ((event_type='Promotional' and analysis_id is null) or
    (event_type <> 'Promotional' and analysis_id is not null)),
  foreign key(analysis_id,workspace_id) references public.analyses(id,workspace_id) on delete restrict
);
create unique index credit_ledger_one_promo on public.credit_ledger(workspace_id) where event_type='Promotional';
create unique index credit_ledger_one_reservation on public.credit_ledger(analysis_id) where event_type='Reserved';
create unique index credit_ledger_one_settlement on public.credit_ledger(analysis_id)
  where event_type in ('Consumed','Released');
create table public.findings (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null, analysis_id uuid not null,
  type public.finding_type not null,
  severity_original public.finding_severity not null, severity_current public.finding_severity not null,
  confidence double precision not null check(confidence >= 0 and confidence <= 1),
  explanation text not null check(char_length(btrim(explanation)) > 0),
  status public.finding_status not null default 'pending_review', assignee_id uuid,
  fingerprint text not null check(char_length(btrim(fingerprint)) > 0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(id,analysis_id,workspace_id), unique(analysis_id,fingerprint),
  foreign key(analysis_id,workspace_id) references public.analyses(id,workspace_id) on delete restrict,
  foreign key(assignee_id,workspace_id) references public.profiles(id,workspace_id) on delete restrict
);
alter table public.document_chunks add constraint document_chunks_s2_identity
  unique(id,version_id,workspace_id);
create table public.finding_evidence (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null, analysis_id uuid not null,
  finding_id uuid not null, document_id uuid not null, version_id uuid not null, chunk_id uuid not null,
  page_number integer check(page_number > 0), section text, section_heading text,
  snapshot text not null check(char_length(snapshot) between 1 and 2000 and char_length(btrim(snapshot)) > 0),
  foreign key(finding_id,analysis_id,workspace_id) references public.findings(id,analysis_id,workspace_id) on delete restrict,
  foreign key(version_id,document_id,workspace_id) references public.document_versions(id,document_id,workspace_id) on delete restrict,
  foreign key(chunk_id,version_id,workspace_id) references public.document_chunks(id,version_id,workspace_id) on delete restrict
);
create table public.notification_events (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null, analysis_id uuid not null,
  type public.notification_type not null, recipient_id uuid not null,
  status public.notification_status not null default 'pending',
  attempt_count integer not null default 0 check(attempt_count between 0 and 3),
  next_attempt_at timestamptz, created_at timestamptz not null default now(), sent_at timestamptz,
  error_code text check(error_code in ('DELIVERY_FAILED','RECIPIENT_UNAVAILABLE','INTERNAL_ERROR')),
  unique(analysis_id,type,recipient_id),
  foreign key(analysis_id,workspace_id) references public.analyses(id,workspace_id) on delete restrict,
  foreign key(recipient_id,workspace_id) references public.profiles(id,workspace_id) on delete restrict
);
```

Antes de terminar la migración, habilitar RLS en las seis tablas, revocar ALL a PUBLIC/anon/authenticated y a service_role; los permisos mínimos se conceden en tarea 4. Reutilizar `private.touch_updated_at()` en analyses/findings. Añadir CHECK de no vacío para las tres versiones textuales. No añadir filas Promotional ni cambiar bootstrap.

Índices adicionales: analyses `(workspace_id,created_at desc,id)`, `(initiator_id,workspace_id)`, `(retry_of_analysis_id,workspace_id)`; scope `(version_id,document_id,workspace_id)`; ledger `(workspace_id,created_at desc,id)` y `(analysis_id,workspace_id)`; findings `(workspace_id,analysis_id,severity_current,id)` y `(assignee_id,workspace_id)`; evidence `(finding_id,analysis_id,workspace_id)`, `(version_id,document_id,workspace_id)` y `(chunk_id,version_id,workspace_id)`; notification `(workspace_id,analysis_id)` y `(recipient_id,workspace_id)`. Evitar duplicar índices ya cubiertos por PK/unique.

- [x] **Step 4: Implementar el helper SQL solo para tests.** En `analysis-fixtures.psql` crear `pg_temp.analysis_case(analysis_id, workspace_id, document_id, version_id, chunk_id, ordinal)` y `pg_temp.create_analysis_fixture(p_workspace uuid, p_initiator uuid, p_status public.analysis_job_status, p_version_count integer) returns uuid`. Generar IDs con gen_random_uuid; insertar un análisis de coste/reserva 3, configuración sintética y fechas; por ordinal crear documento, v1 ready/active, puntero activo y chunk vector unitario de 384 dimensiones; registrar la referencia e insertar source. Usar el patrón de activación transaccional existente en `009_repository_projection.test.sql`. No confirmar upload ni crear trabajos de ingesta.

Implementación del helper de referencia:

```sql
create temporary table analysis_case (
  analysis_id uuid not null, workspace_id uuid not null, document_id uuid not null,
  version_id uuid not null, chunk_id uuid not null, ordinal integer not null,
  primary key(analysis_id,ordinal)
) on commit drop;
create function pg_temp.create_analysis_fixture(
  p_workspace uuid,p_initiator uuid,p_status public.analysis_job_status,p_version_count integer
) returns uuid language plpgsql as $$
declare
  v_analysis uuid := gen_random_uuid();
  v_document uuid; v_version uuid; v_chunk uuid; v_ordinal integer;
begin
  if p_version_count < 0 or p_version_count > 21 then
    raise exception using errcode='22023',message='Invalid synthetic fixture size.';
  end if;
  set constraints all deferred;
  insert into public.analyses(id,workspace_id,initiator_id,status,fixed_cost,reserved_credits,
    idempotency_key,request_fingerprint,retrieval_config,pricing_version,prompt_version,
    output_schema_version,provider_config,attempt_count,operation_id,lease_expires_at,
    started_at,finished_at,error_code)
  values(v_analysis,p_workspace,p_initiator,p_status,3,3,v_analysis::text,v_analysis::text,
    '{"topK":5,"similarityThreshold":0.75,"chunksRevision":"synthetic","embeddingRevision":"synthetic","fingerprint":"synthetic"}'::jsonb,
    'synthetic-v1','synthetic-v1','synthetic-v1',
    '{"primary":{"provider":"synthetic","model":"synthetic"},"fallback":{"provider":"synthetic","model":"synthetic"}}'::jsonb,
    case when p_status='queued' then 0 else 1 end,
    case when p_status='processing' then gen_random_uuid() else null end,
    case when p_status='processing' then now()+interval '60 seconds' else null end,
    case when p_status='queued' then null else now() end,
    case when p_status in ('completed','failed') then now() else null end,
    case when p_status='failed' then 'INTERNAL_ERROR'::public.analysis_failure_code else null end);
  for v_ordinal in 1..p_version_count loop
    v_document:=gen_random_uuid(); v_version:=gen_random_uuid(); v_chunk:=gen_random_uuid();
    insert into public.documents(id,workspace_id,name,category,owner_id)
    values(v_document,p_workspace,'Synthetic analysis document','SOP',p_initiator);
    insert into public.document_versions(id,workspace_id,document_id,version_number,
      storage_path,processing_status,version_status)
    values(v_version,p_workspace,v_document,1,
      p_workspace::text||'/'||v_document::text||'/'||v_version::text||'/original.md','ready','active');
    update public.documents set active_version_id=v_version where id=v_document;
    insert into public.document_chunks(id,workspace_id,version_id,chunk_index,text_content,embedding)
    values(v_chunk,p_workspace,v_version,0,'Synthetic analysis fixture',
      ('[1,' || repeat('0,',382) || '0]')::extensions.vector);
    insert into public.analysis_documents(analysis_id,workspace_id,document_id,version_id,role)
    values(v_analysis,p_workspace,v_document,v_version,'source');
    insert into pg_temp.analysis_case values(v_analysis,p_workspace,v_document,v_version,v_chunk,v_ordinal);
  end loop;
  return v_analysis;
end $$;
```

El helper nunca se crea en public/private ni se expone por Data API. En pruebas cargar con `\ir analysis-fixtures.psql` dentro de BEGIN/ROLLBACK; la extensión `.psql` evita que Supabase lo descubra como suite independiente. Si una constraint S1 adicional requiere metadata de fixture, conservarla y añadir únicamente los datos sintéticos que exige; no desactivar la constraint para hacer pasar este helper.

- [x] **Step 5: Ampliar 012 con FK y valores.** Usar los seed IDs del Día Cero dentro de la transacción. `throws_ok` espera 23503 para tenant/initiator/versión/chunk/destinatario cruzados y para asignar en UPDATE un Profile de otro workspace; 23514 para coste 0, reserva distinta, confidence -0.1/1.1/NaN/Infinity, explicación vacía, intentos 4; 23505 para key, evento, fingerprint, reserva/liquidación duplicados. Aceptar confidence 0, 0.1 y 1. Aceptar el mismo fingerprint en otro análisis completed.

- [x] **Step 6: Aplicar únicamente las migraciones locales revisadas y ejecutar 012.** Esperado: PASS. Los triggers transaccionales de alcance se añaden en tarea 3.
- [x] **Step 7: Regenerar tipos de forma segura.** Usar el mismo comando que `scripts/check-database-types.mjs`; generar en memoria y escribir UTF-8 solo si acaba con éxito:

```js
const generated = execFileSync(process.execPath,
  [resolve("node_modules/supabase/dist/supabase.js"), "gen", "types", "typescript", "--local"],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
writeFileSync("src/types/database.ts", generated, "utf8");
```

Este fragmento se ejecuta desde la raíz con imports de node:child_process, node:path y node:fs; stderr no se adjunta a artefactos. Ejecutar `check:database-types`, typecheck y revisar el diff generado. La prueba de tipos añade igualdad entre los nuevos unions públicos y los enums generados:

```ts
import type { Database } from "./database";
type Equal<A,B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
type JobStatusMatches = Assert<Equal<AnalysisJobStatus,Database["public"]["Enums"]["analysis_job_status"]>>;
```

Añadir la misma igualdad explícita para AnalysisScopeRole, FindingType, FindingSeverity, FindingStatus y CreditEventType, además de AnalysisFailureCode importado de analysis-internal.ts.

- [x] **Step 8: Exigir la forma inicial de findings.** Añadir primero una prueba roja para inserts con severidad distinta o asignatario; después crear la migración incremental con trigger solo de INSERT y permitir cambios posteriores de revisión. Corregir las fixtures para usar severidades iguales. Aplicar únicamente la migración local, ejecutar las 15 suites SQL y la regresión de integración completa. El runner CI excluye la cuarta migración al preparar el baseline S1 y conserva errores de limpieza junto con el fallo principal.

**Salida revisable:** seis tablas sin lectura pública accidental, tipos regenerados, restricciones declarativas y forma inicial de findings probadas; no hay operaciones de dominio.

### Task 3: Alcance y evidencia válidos al confirmar la transacción

**Files:** Create migración `s2_01_analysis_integrity` y `013_analysis_integrity.test.sql`.

**Interfaces:** Consume tablas de tarea 2. Produce `private.lock_analysis_references()`, `private.validate_analysis_integrity(uuid)` y `private.check_analysis_integrity()`, exclusivos para triggers internos. No producen una RPC pública.

- [x] **Step 1: Escribir regresiones con fixtures de 1/20/21.** Forzar la comprobación diferida dentro de `throws_ok`, ya que el ROLLBACK final de una prueba no ejecuta triggers de commit:

```sql
select lives_ok($$select pg_temp.create_analysis_fixture(
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','10000000-0000-4000-8000-000000000001','completed',20);
 set constraints all immediate$$, '20 distinct versions accepted');
set constraints all deferred;
select throws_ok($$select pg_temp.create_analysis_fixture(
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','10000000-0000-4000-8000-000000000001','completed',21);
 set constraints all immediate$$, '23514', null, '21 distinct versions rejected');
```

Añadir una fila comparison de la misma versión a un fixture20: debe pasar. Eliminar todas las source de un fixture y forzar immediate: 23514. Añadir evidencia con versión fuera del scope del mismo workspace: 23514. Borrar ambas asociaciones de una versión con evidencia: 23514; borrar solo una cuando la otra permanece: permitido.

- [x] **Step 2: Ejecutar 013 y confirmar los fallos antes de añadir guards.**
- [x] **Step 3: Implementar lock previo en scope y evidence.**

```sql
create function private.lock_analysis_references() returns trigger
language plpgsql set search_path = '' as $$
declare v_old uuid; v_new uuid;
begin
  if tg_op <> 'INSERT' then v_old := old.analysis_id; end if;
  if tg_op <> 'DELETE' then v_new := new.analysis_id; end if;
  perform a.id from public.analyses a
    where a.id = any(pg_catalog.array_remove(array[v_old,v_new],null::uuid))
    order by a.id for update;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger analysis_scope_lock before insert or update or delete on public.analysis_documents
for each row execute function private.lock_analysis_references();
create trigger analysis_evidence_lock before insert or update or delete on public.finding_evidence
for each row execute function private.lock_analysis_references();
```

Los old/new analysisId se bloquean en orden estable. Mantener operaciones multi-análisis cortas y adquirir previamente sus padres en orden si se escriben varios análisis desde una misma transacción.

- [x] **Step 4: Implementar la validación del estado final.**

```sql
create function private.validate_analysis_integrity(p_analysis_id uuid) returns void
language plpgsql set search_path = '' as $$
declare v_versions bigint; v_sources bigint;
begin
  perform a.id from public.analyses a where a.id=p_analysis_id for update;
  if not found then return; end if;
  select count(distinct s.version_id), count(*) filter(where s.role='source')
    into v_versions,v_sources from public.analysis_documents s where s.analysis_id=p_analysis_id;
  if v_sources < 1 or v_versions > 20 then
    raise exception using errcode='23514', message='Invalid analysis scope.';
  end if;
  if exists(select 1 from public.finding_evidence e where e.analysis_id=p_analysis_id
    and not exists(select 1 from public.analysis_documents s
      where s.analysis_id=e.analysis_id and s.workspace_id=e.workspace_id
        and s.document_id=e.document_id and s.version_id=e.version_id)) then
    raise exception using errcode='23514', message='Evidence is outside the analysis scope.';
  end if;
end $$;
create function private.check_analysis_integrity() returns trigger
language plpgsql set search_path = '' as $$
declare v_ids uuid[]; v_id uuid;
begin
  if tg_table_name='analyses' then
    if tg_op='INSERT' then v_ids:=array[new.id]; else v_ids:=array[old.id,new.id]; end if;
  elsif tg_op='INSERT' then v_ids:=array[new.analysis_id];
  elsif tg_op='DELETE' then v_ids:=array[old.analysis_id];
  else v_ids:=array[old.analysis_id,new.analysis_id]; end if;
  for v_id in select distinct u.id from pg_catalog.unnest(v_ids) as u(id)
    where u.id is not null order by u.id loop
    perform private.validate_analysis_integrity(v_id);
  end loop;
  return null;
end $$;
create constraint trigger analysis_requires_scope after insert or update on public.analyses
deferrable initially deferred for each row execute function private.check_analysis_integrity();
create constraint trigger analysis_scope_integrity after insert or update or delete on public.analysis_documents
deferrable initially deferred for each row execute function private.check_analysis_integrity();
create constraint trigger analysis_evidence_integrity after insert or update or delete on public.finding_evidence
deferrable initially deferred for each row execute function private.check_analysis_integrity();
```

Revocar EXECUTE de estas funciones a PUBLIC/anon/authenticated. Los privilegios de service_role se completan en tarea 4. No introducir SECURITY DEFINER: los escritores internos ya tienen el acceso requerido y RLS es independiente del guard de relaciones.

- [x] **Step 5: Añadir pruebas de corrección en ambos sentidos.** Actualizar analysisId/versionId/chunkId; eliminar la última asociación; crear y después eliminar un análisis sin children antes del commit; insertar análisis y fuente en una transacción válida. Verificar que la validación usa el estado final y no la foto de la primera inserción.
- [x] **Step 6: Fijar Unicode y transición histórica.** Insertar snapshots `repeat('😀',2000)` y `repeat('😀',2001)` y comprobar PASS/23514. Crear evidencia válida, cambiar la versión activa S1 en una transacción consistente y comprobar que su referencia histórica permanece válida. No crear un worker ni cambiar analysis_status.
- [x] **Step 7: Aplicar la nueva migración local y ejecutar 012/013.** PASS completo sin omitir la comprobación diferida. Las carreras se ejercitan en tarea 6.

**Salida revisable:** no se confirma un scope vacío/excesivo ni se pierde pertenencia de evidencia por cambios de asociaciones.

### Task 4: Permisos mínimos, RLS y proyecciones de lectura

**Files:** Create migración `s2_01_analysis_security` y `014_analysis_security.test.sql`; regenerate `src/types/database.ts`.

**Interfaces:** Consume helpers existentes `private.current_workspace_id()` y `private.current_workspace_role()`. Produce views `analysis_runs`, `analysis_scope`, `analysis_findings` y `analysis_finding_evidence`, todas security_invoker. Las consultas de saldo y Server Actions siguen fuera del ticket.

- [x] **Step 1: Escribir pruebas de privilegios antes de conceder lecturas.**

```sql
select ok(has_column_privilege('authenticated','public.analyses','status','SELECT'), 'Public status readable');
select ok(not has_column_privilege('authenticated','public.analyses','lease_expires_at','SELECT'), 'Lease is internal');
select ok(not has_column_privilege('authenticated','public.findings','confidence','SELECT'), 'Confidence is internal');
select ok(not has_table_privilege('authenticated','public.notification_events','SELECT'), 'Outbox is internal');
select ok(not has_table_privilege('service_role','public.credit_ledger','UPDATE'), 'Ledger cannot be changed by the application');
```

Esperado antes de tarea4: primera aserción y views fallan; las negativas de permisos ya pasan gracias a tarea2.

- [x] **Step 2: Añadir SELECT RLS basado en Profile persistido.**

```sql
create policy analyses_read on public.analyses for select to authenticated
using(workspace_id=(select private.current_workspace_id())
  and (select private.current_workspace_role()) in ('Admin','QA Lead'));
create policy analysis_scope_read on public.analysis_documents for select to authenticated
using(workspace_id=(select private.current_workspace_id())
  and (select private.current_workspace_role()) in ('Admin','QA Lead'));
create policy ledger_read on public.credit_ledger for select to authenticated
using(workspace_id=(select private.current_workspace_id())
  and (select private.current_workspace_role()) in ('Admin','QA Lead'));
create policy findings_read on public.findings for select to authenticated
using(workspace_id=(select private.current_workspace_id())
  and (select private.current_workspace_role()) in ('Admin','QA Lead')
  and exists(select 1 from public.analyses a where a.id=findings.analysis_id
    and a.workspace_id=findings.workspace_id and a.status='completed'));
create policy evidence_read on public.finding_evidence for select to authenticated
using(workspace_id=(select private.current_workspace_id())
  and (select private.current_workspace_role()) in ('Admin','QA Lead')
  and exists(select 1 from public.analyses a where a.id=finding_evidence.analysis_id
    and a.workspace_id=finding_evidence.workspace_id and a.status='completed'));
```

En las subqueries correlacionadas, cualificar los campos de la fila exterior (`findings.analysis_id`, `findings.workspace_id`, `finding_evidence.analysis_id`, `finding_evidence.workspace_id`) para evitar una igualdad accidental de la tabla interior consigo misma. No añadir policies de escritura ni policy de lectura de notification_events.

- [x] **Step 3: Conceder solo columnas públicas.**

```sql
grant select(id,workspace_id,initiator_id,status,fixed_cost,retry_of_analysis_id,
  created_at,started_at,finished_at,error_code) on public.analyses to authenticated;
grant select(analysis_id,workspace_id,document_id,version_id,role) on public.analysis_documents to authenticated;
grant select(id,workspace_id,event_type,amount,analysis_id,created_at) on public.credit_ledger to authenticated;
grant select(id,workspace_id,analysis_id,type,severity_original,severity_current,
  explanation,status,created_at,updated_at) on public.findings to authenticated;
grant select(id,workspace_id,analysis_id,finding_id,document_id,version_id,chunk_id,
  page_number,section,section_heading,snapshot) on public.finding_evidence to authenticated;
grant select,insert,update on public.analyses,public.findings,public.notification_events to service_role;
grant select,insert on public.analysis_documents,public.finding_evidence,public.credit_ledger to service_role;
grant execute on function private.lock_analysis_references(),
  private.validate_analysis_integrity(uuid),private.check_analysis_integrity() to service_role;
```

No conceder DELETE/TRUNCATE ni UPDATE del ledger. Los guards de integridad se prueban también como postgres para los cambios de mantenimiento; no habilitar escrituras de cliente para probarlos.

- [x] **Step 4: Crear views con columnas explícitas.**

```sql
create view public.analysis_findings with(security_invoker=true) as
select f.id,f.workspace_id,f.analysis_id,f.type,f.severity_original,f.severity_current,
  f.explanation,f.status,f.created_at,f.updated_at
from public.findings f join public.analyses a
  on a.id=f.analysis_id and a.workspace_id=f.workspace_id where a.status='completed';
grant select on public.analysis_findings to authenticated;
```

`analysis_runs`: columnas públicas de analyses más `profiles.full_name` del iniciador. `analysis_scope`: columnas públicas de scope más nombre/category/owner del documento y version_number de la versión exacta; joins por ID y workspace. `analysis_finding_evidence`: columnas públicas de evidence y join al análisis completed, sin confidence ni texto completo del chunk. Mantener `security_invoker=true` y GRANT SELECT únicamente a authenticated en las cuatro views; revocar grants por defecto a anon/PUBLIC. No añadir agregación de saldo en estas views.

- [x] **Step 5: Probar cada rol y cada ruta de consulta.** Dentro de la transacción SQL, crear fixtures A/B como postgres; alternar `set local role authenticated` con `set_config('request.jwt.claims',...)` para Admin A, QA A, Member A y Admin B. Admin/QA ven solo A; Member devuelve cero filas; anon no tiene SELECT. Un wildcard base analyses/findings devuelve 42501; wildcard de views funciona y excluye campos internos. Intentar INSERT/UPDATE/DELETE y cambios de workspace/rol: 42501. Como service_role, SELECT/INSERT del ledger funcionan y UPDATE/DELETE/TRUNCATE devuelven 42501.
- [x] **Step 6: Probar publicación.** Crear provisional findings/evidence para analysis processing y completed. Ninguna sesión ve los provisionales desde tabla ni view. La escritura terminal atómica real sigue en S2-08.
- [x] **Step 7: Aplicar migración, regenerar database.ts y ejecutar 012/013/014, check:database-types y typecheck.** Los tipos de views no contienen columnas internas; los tipos completos de Tables siguen existiendo para servidor y no se usan como DTO públicos.

**Salida revisable:** la frontera se aplica en SQL/Data API, con independencia de la UI.

### Task 5: Aislamiento HTTP y fixtures persistidos con limpieza segura

**Files:** Create `tests/support/analysis-fixtures.ts`, `tests/integration/analysis-isolation.test.ts`.

**Interfaces:** Consume `newLocalUser()`, `insertLocalProfile(...)`, `cleanupLocalUser(userId)`, `assertLocalSupabaseReady()`, `openLocalSqlSession(name)` y Database generado. Produce:

```ts
export interface AnalysisFixtureOptions {
  versionCount?: number; unscopedVersionCount?: number;
  status?: AnalysisJobStatus; withLedger?: boolean;
}
export interface AnalysisFixture {
  workspaceId: string; analysisId: string; findingId: string; evidenceId: string;
  versions: Array<{documentId: string; versionId: string; chunkId: string}>;
  admin: SupabaseClient<Database>; qa: SupabaseClient<Database>; member: SupabaseClient<Database>;
  adminId: string; qaId: string; memberId: string;
  sql: LocalSqlSession;
  dispose(): Promise<void>;
}
export function createAnalysisFixture(options?: AnalysisFixtureOptions): Promise<AnalysisFixture>;
```

Los tipos importan AnalysisJobStatus de contracts, SupabaseClient del SDK y LocalSqlSession del helper existente. No hay imports de este helper desde src.

- [x] **Step 1: Añadir prueba HTTP que falle antes de existir el helper.**

```ts
it("exposes public findings but denies confidence over the real Data API", async () => {
  const fixture = await createAnalysisFixture();
  try {
    const visible = await fixture.admin.from("analysis_findings").select("*").eq("id",fixture.findingId);
    expect(visible.error).toBeNull();
    expect(visible.data).toHaveLength(1);
    expect(visible.data?.[0]).not.toHaveProperty("confidence");
    const hidden = await fixture.admin.from("findings").select("confidence").eq("id",fixture.findingId);
    expect(hidden.data).toBeNull();
    expect(hidden.error?.code).toBe("42501");
  } finally { await fixture.dispose(); }
});
```

- [x] **Step 2: Ejecutar `node scripts/with-local-supabase.mjs integration tests/integration/analysis-isolation.test.ts`.** Esperado: helper/import ausente; si el entorno no está listo, preparar el stack local sin reset antes de tomar evidencia de test.
- [x] **Step 3: Construir fixture en loopback.** Crear tres usuarios mediante newLocalUser; bootstrap solo el Admin con nombre `kdm-UUID` y full_name sintético; insertar Profile QA/Member del mismo workspace con insertLocalProfile. Abrir sesión SQL del container local guardado; crear documentos/versiones/chunks y analysis/scope en una transacción con los campos de tarea2. Añadir un finding/evidence, y opcionalmente Promotional/Reserved. Confirmar para que Data API vea los datos. No insertar blobs ni cambiar upload gate.

El helper usa UUID generados internamente, valida su forma antes de interpolarlos en SQL y no acepta SQL desde opciones. Los errores se traducen a mensajes constantes/SQLSTATE; no se imprimen documentos, respuestas crudas ni claves. El status por defecto es completed, versionCount 1 y withLedger false; queued/processing se permiten para las pruebas de base. versionCount admite 1..20 y unscopedVersionCount 0..2, por defecto 0. Crear versionCount + unscopedVersionCount versiones y asociar solo las primeras versionCount: las dos restantes permiten probar las carreras del límite sin crear inicialmente un scope inválido.

- [x] **Step 4: Implementar cleanup idempotente y acotado.** El SQL se ejecuta como postgres del container local, no mediante service_role de aplicación. Validar primero que workspace/adminId coinciden con un Profile de email `kdm-UUID@example.test` y workspace de nombre `kdm-UUID`; si falta esa garantía, rechazar y conservar datos.

Orden dentro de una única transacción, siempre filtrando por el workspace generado:

```sql
begin;
delete from public.notification_events where workspace_id = :'fixture_workspace'::uuid;
delete from public.finding_evidence where workspace_id = :'fixture_workspace'::uuid;
delete from public.findings where workspace_id = :'fixture_workspace'::uuid;
delete from public.credit_ledger where workspace_id = :'fixture_workspace'::uuid;
delete from public.analysis_documents where workspace_id = :'fixture_workspace'::uuid;
delete from public.analyses where workspace_id = :'fixture_workspace'::uuid;
commit;
```

El SQL ilustrado se envía con valores UUID validados; LocalSqlSession no añade automáticamente variables psql. El ejecutor sustituye únicamente el UUID generado y validado, o usa una sesión psql con `-v` como el helper existente. No desactivar triggers/RLS ni conceder DELETE a service_role. Después, cleanupLocalUser(Admin) elimina los documentos/workspace S1 del fixture; cleanupLocalUser(QA/Member) elimina sus cuentas Auth ya sin Profile. Si crear el fixture falla parcialmente, limpiar únicamente lo creado y cerrar la sesión. No marcar dispose completado hasta que haya terminado la limpieza.

- [x] **Step 5: Cubrir A/B, QA, Member y anon.** Crear dos fixtures independientes; consultar los IDs del otro tenant tanto en tablas con columnas públicas como en views: cero filas. Probar que Member, incluso como Owner, no ve análisis/evidence/ledger. Probar mutación HTTP denegada y notification_events/lease/key/configuración/confidence inaccesibles. QA debe ver el mismo resultado que Admin de su tenant.
- [x] **Step 6: Fijar degradación de rol y wildcard.** Conservar el cliente QA firmado, cambiar su Profile a Member usando la sesión SQL y repetir las mismas consultas: cero filas sin renovar JWT. Comprobar wildcard de base restringida y wildcard de view segura con la misma sesión Admin.
- [x] **Step 7: Fijar limpieza sin cambios ajenos.** Crear fixtures A/B; disponer A y confirmar que B sigue íntegro. Disponer A otra vez sin error. Forzar un fallo de construcción tras crear el Admin y comprobar que no quedan sus filas S2. No cambiar el helper cleanupLocalUser de S1 ni su alcance general.
- [x] **Step 8: Ejecutar el archivo HTTP y typecheck/lint.** Todos los casos pasan contra Auth/REST reales del stack local; no usar mocks para permisos.

**Salida revisable:** Data API respeta permisos y los fixtures no contaminan otros tests o datos locales.

### Task 6: Carreras SQL con sesiones reales

**Files:** Create `tests/integration/analysis-concurrency.test.ts`; consume fixture de tarea5 y `tests/support/local-sql-session.ts` sin modificar su guard.

**Interfaces:** Consume `openLocalSqlSession(name): Promise<LocalSqlSession>`, `query(sql): Promise<string>`, `waitForSqlLock(observer,pid,blockerPid)` y `LocalSqlError.sqlState`. Produce pruebas, no una API nueva.

- [x] **Step 1: Añadir carrera para la última plaza del scope.** Fixture con 19 versiones, más dos documentos/versiones adicionales sin asociación. A inserta la versión20 y retiene su transacción; B intenta insertar la versión21. Observar lock real con tercera sesión; confirmar A y después forzar la validación de B. Esperado: B falla 23514 y hace rollback; quedan 20 distintas. Repetir con A haciendo rollback: B debe poder confirmar y quedar en20.

- [x] **Step 2: Añadir carrera de evidencia y eliminación de scope.** Usar un scope source/comparison para mantener una fuente válida después de eliminar la comparación. A elimina la comparación, B inserta evidencia que la requiere y espera el lock; A confirma. B debe rechazar la evidencia al verificar el estado final. La carrera inversa inserta/confirmar evidencia primero: borrar su última asociación debe fallar. Quitar solo una de dos asociaciones de la misma versión debe seguir permitido.

Patrón de sincronización, con SQL concreto construido únicamente desde UUID internos del fixture:

```ts
const a = await openLocalSqlSession("kdm_analysis_a");
const b = await openLocalSqlSession("kdm_analysis_b");
const observer = await openLocalSqlSession("kdm_analysis_observer");
try {
  await a.query("begin;");
  await b.query("begin;");
  await a.query(deleteLastComparisonSql);
  const blocked = b.query(insertEvidenceSql);
  const captured = blocked.then(() => ({ok:true as const}),error => ({ok:false as const,error}));
  await waitForSqlLock(observer,b.pid,a.pid);
  await a.query("commit;");
  const write = await captured;
  if (write.ok) {
    await expect(b.query("set constraints all immediate;")).rejects.toMatchObject({sqlState:"23514"});
  } else {
    expect(write.error).toMatchObject({sqlState:"23514"});
  }
  await b.query("rollback;");
} finally {
  await a.close(); await b.close(); await observer.close();
}
```

`deleteLastComparisonSql` elimina la asociación comparison identificada por analysisId/versionId; `insertEvidenceSql` inserta findingId, documento/version/chunk de esa asociación, workspace y snapshot sintético en finding_evidence. Los tests definen ambas cadenas explícitamente usando datos del fixture. El error puede aparecer al escribir o al forzar la validación, pero una confirmación inválida nunca se acepta.

- [x] **Step 3: Probar un único queued/processing.** Un fixture queued existente rechaza otro queued/processing A con 23505. Para la carrera desde tenant sin activo, A/B insertan distintos análisis activos del mismo workspace con fuentes dentro de sus respectivas transacciones; B bloquea en el índice único y falla si A confirma, o puede confirmar si A revierte. Otro workspace confirma en paralelo. Un análisis completed nuevo no queda bloqueado por esta restricción.
- [x] **Step 4: Probar actualización de referencias old/new.** Cambiar la pertenencia de una asociación entre análisis sin dejar inválido ninguno; validar ambos padres y usar orden estable. Si el cambio deja un análisis sin fuentes o evidencia huérfana, falla. El test acepta conflicto/deadlock controlado cuando dos transacciones adquieren previamente recursos incompatibles, pero no acepta datos inválidos ni espera ilimitada.
- [x] **Step 5: Ejecutar las carreras focalizadas y después integración completa.** `node scripts/with-local-supabase.mjs integration tests/integration/analysis-concurrency.test.ts`; después `npx pnpm@12.5.1 test:integration`. Timeout por query de 5s del helper existente; observar blockers, no coordinar con sleeps largos. Capturar las promises para evitar rechazos no manejados.

**Salida revisable:** los guards soportan commit/rollback concurrente real, sin atribuir pruebas de claim/reserva a esta base.

### Task 7: Upgrade descartable, gates y acta de aceptación

**Files:** Create `scripts/check-analysis-upgrade.mjs`, `tests/unit/analysis-upgrade-guard.test.ts`, `docs/testing/s2-01-analysis-foundation-acceptance.md`; modify `.github/workflows/s1-01.yml` únicamente para añadir el control de upgrade antes del arranque existente del stack de pruebas.

**Interfaces:** Consume CLI instalada, migraciones revisadas y configuración Supabase local. Produce runner CI-only que termina con código 0 si preserva S1 y aplica S2; mantiene nombre Quality gates, SHA, steps de S1 y reglas de despliegue existentes.

- [x] **Step 1: Añadir prueba de rechazo fuera de CI.**

```ts
it("refuses the destructive upgrade harness outside disposable CI", () => {
  const result = spawnSync(process.execPath,["scripts/check-analysis-upgrade.mjs"],{
    env:{...process.env,CI:"",GITHUB_ACTIONS:""},encoding:"utf8",windowsHide:true,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Disposable CI is required.");
});
```

El test importa spawnSync de node:child_process y it/expect de vitest. Antes del runner, falla porque el archivo no existe; después debe rechazar antes de llamar Docker/CLI.

- [x] **Step 2: Implementar guard e inventario de stack.**

```js
if(process.env.CI !== "true" || process.env.GITHUB_ACTIONS !== "true") {
  console.error("Disposable CI is required.");
  process.exit(1);
}
const names = execFileSync("docker",["ps","-a","--filter",
  "name=supabase_db_knowledge-decay-monitor-s1-02","--format","{{.Names}}"],
  {encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
if(names) throw new Error("Refusing to reuse an existing local stack.");
```

Imports: execFileSync de node:child_process; readFileSync/copyFileSync/mkdirSync/mkdtempSync/readdirSync de node:fs; resolve/join de node:path; tmpdir de node:os. Crear un directorio temporal propio y copiar los archivos Supabase versionados que necesita start: config, seed, fixtures, templates y funciones locales, además de las migraciones S1. Enumerarlos con git ls-files supabase, sin copiar snippets ajenos, .env ni directorios .temp. Excluir exactamente las cuatro migraciones S2-01 registradas (tablas, integridad, seguridad y forma inicial de findings); no excluir otras migraciones por fecha genérica. Las pruebas no mueven ni borran archivos del checkout.

- [ ] **Step 3: Iniciar S1 en el workspace temporal.** Ejecutar CLI local con `start --workdir directorioTemporal`. Antes de implementar, consultar `start --help` y `stop --help` de esa versión para sus opciones de ciclo de vida. No reutilizar el workaround histórico de analytics sin un fallo actual demostrado. La ausencia de migraciones S2 en la copia permite verificar S1 anterior de verdad.
- [ ] **Step 4: Capturar evidencia base sin contenido privado.** Consultar conteos/IDs/metadata y vectores sintéticos del seed; capturar hashes solo en memoria de las filas fixture S1 seleccionadas por IDs. Confirmar las tablas S2 ausentes, bucket documents privado y permisos S1. No adjuntar claves, status crudo ni texto de documentos.
- [ ] **Step 5: Aplicar S2 desde la raíz original sobre ese stack descartable.** CLI `migration up --local --workdir raizOriginal`; comparar exactamente los snapshots S1 en memoria y ejecutar las pruebas SQL nuevas. Comprobar que no se añadieron grants promocionales reales ni se modificó bootstrap. La configuración conserva el mismo project_id dentro del runner aislado; no hay otro stack con ese nombre.
- [ ] **Step 6: Detener exclusivamente el stack creado por el runner.** En finally, si se registró ownership de creación, usar CLI stop del workspace temporal con la opción verificada de no conservar sus volúmenes. Ante error de arranque, verificar que el container pertenece al intento antes de detenerlo. No limpiar directorios recursivamente desde un path calculado; el runner de CI elimina sus archivos temporales al terminar. No capturar stderr de CLI con secretos en el acta.
- [x] **Step 7: Añadir step al quality job.**

```yaml
      - name: Verify S1 to S2 foundation upgrade
        run: node scripts/check-analysis-upgrade.mjs
```

Ubicarlo después de Unit tests y antes de Start disposable local Supabase. Conserva después el reset del stack descartable original, test:db, check:database-types, fixtures, integración, build y E2E S1. No añadir pagos/proveedores/correo, cambiar checks obligatorios ni ejecutar pipelines remotos desde esta implementación sin autorización de integración.
- [x] **Step 8: Ejecutar validación final local una sola vez sobre el candidato.**

```powershell
npx pnpm@12.5.1 lint
npx pnpm@12.5.1 typecheck
npx pnpm@12.5.1 test:unit
npx pnpm@12.5.1 test:db
npx pnpm@12.5.1 check:database-types
npx pnpm@12.5.1 test:fixtures
npx pnpm@12.5.1 test:integration
node scripts/with-local-supabase.mjs build
git -c core.whitespace=cr-at-eol diff --check
```

No ejecutar el runner destructivo de upgrade contra el stack del usuario. El clean install y upgrade son del CI descartable. Como regresión local de permisos sobre flujos existentes, ejecutar los E2E de Auth y Repository mediante `node scripts/with-local-supabase.mjs e2e tests/e2e/auth tests/e2e/repository.spec.ts tests/e2e/repository-filters.spec.ts`; el CI conserva además la suite S1 completa.

- [x] **Step 9: Completar acta con resultados reales.** Registrar revisión de consumidores, checkout/SHA candidato, rutas exactas de migraciones, comandos, estados de tests, pruebas concurrentes y diferencias de tipos/permisos. Distinguir evidencia local, CI y entorno publicado; no llamar E2E S2 a estas pruebas. Si aún no hay una ejecución CI del candidato por faltar autorización de publicación, marcar ese criterio pendiente y reportar únicamente la aceptación local conseguida.
- [x] **Step 10: Revisar diff final por ownership y alcance.** Únicamente archivos de este plan; sin .env, snippets ajenos, caches ni versiones del modelo. No hacer commit/push/merge por defecto. Integración y edición externa del ticket requieren su propio alcance autorizado.

**Salida revisable:** base aceptada localmente y evidencia de clean/upgrade en CI cuando se publique el candidato; cualquier revisión de consumidores o gate faltante permanece visible.

## Cobertura y revisión del plan

| Spec | Tarea |
|---|---|
| Objetivo, ownership y cierre independiente | Global Constraints, tareas 1 y 7 |
| Contratos públicos/internos, errores y fixtures | 1 |
| Seis tablas, enums, FK, índices y tipos | 2 |
| Alcance máximo/mínimo y evidencia exacta | 3 y 6 |
| Ledger append-only y unicidades | 2 y 4 |
| RLS, columnas internas y publicación completed | 4 y 5 |
| Unicode y referencias históricas | 3 |
| HTTP, roles reales y Profile persistido | 5 |
| Concurrencia commit/rollback | 6 |
| Instalación limpia, upgrade y regresiones S1 | 7 |
| Revisión de consumidores y evidencia | 1 y 7 |

Se revisaron cobertura, nombres entre tareas, ausencia de pasos vacíos y los cinco casos de Review Focus. El plan no implementa saldo, inferencia, worker, finalización contable o correo. No necesita una dependencia nueva ni un cambio de arquitectura del PRD.

## Ejecución y estado

El usuario autorizó la ejecución inline en `feature/analysis_schema_contracts`. La implementación y las verificaciones locales terminaron; el runner S1→S2 no se ejecutó sobre el stack local existente y requiere una corrida del workflow CI descartable. La revisión de consumidores S2 sigue pendiente porque no hay consumidores implementados ni propietarios disponibles en este checkout. No se hizo commit, push, merge, despliegue ni migración remota.
