# Technical Design: S2-03 Authorized Document Selection & Comparison Scope

- **Ticket Code:** S2-03
- **Linear Issue:** SAA-15
- **Responsible Developer:** Juan Pablo Castaño Arango (Dev 3)
- **Status:** Approved Design
- **Date:** 2026-10-11
- **Target Release:** Sprint 2 — AI Analysis v0.2

---

## 1. Executive Summary & User Story

### 1.1 Context
In Sprint 2 (AI Analysis v0.2), Knowledge Decay Monitor delivers its core value proposition: identifying contradictions and obsolescence across private documentation. Before running an AI analysis, users must select which documents will serve as the primary sources to analyze (*"Documents to analyze"*) and which documents will serve as the comparative baseline (*"Compare against"*).

### 1.2 User Story
* **As a** QA Lead (or Admin)
* **I want to** select source documents and comparison documents
* **So that** I control exactly which documentation participates in the AI contradiction and obsolescence analysis.

### 1.3 Key Invariants & Acceptance Criteria (DoD)
1. **Authorized Access:** The Run Analysis selection UI is strictly restricted to `Admin` and `QA Lead` roles within verified workspace sessions. `Member` roles and unauthenticated users are denied (`FORBIDDEN` / `UNAUTHENTICATED`).
2. **Strict Eligibility Filter:** The backend selection query returns exclusively versions in `active` + `ready` state from the verified tenant session. Versions marked with `analysis_status = 'pending_reanalysis'` remain fully eligible. Historical versions, `rejected`, `pending_approval`, `uploaded`, `processing`, and `processing_failed` versions are strictly excluded.
3. **Search & Filter Parity:** Provides non-semantic name search (with escaped LIKE literals) and category/owner filters reusing repository presentation conventions. Counters and options stay within the tenant boundary.
4. **Source & Comparison Cardinality:**
   * At least one source version is required (`sources.length >= 1`).
   * Comparison version list can be empty (`comparisons.length === 0`) to trigger internal contradiction analysis within sources only. This is made explicit to the user in the UI.
   * Hard maximum of **20 distinct versions** in the union `sources ∪ comparisons`. A version present in both lists counts once toward this limit.
5. **Bulk Selection Rules:**
   * *"Select all filtered"*: Selects all authorized matching versions for the current active filter (across all pages). If the resulting union with existing selections exceeds 20, the operation is rejected with a controlled error without silent truncation.
   * *"Compare against entire repository"*: Only accepted if `total eligible repository versions ∪ sources <= 20`. Never silently samples a subset of the repository.
6. **Server Revalidation:** The server never trusts client-provided counts, lists, or flags. All version IDs are revalidated for tenant ownership, eligibility, and union limit <= 20 before progression.
7. **Estimate Invalidation:** Any mutation to source or comparison selection invalidates previous estimates and forces recalculation.
8. **Decoupled Projections:** The general Repository view continues to show all documents (including failed or in-flight processing versions), whereas the Analysis Selector queries a dedicated projection returning only `active` + `ready` documents.

---

## 2. Architecture & Module Design

### 2.1 Monolithic Modular Architecture
Following the architecture defined in `AGENTS.md` and `docs/architecture/arquitectura-base.md`, the implementation introduces the `src/modules/analysis` module with clear separation of concerns:

```
src/
├── app/
│   └── (workspace)/
│       └── analysis/
│           └── run/
│               └── page.tsx              # Server Component route entry point
└── modules/
    └── analysis/
        ├── index.ts                      # Public module interface
        ├── schemas.ts                    # Zod schemas for query and selection validation
        ├── application/
        │   ├── analysis.actions.ts       # "use server" actions with session/actor checks
        │   └── analysis.service.ts       # Domain service implementing AnalysisApi selection methods
        ├── infrastructure/
        │   └── analysis.repository.ts    # Supabase queries over eligible_analysis_documents
        └── ui/
            ├── run-analysis-view.tsx         # Main client component container
            ├── document-selection-table.tsx  # Searchable, filterable, paginated selection table
            └── scope-summary-sidebar.tsx     # Sticky sidebar with union meter, lists, and estimate CTA
```

