import type {
  AnalysisJobStatus,
  AnalysisPage,
  AnalysisSelectionInput,
  AnalysisSelectionItem,
  AnalysisSnapshot,
  CreditSnapshot,
  FindingSummary,
} from "../../../src/types/contracts";

const versionIds = Array.from({ length: 21 }, (_, index) =>
  `90000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
);

export const scopeOne = {
  sourceVersionIds: [versionIds[0]],
  comparisonVersionIds: [],
} satisfies AnalysisSelectionInput;

export const scope20 = {
  sourceVersionIds: [versionIds[0]],
  comparisonVersionIds: versionIds.slice(1, 20),
} satisfies AnalysisSelectionInput;

export const scope21 = {
  sourceVersionIds: [versionIds[0]],
  comparisonVersionIds: versionIds.slice(1),
} satisfies AnalysisSelectionInput;

export const overlappingScope = {
  sourceVersionIds: versionIds.slice(0, 2),
  comparisonVersionIds: versionIds.slice(1, 3),
} satisfies AnalysisSelectionInput;

const owner = {
  id: "90000000-0000-4000-8000-000000000101",
  fullName: "Fixture Owner",
};

const selectionItems: AnalysisSelectionItem[] = [
  {
    documentId: "90000000-0000-4000-8000-000000000201",
    versionId: versionIds[0],
    versionNumber: 1,
    name: "Employee Handbook",
    category: "Policy",
    owner,
  },
  {
    documentId: "90000000-0000-4000-8000-000000000202",
    versionId: versionIds[1],
    versionNumber: 2,
    name: "Incident Procedure",
    category: "SOP",
    owner: null,
  },
];

export const selectionPageOne = {
  items: selectionItems.slice(0, 1),
  total: 2,
  page: 1,
  pageSize: 1,
} satisfies AnalysisPage<AnalysisSelectionItem>;

export const selectionPageTwo = {
  items: selectionItems.slice(1),
  total: 2,
  page: 2,
  pageSize: 1,
} satisfies AnalysisPage<AnalysisSelectionItem>;

function analysisSnapshot(status: AnalysisJobStatus): AnalysisSnapshot {
  const terminal = status === "completed" || status === "failed";
  return {
    analysisId: "90000000-0000-4000-8000-000000000301",
    status,
    fixedCost: 50,
    initiator: { id: owner.id, fullName: owner.fullName },
    sources: selectionItems.slice(0, 1),
    comparisons: selectionItems.slice(1),
    createdAt: "2026-10-10T12:00:00.000Z",
    startedAt: status === "queued" ? null : "2026-10-10T12:01:00.000Z",
    finishedAt: terminal ? "2026-10-10T12:02:00.000Z" : null,
    retryOfAnalysisId: null,
    error: status === "failed"
      ? { code: "ANALYSIS_FAILED", message: "Analysis could not be completed." }
      : null,
    canRetry: status === "failed",
  };
}

export const queuedAnalysis = analysisSnapshot("queued");
export const processingAnalysis = analysisSnapshot("processing");
export const completedAnalysis = analysisSnapshot("completed");
export const failedAnalysis = analysisSnapshot("failed");

export const emptyFindingsPage = {
  items: [] satisfies FindingSummary[],
  total: 0,
  page: 1,
  pageSize: 25,
} satisfies AnalysisPage<FindingSummary>;

export const emptyCredits = {
  available: 0,
  reserved: 0,
} satisfies CreditSnapshot;

export const populatedCredits = {
  available: 42,
  reserved: 8,
} satisfies CreditSnapshot;

export const invalidPublicProjection: unknown = {
  ...queuedAnalysis,
  confidence: 0.1,
  operationId: "private-operation-id",
  leaseExpiresAt: "2026-10-10T12:03:00.000Z",
};
