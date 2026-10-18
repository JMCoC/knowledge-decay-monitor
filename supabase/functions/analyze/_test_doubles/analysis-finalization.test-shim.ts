import type { AnalysisFailureCode } from "../../../../src/types/analysis-internal.ts";
import type { AnalysisFinalization } from "../../../../src/modules/analysis/worker/finalization.ts";
import type { AnalysisWorkerDb } from "../../../../src/modules/analysis/worker/types.ts";

// v1 test-only: state transitions only. S2-08 replaces this with
// the atomic findings + ledger + event transaction (spec §7).
//
// Retryable mapping mirrors spec §5 C3 (ESTIMATE_STALE is the only
// terminal code here; process-analysis.ts deliberately carries no copy:
// it maps INTERNAL_ERROR to abort instead of finalizing).

const RETRYABLE_CODES: ReadonlySet<AnalysisFailureCode> = new Set([
  "RETRIEVAL_FAILED",
  "PROVIDER_UNAVAILABLE",
  "INVALID_PROVIDER_OUTPUT",
  "PERSISTENCE_FAILED",
  "TIMEOUT",
  "INTERNAL_ERROR",
]);

/**
 * Test-only AnalysisFinalization for the local Edge: forwards the
 * outcome to complete/fail_analysis and nothing else. Never writes
 * credit_ledger, never emits events, never persists findings.
 */
export function createTestFinalization(
  client: AnalysisWorkerDb,
): AnalysisFinalization {
  return {
    async finalize({ analysisId, operationId, outcome }) {
      if (outcome.kind === "completed") {
        const done = await client.rpc("complete_analysis", {
          p_analysis_id: analysisId,
          p_operation_id: operationId,
        });
        if (done.error) {
          throw new Error(`test finalize failed: ${done.error.message}`);
        }
        return { ok: true };
      }
      const failed = await client.rpc("fail_analysis", {
        p_analysis_id: analysisId,
        p_operation_id: operationId,
        p_retryable: RETRYABLE_CODES.has(outcome.code),
        p_error_code: outcome.code,
      });
      if (failed.error) {
        throw new Error(`test finalize failed: ${failed.error.message}`);
      }
      if (failed.data === "superseded") {
        return { ok: false, code: "superseded" };
      }
      return { ok: true };
    },
  };
}
