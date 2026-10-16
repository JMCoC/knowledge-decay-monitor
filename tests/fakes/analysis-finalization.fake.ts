import type { AnalysisFinalization } from "../../src/modules/analysis/worker/finalization";

export interface FakeFinalizationBehavior {
  /** Throw instead of recording. Default false. */
  throwOnFinalize?: boolean;
  /** Result to return. Default { ok: true }. */
  okResult?: boolean;
  /** Code returned with { ok: false }. Default "superseded". */
  failCode?: string;
}

type FinalizeInput = Parameters<AnalysisFinalization["finalize"]>[0];

/**
 * Deterministic test-only AnalysisFinalization: records every call.
 * Never import from src/ (spec §7).
 */
export class FakeAnalysisFinalization implements AnalysisFinalization {
  readonly calls: FinalizeInput[] = [];

  constructor(private readonly behavior: FakeFinalizationBehavior = {}) {}

  async finalize(
    input: FinalizeInput,
  ): Promise<{ ok: true } | { ok: false; code: string }> {
    const { throwOnFinalize = false, okResult = true, failCode = "superseded" } =
      this.behavior;
    this.calls.push(input);
    if (throwOnFinalize) {
      throw new Error("finalize failed");
    }
    if (!okResult) {
      return { ok: false, code: failCode };
    }
    return { ok: true };
  }
}
