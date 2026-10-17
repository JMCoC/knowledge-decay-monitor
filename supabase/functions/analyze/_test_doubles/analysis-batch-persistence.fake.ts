import type {
  AnalysisBatchPersistence,
  AnalysisBatchPersistenceInput,
  AnalysisWorkerDb,
} from "../../../../src/modules/analysis/worker/types.ts";

/**
 * Local-only handoff double. It persists the checkpoint through the real
 * SQL CAS RPCs but deliberately discards business findings until S2-08.
 */
export class FakeAnalysisBatchPersistence implements AnalysisBatchPersistence {
  readonly calls: AnalysisBatchPersistenceInput[] = [];

  constructor(private readonly client: AnalysisWorkerDb) {}

  async persist(
    input: AnalysisBatchPersistenceInput,
  ): Promise<{ ok: true } | { ok: false; code: string }> {
    this.calls.push(input);
    if (input.hasMore) {
      const result = await this.client.rpc<boolean>("yield_analysis_batch", {
        p_analysis_id: input.analysisId,
        p_operation_id: input.operationId,
        p_expected_processed_pairs: input.expectedProcessedPairs,
        p_checkpoint: input.checkpoint,
      });
      if (result.error || result.data !== true) {
        return { ok: false, code: result.error?.code ?? "STALE_OPERATION" };
      }
      return { ok: true };
    }

    const result = await this.client.rpc<unknown>("renew_analysis_lease", {
      p_analysis_id: input.analysisId,
      p_operation_id: input.operationId,
      p_expected_processed_pairs: input.expectedProcessedPairs,
      p_checkpoint: input.checkpoint,
    });
    if (result.error || result.data === null) {
      return { ok: false, code: result.error?.code ?? "STALE_OPERATION" };
    }
    return { ok: true };
  }
}
