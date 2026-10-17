import type { Actor, AnalysisScopeRole, FindingSeverity, FindingType } from "./contracts.ts";

export type AnalysisFailureCode =
  | "RETRIEVAL_FAILED"
  | "ESTIMATE_STALE"
  | "PROVIDER_UNAVAILABLE"
  | "INVALID_PROVIDER_OUTPUT"
  | "PERSISTENCE_FAILED"
  | "TIMEOUT"
  | "ATTEMPTS_EXHAUSTED"
  | "INTERNAL_ERROR";

export interface AnalysisConfiguration {
  retrieval: {
    topK: 5;
    similarityThreshold: 0.75;
    chunksRevision: string;
    embeddingRevision: string;
    fingerprint: string;
  };
  pricingVersion: string;
  promptVersion: string;
  outputSchemaVersion: string;
  providers: {
    primary: { provider: string; model: string };
    fallback: { provider: string; model: string };
  };
}

/** Immutable execution versions recorded with an S2-05 estimate. */
export interface AnalysisExecutionManifest {
  fingerprintVersion: "s2-05-v2";
  pricingVersion: "s2-04-v1";
  promptVersion: string;
  outputSchemaVersion: string;
  providers: AnalysisConfiguration["providers"];
}

/** Stable keyset cursor over canonical unordered chunk pairs. */
export interface AnalysisPairCursor {
  lowChunkId: string;
  highChunkId: string;
}

/** Complete SQL-computed estimate, independent of PostgREST max_rows. */
export interface AnalysisRetrievalSummary {
  chunkCount: number;
  candidatePairCount: number;
  chunksRevision: string;
  fingerprint: string;
  fixedCost: number;
}

export interface AnalysisLease {
  analysisId: string;
  workspaceId: string;
  operationId: string;
  attemptCount: number;
  leaseExpiresAt: string;
}

export interface AnalysisChunkReference {
  documentId: string;
  versionId: string;
  chunkId: string;
  role: AnalysisScopeRole;
}

export interface AnalysisCandidatePair {
  source: AnalysisChunkReference & { text: string };
  comparison: AnalysisChunkReference & { text: string };
}

export interface PreparedRetrieval {
  actor: Actor;
  configuration: AnalysisConfiguration;
  chunkCount: number;
  candidatePairCount: number;
  fingerprint: string;
  pairs: AnalysisCandidatePair[];
}

export interface InternalFinding {
  type: FindingType;
  severity: FindingSeverity;
  confidence: number;
  explanation: string;
  evidence: Array<AnalysisChunkReference & {
    snapshot: string;
    pageNumber: number | null;
    section: string | null;
    sectionHeading: string | null;
  }>;
}

export type AIProviderResult =
  | { ok: true; findings: InternalFinding[] }
  | { ok: false; error: { code: AnalysisFailureCode } };

export interface AIProvider {
  analyzePair(input: {
    pair: AnalysisCandidatePair;
    configuration: AnalysisConfiguration;
    signal?: AbortSignal;
  }): Promise<AIProviderResult>;
}

export interface AnalysisFinalizationInput {
  lease: AnalysisLease;
  findings: InternalFinding[];
}

export interface CreditEffectInput {
  actor: Actor;
  analysisId: string;
  fixedCost: number;
}

export interface TerminalNotification {
  analysisId: string;
  workspaceId: string;
  recipientId: string;
  type: "analysis_completed" | "analysis_failed";
}
