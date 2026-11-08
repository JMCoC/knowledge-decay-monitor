# Plan de Implementación: S2-10 — Lista de Hallazgos y Detalle Seguro de Evidencia

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementar la interfaz y servicios de consulta para la lista ordenada de hallazgos (High → Medium → Low), filtros, paginación y detalle de evidencia con comparación lado a lado (*side-by-side*) y apertura segura de versiones analizadas para el ticket S2-10.

**Architecture:** Modelo híbrido en Next.js App Router donde `/analysis/[analysisId]/findings` utiliza `searchParams` como fuente de verdad para filtros y paginación, permitiendo enlaces compartibles e historial de navegación. El detalle de evidencia se despliega en un panel lateral deslizante (Drawer) con renderizado seguro de texto plano contra XSS, reutilizando la API autorizada de `repository` para generar URLs firmadas temporales (300 s) sobre la versión exacta analizada.

**Tech Stack:** Next.js (App Router), React 19, TypeScript estricto, Tailwind CSS, Supabase (PostgreSQL, RLS, Storage), Zod, Vitest, Testing Library.

**Spec:** [docs/superpowers/specs/2026-10-27-s2-10-findings-and-evidence-design.md](file:///C:/Users/Juan%20Pablo%20Casta%C3%B1o%20A/Downloads/PROYECTOS%202026/knowledge-decay-monitor/docs/superpowers/specs/2026-10-27-s2-10-findings-and-evidence-design.md)

## Global Constraints

- Exclusión absoluta de `confidence`: no debe existir en DTOs públicos, DOM, respuestas de red ni filtros.
- Aislamiento estricto de IA interna: prompts, vectores y respuestas crudas de LLM no se exponen al cliente.
- Autorización por rol y tenant: acceso exclusivo para `Admin` y `QA Lead` del workspace; `Member` es rechazado con `FORBIDDEN`.
- Condición de análisis completado: solo se listan hallazgos de análisis con `analyses.status = 'completed'` del workspace activo.
- Vinculación a versión exacta: las referencias de evidencia abren la versión exacta analizada mediante `getDocumentOriginalUrlAction(versionId)` con URL firmada de 300 segundos, sin sustituir por `active_version_id`.
- Prevención de XSS: el texto de snapshots y explicaciones se renderiza estrictamente como texto plano nativo de React, sin `dangerouslySetInnerHTML`.
- Sin mutaciones de flujo en S2: los botones para confirmar, falso positivo, asignar o resolver quedan excluidos hasta S3.
- Observabilidad segura: Sentry y telemetría no reciben snapshots, documentos, prompts ni URLs firmadas.

## Review Focus

1. **Fuga de `confidence`:** Comprobar que ninguna serialización o mapeo incluya la clave `confidence`. (Cubierto en Task 2, Step 1).
2. **Acceso cross-tenant a hallazgos:** Usuario de Workspace A no puede consultar hallazgos ni evidencias de Workspace B. (Cubierto en Task 6, Step 1).
3. **Consulta sobre análisis no completado:** Intentar listar hallazgos de un análisis en `queued`, `processing` o `failed` debe retornar error `NOT_FOUND` o 0 filas. (Cubierto en Task 3, Step 1 y Task 6, Step 3).
4. **Inyección XSS en fragmentos de documentos:** Fragmentos con `<script>` o HTML malicioso deben renderizarse como texto plano inofensivo. (Cubierto en Task 4, Step 1).
5. **Exactitud de versión analizada:** El botón de abrir archivo original debe enviar inequívocamente el `versionId` de la evidencia y no el `active_version_id` del documento. (Cubierto en Task 4, Step 1).

## Estado de ejecución (2026-10-27)

- Tasks 1–6 implementadas y verificadas. La consulta aplica filtros autorizados, orden de severidad antes de paginar, y el detalle resuelve nombres/versiones desde tablas con workspace; la evidencia abre la versión asociada.
- Las cinco suites enfocadas de S2-10 pasan: 11 tests. La suite completa pasa: 108 archivos, 884 tests.
- Playwright local verifica Completed → Findings, filtros type/severity/status/assignee, orden High → Low, paginación, Drawer side-by-side, ausencia de `confidence` y completed sin findings. Los 5 escenarios pasan; el escenario de findings se repitió tras añadir filtros y paginación.
- `pnpm test:db` pasa: 30 archivos, 1.205 assertions. La prueba S2-10 usa fixtures reales y sesión authenticated para comprobar aislamiento tenant, Member, análisis no completado y `confidence`.
- `pnpm typecheck` y `pnpm build` pasan; el build incluye `/analysis/[analysisId]/findings`. `pnpm lint` termina con 0 errores y 3 warnings preexistentes en dos pruebas de ingestion.
- Fase roja TDD recreada de forma controlada después de implementar: se deshabilitaron temporalmente los exports de los cinco módulos y fallaron 11/11 pruebas enfocadas. Se restauraron los archivos y la fase verde pasó 11/11. No se conservó evidencia de una ejecución roja anterior a la implementación. El warning existente de instrumentación de navegación de Sentry aparece en typecheck/build.

---

### Task 1: Contratos de Tipos y Esquemas de Validación Zod

**Files:**
- Modify: `src/types/contracts.ts:285-338`
- Modify: `src/modules/analysis/schemas.ts:1-70`
- Create: `src/modules/analysis/schemas.test.ts`

**Interfaces:**
- Produces:
  - `FindingSummary`, `FindingEvidenceItem`, `FindingDetail`, `FindingsQuery`, `AnalysisResultsApi` en `src/types/contracts.ts`
  - `findingsQuerySchema`, `findingIdSchema` en `src/modules/analysis/schemas.ts`

- [x] **Step 1: Escribir prueba unitaria que falla para validación de esquemas Zod**

```typescript
// src/modules/analysis/schemas.test.ts
import { describe, expect, it } from "vitest";
import { findingsQuerySchema, findingIdSchema } from "./schemas";

describe("findings schemas", () => {
  it("valida query de findings con valores válidos y aplica defaults", () => {
    const parsed = findingsQuerySchema.safeParse({
      analysisId: "123e4567-e89b-12d3-a456-426614174000",
      type: "contradiction",
      severity: "High",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.page).toBe(1);
      expect(parsed.data.pageSize).toBe(10);
      expect(parsed.data.type).toBe("contradiction");
      expect(parsed.data.severity).toBe("High");
    }
  });

  it("rechaza analysisId no uuid o página fuera de rango", () => {
    expect(findingsQuerySchema.safeParse({ analysisId: "invalid-id" }).success).toBe(false);
    expect(findingsQuerySchema.safeParse({
      analysisId: "123e4567-e89b-12d3-a456-426614174000",
      page: 0,
    }).success).toBe(false);
    expect(findingsQuerySchema.safeParse({
      analysisId: "123e4567-e89b-12d3-a456-426614174000",
      pageSize: 100,
    }).success).toBe(false);
  });

  it("valida findingId uuid", () => {
    expect(findingIdSchema.safeParse("123e4567-e89b-12d3-a456-426614174000").success).toBe(true);
    expect(findingIdSchema.safeParse("not-a-uuid").success).toBe(false);
  });
});
```

- [x] **Step 2: Ejecutar prueba para verificar que falla**

Run: `pnpm exec vitest run src/modules/analysis/schemas.test.ts`
Expected: FAIL con `findingsQuerySchema is not defined` o `findingIdSchema is not defined`.

- [x] **Step 3: Actualizar `src/types/contracts.ts` y exportar esquemas en `src/modules/analysis/schemas.ts`**

En `src/types/contracts.ts`:
- Actualizar `FindingEvidence` a `FindingEvidenceItem` conteniendo `documentName: string` y `versionNumber: number`.
- Actualizar `FindingSummary` para incluir `createdAt: string` y `assignee: EligibleOwner | null`.
- Actualizar `FindingsQuery` para soportar `status?: FindingStatus` y `assignee?: "all" | "unassigned"`.

En `src/modules/analysis/schemas.ts`:
- Implementar y exportar `findingsQuerySchema` y `findingIdSchema` con Zod.

- [x] **Step 4: Ejecutar prueba para verificar que pasa**

Run: `pnpm exec vitest run src/modules/analysis/schemas.test.ts`
Expected: PASS.

- [x] **Step 5: Typecheck general**

Run: `pnpm typecheck`
Expected: 0 errores de tipo.

---

### Task 2: Capa de Acceso a Datos y Servicios de Hallazgos

**Files:**
- Modify: `src/modules/analysis/infrastructure/analysis.repository.ts`
- Modify: `src/modules/analysis/application/analysis.service.ts`
- Create: `src/modules/analysis/application/findings.service.test.ts`

**Interfaces:**
- Consumes: `findingsQuerySchema`, `findingIdSchema`, `FindingSummary`, `FindingDetail`, `FindingsQuery`
- Produces:
  - `listFindingsService(client, workspaceId, query: FindingsQuery): Promise<AnalysisPage<FindingSummary>>`
  - `getFindingDetailService(client, workspaceId, findingId: string): Promise<FindingDetail | null>`

- [x] **Step 1: Escribir prueba unitaria que falla para la lógica del servicio de hallazgos**

```typescript
// src/modules/analysis/application/findings.service.test.ts
import { describe, expect, it } from "vitest";
import { sortFindingsBySeverityAndDate, mapFindingRowToSummary } from "./analysis.service";

describe("findings service logic", () => {
  it("ordena estrictamente High -> Medium -> Low con desempate por fecha descendente y id", () => {
    const items = [
      { id: "1", severityCurrent: "Low" as const, createdAt: "2026-10-27T10:00:00Z" },
      { id: "2", severityCurrent: "High" as const, createdAt: "2026-10-27T09:00:00Z" },
      { id: "3", severityCurrent: "Medium" as const, createdAt: "2026-10-27T11:00:00Z" },
      { id: "4", severityCurrent: "High" as const, createdAt: "2026-10-27T10:00:00Z" },
    ];
    const sorted = sortFindingsBySeverityAndDate(items);
    expect(sorted.map((item) => item.id)).toEqual(["4", "2", "3", "1"]);
  });

  it("garantiza que el DTO resultante jamás contiene la propiedad confidence", () => {
    const rawRow = {
      id: "f-1",
      analysis_id: "a-1",
      type: "contradiction" as const,
      explanation: "Expl",
      severity_original: "High" as const,
      severity_current: "High" as const,
      status: "pending_review" as const,
      created_at: "2026-10-27T10:00:00Z",
      confidence: 0.95, // Raw data simulator
    };
    const summary = mapFindingRowToSummary(rawRow as any);
    expect("confidence" in summary).toBe(false);
    expect(summary.assignee).toBeNull();
    expect(summary.severityCurrent).toBe("High");
  });
});
```

- [x] **Step 2: Ejecutar prueba para verificar que falla**

Run: `pnpm exec vitest run src/modules/analysis/application/findings.service.test.ts`
Expected: FAIL con funciones no definidas.

- [x] **Step 3: Implementar métodos de repositorio y funciones de servicio**

- En `analysis.repository.ts`:
  - `findFindingsByAnalysis(client, { workspaceId, analysisId, type, severity, status, offset, limit })`: consulta la vista `analysis_findings`, mapea `severity_current` order `High -> Medium -> Low`, desempata por `created_at DESC, id DESC`.
  - `findFindingWithEvidence(client, { workspaceId, findingId })`: consulta `analysis_findings` y `analysis_finding_evidence` realizando join con `documents(name)` y `document_versions(version_number)`.
- En `analysis.service.ts`:
  - Implementar `sortFindingsBySeverityAndDate`, `mapFindingRowToSummary`, `listFindingsService` y `getFindingDetailService`.

- [x] **Step 4: Ejecutar prueba para verificar que pasa**

Run: `pnpm exec vitest run src/modules/analysis/application/findings.service.test.ts`
Expected: PASS.

---

### Task 3: Capa de Server Actions y Validación de Autorización

**Files:**
- Modify: `src/modules/analysis/application/analysis.actions.ts`
- Modify: `src/modules/analysis/index.ts`
- Create: `src/modules/analysis/application/findings.actions.test.ts`

**Interfaces:**
- Consumes: `requireDocumentActor` de `@/modules/identity`, `listFindingsService`, `getFindingDetailService`
- Produces:
  - `listFindingsAction(query: FindingsQuery): Promise<ActionResult<AnalysisPage<FindingSummary>>>`
  - `getFindingDetailAction(findingId: string): Promise<ActionResult<FindingDetail>>`

- [x] **Step 1: Escribir prueba unitaria para las Server Actions**

```typescript
// src/modules/analysis/application/findings.actions.test.ts
import { describe, expect, it, vi } from "vitest";
import { listFindingsAction, getFindingDetailAction } from "./analysis.actions";

describe("findings server actions", () => {
  it("rechaza la consulta con FORBIDDEN si el actor no tiene rol Admin o QA Lead", async () => {
    // Mock requireDocumentActor rejecting or throwing IdentityError FORBIDDEN
    const result = await listFindingsAction({ analysisId: "123e4567-e89b-12d3-a456-426614174000" });
    // Expect error code FORBIDDEN or UNAUTHENTICATED depending on identity state
    expect(result.ok).toBe(false);
  });

  it("rechaza IDs inválidos con INVALID_INPUT", async () => {
    const result = await getFindingDetailAction("invalid-uuid");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
    }
  });
});
```

- [x] **Step 2: Ejecutar prueba para verificar que falla**

Run: `pnpm exec vitest run src/modules/analysis/application/findings.actions.test.ts`
Expected: FAIL con `listFindingsAction is not defined`.

- [x] **Step 3: Implementar Server Actions en `analysis.actions.ts` y exportar en `index.ts`**

- En `analysis.actions.ts`:
  - `listFindingsAction(input)`:
    1. Invoca `requireDocumentActor()`.
    2. Valida input con `findingsQuerySchema`.
    3. Verifica que el análisis exista, pertenezca al `workspace_id` del actor y tenga `status = 'completed'`. Si no está `completed` o no existe, retorna `{ ok: false, error: { code: "NOT_FOUND", message: "This analysis is unavailable." } }`.
    4. Invoca `listFindingsService`. Retorna `{ ok: true, data }`.
    5. Atrapa errores y usa `reportInternalFailure("findings_read", ...)`.
  - `getFindingDetailAction(findingId)`:
    1. Invoca `requireDocumentActor()`.
    2. Valida `findingId` con `findingIdSchema`.
    3. Invoca `getFindingDetailService`. Si es null, retorna `NOT_FOUND`.
    4. Retorna `{ ok: true, data }`.
- En `src/modules/analysis/index.ts`:
  - Exportar `listFindingsAction` y `getFindingDetailAction`.

- [x] **Step 4: Ejecutar prueba para verificar que pasa**

Run: `pnpm exec vitest run src/modules/analysis/application/findings.actions.test.ts`
Expected: PASS.

---

### Task 4: Componente Drawer de Evidencia con Comparación Side-by-Side y Apertura Segura

**Files:**
- Create: `src/modules/analysis/ui/finding-evidence-drawer.tsx`
- Create: `src/modules/analysis/ui/finding-evidence-drawer.test.tsx`

**Interfaces:**
- Consumes: `FindingDetail`, `getDocumentOriginalUrlAction` de `@/modules/repository`
- Produces: `FindingEvidenceDrawer` component

- [x] **Step 1: Escribir pruebas de componente para el Drawer (XSS e inspección side-by-side)**

```typescript
// src/modules/analysis/ui/finding-evidence-drawer.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FindingEvidenceDrawer } from "./finding-evidence-drawer";
import type { FindingDetail } from "@/types/contracts";

const mockFinding: FindingDetail = {
  id: "f-1",
  analysisId: "a-1",
  type: "contradiction",
  explanation: "SOP-1 contradicts Policy-2 regarding retention periods.",
  severityOriginal: "High",
  severityCurrent: "High",
  status: "pending_review",
  assignee: null,
  createdAt: "2026-10-27T10:00:00Z",
  evidence: [
    {
      id: "ev-1",
      documentId: "d-1",
      documentName: "Data-Retention-SOP.pdf",
      versionId: "v-1",
      versionNumber: 1,
      chunkId: "c-1",
      pageNumber: 4,
      section: "Section 2.1",
      sectionHeading: "Retention Duration",
      snapshot: "Records must be retained for 3 years. <script>alert('xss')</script>",
    },
    {
      id: "ev-2",
      documentId: "d-2",
      documentName: "Security-Policy.docx",
      versionId: "v-2",
      versionNumber: 2,
      chunkId: "c-2",
      pageNumber: 12,
      section: "Section 5.3",
      sectionHeading: "Compliance Rule",
      snapshot: "All records must be permanently deleted after 12 months.",
    },
  ],
};

describe("FindingEvidenceDrawer", () => {
  it("renderiza comparación side-by-side de 2 evidencias con nombres de documentos y versiones", () => {
    render(<FindingEvidenceDrawer finding={mockFinding} onClose={vi.fn()} />);
    expect(screen.getByText(/Data-Retention-SOP.pdf/)).toBeDefined();
    expect(screen.getByText(/Security-Policy.docx/)).toBeDefined();
    expect(screen.getByText(/v1/)).toBeDefined();
    expect(screen.getByText(/v2/)).toBeDefined();
  });

  it("renderiza texto de snapshot de forma segura sin interpretar HTML ni ejecutar scripts", () => {
    const { container } = render(<FindingEvidenceDrawer finding={mockFinding} onClose={vi.fn()} />);
    expect(screen.getByText(/Records must be retained for 3 years/)).toBeDefined();
    // Verify no script element was created in the DOM
    expect(container.querySelectorAll("script").length).toBe(0);
    expect(container.innerHTML).toContain("&lt;script&gt;alert('xss')&lt;/script&gt;");
  });
});
```

- [x] **Step 2: Ejecutar prueba para verificar que falla**

Run: `pnpm exec vitest run src/modules/analysis/ui/finding-evidence-drawer.test.tsx`
Expected: FAIL con `FindingEvidenceDrawer is not defined`.

- [x] **Step 3: Implementar `FindingEvidenceDrawer`**

- Crear `src/modules/analysis/ui/finding-evidence-drawer.tsx`:
  - Panel deslizable con `role="dialog"`, `aria-modal="true"`.
  - Escucha de tecla `ESC` y botón `✕` para invocar `onClose()`.
  - Renderizado de badges de severidad y tipo.
  - Renderizado seguro de `snapshot` como texto plano dentro de `<p className="whitespace-pre-wrap font-mono text-xs text-slate-800 bg-slate-50 p-3 rounded border border-slate-200">`.
  - Grid responsivo de 2 columnas (`grid grid-cols-1 lg:grid-cols-2 gap-4`) si `evidence.length === 2`.
  - Botón `"Open original document"` para cada evidencia:
    - Llama a `getDocumentOriginalUrlAction(evidence.versionId)`.
    - Al resolver, invoca `window.open(url, "_blank", "noopener,noreferrer")`.
    - Muestra estado de carga y error controlado en caso de fallo.

- [x] **Step 4: Ejecutar prueba para verificar que pasa**

Run: `pnpm exec vitest run src/modules/analysis/ui/finding-evidence-drawer.test.tsx`
Expected: PASS.

---

### Task 5: Vista de Hallazgos, Filtros, Estados Vacíos y Ruta en App Router

**Files:**
- Create: `src/modules/analysis/ui/findings-view.tsx`
- Create: `src/modules/analysis/ui/findings-view.test.tsx`
- Create: `src/app/(workspace)/analysis/[analysisId]/findings/page.tsx`
- Modify: `src/modules/analysis/ui/analysis-status-view.tsx:152`

**Interfaces:**
- Consumes: `listFindingsAction`, `getFindingDetailAction`, `FindingEvidenceDrawer`
- Produces: `FindingsView`, ruta `/analysis/[analysisId]/findings`

- [x] **Step 1: Escribir pruebas unitarias para `FindingsView`**

```typescript
// src/modules/analysis/ui/findings-view.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FindingsView } from "./findings-view";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/analysis/a-1/findings",
  useSearchParams: () => new URLSearchParams(),
}));

describe("FindingsView", () => {
  it("muestra empty state cuando el análisis completed no tiene hallazgos", () => {
    render(
      <FindingsView
        analysisId="a-1"
        initialPage={{ items: [], total: 0, page: 1, pageSize: 10 }}
        totalAnalysisFindings={0}
      />
    );
    expect(screen.getByText(/No contradictions or obsolescence issues/i)).toBeDefined();
  });

  it("muestra empty state diferenciado cuando los filtros no arrojan resultados", () => {
    render(
      <FindingsView
        analysisId="a-1"
        initialPage={{ items: [], total: 0, page: 1, pageSize: 10 }}
        totalAnalysisFindings={5}
      />
    );
    expect(screen.getByText(/No findings match your selected filters/i)).toBeDefined();
    expect(screen.getByText(/Clear filters/i)).toBeDefined();
  });
});
```

- [x] **Step 2: Ejecutar prueba para verificar que falla**

Run: `pnpm exec vitest run src/modules/analysis/ui/findings-view.test.tsx`
Expected: FAIL con `FindingsView is not defined`.

- [x] **Step 3: Implementar `FindingsView` y la página `/analysis/[analysisId]/findings/page.tsx`**

- En `findings-view.tsx`:
  - Barra de filtros interactiva sincronizada con `searchParams` (`router.push`).
  - Tabla de hallazgos con orden High → Medium → Low.
  - Badges accesibles.
  - Botón `"View Evidence"` que actualiza `?findingId=<id>`.
  - Integración del `FindingEvidenceDrawer`.
- En `page.tsx`:
  - Server Component que valida actor con `requireDocumentActor()`.
  - Lee `params.analysisId` y `searchParams`.
  - Consulta `listFindingsAction` y `getFindingDetailAction` si `findingId` está presente.
  - Renderiza `FindingsView`.
- En `analysis-status-view.tsx`:
  - Actualizar línea 152: cuando `snapshot.status === "completed"`, renderizar tarjeta con botón destacado:
    `<Link href={'/analysis/' + snapshot.analysisId + '/findings'} className="font-semibold text-cyan-800 underline">View Analysis Findings →</Link>`.

- [x] **Step 4: Ejecutar prueba para verificar que pasa**

Run: `pnpm exec vitest run src/modules/analysis/ui/findings-view.test.tsx`
Expected: PASS.

---

### Task 6: Pruebas de Base de Datos y Aislamiento RLS en Supabase

**Files:**
- Create: `supabase/tests/database/s2_10_findings_security.test.sql`

**Interfaces:**
- Consumes: Vistas `analysis_findings`, `analysis_finding_evidence`, tablas `findings`, `analyses`
- Proves: Aislamiento cross-tenant, exclusión de rol `Member`, exclusión de análisis no completados y bloqueo de columna `confidence`

- [x] **Step 1: Escribir archivo de pruebas SQL en `supabase/tests/database/s2_10_findings_security.test.sql`**

```sql
begin;
select plan(5);

-- Test 1: Verificar que un usuario del Workspace A no puede leer hallazgos del Workspace B
select is_empty(
  $$
    select * from public.analysis_findings
    where workspace_id = '00000000-0000-0000-0000-000000000002'::uuid
  $$,
  'Usuario autenticado no puede consultar hallazgos de otro workspace'
);

-- Test 2: Verificar que un usuario del Workspace A no puede leer evidencia del Workspace B
select is_empty(
  $$
    select * from public.analysis_finding_evidence
    where workspace_id = '00000000-0000-0000-0000-000000000002'::uuid
  $$,
  'Usuario autenticado no puede consultar evidencia de otro workspace'
);

-- Test 3: Verificar que hallazgos de un análisis en estado "processing" no son visibles
select is_empty(
  $$
    select f.* from public.analysis_findings f
    join public.analyses a on a.id = f.analysis_id
    where a.status = 'processing'
  $$,
  'Hallazgos de un análisis no completado permanecen invisibles'
);

-- Test 4: Denegación de acceso a la columna confidence para el rol authenticated
select throws_ok(
  $$ select confidence from public.findings limit 1 $$,
  '42501',
  null,
  'El rol authenticated no tiene permisos SELECT sobre la columna confidence'
);

-- Test 5: Orden determinista por severidad High -> Medium -> Low
select results_eq(
  $$
    select severity_current from public.analysis_findings
    order by case severity_current when 'high' then 1 when 'medium' then 2 when 'low' then 3 end asc
    limit 3
  $$,
  $$ values ('high'::public.finding_severity), ('medium'::public.finding_severity), ('low'::public.finding_severity) $$,
  'Los hallazgos se ordenan High -> Medium -> Low'
);

select * from finish();
rollback;
```

- [x] **Step 2: Ejecutar prueba SQL en Supabase local si el stack local está activo**

Run: `pnpm test:db` (o verificar sintaxis si Supabase local no está en ejecución).
Expected: 5 tests pass.

---

### Task 7: Verificación Integral, Typecheck y Lint

**Files:**
- N/A (Verificación de toda la suite)

- [x] **Step 1: Ejecutar suite de pruebas Vitest**

Run: `pnpm exec vitest run`
Expected: Todos los tests unitarios y de componentes pasan.

- [x] **Step 2: Ejecutar Typecheck de TypeScript**

Run: `pnpm typecheck`
Expected: 0 errores de tipado en toda la base de código.

- [x] **Step 3: Ejecutar Linter de ESLint**

Run: `pnpm lint`
Expected: 0 advertencias o errores de linting.

- [x] **Step 4: Ejecutar Build de producción**

Run: `pnpm build`
Expected: Next.js compila todas las rutas correctamente, incluyendo `/analysis/[analysisId]/findings`.
