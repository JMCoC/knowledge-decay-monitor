import type {
  AnalysisBatchPersistence,
  AnalysisWorkerDb,
} from "./types.ts";

function sqlStateOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function seamCode(error: unknown): string {
  const code = sqlStateOf(error);
  if (code === "22023") return "STALE_OPERATION";
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

/** Real batch staging port backed by the atomic S2-08a RPC. */
export function createBatchPersistence(
  client: AnalysisWorkerDb,
): AnalysisBatchPersistence {
  if (!client) throw new Error("AnalysisWorkerDb is required");

  return {
    async persist(input) {
      try {
        const result = await client.rpc<boolean>(
          "persist_analysis_batch",
          {
            p_analysis_id: input.analysisId,
            p_operation_id: input.operationId,
            p_expected_processed_pairs: input.expectedProcessedPairs,
            p_checkpoint: input.checkpoint,
            p_findings: input.findings,
            p_has_more: input.hasMore,
          },
        );
        if (result.error) {
          return { ok: false, code: seamCode(result.error) };
        }
        if (result.data === true) return { ok: true };
        if (result.data === false) {
          return { ok: false, code: "STALE_OPERATION" };
        }
        return { ok: false, code: "INTERNAL_ERROR" };
      } catch (error: unknown) {
        return { ok: false, code: seamCode(error) };
      }
    },
  };
}
