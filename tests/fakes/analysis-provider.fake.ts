import type {
  AIProvider,
  AIProviderResult,
  AnalysisCandidatePair,
  AnalysisConfiguration,
  AnalysisFailureCode,
  InternalFinding,
} from "../../src/types/analysis-internal";
import { AnalysisWorkerError } from "../../src/modules/analysis/worker/types";

export interface FakeProviderBehavior {
  /** Simulated latency per call in milliseconds. Default 0. */
  latencyMs?: number;
  /** Findings returned on every successful call. Default []. */
  findings?: InternalFinding[];
  /** Zero-based call index that fails instead of succeeding. */
  failAtCallIndex?: number;
  /** Code returned by the failing call. Default PROVIDER_UNAVAILABLE. */
  failCode?: AnalysisFailureCode;
  /** Code thrown (not returned) by every call. */
  throwCode?: AnalysisFailureCode;
}

/**
 * Deterministic test-only AIProvider: the same input sequence always
 * produces the same output sequence. Never import from src/ (spec §7).
 */
export class FakeAnalysisProvider implements AIProvider {
  readonly calls: Array<{
    pair: AnalysisCandidatePair;
    configuration: AnalysisConfiguration;
  }> = [];

  maxActive = 0;

  private active = 0;

  constructor(private readonly behavior: FakeProviderBehavior = {}) {}

  async analyzePair(input: {
    pair: AnalysisCandidatePair;
    configuration: AnalysisConfiguration;
  }): Promise<AIProviderResult> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      const {
        latencyMs = 0,
        findings = [],
        failAtCallIndex,
        failCode = "PROVIDER_UNAVAILABLE",
        throwCode,
      } = this.behavior;
      if (latencyMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, latencyMs));
      }
      const index = this.calls.length;
      this.calls.push(input);
      if (throwCode !== undefined) {
        throw new AnalysisWorkerError(throwCode);
      }
      if (failAtCallIndex !== undefined && index === failAtCallIndex) {
        return { ok: false, error: { code: failCode } };
      }
      return { ok: true, findings };
    } finally {
      this.active -= 1;
    }
  }
}
