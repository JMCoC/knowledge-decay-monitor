import type {
  AIProvider,
  AnalysisCandidatePair,
  AnalysisConfiguration,
  AnalysisFailureCode,
  InternalFinding,
} from "../../../types/analysis-internal.ts";

/** Coded failure the worker maps to AnalysisFailureCode outcomes. */
export class AnalysisWorkerError extends Error {
  readonly code: AnalysisFailureCode;

  constructor(code: AnalysisFailureCode, message?: string) {
    super(message ?? code);
    this.name = "AnalysisWorkerError";
    this.code = code;
  }
}


export type {
  AIProvider,
  InternalFinding,
} from "../../../types/analysis-internal.ts";

/** Minimal Supabase surface the worker needs; the client is injected. */
export interface DbResult<T> {
  data: T | null;
  error: { message: string; code?: string } | null;
}

export interface DbFilter {
  eq(column: string, value: unknown): DbFilter;
  single<T>(): Promise<DbResult<T>>;
  then<TResult>(
    onFulfilled: (value: DbResult<unknown[]>) => TResult,
  ): Promise<TResult>;
}

export interface DbTable {
  select(columns: string): DbFilter;
}

export interface AnalysisWorkerDb {
  from(table: string): DbTable;
  rpc<T>(functionName: string, args?: Record<string, unknown>): Promise<DbResult<T>>;
}

/** The seven columns returned by claim_analysis (spec §5.1). */
export interface ClaimedAnalysis {
  id: string;
  workspaceId: string;
  initiatorId: string;
  operationId: string;
  attemptCount: number;
  leaseExpiresAt: string | null;
  nextAttemptAt: string | null;
}

export interface ClaimArgs {
  p_analysis_id: string | null;
}

/** Checkpoint cursor persisted via renew_analysis_lease (spec §5 C1). */
export interface CheckpointState {
  processedPairs: number;
  totalPairs: number;
  findingsCount: number;
  lastPairFingerprint: string | null;
  startedAt: string;
}

export interface LoadedContext {
  analysisId: string;
  workspaceId: string;
  sourceVersionIds: string[];
  comparisonVersionIds: string[];
  pairs: AnalysisCandidatePair[];
  fingerprint: string;
  chunkCount: number;
  candidatePairCount: number;
}

export interface RunBatchArgs {
  claimed: ClaimedAnalysis;
  context: LoadedContext;
  provider: AIProvider;
  client: AnalysisWorkerDb;
  configuration: AnalysisConfiguration;
  startIndex: number;
  startedAt?: string;
}

export type BatchOutcome =
  | {
      kind: "completed";
      processedPairs: number;
      findings: InternalFinding[];
    }
  | {
      kind: "failed";
      code: AnalysisFailureCode;
      processedPairs: number;
      findings: InternalFinding[];
    }
  | { kind: "aborted"; processedPairs: number; findings: InternalFinding[] };

export interface BatchResult {
  outcome: BatchOutcome;
  checkpoint: CheckpointState;
}
