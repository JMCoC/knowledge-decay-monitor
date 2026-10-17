import type {
  AIProvider,
  AIProviderResult,
  AnalysisCandidatePair,
  AnalysisConfiguration,
  AnalysisFailureCode,
  InternalFinding,
} from "../../../../src/types/analysis-internal.ts";
import { AnalysisWorkerError } from "../../../../src/modules/analysis/worker/types.ts";

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

export interface AnalyzeEnvLike {
  analysisFakeLatencyMs?: string | undefined;
  analysisFakeFailAtCallIndex?: string | undefined;
  analysisFakeFailCode?: string | undefined;
  analysisFakeThrowCode?: string | undefined;
}

const FAILURE_CODES: ReadonlySet<string> = new Set([
  "RETRIEVAL_FAILED",
  "ESTIMATE_STALE",
  "PROVIDER_UNAVAILABLE",
  "INVALID_PROVIDER_OUTPUT",
  "PERSISTENCE_FAILED",
  "TIMEOUT",
  "ATTEMPTS_EXHAUSTED",
  "INTERNAL_ERROR",
]);

function parseIntSafe(value: string | undefined): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseFailCodeSafe(
  value: string | undefined,
): AnalysisFailureCode | undefined {
  if (typeof value !== "string") return undefined;
  return FAILURE_CODES.has(value)
    ? (value as AnalysisFailureCode)
    : undefined;
}

/**
 * Builds a fake provider from stringly environment input. Invalid
 * values degrade to undefined (the constructor defaults apply);
 * nothing here ever throws.
 */
export function createFakeProvider(
  env: AnalyzeEnvLike,
  overrides: FakeProviderBehavior = {},
): AIProvider {
  return new FakeAnalysisProvider({
    latencyMs: overrides.latencyMs ?? parseIntSafe(env.analysisFakeLatencyMs),
    failAtCallIndex:
      overrides.failAtCallIndex ?? parseIntSafe(env.analysisFakeFailAtCallIndex),
    failCode: overrides.failCode ?? parseFailCodeSafe(env.analysisFakeFailCode),
    throwCode:
      overrides.throwCode ?? parseFailCodeSafe(env.analysisFakeThrowCode),
  });
}

/**
 * Parses per-request fake overrides. Only honored when the
 * isLocalTestEnv gate is already open; anything malformed is ignored
 * field by field (never throws, never falls back to ambient values).
 */
export function parseFakeBehaviorSafe(
  value: unknown,
): FakeProviderBehavior {
  if (typeof value !== "object" || value === null) return {};
  const record = value as Record<string, unknown>;
  const behavior: FakeProviderBehavior = {};
  if (typeof record["latencyMs"] === "number") {
    const latency = record["latencyMs"];
    if (Number.isInteger(latency) && latency >= 0) {
      behavior.latencyMs = latency;
    }
  }
  if (typeof record["failAtCallIndex"] === "number") {
    const index = record["failAtCallIndex"];
    if (Number.isInteger(index) && index >= 0) {
      behavior.failAtCallIndex = index;
    }
  }
  if (typeof record["failCode"] === "string") {
    const code = parseFailCodeSafe(record["failCode"]);
    if (code !== undefined) behavior.failCode = code;
  }
  if (typeof record["throwCode"] === "string") {
    const code = parseFailCodeSafe(record["throwCode"]);
    if (code !== undefined) behavior.throwCode = code;
  }
  return behavior;
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
