# S2-03 Authorized Document Selection & Comparison Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Build the authorized document selection UI and backend service for AI Analysis, allowing Admin and QA Lead to select source documents and comparison documents with strict eligibility filtering (`active` + `ready`), tenant isolation, and a 20 distinct version union limit.

**Architecture:** Monolith-modular architecture creating `src/modules/analysis`. A dedicated PostgreSQL view with `security_invoker = true` (`eligible_analysis_documents`) projects active/ready versions under RLS. Application services validate scope constraints and resolve bulk queries (*Select all filtered*, *Entire repository*), while a dual-tab Next.js client view with a sticky summary sidebar manages selection and invalidates estimates upon changes.

**Tech Stack:** Next.js 15 (App Router), React 19, TypeScript (strict), Tailwind CSS, Supabase (PostgreSQL, RLS, PostgREST), Zod, Vitest.

**Spec:** [`docs/superpowers/specs/2026-10-11-s2-03-document-selection-and-comparison-scope-design.md`](file:///C:/Users/Juan%20Pablo%20Casta%C3%B1o%20A/Downloads/PROYECTOS%202026/knowledge-decay-monitor/docs/superpowers/specs/2026-10-11-s2-03-document-selection-and-comparison-scope-design.md)

---

## Global Constraints

- Language: UI labels, badges, and user-facing messages must be in English.
- Roles: Only `Admin` and `QA Lead` can access analysis selection or invoke analysis queries; `Member` is denied with `FORBIDDEN`.
- Eligibility: Only document versions in `active` + `ready` state are eligible (including `pending_reanalysis`). Historical, failed, processing, and pending versions are excluded.
- Union Limit: Union of distinct versions across sources and comparisons cannot exceed 20 (`distinctCount <= 20`).
- No Silent Truncation: Bulk selection exceeding 20 must return a controlled error, never a silent subset.
- Minimum Sources: At least 1 source version is required. Comparison can be empty (internal contradiction mode).
- Estimate Invalidation: Any modification to sources or comparisons immediately invalidates any existing estimate.
- Privacy: No document text, chunks, embeddings, or signed URLs in telemetry, Sentry, or user-facing error messages.

## Review Focus

1. **Overlapping Document in Sources and Comparisons:** When the same version is selected as both a source and a comparison, it must count exactly once toward the 20-version union limit and display contextual badges.
2. **Bulk Filter Overflow (> 20 versions):** When *"Select all filtered"* matches more versions than the remaining budget or > 20 total, the action must abort with a controlled error message without modifying selections or silently taking the first 20.
3. **Internal Contradiction Only Mode (Zero Comparisons):** When 0 comparisons are selected and >= 1 source is present, the scope is valid, displays the internal contradiction notice, and allows proceeding.
4. **`Member` Role Access Block:** When an authenticated user with `role: "Member"` invokes the action or navigates to `/analysis/run`, access is strictly denied with `FORBIDDEN` and no document data is leaked.
5. **Cross-Tenant Version ID Tampering:** If a malicious user attempts to pass a valid `version_id` from another workspace in `sourceVersionIds` or `comparisonVersionIds`, server validation rejects it with `INVALID_INPUT` / `NOT_FOUND`.

---

## Tasks

### Task 1: Database Projection & RLS Policies (`eligible_analysis_documents`)

**Files:**
- Create: `supabase/migrations/20261011030000_s2_03_eligible_documents_projection.sql`
- Test: `supabase/tests/database/s2_03_eligible_documents_projection.test.sql`

**Interfaces:**
- Produces: View `public.eligible_analysis_documents (document_id, workspace_id, name, category, owner_id, owner_profile_id, owner_full_name, version_id, version_number, analysis_status, created_at)` with `security_invoker = true` and `grant select to authenticated`.

- [x] **Step 1: Write the failing SQL test**

Create `supabase/tests/database/s2_03_eligible_documents_projection.test.sql`:
```sql
begin;
select plan(5);

-- 1. View exists
select has_view('public', 'eligible_analysis_documents', 'eligible_analysis_documents view exists');

-- 2. Projects only active + ready versions
select results_eq(
  $$ select count(*)::integer from public.eligible_analysis_documents $$,
  $$ select count(*)::integer from public.document_versions v join public.documents d on d.active_version_id = v.id where v.version_status = 'active' and v.processing_status = 'ready' $$,
  'Projects only active and ready document versions'
);

-- 3. Excludes processing_failed and historical versions
select is_empty(
  $$ select * from public.eligible_analysis_documents where version_id in (select id from public.document_versions where processing_status = 'processing_failed' or version_status is distinct from 'active') $$,
  'Excludes failed, in-flight, and non-active versions'
);

-- 4. Cross-tenant isolation under security_invoker
select is(
  (select count(distinct workspace_id) from public.eligible_analysis_documents),
  (select count(distinct d.workspace_id) from public.documents d join public.document_versions v on d.active_version_id = v.id where v.version_status = 'active' and v.processing_status = 'ready'),
  'Maintains workspace tenant partitioning'
);

-- 5. Revoked from anon
select throws_ok(
  $$ set role anon; select * from public.eligible_analysis_documents; $$,
  '42501',
  null,
  'Anon cannot read eligible_analysis_documents'
);

select * from finish();
rollback;
```

- [x] **Step 2: Run SQL test to verify it fails**

Run: `pnpm test:db`
Expected: FAIL because view `eligible_analysis_documents` does not exist.

- [x] **Step 3: Implement `eligible_analysis_documents` migration**

Write `supabase/migrations/20261011030000_s2_03_eligible_documents_projection.sql`:
```sql
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

- [x] **Step 4: Run database tests to verify passing**

Run: `pnpm test:db`
Expected: PASS all 5 assertions.

- [x] **Step 5: Verify migration syntax and file structure**

Run: `pnpm typecheck`
Expected: PASS

---

### Task 2: Zod Schemas & Validation (`src/modules/analysis/schemas.ts`)

**Files:**
- Create: `src/modules/analysis/schemas.ts`
- Test: `tests/unit/analysis-selection-schemas.test.ts`

**Interfaces:**
- Produces:
  - `eligibleDocumentsQuerySchema`: Zod schema for query parsing and pagination limits.
  - `analysisSelectionInputSchema`: Zod schema for `sourceVersionIds` (min 1) and `comparisonVersionIds`.
  - `resolveFilteredScopeSchema`: Zod schema for bulk resolution requests.

- [x] **Step 1: Write the failing schema unit test**

Create `tests/unit/analysis-selection-schemas.test.ts`:
```typescript
import { describe, expect, it } from "vitest";
import {
  eligibleDocumentsQuerySchema,
  analysisSelectionInputSchema,
  resolveFilteredScopeSchema,
} from "../../src/modules/analysis/schemas";

describe("Analysis selection schemas", () => {
  it("defaults pagination, trims names, and accepts valid categories and ownerIds", () => {
    const parsed = eligibleDocumentsQuerySchema.parse({ name: "  Policy Doc  " });
    expect(parsed).toEqual({
      name: "Policy Doc",
      page: 1,
      pageSize: 25,
    });
  });

  it("rejects invalid page, zero pageSize, or excessively long name", () => {
    expect(eligibleDocumentsQuerySchema.safeParse({ page: 0 }).success).toBe(false);
    expect(eligibleDocumentsQuerySchema.safeParse({ pageSize: 0 }).success).toBe(false);
    expect(eligibleDocumentsQuerySchema.safeParse({ pageSize: 101 }).success).toBe(false);
    expect(eligibleDocumentsQuerySchema.safeParse({ name: "a".repeat(201) }).success).toBe(false);
  });

  it("requires at least one source document in analysisSelectionInputSchema", () => {
    const valid = analysisSelectionInputSchema.safeParse({
      sourceVersionIds: ["550e8400-e29b-41d4-a716-446655440000"],
      comparisonVersionIds: [],
    });
    expect(valid.success).toBe(true);

    const emptySources = analysisSelectionInputSchema.safeParse({
      sourceVersionIds: [],
      comparisonVersionIds: [],
    });
    expect(emptySources.success).toBe(false);
    if (!emptySources.success) {
      expect(emptySources.error.issues[0].message).toMatch(/At least one source document is required/i);
    }
  });

  it("rejects malformed UUIDs in sources or comparisons", () => {
    expect(
      analysisSelectionInputSchema.safeParse({
        sourceVersionIds: ["not-a-uuid"],
        comparisonVersionIds: [],
      }).success
    ).toBe(false);
  });

  it("validates resolveFilteredScopeSchema with defaults", () => {
    const parsed = resolveFilteredScopeSchema.parse({});
    expect(parsed.currentOtherListVersionIds).toEqual([]);
    expect(parsed.query).toEqual({ page: 1, pageSize: 25 });
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/unit/analysis-selection-schemas.test.ts`
Expected: FAIL ("Cannot find module '../../src/modules/analysis/schemas'")

- [x] **Step 3: Implement schemas in `src/modules/analysis/schemas.ts`**

Create `src/modules/analysis/schemas.ts`:
```typescript
import { z } from "zod";
import type { DocumentCategory } from "@/types/contracts";

const DOCUMENT_CATEGORIES: [DocumentCategory, ...DocumentCategory[]] = [
  "policy",
  "procedure",
  "manual",
  "specification",
  "other",
];

export const eligibleDocumentsQuerySchema = z.object({
  name: z.string().max(200).trim().optional(),
  category: z.enum(DOCUMENT_CATEGORIES).optional(),
  ownerId: z.union([z.string().uuid({ message: "Invalid owner ID." }), z.null()]).optional(),
  page: z.coerce.number().int().min(1, "Page must be at least 1.").default(1),
  pageSize: z.coerce.number().int().min(1).max(100, "Page size cannot exceed 100.").default(25),
});

export const analysisSelectionInputSchema = z.object({
  sourceVersionIds: z
    .array(z.string().uuid({ message: "Invalid source version ID." }))
    .min(1, "At least one source document is required."),
  comparisonVersionIds: z
    .array(z.string().uuid({ message: "Invalid comparison version ID." }))
    .default([]),
});

export const resolveFilteredScopeSchema = z.object({
  query: eligibleDocumentsQuerySchema.default({}),
  currentOtherListVersionIds: z
    .array(z.string().uuid({ message: "Invalid version ID." }))
    .default([]),
});
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/unit/analysis-selection-schemas.test.ts`
Expected: PASS

---

### Task 3: Infrastructure Repository Queries (`src/modules/analysis/infrastructure/analysis.repository.ts`)

**Files:**
- Create: `src/modules/analysis/infrastructure/analysis.repository.ts`
- Test: `tests/unit/analysis-repository.test.ts`

**Interfaces:**
- Consumes: Supabase client, `eligibleDocumentsQuerySchema`
- Produces:
  - `findEligibleDocuments(supabase, query)`
  - `resolveEligibleVersionIds(supabase, query)`
  - `verifyVersionsEligibility(supabase, versionIds)`

- [x] **Step 1: Write the failing repository unit test**

Create `tests/unit/analysis-repository.test.ts`:
```typescript
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  findEligibleDocuments,
  resolveEligibleVersionIds,
  verifyVersionsEligibility,
  escapeLikeLiteral,
} from "../../src/modules/analysis/infrastructure/analysis.repository";

function mockSupabase(data: unknown[], count: number | null = null, error: unknown = null) {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "order", "range", "ilike", "eq", "is", "in"]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve({ data, count: count ?? data.length, error }).then(resolve, reject);
  return {
    from: vi.fn(() => chain),
    _chain: chain,
  };
}

describe("Analysis infrastructure repository", () => {
  it("escapes LIKE special characters correctly", () => {
    expect(escapeLikeLiteral("100%_guideline")).toBe("100\\%\\_guideline");
  });

  it("escapes LIKE special characters and executes paginated query", async () => {
    const fakeRows = [
      {
        document_id: "doc-1",
        version_id: "ver-1",
        version_number: 1,
        name: "Security Guide 100%",
        category: "policy",
        owner_profile_id: "user-1",
        owner_full_name: "Alice",
        analysis_status: null,
        created_at: "2026-10-11T00:00:00Z",
      },
    ];
    const client = mockSupabase(fakeRows, 1);
    const result = await findEligibleDocuments(client as never, { name: "100%", page: 1, pageSize: 25 });

    expect(client.from).toHaveBeenCalledWith("eligible_analysis_documents");
    expect(result.data).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it("resolves matching version IDs for bulk filter selection", async () => {
    const client = mockSupabase([{ version_id: "ver-1" }, { version_id: "ver-2" }]);
    const ids = await resolveEligibleVersionIds(client as never, { category: "policy" });
    expect(ids).toEqual(["ver-1", "ver-2"]);
  });

  it("verifies eligibility of given version IDs in database", async () => {
    const client = mockSupabase([{ version_id: "ver-1" }, { version_id: "ver-2" }]);
    const eligibleIds = await verifyVersionsEligibility(client as never, ["ver-1", "ver-2"]);
    expect(eligibleIds).toEqual(["ver-1", "ver-2"]);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/unit/analysis-repository.test.ts`
Expected: FAIL ("Cannot find module '../../src/modules/analysis/infrastructure/analysis.repository'")

- [x] **Step 3: Implement `src/modules/analysis/infrastructure/analysis.repository.ts`**

Create `src/modules/analysis/infrastructure/analysis.repository.ts`:
```typescript
import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { EligibleDocumentsQuery } from "@/types/contracts";
import { eligibleDocumentsQuerySchema } from "../schemas";

type DbClient = SupabaseClient<Database>;

export function escapeLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

async function countEligibleDocuments(supabase: DbClient, query: EligibleDocumentsQuery) {
  let request = supabase
    .from("eligible_analysis_documents")
    .select("document_id", { count: "exact", head: true });

  if (query.name) request = request.ilike("name", `%${escapeLikeLiteral(query.name)}%`);
  if (query.category) request = request.eq("category", query.category);
  if (query.ownerId !== undefined) {
    request = query.ownerId === null ? request.is("owner_id", null) : request.eq("owner_id", query.ownerId);
  }

  return request;
}

export async function findEligibleDocuments(supabase: DbClient, query: EligibleDocumentsQuery) {
  const parsed = eligibleDocumentsQuerySchema.parse(query);
  const { page, pageSize } = parsed;
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let request = supabase
    .from("eligible_analysis_documents")
    .select(
      "document_id,name,category,owner_id,owner_profile_id,owner_full_name,version_id,version_number,analysis_status,created_at",
      { count: "exact" },
    )
    .order("created_at", { ascending: false })
    .order("document_id", { ascending: false })
    .range(from, to);

  if (parsed.name) request = request.ilike("name", `%${escapeLikeLiteral(parsed.name)}%`);
  if (parsed.category) request = request.eq("category", parsed.category);
  if (parsed.ownerId !== undefined) {
    request = parsed.ownerId === null ? request.is("owner_id", null) : request.eq("owner_id", parsed.ownerId);
  }

  const { data, error, count } = await request;
  if (error?.code === "PGRST103") {
    const { count: total, error: countError } = await countEligibleDocuments(supabase, parsed);
    if (countError) throw new Error("Eligible documents count query failed.");
    return { data: [], total: total ?? 0, page, pageSize };
  }
  if (error) throw new Error("Eligible documents query failed.");
  return { data: data ?? [], total: count ?? 0, page, pageSize };
}

export async function resolveEligibleVersionIds(supabase: DbClient, query: EligibleDocumentsQuery): Promise<string[]> {
  const parsed = eligibleDocumentsQuerySchema.parse(query);
  let request = supabase.from("eligible_analysis_documents").select("version_id");

  if (parsed.name) request = request.ilike("name", `%${escapeLikeLiteral(parsed.name)}%`);
  if (parsed.category) request = request.eq("category", parsed.category);
  if (parsed.ownerId !== undefined) {
    request = parsed.ownerId === null ? request.is("owner_id", null) : request.eq("owner_id", parsed.ownerId);
  }

  const { data, error } = await request;
  if (error) throw new Error("Failed to resolve eligible version IDs.");
  return (data ?? []).map((row: { version_id: string }) => row.version_id);
}

export async function verifyVersionsEligibility(supabase: DbClient, versionIds: string[]): Promise<string[]> {
  if (versionIds.length === 0) return [];
  const { data, error } = await supabase
    .from("eligible_analysis_documents")
    .select("version_id")
    .in("version_id", versionIds);
  if (error) throw new Error("Failed to verify version eligibility.");
  return (data ?? []).map((row: { version_id: string }) => row.version_id);
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/unit/analysis-repository.test.ts`
Expected: PASS

---

### Task 4: Application Domain Service & Server Actions (`src/modules/analysis/application/`)

**Files:**
- Create: `src/modules/analysis/application/analysis.service.ts`
- Create: `src/modules/analysis/application/analysis.actions.ts`
- Create: `src/modules/analysis/index.ts`
- Test: `tests/unit/analysis-scope-service.test.ts`

**Interfaces:**
- Consumes: `requireDocumentActor`, `createReadOnlyClient`, `analysis.repository.ts`, `schemas.ts`
- Produces:
  - `listEligibleDocumentsAction`
  - `resolveFilteredScopeAction`
  - `validateAnalysisScopeAction`
  - `estimateAnalysisAction`

- [x] **Step 1: Write the failing domain service unit test**

Create `tests/unit/analysis-scope-service.test.ts`:
```typescript
import { describe, expect, it } from "vitest";
import {
  calculateDistinctScopeUnion,
  validateScopeLimit,
  estimateAnalysisMock,
} from "../../src/modules/analysis/application/analysis.service";

describe("Analysis Scope Service", () => {
  it("counts overlapping documents in sources and comparisons exactly once", () => {
    const sources = ["doc-1", "doc-2"];
    const comparisons = ["doc-2", "doc-3"];
    const union = calculateDistinctScopeUnion(sources, comparisons);
    expect(union).toEqual(["doc-1", "doc-2", "doc-3"]);
    expect(union.length).toBe(3);
  });

  it("permits 20 distinct versions and rejects 21 distinct versions", () => {
    const pass20 = Array.from({ length: 20 }, (_, i) => `id-${i}`);
    expect(validateScopeLimit(pass20).ok).toBe(true);

    const fail21 = Array.from({ length: 21 }, (_, i) => `id-${i}`);
    const result = validateScopeLimit(fail21);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
      expect(result.error.message).toMatch(/exceeds the maximum limit of 20 distinct versions/i);
    }
  });

  it("handles empty comparison as valid internal-only scope", () => {
    const sources = ["id-1"];
    const comparisons: string[] = [];
    const union = calculateDistinctScopeUnion(sources, comparisons);
    expect(union).toEqual(["id-1"]);
    expect(validateScopeLimit(union).ok).toBe(true);
  });

  it("calculates mock estimate with opaque reference and positive cost", () => {
    const estimateResult = estimateAnalysisMock({
      sourceVersionIds: ["doc-1", "doc-2"],
      comparisonVersionIds: ["doc-3"],
    });
    expect(estimateResult.ok).toBe(true);
    if (estimateResult.ok) {
      expect(estimateResult.data.fixedCost).toBeGreaterThan(0);
      expect(estimateResult.data.estimateRef).toMatch(/^est_/);
      expect(estimateResult.data.sourceVersionIds).toHaveLength(2);
      expect(estimateResult.data.comparisonVersionIds).toHaveLength(1);
    }
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/unit/analysis-scope-service.test.ts`
Expected: FAIL ("Cannot find module '../../src/modules/analysis/application/analysis.service'")

- [x] **Step 3: Implement domain service and actions**

Create `src/modules/analysis/application/analysis.service.ts`:
```typescript
import type {
  ActionResult,
  AnalysisPage,
  AnalysisSelectionItem,
  EligibleDocumentsQuery,
  AnalysisSelectionInput,
  AnalysisEstimate,
} from "@/types/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import {
  findEligibleDocuments,
  resolveEligibleVersionIds,
  verifyVersionsEligibility,
} from "../infrastructure/analysis.repository";
import { eligibleDocumentsQuerySchema, analysisSelectionInputSchema } from "../schemas";

export function calculateDistinctScopeUnion(sources: string[], comparisons: string[]): string[] {
  return Array.from(new Set([...sources, ...comparisons]));
}

export function validateScopeLimit(distinctVersionIds: string[]): ActionResult<{ distinctCount: number }> {
  if (distinctVersionIds.length > 20) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: `Analysis scope contains ${distinctVersionIds.length} versions, which exceeds the maximum limit of 20 distinct versions.`,
      },
    };
  }
  return { ok: true, data: { distinctCount: distinctVersionIds.length } };
}

export async function listEligibleDocumentsService(
  supabase: SupabaseClient<Database>,
  query: EligibleDocumentsQuery,
): Promise<ActionResult<AnalysisPage<AnalysisSelectionItem>>> {
  const parsed = eligibleDocumentsQuerySchema.safeParse(query);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "INVALID_INPUT", message: "The document query filters are invalid." },
    };
  }
  try {
    const result = await findEligibleDocuments(supabase, parsed.data);
    const items: AnalysisSelectionItem[] = result.data.map((row) => ({
      documentId: row.document_id,
      versionId: row.version_id,
      versionNumber: row.version_number,
      name: row.name,
      category: row.category,
      owner: row.owner_profile_id ? { id: row.owner_profile_id, fullName: row.owner_full_name } : null,
    }));
    return {
      ok: true,
      data: {
        items,
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
      },
    };
  } catch {
    return {
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "We couldn't retrieve eligible documents. Please try again." },
    };
  }
}

export async function resolveFilteredScopeService(
  supabase: SupabaseClient<Database>,
  query: EligibleDocumentsQuery,
  currentOtherListVersionIds: string[],
): Promise<ActionResult<{ versionIds: string[]; totalUnion: number }>> {
  try {
    const resolvedIds = await resolveEligibleVersionIds(supabase, query);
    const combinedUnion = calculateDistinctScopeUnion(resolvedIds, currentOtherListVersionIds);
    if (combinedUnion.length > 20) {
      return {
        ok: false,
        error: {
          code: "INVALID_INPUT",
          message: `The filtered selection contains ${resolvedIds.length} versions, which would result in ${combinedUnion.length} total versions (exceeding the limit of 20).`,
        },
      };
    }
    return { ok: true, data: { versionIds: resolvedIds, totalUnion: combinedUnion.length } };
  } catch {
    return {
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "Failed to resolve filtered documents." },
    };
  }
}

export async function validateAnalysisScopeService(
  supabase: SupabaseClient<Database>,
  input: AnalysisSelectionInput,
): Promise<ActionResult<{ distinctCount: number; isInternalOnly: boolean }>> {
  const parsed = analysisSelectionInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "INVALID_INPUT", message: parsed.error.issues[0]?.message ?? "Invalid selection." },
    };
  }
  const distinctIds = calculateDistinctScopeUnion(parsed.data.sourceVersionIds, parsed.data.comparisonVersionIds);
  const limitCheck = validateScopeLimit(distinctIds);
  if (!limitCheck.ok) return limitCheck;

  try {
    const validIds = await verifyVersionsEligibility(supabase, distinctIds);
    if (validIds.length !== distinctIds.length) {
      return {
        ok: false,
        error: { code: "INVALID_INPUT", message: "One or more selected documents are not eligible for analysis." },
      };
    }
    return {
      ok: true,
      data: {
        distinctCount: distinctIds.length,
        isInternalOnly: parsed.data.comparisonVersionIds.length === 0,
      },
    };
  } catch {
    return {
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "Failed to validate analysis scope." },
    };
  }
}

