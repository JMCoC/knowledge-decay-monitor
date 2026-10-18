import type {
  AnalysisBatchPersistence,
  AnalysisWorkerDb,
} from "./types.ts";

/**
 * Business finding staging is owned by S2-08. Fail readiness closed until
 * its atomic staging/finalization contract is present.
 */
export function createBatchPersistence(
  _client: AnalysisWorkerDb,
): AnalysisBatchPersistence {
  void _client;
  throw new Error("S2-08 not merged: analysis batch staging unavailable.");
}
