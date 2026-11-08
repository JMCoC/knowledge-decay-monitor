export const ANALYSIS_CAPACITY_SCENARIOS = Object.freeze({
  "zero-pairs": Object.freeze({ versionCount: 1, chunksPerVersion: 1, workspaceCount: 1 }),
  "multi-batch": Object.freeze({ versionCount: 2, chunksPerVersion: 8, workspaceCount: 1 }),
  "over-1000": Object.freeze({ versionCount: 2, chunksPerVersion: 500, workspaceCount: 1 }),
  "twenty-versions": Object.freeze({ versionCount: 20, chunksPerVersion: 1, workspaceCount: 1 }),
  "max-chunks": Object.freeze({ versionCount: 20, chunksPerVersion: 500, workspaceCount: 1 }),
  "multi-workspace": Object.freeze({ versionCount: 2, chunksPerVersion: 8, workspaceCount: 2 }),
});

const CAPACITY_BUDGET_RATIO = 0.7;
const MIN_P99_SAMPLES = 20;

/** @param {string[]} args */
export function parseCapacityArgs(args) {
  let target = "local";
  let scenario;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (option !== "--target" && option !== "--scenario") {
      throw new Error("Unsupported capacity measurement option.");
    }
    if (!value || value.startsWith("--")) {
      throw new Error("A value is required for the capacity measurement option.");
    }
    if (option === "--target") target = value;
    else scenario = value;
    index += 1;
  }

  if (target !== "local" && target !== "hosted") {
    throw new Error("Capacity target must be local or hosted.");
  }
  if (!scenario || !Object.hasOwn(ANALYSIS_CAPACITY_SCENARIOS, scenario)) {
    throw new Error("Choose a reviewed analysis capacity scenario.");
  }
  return { target, scenario };
}