export function estimateAnalysisMock(input: AnalysisSelectionInput): ActionResult<AnalysisEstimate> {
  const distinctIds = calculateDistinctScopeUnion(input.sourceVersionIds, input.comparisonVersionIds);
  const simulatedCost = Math.max(1, Math.ceil(1 + distinctIds.length * 0.5));
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  return {
    ok: true,
    data: {
      sourceVersionIds: input.sourceVersionIds,
      comparisonVersionIds: input.comparisonVersionIds,
      estimateRef: `est_${crypto.randomUUID()}`,
      fixedCost: simulatedCost,
      expiresAt,
    },
  };
}
```

Create `src/modules/analysis/application/analysis.actions.ts`:
```typescript
"use server";

import type {
  ActionResult,
  AnalysisPage,
  AnalysisSelectionItem,
  EligibleDocumentsQuery,
  AnalysisSelectionInput,
  AnalysisEstimate,
} from "@/types/contracts";
import { requireDocumentActor, IdentityError } from "@/modules/identity";
import { createReadOnlyClient } from "@/lib/supabase/server";
import {
  listEligibleDocumentsService,
  resolveFilteredScopeService,
  validateAnalysisScopeService,
  estimateAnalysisMock,
} from "./analysis.service";

function mapIdentityError(error: unknown): ActionResult<never> | null {
  if (error instanceof IdentityError) {
    const code = error.code === "WORKSPACE_REQUIRED" ? "FORBIDDEN" : error.code;
    return {
      ok: false,
      error: {
        code: code as "UNAUTHENTICATED" | "FORBIDDEN",
        message: code === "UNAUTHENTICATED" ? "Please sign in to access analysis." : "You don't have permission to perform document analysis.",
      },
    };
  }
  return null;
}

