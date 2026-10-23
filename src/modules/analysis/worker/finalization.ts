import type {
  AnalysisFailureCode,
  InternalFinding,
} from "../../../types/analysis-internal.ts";
import type { AnalysisWorkerDb } from "./types.ts";

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

function sqlStateOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function seamCode(error: unknown): string {
  const code = sqlStateOf(error);
  if (code === "22023") return "superseded";
  if (
    code === "P0001" ||
    code === "P2002" ||
    code === "P2003" ||
    code === "55P03" ||
    code === "57014"
  ) {
    return "PERSISTENCE_FAILED";
  }
  return "INTERNAL_ERROR";
}

/**
 * Real finalization factory for the S2-08a success transaction. Failure
 * finalization belongs to S2-08b; failing loud here leaves the job
 * processing instead of closing it as completed.
 */
export function createFinalization(
  client: AnalysisWorkerDb,
): AnalysisFinalization {
  if (!client) throw new Error("AnalysisWorkerDb is required");

  return {
    async finalize({ analysisId, operationId, outcome }) {
      if (outcome.kind !== "completed") {
        throw new Error(
          "S2-08b: analysis failure finalization is not available.",
        );
      }
      try {
        const result = await client.rpc("finalize_analysis_success", {
          p_analysis_id: analysisId,
          p_operation_id: operationId,
          p_reported_findings_count: outcome.findings.length,
        });
        if (result.error) {
          return { ok: false, code: seamCode(result.error) };
        }
        return { ok: true };
      } catch (error: unknown) {
        return { ok: false, code: seamCode(error) };
      }
    },
  };
}
