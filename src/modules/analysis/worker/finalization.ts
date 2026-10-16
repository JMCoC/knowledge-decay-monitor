import type {
  AnalysisFailureCode,
  InternalFinding,
} from "../../../types/analysis-internal.ts";

/**
 * Frozen seam between the worker (S2-06) and the finalization owner
 * (S2-08). The v1 implementation behind this seam performs only the
 * state transitions of complete/fail_analysis; S2-08 replaces it with
 * the atomic findings + ledger + event transaction without changing
 * the worker (spec §7; PRD §30 steps 8/10 delegated, Nota PRD-1).
 * Do not change this signature without an ADR or explicit coordination.
 */
export interface AnalysisFinalization {
  finalize(input: {
    analysisId: string;
    operationId: string;
    outcome:
      | { kind: "completed"; findings: InternalFinding[] }
      | { kind: "failed"; code: AnalysisFailureCode };
  }): Promise<{ ok: true } | { ok: false; code: string }>;
}

/**
 * Real finalization factory, unavailable until S2-08 merges (spec §7).
 * Same fail-loud contract as createProvider: never resolve to a fake.
 */
export function createFinalization(): AnalysisFinalization {
  throw new Error("S2-08 not merged: AnalysisFinalization unavailable.");
}