export async function listEligibleDocumentsAction(
  query: EligibleDocumentsQuery = {},
): Promise<ActionResult<AnalysisPage<AnalysisSelectionItem>>> {
  try {
    await requireDocumentActor();
    const supabase = await createReadOnlyClient();
    return await listEligibleDocumentsService(supabase, query);
  } catch (error) {
    const mapped = mapIdentityError(error);
    if (mapped) return mapped;
    return { ok: false, error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." } };
  }
}

export async function resolveFilteredScopeAction(
  query: EligibleDocumentsQuery,
  currentOtherListVersionIds: string[],
): Promise<ActionResult<{ versionIds: string[]; totalUnion: number }>> {
  try {
    await requireDocumentActor();
    const supabase = await createReadOnlyClient();
    return await resolveFilteredScopeService(supabase, query, currentOtherListVersionIds);
  } catch (error) {
    const mapped = mapIdentityError(error);
    if (mapped) return mapped;
    return { ok: false, error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." } };
  }
}

export async function validateAnalysisScopeAction(
  input: AnalysisSelectionInput,
): Promise<ActionResult<{ distinctCount: number; isInternalOnly: boolean }>> {
  try {
    await requireDocumentActor();
    const supabase = await createReadOnlyClient();
    return await validateAnalysisScopeService(supabase, input);
  } catch (error) {
    const mapped = mapIdentityError(error);
    if (mapped) return mapped;
    return { ok: false, error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." } };
  }
}

export async function estimateAnalysisAction(
  input: AnalysisSelectionInput,
): Promise<ActionResult<AnalysisEstimate>> {
  try {
    await requireDocumentActor();
    const supabase = await createReadOnlyClient();
    const validation = await validateAnalysisScopeService(supabase, input);
    if (!validation.ok) return validation;
    return estimateAnalysisMock(input);
  } catch (error) {
    const mapped = mapIdentityError(error);
    if (mapped) return mapped;
    return { ok: false, error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." } };
  }
}
```

Create `src/modules/analysis/index.ts`:
```typescript
export {
  listEligibleDocumentsAction,
  resolveFilteredScopeAction,
  validateAnalysisScopeAction,
  estimateAnalysisAction,
} from "./application/analysis.actions";

export {
  calculateDistinctScopeUnion,
  validateScopeLimit,
} from "./application/analysis.service";

export {
  eligibleDocumentsQuerySchema,
  analysisSelectionInputSchema,
} from "./schemas";
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/unit/analysis-scope-service.test.ts`
Expected: PASS

---

### Task 5: Document Selection Table Component (`src/modules/analysis/ui/document-selection-table.tsx`)

**Files:**
- Create: `src/modules/analysis/ui/document-selection-table.tsx`
- Test: `tests/unit/document-selection-table.test.tsx`

**Interfaces:**
- Consumes: `AnalysisSelectionItem`, `DocumentCategory`, `EligibleOwner`
- Produces: `DocumentSelectionTable` component with search, filtering, table checkboxes, dual-role badges, and pagination.

- [x] **Step 1: Write the failing table unit test**

Create `tests/unit/document-selection-table.test.tsx`:
```typescript
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { DocumentSelectionTable } from "../../src/modules/analysis/ui/document-selection-table";
import type { AnalysisSelectionItem } from "@/types/contracts";

const testItems: AnalysisSelectionItem[] = [
  {
    documentId: "doc-1",
    versionId: "ver-1",
    versionNumber: 1,
    name: "Engineering Policy",
    category: "policy",
    owner: { id: "user-1", fullName: "Alice" },
  },
  {
    documentId: "doc-2",
    versionId: "ver-2",
    versionNumber: 2,
    name: "QA Runbook",
    category: "manual",
    owner: null,
  },
];

describe("DocumentSelectionTable Component", () => {
  it("renders search, category selector, table rows and badges", () => {
    render(
      <DocumentSelectionTable
        items={testItems}
        total={2}
        page={1}
        pageSize={25}
        selectedVersionIds={new Set(["ver-1"])}
        otherListVersionIds={new Set(["ver-1"])}
        onToggleVersion={vi.fn()}
        onSelectAllFiltered={vi.fn()}
        onClearSelection={vi.fn()}
        onPageChange={vi.fn()}
        onFilterChange={vi.fn()}
        stepRole="source"
        eligibleOwners={[{ id: "user-1", fullName: "Alice" }]}
      />
    );

    expect(screen.getByPlaceholderText(/search documents by name/i)).toBeDefined();
    expect(screen.getByText("Engineering Policy")).toBeDefined();
    expect(screen.getByText("QA Runbook")).toBeDefined();
    // Contextual badge for item also in the other list
    expect(screen.getByText(/Also in Comparisons/i)).toBeDefined();
  });

  it("triggers onToggleVersion when clicking a row checkbox", () => {
    const handleToggle = vi.fn();
    render(
      <DocumentSelectionTable
        items={testItems}
        total={2}
        page={1}
        pageSize={25}
        selectedVersionIds={new Set()}
        otherListVersionIds={new Set()}
        onToggleVersion={handleToggle}
        onSelectAllFiltered={vi.fn()}
        onClearSelection={vi.fn()}
        onPageChange={vi.fn()}
        onFilterChange={vi.fn()}
        stepRole="source"
        eligibleOwners={[]}
      />
    );
    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[0]);
    expect(handleToggle).toHaveBeenCalledWith("ver-1");
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/unit/document-selection-table.test.tsx`
Expected: FAIL ("Cannot find module '../../src/modules/analysis/ui/document-selection-table'")

- [x] **Step 3: Implement `DocumentSelectionTable`**

Create `src/modules/analysis/ui/document-selection-table.tsx`:
```typescript
"use client";

import React from "react";
import type { AnalysisSelectionItem, DocumentCategory } from "@/types/contracts";

interface DocumentSelectionTableProps {
  items: AnalysisSelectionItem[];
  total: number;
  page: number;
  pageSize: number;
  selectedVersionIds: Set<string>;
  otherListVersionIds: Set<string>;
  onToggleVersion: (versionId: string) => void;
  onSelectAllFiltered: () => void;
  onClearSelection: () => void;
  onPageChange: (newPage: number) => void;
  onFilterChange: (filters: { name?: string; category?: DocumentCategory; ownerId?: string | null }) => void;
  stepRole: "source" | "comparison";
  eligibleOwners: Array<{ id: string; fullName: string }>;
  isBulkLoading?: boolean;
}

export function DocumentSelectionTable({
  items,
  total,
  page,
  pageSize,
  selectedVersionIds,
  otherListVersionIds,
  onToggleVersion,
  onSelectAllFiltered,
  onClearSelection,
  onPageChange,
  onFilterChange,
  stepRole,
  eligibleOwners,
  isBulkLoading = false,
}: DocumentSelectionTableProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="flex flex-col gap-4">
      {/* Filter and Search Bar */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <input
          type="text"
          placeholder="Search documents by name…"
          onChange={(e) => onFilterChange({ name: e.target.value })}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-cyan-600 focus:outline-none focus:ring-1 focus:ring-cyan-600"
        />
        <select
          aria-label="Filter by category"
          onChange={(e) =>
            onFilterChange({ category: (e.target.value as DocumentCategory) || undefined })
          }
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-cyan-600 focus:outline-none focus:ring-1 focus:ring-cyan-600"
        >
          <option value="">All Categories</option>
          <option value="policy">Policy</option>
          <option value="procedure">Procedure</option>
          <option value="manual">Manual</option>
          <option value="specification">Specification</option>
          <option value="other">Other</option>
        </select>
        <select
          aria-label="Filter by owner"
          onChange={(e) => {
            const val = e.target.value;
            onFilterChange({ ownerId: val === "unassigned" ? null : val || undefined });
          }}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-cyan-600 focus:outline-none focus:ring-1 focus:ring-cyan-600"
        >
          <option value="">All Owners</option>
          <option value="unassigned">Unassigned</option>
          {eligibleOwners.map((owner) => (
            <option key={owner.id} value={owner.id}>
              {owner.fullName}
            </option>
          ))}
        </select>
      </div>

      {/* Action Bar */}
      <div className="flex items-center justify-between border-b border-slate-200 pb-3">
        <div className="text-sm text-slate-600">
          Showing <span className="font-semibold">{items.length}</span> of <span className="font-semibold">{total}</span> eligible documents
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onSelectAllFiltered}
            disabled={isBulkLoading || total === 0}
            className="rounded-md bg-cyan-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-cyan-800 disabled:opacity-50"
          >
            {isBulkLoading ? "Selecting…" : "Select all filtered"}
          </button>
          <button
            type="button"
            onClick={onClearSelection}
            disabled={selectedVersionIds.size === 0}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Clear selection
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
          <thead className="bg-slate-50 text-xs font-semibold uppercase text-slate-500">
            <tr>
              <th className="w-12 px-4 py-3 text-center">Select</th>
              <th className="px-4 py-3">Document Name</th>
              <th className="px-4 py-3">Category</th>
              <th className="px-4 py-3">Owner</th>
              <th className="px-4 py-3">Role Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.length === 0 ? (
              <tr>
                <td colSpan={5} className="p-8 text-center text-sm text-slate-500">
                  No eligible active documents match the filters.
                </td>
              </tr>
            ) : (
              items.map((item) => {
                const isSelected = selectedVersionIds.has(item.versionId);
                const isAlsoInOther = otherListVersionIds.has(item.versionId);

                return (
                  <tr key={item.versionId} className="hover:bg-slate-50">
                    <td className="px-4 py-3 text-center">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => onToggleVersion(item.versionId)}
                        className="h-4 w-4 rounded border-slate-300 text-cyan-700 focus:ring-cyan-600"
                        aria-label={`Select ${item.name}`}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-900">{item.name}</div>
                      <span className="text-xs text-slate-500">v{item.versionNumber}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700 capitalize">
                        {item.category}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {item.owner ? item.owner.fullName : <span className="italic text-slate-400">Unassigned</span>}
                    </td>
                    <td className="px-4 py-3">
                      {isAlsoInOther && (
                        <span className="rounded bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 border border-amber-200">
                          {stepRole === "source" ? "Also in Comparisons" : "Also in Sources"}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between pt-2">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
        >
          Previous
        </button>
        <span className="text-xs text-slate-600">
          Page {page} of {totalPages}
        </span>
        <button
          type="button"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </div>
  );
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/unit/document-selection-table.test.tsx`
Expected: PASS

---

### Task 6: Scope Summary Sidebar Component (`src/modules/analysis/ui/scope-summary-sidebar.tsx`)

**Files:**
- Create: `src/modules/analysis/ui/scope-summary-sidebar.tsx`
- Test: `tests/unit/scope-summary-sidebar.test.tsx`

**Interfaces:**
- Consumes: `AnalysisSelectionItem`, `AnalysisEstimate`
- Produces: `ScopeSummarySidebar` component with union count meter (X/20), sources and comparisons item list, remove handlers, internal contradiction notice, and estimate calculation CTA.

- [x] **Step 1: Write the failing sidebar unit test**

Create `tests/unit/scope-summary-sidebar.test.tsx`:
```typescript
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { ScopeSummarySidebar } from "../../src/modules/analysis/ui/scope-summary-sidebar";
import type { AnalysisSelectionItem } from "@/types/contracts";

const sourceItem: AnalysisSelectionItem = {
  documentId: "doc-1",
  versionId: "ver-1",
  versionNumber: 1,
  name: "Policy A",
  category: "policy",
  owner: null,
};

describe("ScopeSummarySidebar Component", () => {
  it("renders distinct versions count, source items, and internal contradiction note when comparison is empty", () => {
    render(
      <ScopeSummarySidebar
        sources={[sourceItem]}
        comparisons={[]}
        onRemoveSource={vi.fn()}
        onRemoveComparison={vi.fn()}
        estimate={null}
        onCalculateEstimate={vi.fn()}
        onProceedToRun={vi.fn()}
        isEstimating={false}
        validationError={null}
      />
    );

    expect(screen.getByText(/1 \/ 20 distinct versions/i)).toBeDefined();
    expect(screen.getByText("Policy A")).toBeDefined();
    expect(screen.getByText(/Running internal contradiction analysis only/i)).toBeDefined();
  });

  it("displays estimate cost when available and triggers calculate callback", () => {
    const handleCalculate = vi.fn();
    render(
      <ScopeSummarySidebar
        sources={[sourceItem]}
        comparisons={[]}
        onRemoveSource={vi.fn()}
        onRemoveComparison={vi.fn()}
        estimate={{
          sourceVersionIds: ["ver-1"],
          comparisonVersionIds: [],
          estimateRef: "est_123",
          fixedCost: 3,
          expiresAt: "2026-10-11T12:00:00Z",
        }}
        onCalculateEstimate={handleCalculate}
        onProceedToRun={vi.fn()}
        isEstimating={false}
        validationError={null}
      />
    );

    expect(screen.getByText(/Estimated cost: 3 credits/i)).toBeDefined();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/unit/scope-summary-sidebar.test.tsx`
Expected: FAIL ("Cannot find module '../../src/modules/analysis/ui/scope-summary-sidebar'")

- [x] **Step 3: Implement `ScopeSummarySidebar`**

Create `src/modules/analysis/ui/scope-summary-sidebar.tsx`:
```typescript
"use client";

import React from "react";
import type { AnalysisSelectionItem, AnalysisEstimate } from "@/types/contracts";

interface ScopeSummarySidebarProps {
  sources: AnalysisSelectionItem[];
  comparisons: AnalysisSelectionItem[];
  onRemoveSource: (versionId: string) => void;
  onRemoveComparison: (versionId: string) => void;
  estimate: AnalysisEstimate | null;
  onCalculateEstimate: () => void;
  onProceedToRun: () => void;
  isEstimating: boolean;
  validationError: string | null;
}

export function ScopeSummarySidebar({
  sources,
  comparisons,
  onRemoveSource,
  onRemoveComparison,
  estimate,
  onCalculateEstimate,
  onProceedToRun,
  isEstimating,
  validationError,
}: ScopeSummarySidebarProps) {
  const distinctIds = new Set([
    ...sources.map((s) => s.versionId),
    ...comparisons.map((c) => c.versionId),
  ]);
  const distinctCount = distinctIds.size;
  const isOverLimit = distinctCount > 20;
  const hasNoSources = sources.length === 0;
  const isInternalOnly = comparisons.length === 0 && sources.length > 0;

  return (
    <aside className="sticky top-6 flex flex-col gap-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      {/* Header & Counter */}
      <div>
        <h2 className="text-base font-semibold text-slate-900">Scope Summary</h2>
        <div className="mt-2 flex items-center justify-between text-sm">
          <span className="font-medium text-slate-600">Total Selection</span>
          <span className={`font-semibold ${isOverLimit ? "text-rose-600" : "text-cyan-900"}`}>
            {distinctCount} / 20 distinct versions
          </span>
        </div>
        {/* Progress bar */}
        <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-slate-100">
          <div
            className={`h-full transition-all duration-300 ${
              isOverLimit ? "bg-rose-500" : distinctCount >= 16 ? "bg-amber-500" : "bg-cyan-600"
            }`}
            style={{ width: `${Math.min(100, (distinctCount / 20) * 100)}%` }}
          />
        </div>
        <p className="mt-1.5 text-xs text-slate-400">
          Versions present in both lists count once toward the 20-version limit.
        </p>
      </div>

      {/* Validation Error Alert */}
      {validationError && (
        <div role="alert" className="rounded-lg bg-rose-50 p-3 text-xs text-rose-800 border border-rose-200">
          {validationError}
        </div>
      )}

      {/* Documents to Analyze List */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Documents to analyze ({sources.length})
        </h3>
        {sources.length === 0 ? (
          <p className="mt-1.5 text-xs italic text-slate-400">At least 1 source document required.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1.5 max-h-36 overflow-y-auto">
            {sources.map((item) => (
              <li
                key={item.versionId}
                className="flex items-center justify-between rounded bg-slate-50 px-2 py-1 text-xs text-slate-800"
              >
                <span className="truncate pr-2">{item.name} <span className="text-slate-400">v{item.versionNumber}</span></span>
                <button
                  type="button"
                  onClick={() => onRemoveSource(item.versionId)}
                  className="text-slate-400 hover:text-rose-600"
                  aria-label={`Remove ${item.name} from sources`}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Compare Against List */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Compare against ({comparisons.length})
        </h3>
        {comparisons.length === 0 ? (
          <div className="mt-1.5 rounded bg-cyan-50 p-2 text-xs text-cyan-900 border border-cyan-100">
            {hasNoSources
              ? "No comparisons selected."
              : "No comparison documents selected. Running internal contradiction analysis only."}
          </div>
        ) : (
          <ul className="mt-2 flex flex-col gap-1.5 max-h-36 overflow-y-auto">
            {comparisons.map((item) => (
              <li
                key={item.versionId}
                className="flex items-center justify-between rounded bg-slate-50 px-2 py-1 text-xs text-slate-800"
              >
                <span className="truncate pr-2">{item.name} <span className="text-slate-400">v{item.versionNumber}</span></span>
                <button
                  type="button"
                  onClick={() => onRemoveComparison(item.versionId)}
                  className="text-slate-400 hover:text-rose-600"
                  aria-label={`Remove ${item.name} from comparisons`}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Estimation Card */}
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-center">
        {estimate ? (
          <div>
            <span className="text-xs font-medium text-slate-500">Estimated Cost</span>
            <div className="mt-1 text-lg font-bold text-cyan-950">
              Estimated cost: {estimate.fixedCost} credits
            </div>
          </div>
        ) : (
          <div>
            <button
              type="button"
              disabled={hasNoSources || isOverLimit || isEstimating}
              onClick={onCalculateEstimate}
              className="w-full rounded-md bg-slate-800 py-2 text-xs font-semibold text-white hover:bg-slate-900 disabled:opacity-40"
            >
              {isEstimating ? "Calculating…" : "Calculate Estimated Cost"}
            </button>
            <p className="mt-1 text-xs text-slate-400">Recalculated whenever selection changes</p>
          </div>
        )}
      </div>

      {/* Proceed CTA */}
      <button
        type="button"
        disabled={hasNoSources || isOverLimit || !estimate}
        onClick={onProceedToRun}
        className="w-full rounded-lg bg-cyan-600 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-cyan-700 disabled:opacity-40"
      >
        Proceed to Run Analysis
      </button>
    </aside>
  );
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/unit/scope-summary-sidebar.test.tsx`
Expected: PASS

---

### Task 7: Container View & Route Integration (`/analysis/run`)

**Files:**
- Create: `src/modules/analysis/ui/run-analysis-view.tsx`
- Create: `src/app/(workspace)/analysis/run/page.tsx`
- Modify: `src/app/(workspace)/repository/page.tsx:50-70`
- Test: `tests/unit/run-analysis-view.test.tsx`

**Interfaces:**
- Consumes: `DocumentSelectionTable`, `ScopeSummarySidebar`, `resolveFilteredScopeAction`, `estimateAnalysisAction`, `listEligibleDocumentsAction`
- Produces: Integrated container view managing state sets, tab switching, and estimate invalidation.

- [x] **Step 1: Write the failing container unit test**

Create `tests/unit/run-analysis-view.test.tsx`:
```typescript
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { RunAnalysisView } from "../../src/modules/analysis/ui/run-analysis-view";
import type { AnalysisSelectionItem } from "@/types/contracts";

const testItems: AnalysisSelectionItem[] = [
  {
    documentId: "doc-1",
    versionId: "ver-1",
    versionNumber: 1,
    name: "Standard Protocol",
    category: "procedure",
    owner: { id: "u-1", fullName: "Bob" },
  },
  {
    documentId: "doc-2",
    versionId: "ver-2",
    versionNumber: 1,
    name: "Compliance Doc",
    category: "policy",
    owner: null,
  },
];

describe("RunAnalysisView Container", () => {
  it("allows switching between Steps 1 and 2 tabs", () => {
    render(
      <RunAnalysisView
        initialItems={testItems}
        initialTotal={2}
        eligibleOwners={[]}
      />
    );
    const step2Tab = screen.getByRole("tab", { name: /2\. Compare against/i });
    fireEvent.click(step2Tab);
    expect(step2Tab.getAttribute("aria-selected")).toBe("true");
  });

  it("invalidates estimate when adding a document to sources", () => {
    render(
      <RunAnalysisView
        initialItems={testItems}
        initialTotal={2}
        eligibleOwners={[]}
      />
    );
    const checkbox = screen.getAllByRole("checkbox")[0];
    fireEvent.click(checkbox);
    expect(screen.getByText(/1 \/ 20 distinct versions/i)).toBeDefined();
    // Calculate button is available when estimate is null
    expect(screen.getByRole("button", { name: /Calculate Estimated Cost/i })).toBeDefined();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/unit/run-analysis-view.test.tsx`
Expected: FAIL ("Cannot find module '../../src/modules/analysis/ui/run-analysis-view'")

- [x] **Step 3: Implement `RunAnalysisView` and `/analysis/run/page.tsx`**

Create `src/modules/analysis/ui/run-analysis-view.tsx`:
```typescript
"use client";

import React, { useState } from "react";
import type { AnalysisSelectionItem, AnalysisEstimate, DocumentCategory } from "@/types/contracts";
import { DocumentSelectionTable } from "./document-selection-table";
import { ScopeSummarySidebar } from "./scope-summary-sidebar";
import { resolveFilteredScopeAction, estimateAnalysisAction } from "../application/analysis.actions";

interface RunAnalysisViewProps {
  initialItems: AnalysisSelectionItem[];
  initialTotal: number;
  eligibleOwners: Array<{ id: string; fullName: string }>;
}

export function RunAnalysisView({
  initialItems,
  initialTotal,
  eligibleOwners,
}: RunAnalysisViewProps) {
  const [activeTab, setActiveTab] = useState<"sources" | "comparisons">("sources");
  const [items] = useState<AnalysisSelectionItem[]>(initialItems);
  const [selectedSources, setSelectedSources] = useState<Map<string, AnalysisSelectionItem>>(new Map());
  const [selectedComparisons, setSelectedComparisons] = useState<Map<string, AnalysisSelectionItem>>(new Map());
  const [estimate, setEstimate] = useState<AnalysisEstimate | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isEstimating, setIsEstimating] = useState(false);
  const [isBulkLoading, setIsBulkLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [currentFilters, setCurrentFilters] = useState<{
    name?: string;
    category?: DocumentCategory;
    ownerId?: string | null;
  }>({});

  const sourceVersionIds = new Set(selectedSources.keys());
  const comparisonVersionIds = new Set(selectedComparisons.keys());

  function toggleVersion(versionId: string) {
    setEstimate(null);
    setValidationError(null);
    const item = items.find((i) => i.versionId === versionId);
    if (!item) return;

    if (activeTab === "sources") {
      const next = new Map(selectedSources);
      if (next.has(versionId)) next.delete(versionId);
      else next.set(versionId, item);
      setSelectedSources(next);
    } else {
      const next = new Map(selectedComparisons);
      if (next.has(versionId)) next.delete(versionId);
      else next.set(versionId, item);
      setSelectedComparisons(next);
    }
  }

  async function handleSelectAllFiltered() {
    setIsBulkLoading(true);
    setValidationError(null);
    setEstimate(null);

    const otherListIds =
      activeTab === "sources"
        ? Array.from(comparisonVersionIds)
        : Array.from(sourceVersionIds);

    const result = await resolveFilteredScopeAction(
      { ...currentFilters, page: 1, pageSize: 100 },
      otherListIds
    );

    setIsBulkLoading(false);
    if (!result.ok) {
      setValidationError(result.error.message);
      return;
    }

    const matchingItems = items.filter((i) => result.data.versionIds.includes(i.versionId));
    if (activeTab === "sources") {
      const next = new Map(selectedSources);
      matchingItems.forEach((i) => next.set(i.versionId, i));
      setSelectedSources(next);
    } else {
      const next = new Map(selectedComparisons);
      matchingItems.forEach((i) => next.set(i.versionId, i));
      setSelectedComparisons(next);
    }
  }

  function handleClearSelection() {
    setEstimate(null);
    setValidationError(null);
    if (activeTab === "sources") setSelectedSources(new Map());
    else setSelectedComparisons(new Map());
  }

  async function handleCalculateEstimate() {
    setIsEstimating(true);
    setValidationError(null);
    const result = await estimateAnalysisAction({
      sourceVersionIds: Array.from(sourceVersionIds),
      comparisonVersionIds: Array.from(comparisonVersionIds),
    });
    setIsEstimating(false);
    if (!result.ok) {
      setValidationError(result.error.message);
      return;
    }
    setEstimate(result.data);
  }

  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_22rem]">
      <div className="flex flex-col gap-6">
        {/* Navigation Tabs */}
        <div className="flex border-b border-slate-200" role="tablist">
          <button
            role="tab"
            aria-selected={activeTab === "sources"}
            onClick={() => setActiveTab("sources")}
            className={`border-b-2 px-4 py-3 text-sm font-semibold transition-colors ${
              activeTab === "sources"
                ? "border-cyan-700 text-cyan-900"
                : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            1. Documents to analyze ({selectedSources.size})
          </button>
          <button
            role="tab"
            aria-selected={activeTab === "comparisons"}
            onClick={() => setActiveTab("comparisons")}
            className={`border-b-2 px-4 py-3 text-sm font-semibold transition-colors ${
              activeTab === "comparisons"
                ? "border-cyan-700 text-cyan-900"
                : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            2. Compare against ({selectedComparisons.size})
          </button>
        </div>

        {/* Tab Description */}
        <div className="text-xs text-slate-500">
          {activeTab === "sources" ? (
            <p>Select the baseline documents you want to analyze for decay, contradictions, or obsolescence.</p>
          ) : (
            <p>Optionally select comparative documents. If none are selected, analysis runs for internal contradictions only.</p>
          )}
        </div>

        {/* Document Selection Table */}
        <DocumentSelectionTable
          items={items}
          total={initialTotal}
          page={page}
          pageSize={25}
          selectedVersionIds={activeTab === "sources" ? sourceVersionIds : comparisonVersionIds}
          otherListVersionIds={activeTab === "sources" ? comparisonVersionIds : sourceVersionIds}
          onToggleVersion={toggleVersion}
          onSelectAllFiltered={handleSelectAllFiltered}
          onClearSelection={handleClearSelection}
          onPageChange={setPage}
          onFilterChange={(f) => setCurrentFilters((prev) => ({ ...prev, ...f }))}
          stepRole={activeTab === "sources" ? "source" : "comparison"}
          eligibleOwners={eligibleOwners}
          isBulkLoading={isBulkLoading}
        />
      </div>

      {/* Sidebar Summary */}
      <ScopeSummarySidebar
        sources={Array.from(selectedSources.values())}
        comparisons={Array.from(selectedComparisons.values())}
        onRemoveSource={(id) => {
          setEstimate(null);
          const next = new Map(selectedSources);
          next.delete(id);
          setSelectedSources(next);
        }}
        onRemoveComparison={(id) => {
          setEstimate(null);
          const next = new Map(selectedComparisons);
          next.delete(id);
          setSelectedComparisons(next);
        }}
        estimate={estimate}
        onCalculateEstimate={handleCalculateEstimate}
        onProceedToRun={() => {
          // Hooks into S2-09 confirmation flow
          window.alert("Proceeding to analysis confirmation (Ticket S2-09 integration).");
        }}
        isEstimating={isEstimating}
        validationError={validationError}
      />
    </div>
  );
}
```

Create `src/app/(workspace)/analysis/run/page.tsx`:
```typescript
import { requireDocumentActor } from "@/modules/identity";
import { listEligibleDocumentsAction } from "@/modules/analysis";
import { listEligibleOwners } from "@/modules/workspace";
import { RunAnalysisView } from "@/modules/analysis/ui/run-analysis-view";
import { OperationError } from "@/components/operation-error";

export const runtime = "nodejs";

export default async function RunAnalysisPage() {
  const actor = await requireDocumentActor().catch(() => null);

  if (!actor) {
    return (
      <div className="mx-auto w-full max-w-4xl p-6">
        <OperationError
          error={{
            code: "FORBIDDEN",
            message: "You don't have permission to perform document analysis.",
          }}
        />
      </div>
    );
  }

  const [docsResult, ownersResult] = await Promise.all([
    listEligibleDocumentsAction({ page: 1, pageSize: 25 }),
    listEligibleOwners(),
  ]);

  if (!docsResult.ok) {
    return (
      <div className="mx-auto w-full max-w-4xl p-6">
        <OperationError error={docsResult.error} />
      </div>
    );
  }

  const owners = ownersResult.ok ? ownersResult.data : [];

  return (
    <div className="mx-auto w-full max-w-7xl">
      <div className="mb-6">
        <h1 className="text-3xl font-semibold text-slate-900">Run Analysis</h1>
        <p className="mt-1 text-sm text-slate-600">
          Select documentation to analyze and compare for contradictions and obsolescence.
        </p>
      </div>

      <RunAnalysisView
        initialItems={docsResult.data.items}
        initialTotal={docsResult.data.total}
        eligibleOwners={owners}
      />
    </div>
  );
}
```

Modify `src/app/(workspace)/repository/page.tsx` around line 55 to add the "Run Analysis" CTA link:
```tsx
<div className="flex items-center justify-between">
  <div>
    <h1 className="text-3xl font-semibold text-slate-900">Repository</h1>
    <p className="mt-2 text-sm text-zinc-600">
      Documents available in your workspace
    </p>
  </div>
  {actor && (
    <a
      href="/analysis/run"
      className="rounded-lg bg-cyan-700 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-800 focus:outline-none focus:ring-2 focus:ring-cyan-600 focus:ring-offset-2"
    >
      Run Analysis
    </a>
  )}
</div>
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/unit/run-analysis-view.test.tsx`
Expected: PASS

---

### Task 8: Full Verification & Quality Gates

**Files:**
- Run test suites and static checks.

- [x] **Step 1: Run TypeScript Typecheck**

Run: `pnpm typecheck`
Expected: 0 errors.

- [x] **Step 2: Run ESLint**

Run: `pnpm lint`
Expected: 0 errors.

- [x] **Step 3: Run Full Vitest Suite**

Run: `pnpm exec vitest run`
Expected: All tests pass.

- [x] **Step 4: Run Database Tests**

Run: `pnpm test:db`
Expected: All database assertions pass.

---

## Current implementation review (2026-10-11)

The executable implementation supersedes earlier illustrative snippets in this plan in these points:

- Query categories match the persisted Repository values (`SOP`, `Policy`, `Manual`, `QA Process`, `Security`, `Engineering Guideline`, `Other`).
- Filtered bulk resolution receives the target role and both current lists, revalidates current IDs through the tenant-scoped eligible projection, and checks the resulting complete union before returning IDs. The repository probes at most 21 rows, enough to reject any overflow without PostgREST truncation.
- The owner and category filters combine; clearing one filter preserves the rest. "Compare against entire repository" ignores the active filters and remains available when they produce zero rows.
- Async selection and estimate responses are discarded when the scope changes while a request is in flight; missing rows between ID resolution and metadata loading abort the bulk operation instead of applying a partial scope.
- Projection tests run under authenticated Admin, Member, and anonymous roles, and explicitly cover `pending_reanalysis`.
- Internal errors include correlation IDs and identifier-only telemetry for the `analysis` module, including the real estimate operation.
- The earlier illustrative mock estimate snippets below are superseded: the UI action delegates to S2-04 and no mock estimate implementation remains in the application code.

## Execution Handoff

Implementation was resumed in the existing workspace. The selector, scope validation, server actions, database projection, and route are present. Filters and pagination now query each requested page; bulk selection resolves matching IDs and rejects overflow without partial selection. The 20-version limit counts overlap once, and comparison selection can use the entire eligible repository when it fits. The real S2-04 estimate is now wired through the same S2-03 scope guard.

Verification before S2-04 arrived: `pnpm typecheck`, `pnpm lint` (0 errors; 4 warnings in unrelated existing files), full Vitest (67 files/465 tests), and `pnpm test:db` (536 assertions, including the S2-03 projection test). The S2-03 selection implementation is complete. S2-09 confirmation/run remains a separate dependency.

## S2-04 Integration Review (2026-10-14)

- The S2-03 `estimateAnalysisAction` now preserves the S2-03 distinct-union and eligibility validation, then delegates to the persisted, session-scoped S2-04 `estimateAnalysis` action. The UI therefore displays the real fixed-cost estimate in all environments.
- Removed the development-only simulated estimate so no caller can mistake it for a persisted S2-04 estimate.
- Registered `analysis:estimate` in the closed telemetry catalog; failures now pass allowlist validation and retain the identifier-only event shape.
- Added focused tests for delegation, rejection before delegation when S2-03 scope validation fails, and the safe telemetry operation.
- Combined the S2-03 document-query schemas with S2-04's estimate schema after the merge exposed that the shared `schemas.ts` had been replaced; restored the public `analysis` barrel exports needed by the S2-03 route. The S2-04 action also enforces the 20-version distinct union itself, so direct calls cannot bypass the UI guard.
- S2-09's confirmation and run flow remains pending and is outside this selection/estimate integration.

Validation after integration: `pnpm typecheck` passed; `pnpm lint` passed with four existing warnings in unrelated test files; full Vitest passed (72 files, 507 tests); `git diff --check` passed. After restarting the computer, `pnpm test:db` passed with the default local Supabase ports (20 files, 577 tests). No remote database was used.
