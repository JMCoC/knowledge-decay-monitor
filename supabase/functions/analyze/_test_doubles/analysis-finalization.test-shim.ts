import type { AnalysisFailureCode } from "../../../../src/types/analysis-internal.ts";
import type { AnalysisFinalization } from "../../../../src/modules/analysis/worker/finalization.ts";
import type { AnalysisWorkerDb } from "../../../../src/modules/analysis/worker/types.ts";

// Delegates success to finalize_analysis_success and failure to fail_analysis;
// the RPC performs the atomic writes (ledger, event, findings/evidence, staging
// cleanup) inside a single transaction (spec §13.3).
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
 * Test-only AnalysisFinalization for the local Edge: forwards the
 * outcome to finalize_analysis_success/fail_analysis. The RPC owns the
 * ledger, notification_events, findings/evidence persistence and staging
 * cleanup; the shim does not duplicate any of those writes.
 */
export function createTestFinalization(
  client: AnalysisWorkerDb,
): AnalysisFinalization {
  return {
    async finalize({ analysisId, operationId, outcome }) {
      if (outcome.kind === "completed") {
        try {
          const done = await client.rpc("finalize_analysis_success", {
            p_analysis_id: analysisId,
            p_operation_id: operationId,
            p_reported_findings_count: outcome.findings.length,
          });
          if (done.error) {
            return { ok: false, code: seamCode(done.error) };
          }
          return { ok: true };
        } catch (error: unknown) {
          return { ok: false, code: seamCode(error) };
        }
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