### 2.2 Public Contracts (`src/types/contracts.ts`)
The implementation satisfies and adheres to the existing contracts:
* `EligibleDocumentsQuery`: `{ name?: string; category?: DocumentCategory; ownerId?: string | null; page?: number; pageSize?: number; }`
* `AnalysisSelectionItem`: `{ documentId: string; versionId: string; versionNumber: number; name: string; category: DocumentCategory; owner: EligibleOwner | null; }`
* `AnalysisSelectionInput`: `{ sourceVersionIds: string[]; comparisonVersionIds: string[]; }`
* `AnalysisEstimate`: `{ sourceVersionIds: string[]; comparisonVersionIds: string[]; estimateRef: string; fixedCost: number; expiresAt: string; }`
* `AnalysisApi.listEligibleDocuments(query)`: returns `Promise<ActionResult<AnalysisPage<AnalysisSelectionItem>>>`.

---

## 3. Database Projection & Migrations

### 3.1 Dedicated SQL View: `eligible_analysis_documents`
A new versioned migration `supabase/migrations/20261011030000_s2_03_eligible_documents_projection.sql` creates the dedicated projection with `security_invoker = true`:

```sql
-- Migration: 20261011030000_s2_03_eligible_documents_projection.sql
-- S2-03: Projection of eligible active + ready documents for analysis scope selection.

create or replace view public.eligible_analysis_documents with (security_invoker = true) as
select
  d.id as document_id,
  d.workspace_id,
  d.name,
  d.category,
  d.owner_id,
  p.id as owner_profile_id,
  p.full_name as owner_full_name,
  v.id as version_id,
  v.version_number,
  v.analysis_status,
  d.created_at
from public.documents d
inner join public.document_versions v
  on d.active_version_id = v.id and d.workspace_id = v.workspace_id
left join public.profiles p
  on p.id = d.owner_id and p.workspace_id = d.workspace_id
where v.version_status = 'active'
  and v.processing_status = 'ready';

revoke all on public.eligible_analysis_documents from public, anon, authenticated;
grant select on public.eligible_analysis_documents to authenticated;

comment on view public.eligible_analysis_documents is
  'Projects only active and ready document versions for authorized analysis scope selection under tenant RLS.';

notify pgrst, 'reload schema';
```

### 3.2 RLS & Tenant Isolation
Because `security_invoker = true` is enabled, queries executed by authenticated clients inherit the existing row-level security policies on `public.documents` and `public.document_versions`. Multi-tenant isolation is guaranteed at the database level:
* A user in Workspace A cannot retrieve rows for Workspace B.
* `Member` role users lack select permissions on `document_versions` in S1/S2 and receive zero rows from the view.

---

## 4. Application & Domain Service Layer

### 4.1 Zod Schemas (`src/modules/analysis/schemas.ts`)
```typescript
import { z } from "zod";

export const eligibleDocumentsQuerySchema = z.object({
  name: z.string().max(200).trim().optional(),
  category: z.enum(["policy", "procedure", "manual", "specification", "other"] as const).optional(),
  ownerId: z.union([z.string().uuid(), z.null()]).optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
});

export const analysisSelectionInputSchema = z.object({
  sourceVersionIds: z.array(z.string().uuid()).min(1, "At least one source document is required."),
  comparisonVersionIds: z.array(z.string().uuid()).default([]),
});

export const resolveFilteredScopeSchema = z.object({
  query: eligibleDocumentsQuerySchema,
  currentOtherListVersionIds: z.array(z.string().uuid()).default([]),
});
```