/** @param {unknown} evidence */
export function evaluateCapacityGate(evidence) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new Error("Capacity evidence must be an object.");
  }
  const value = /** @type {Record<string, any>} */ (evidence);
  if (!Object.hasOwn(ANALYSIS_CAPACITY_SCENARIOS, value.scenario)) {
    throw new Error("Capacity evidence has an unreviewed scenario.");
  }
  if (!value.source || !["local", "hosted"].includes(value.source.environment)
    || !["fake", "real"].includes(value.source.provider)
    || !["measured", "extrapolated"].includes(value.source.method)) {
    throw new Error("Capacity evidence source is invalid.");
  }

  const pending = new Set();
  const failed = new Set();
  const addUnavailable = (reason, metric, limit) => {
    if (metric === null || metric === undefined || limit === null || limit === undefined) {
      pending.add(reason);
      return;
    }
    if (!Number.isFinite(metric) || !Number.isFinite(limit) || metric < 0 || limit <= 0) {
      failed.add(`${reason.replace("unavailable", "invalid")}`);
      return;
    }
    if (metric > limit * CAPACITY_BUDGET_RATIO) failed.add(`${reason.replace("unavailable", "exceeded")}`);
  };

  const limits = value.limits ?? {};
  if (value.workerSummaryFailureCode === "57014") {
    failed.add("worker_retrieval_summary_timeout");
  } else if (typeof value.workerSummaryFailureCode === "string") {
    failed.add("worker_retrieval_summary_failed");
  }
  if (value.workerPageFailureCode === "57014") {
    failed.add("worker_pair_page_timeout");
  } else if (typeof value.workerPageFailureCode === "string") {
    failed.add("worker_pair_page_failed");
  }
  if (typeof value.workerBatchFailureCode === "string") {
    failed.add("worker_batch_failed");
  }
  if (value.retrievalCountMismatch === true) {
    failed.add("worker_and_postgrest_candidate_counts_differ");
  }
  if (value.keysetBudgetExceeded === true) {
    pending.add("worker_keyset_measurement_budget_exceeded");
  }
  addUnavailable("effective_wall_clock_limit_unavailable", value.wallMs, limits.wallClockMs);
  addUnavailable("effective_cpu_limit_unavailable", value.cpuMs, limits.cpuMs);
  addUnavailable("effective_memory_limit_unavailable", value.memoryBytes, limits.memoryBytes);
  addUnavailable("attempt_wall_clock_unavailable", value.attemptWallMs, limits.attemptMs);
  addUnavailable("analysis_wall_clock_unavailable", value.analysisWallMs, limits.analysisMs);

  if (value.summaryFingerprintMeasured !== true) {
    pending.add("retrieval_summary_fingerprint_unavailable");
  }
  if (value.keysetRetrievalComplete !== true) {
    pending.add("worker_keyset_traversal_incomplete");
  }
  if (value.workerBatchMeasured !== true) {
    pending.add("worker_batch_measurement_unavailable");
  }

  if (value.batchP99Ms === null || value.batchP99Ms === undefined) {
    pending.add("worker_batch_p99_unavailable");
  } else if (!Number.isFinite(value.batchP99Ms) || value.batchP99Ms < 0) {
    failed.add("worker_batch_p99_invalid");
  } else if (value.batchP99Ms > 60_000) {
    failed.add("worker_batch_p99_exceeded");
  }

  if (!Number.isInteger(value.sampleCount) || value.sampleCount < MIN_P99_SAMPLES) {
    pending.add("insufficient_samples_for_p99");
  }
  if (!Number.isInteger(value.batchSampleCount) || value.batchSampleCount < MIN_P99_SAMPLES) {
    pending.add("insufficient_worker_batch_samples_for_p99");
  }
  if (value.source.method !== "measured") pending.add("measurement_is_extrapolated");
  if (value.source.environment === "hosted"
    && (value.source.provider !== "real" || value.source.method !== "measured")) {
    pending.add("hosted_real_provider_measurement_required");
  }

  const count = value.candidatePairCount;
  if (count === null || count === undefined) pending.add("candidate_pair_count_unavailable");
  else if (!Number.isInteger(count) || count < 0) failed.add("candidate_pair_count_invalid");

  if (value.truncated === true) failed.add("candidate_pairs_truncated");
  if (value.scenario === "zero-pairs" && count !== null && count !== undefined && count !== 0) {
    failed.add("zero_pairs_scenario_has_candidates");
  }
  if (value.scenario === "multi-batch" && count !== null && count !== undefined && count <= 30) {
    failed.add("multi_batch_scenario_did_not_exceed_30_pairs");
  }
  if (value.scenario === "over-1000" && count !== null && count !== undefined && count <= 1_000) {
    failed.add("over_1000_scenario_did_not_exceed_1000_pairs");
  }
  if (value.scenario === "max-chunks" && value.chunkCount !== 10_000) {
    failed.add("max_chunks_scenario_incomplete");
  }
  if (value.scenario === "twenty-versions" && value.versionCount !== 20) {
    failed.add("twenty_versions_scenario_incomplete");
  }
  if (value.scenario === "multi-workspace" && value.workspaceCount < 2) {
    failed.add("multi_workspace_scenario_incomplete");
  }

  const reasonCodes = [...failed, ...pending];
  return {
    gate: failed.size > 0 ? "failed" : pending.size > 0 ? "pending" : "passed",
    reasonCodes,
  };
}

/** Capacity measurements never prove model relevance or AI output quality. */
/** @param {unknown} evidence */
export function supportsAiQualityEvidence(evidence) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return false;
  const value = /** @type {Record<string, any>} */ (evidence);
  return value.purpose === "ai-quality"
    && value.source?.environment === "hosted"
    && value.source?.provider === "real"
    && value.source?.method === "measured"
    && typeof value.qualityEvaluation?.corpusId === "string"
    && typeof value.qualityEvaluation?.expectedFindingsVersion === "string";
}
