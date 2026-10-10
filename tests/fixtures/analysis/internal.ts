import type {
  AIProviderResult,
  AnalysisCandidatePair,
  AnalysisConfiguration,
  AnalysisLease,
  InternalFinding,
} from "../../../src/types/analysis-internal";

export const analysisConfiguration = {
  retrieval: {
    topK: 5,
    similarityThreshold: 0.75,
    chunksRevision: "chunks-v1",
    embeddingRevision: "embeddings-v1",
    fingerprint: "fixture-retrieval-fingerprint",
  },
  pricingVersion: "pricing-v1",
  promptVersion: "prompt-v1",
  outputSchemaVersion: "findings-v1",
  providers: {
    primary: { provider: "fixture-provider", model: "fixture-model" },
    fallback: { provider: "fixture-provider-fallback", model: "fixture-model-fallback" },
  },
} satisfies AnalysisConfiguration;

export const liveLease = {
  analysisId: "90000000-0000-4000-8000-000000000301",
  workspaceId: "90000000-0000-4000-8000-000000000401",
  operationId: "90000000-0000-4000-8000-000000000501",
  attemptCount: 1,
  leaseExpiresAt: "2026-10-10T12:03:00.000Z",
} satisfies AnalysisLease;

export const expiredLease = {
  ...liveLease,
  leaseExpiresAt: "2026-10-10T11:59:00.000Z",
} satisfies AnalysisLease;

const source = {
  documentId: "90000000-0000-4000-8000-000000000201",
  versionId: "90000000-0000-4000-8000-000000000001",
  chunkId: "90000000-0000-4000-8000-000000000601",
  role: "source",
  text: "A synthetic source procedure requires manager approval.",
} as const;

const comparison = {
  documentId: "90000000-0000-4000-8000-000000000202",
  versionId: "90000000-0000-4000-8000-000000000002",
  chunkId: "90000000-0000-4000-8000-000000000602",
  role: "comparison",
  text: "A synthetic comparison procedure permits self-approval.",
} as const;

export const repeatedPair = {
  source,
  comparison,
} satisfies AnalysisCandidatePair;

export const invertedPair = {
  source: { ...comparison, role: "source" },
  comparison: { ...source, role: "comparison" },
} satisfies AnalysisCandidatePair;

export const lowConfidenceFinding = {
  type: "contradiction",
  severity: "Medium",
  confidence: 0.1,
  explanation: "The synthetic procedures disagree about approval authority.",
  evidence: [
    {
      documentId: source.documentId,
      versionId: source.versionId,
      chunkId: source.chunkId,
      role: source.role,
      snapshot: "A synthetic source procedure requires manager approval.",
      pageNumber: 3,
      section: "Approvals",
      sectionHeading: "Manager approval",
    },
  ],
} satisfies InternalFinding;

export const providerSuccess = {
  ok: true,
  findings: [lowConfidenceFinding],
} satisfies AIProviderResult;

export const invalidProviderOutput: unknown = {
  ok: true,
  findings: [{ confidence: 1.1, explanation: "Synthetic invalid output" }],
};

export const snapshot2000Unicode = "😀".repeat(2_000);
export const snapshot2001Unicode = "😀".repeat(2_001);