### 4.2 Repository Layer (`src/modules/analysis/infrastructure/analysis.repository.ts`)
* `findEligibleDocuments(supabase, query)`: Queries `eligible_analysis_documents` with:
  * Name filter via `ilike("name", `%${escapeLikeLiteral(name)}%`)`.
  * Category equality check.
  * Owner equality check or `is("owner_id", null)`.
  * Pagination using `.range(from, to)` with exact count (`count: "exact"`). Handles PostgREST `PGRST103` when requesting a range beyond total rows.
* `resolveEligibleVersionIds(supabase, query)`: Returns array of `{ version_id: string }` matching the filters.
* `verifyVersionsEligibility(supabase, versionIds: string[])`: Queries `eligible_analysis_documents` with `.in("version_id", versionIds)` to confirm all IDs exist and are active + ready within the caller's workspace.

### 4.3 Server Actions (`src/modules/analysis/application/analysis.actions.ts`)
* `listEligibleDocumentsAction(query)`:
  * Verifies actor with `await requireDocumentActor()`.
  * Validates query with `eligibleDocumentsQuerySchema`.
  * Executes `findEligibleDocuments` and returns `ActionResult<AnalysisPage<AnalysisSelectionItem>>`.
* `resolveFilteredScopeAction(input)`:
  * Validates input with `resolveFilteredScopeSchema`.
  * Resolves matching version IDs.
  * Calculates `newUnion = new Set([...currentOtherListVersionIds, ...resolvedVersionIds])`.
  * If `newUnion.size > 20`: Returns `{ ok: false, error: { code: "INVALID_INPUT", message: `The filtered selection contains ${resolvedVersionIds.length} versions, which exceeds the maximum limit of 20 distinct versions.` } }`.
  * Otherwise returns `{ ok: true, data: { versionIds: resolvedVersionIds } }`.
* `validateAnalysisScopeAction(input)`:
  * Validates input with `analysisSelectionInputSchema`.
  * Computes unique union `distinctVersionIds = Array.from(new Set([...input.sourceVersionIds, ...input.comparisonVersionIds]))`.
  * If `distinctVersionIds.length > 20`: Returns `INVALID_INPUT` error.
  * Verifies eligibility of all distinct IDs in database. If count mismatch: Returns `INVALID_INPUT` ("One or more selected documents are not eligible for analysis.").
  * Returns validation success metadata (`distinctCount`, `sourcesCount`, `comparisonsCount`, `isInternalOnly`).
* `estimateAnalysisMockAction(input)`:
  * Provides simulated `AnalysisEstimate` contract implementation for S2-03 independent testing (to be wired to S2-04 in full integration):
  * `fixedCost = Math.ceil(1 + distinctCount * 0.05 + 5 * 0.20)`.

### 4.4 Implementation Review Correction (2026-10-11)

The initial `currentOtherListVersionIds` example above is insufficient: it does not count already-selected versions in the list being bulk-updated, and it trusts client-supplied IDs. The implemented action instead receives `targetRole`, `currentSourceVersionIds`, and `currentComparisonVersionIds`; it revalidates the union of current IDs against the caller's tenant-scoped eligible projection, adds the resolved filtered IDs to the target role, and checks the complete resulting union before returning. The bounded repository query reads at most 21 matching IDs, which is enough to reject any scope overflow without silently accepting a PostgREST-truncated result.
  * Returns opaque `estimateRef` and `expiresAt` (5 minutes).

---

## 5. User Interface & Interaction Flow

### 5.1 Route Entry Point (`src/app/(workspace)/analysis/run/page.tsx`)
* Server component verifying `requireDocumentActor()`.
* Loads initial page of eligible documents and workspace owners via `listEligibleOwners()`.
* Renders `RunAnalysisView`.
* Entry point link added to `src/app/(workspace)/repository/page.tsx` header for Admin and QA Lead.

### 5.2 Client Components
* **`RunAnalysisView`:**
  * Coordinates step state (`activeTab: "sources" | "comparisons"`).
  * Stores `sourceVersionIds: Set<string>` and `comparisonVersionIds: Set<string>`.
  * Manages `estimate: AnalysisEstimate | null` and resets it on any set modification.
