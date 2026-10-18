import { describe, expect, it } from "vitest";
import {
  ANALYSIS_CAPACITY_SCENARIOS,
  evaluateCapacityGate,
  parseCapacityArgs,
  supportsAiQualityEvidence,
} from "../../scripts/analysis-capacity-policy.mjs";

const measuredLocalRun = {
  scenario: "over-1000",
  sha: "a".repeat(40),
  runtime: "local Postgres retrieval RPC",
  limits: {
    wallClockMs: 150_000,
    cpuMs: null,
    memoryBytes: null,
    batchP99Ms: null,
  },
  sampleCount: 3,
  versionCount: 2,
  workspaceCount: 1,
  chunkCount: 1_000,
  candidatePairCount: 1_250,
  transferBytes: 900_000,
  wallMs: 2_500,
  cpuMs: null,
  memoryBytes: null,
  batchP99Ms: null,
  batchCount: null,
  truncated: false,
  source: { environment: "local", provider: "fake", method: "measured" },
};

const completeMeasuredRun = {
  ...measuredLocalRun,
  limits: {
    wallClockMs: 10_000,
    cpuMs: 10_000,
    memoryBytes: 10_000,
    attemptMs: 1_800_000,
    analysisMs: 5_400_000,
  },
  sampleCount: 20,
  batchSampleCount: 20,
  wallMs: 7_000,
  cpuMs: 7_000,
  memoryBytes: 7_000,
  batchP99Ms: 12_000,
  attemptWallMs: 1_000_000,
  analysisWallMs: 2_000_000,
  summaryFingerprintMeasured: true,
  keysetRetrievalComplete: true,
  workerBatchMeasured: true,
};

describe("analysis capacity policy", () => {
  it("preserves the full 20-version, 500-chunk scenario", () => {
    expect(ANALYSIS_CAPACITY_SCENARIOS["max-chunks"]).toEqual({
      versionCount: 20,
      chunksPerVersion: 500,
      workspaceCount: 1,
    });
    expect(ANALYSIS_CAPACITY_SCENARIOS["over-1000"]).toEqual({
      versionCount: 2,
      chunksPerVersion: 500,
      workspaceCount: 1,
    });
  });

  it("keeps unobservable effective CPU, memory, and worker-batch metrics pending", () => {
    const result = evaluateCapacityGate(measuredLocalRun);

    expect(result.gate).toBe("pending");
    expect(result.reasonCodes).toEqual(expect.arrayContaining([
      "effective_cpu_limit_unavailable",
      "effective_memory_limit_unavailable",
      "worker_batch_p99_unavailable",
    ]));
  });

  it("labels a small sample as insufficient for a p99 claim", () => {
    const result = evaluateCapacityGate({
      ...measuredLocalRun,
      limits: { ...measuredLocalRun.limits, batchP99Ms: 60_000 },
      batchP99Ms: 12_000,
      sampleCount: 3,
    });

    expect(result.gate).toBe("pending");
    expect(result.reasonCodes).toContain("insufficient_samples_for_p99");
  });

  it("passes only when all observed resource use stays within the 70 percent budget", () => {
    const passing = {
      ...completeMeasuredRun,
    };
    expect(evaluateCapacityGate(passing).gate).toBe("passed");
    expect(evaluateCapacityGate({ ...passing, wallMs: 7_001 }).reasonCodes)
      .toContain("effective_wall_clock_limit_exceeded");
  });

  it("cannot pass without summary, complete keyset traversal, batch samples, and wall-clock budgets", () => {
    const result = evaluateCapacityGate({
      ...completeMeasuredRun,
      summaryFingerprintMeasured: false,
      keysetRetrievalComplete: false,
      workerBatchMeasured: false,
      batchSampleCount: 3,
      attemptWallMs: null,
      analysisWallMs: null,
    });

    expect(result.gate).toBe("pending");
    expect(result.reasonCodes).toEqual(expect.arrayContaining([
      "retrieval_summary_fingerprint_unavailable",
      "worker_keyset_traversal_incomplete",
      "worker_batch_measurement_unavailable",
      "insufficient_worker_batch_samples_for_p99",
      "attempt_wall_clock_unavailable",
      "analysis_wall_clock_unavailable",
    ]));
  });

  it("fails when attempt or total analysis time exceeds 70 percent of its budget", () => {
    expect(evaluateCapacityGate({ ...completeMeasuredRun, attemptWallMs: 1_260_001 }).reasonCodes)
      .toContain("attempt_wall_clock_exceeded");
    expect(evaluateCapacityGate({ ...completeMeasuredRun, analysisWallMs: 3_780_001 }).reasonCodes)
      .toContain("analysis_wall_clock_exceeded");
  });

  it("fails rather than accepting a truncated or undersized over-1000 scenario", () => {
    expect(evaluateCapacityGate({ ...measuredLocalRun, candidatePairCount: 1_000 }).gate)
      .toBe("failed");
    expect(evaluateCapacityGate({ ...measuredLocalRun, truncated: true }).reasonCodes)
      .toContain("candidate_pairs_truncated");
  });

  it("keeps an auxiliary PostgREST timeout separate from the worker retrieval gate", () => {
    const result = evaluateCapacityGate({
      ...completeMeasuredRun,
      postgrestFailureCode: "57014",
    });

    expect(result.gate).toBe("passed");
    expect(result.reasonCodes).not.toContain("worker_retrieval_summary_timeout");
  });

  it("fails when the worker retrieval summary hits its database statement timeout", () => {
    const result = evaluateCapacityGate({
      ...completeMeasuredRun,
      workerSummaryFailureCode: "57014",
      summaryFingerprintMeasured: false,
    });

    expect(result.gate).toBe("failed");
    expect(result.reasonCodes).toContain("worker_retrieval_summary_timeout");
  });

  it("fails when the worker and auxiliary retrieval routes count different pairs", () => {
    const result = evaluateCapacityGate({
      ...completeMeasuredRun,
      retrievalCountMismatch: true,
    });

    expect(result.gate).toBe("failed");
    expect(result.reasonCodes).toContain("worker_and_postgrest_candidate_counts_differ");
  });

  it("keeps a bounded but incomplete keyset scan pending", () => {
    const result = evaluateCapacityGate({
      ...completeMeasuredRun,
      keysetRetrievalComplete: false,
      keysetBudgetExceeded: true,
    });

    expect(result.gate).toBe("pending");
    expect(result.reasonCodes).toContain("worker_keyset_measurement_budget_exceeded");
  });

  it("keeps hosted measurements pending unless they use a real provider and measured method", () => {
    const result = evaluateCapacityGate({
      ...measuredLocalRun,
      source: { environment: "hosted", provider: "fake", method: "measured" },
    });

    expect(result.gate).toBe("pending");
    expect(result.reasonCodes).toContain("hosted_real_provider_measurement_required");
  });

  it("defaults to local and rejects arbitrary destination URLs", () => {
    expect(parseCapacityArgs(["--scenario", "zero-pairs"]).target).toBe("local");
    expect(() => parseCapacityArgs([
      "--target", "local", "--scenario", "zero-pairs", "--url", "https://prod.example",
    ])).toThrow("Unsupported capacity measurement option.");
  });

  it("does not treat capacity JSON or fake-provider output as AI quality evidence", () => {
    expect(supportsAiQualityEvidence({
      ...measuredLocalRun,
      gate: "passed",
      quality: "passed",
    })).toBe(false);
  });
});