* **`DocumentSelectionTable`:**
  * Includes text search with debounce, category select, owner select.
  * Table columns: Checkbox, Name + Version badge, Category badge, Owner, Dual-role badge (`"Also in Comparisons"` or `"Also in Sources"`).
  * Action bar:
    * In Step 1: *"Select all filtered"*, *"Clear sources"*.
    * In Step 2: *"Analyze internal contradictions only"* toggle, *"Compare against entire repository"* button, *"Select all filtered"*.
* **`ScopeSummarySidebar`:**
  * **Union Counter Meter:** Shows `X / 20 distinct versions` with visual progress bar.
  * **Selected Items Lists:** Expandable lists for Sources and Comparisons with document title, version number, and quick `✕` remove button.
  * **Internal Only Banner:** Displayed when comparisons is empty: *"No comparison documents selected. Running internal contradiction analysis only."*
  * **Cost Estimation Card:** Button to calculate estimate, displaying `"Estimated cost: X credits"` without exposing chunk/pair internals.
  * **Proceed CTA:** Enabled when scope is valid and estimated.

---

## 6. Error Handling & Privacy

### 6.1 Controlled Error Codes & Messages
* `UNAUTHENTICATED`: `"Please sign in to access analysis."`
* `FORBIDDEN`: `"You don't have permission to perform document analysis."`
* `INVALID_INPUT`:
  * Zero sources: `"At least one source document is required."`
  * Limit exceeded: `"Analysis scope cannot exceed 20 distinct versions."`
  * Filter overflow: `"The filtered selection contains {N} versions, exceeding the maximum limit of 20 distinct versions."`
  * Ineligible versions: `"One or more selected documents are not eligible for analysis."`
* `INTERNAL_ERROR`: `"We couldn't prepare the analysis scope. Please try again."` with UUID correlation ID logged via `captureOperationFailure`.

### 6.2 Privacy & Telemetry Guarantees
* No document text, chunk content, embeddings, or signed URLs are emitted in telemetry, Sentry events, or user-facing errors.
* Telemetry captures only module (`"analysis"`), operation (`"selection" | "scope_validation"`), and error code.

---

## 7. Verification & Testing Plan

### 7.1 Vitest Unit Tests (`tests/unit/`)
1. **`analysis-selection-schemas.test.ts`:**
   * Validates query defaults (`page: 1`, `pageSize: 25`).
   * Rejects negative pages, overflow page sizes ($> 100$), malformed UUIDs.
   * Validates `analysisSelectionInputSchema` requires at least 1 source and allows 0 comparisons.
2. **`analysis-scope-service.test.ts`:**
   * Scope union calculation: verifies overlapping IDs between sources and comparisons count once.
   * 20 vs 21 boundary check: 20 distinct versions pass, 21 distinct versions fail.
   * Zero comparisons: verified as valid internal-only contradiction scope.
   * `pending_reanalysis`: verified as eligible.
   * Estimate reset: verified to invalidate upon scope modification.

### 7.2 Database & RLS Tests (`supabase/tests/database/`)
1. **`test_s2_03_eligible_documents_projection.sql`:**
   * Verifies `eligible_analysis_documents` returns strictly `active` + `ready` versions.
   * Verifies exclusion of `processing_failed`, `uploaded`, `processing`, and historical versions.
   * Verifies cross-tenant isolation (Workspace A cannot select Workspace B's documents).
   * Verifies Member role cannot read through projection.

### 7.3 Integration & Scenario Validation
* **BDD Scenario 1 (Select all filtered):** 12 matching eligible versions in a category across 2 pages $\to$ *"Select all filtered"* includes all 12 versions preserving IDs.
* **BDD Scenario 2 (Impedir alcance excesivo):** 21 distinct versions selected $\to$ rejected with controlled error without creating job or estimate.
* **BDD Scenario 3 (Internal contradiction only):** 1 source, 0 comparisons $\to$ accepted as valid internal-only scope.
