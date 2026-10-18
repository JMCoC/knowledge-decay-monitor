import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import {
  ANALYSIS_CAPACITY_SCENARIOS,
  evaluateCapacityGate,
  parseCapacityArgs,
} from "./analysis-capacity-policy.mjs";
import { disposeCapacityFixtures } from "./analysis-capacity-cleanup.mjs";
import { readLocalSupabaseRuntime } from "./local-supabase.mjs";
import { createAnalysisCapacityFixture } from "../tests/support/analysis-capacity-fixtures";
import { LocalSqlError } from "../tests/support/local-sql-session";
import { runBatch } from "../src/modules/analysis/worker/batch";
import { WORKER_LIMITS } from "../src/modules/analysis/worker/constants";
import type {
  AnalysisCandidatePair,
  AnalysisConfiguration,
  AnalysisExecutionManifest,
} from "../src/types/analysis-internal";
import type {
  AnalysisWorkerDb,
  ClaimedAnalysis,
  CheckpointState,
  LoadedContext,
} from "../src/modules/analysis/worker/types";
import { FakeAnalysisProvider } from "../supabase/functions/analyze/_test_doubles/analysis-provider.fake";

const PAGE_SIZE = 1_000;
const MAX_CANDIDATE_PAIRS = 100_000;
const SAMPLE_COUNT = 3;
const SQL_QUERY_TIMEOUT_MS = 40_000;
const KEYSET_MEASUREMENT_BUDGET_MS = 90_000;
const CAPACITY_MANIFEST: AnalysisExecutionManifest = {
  fingerprintVersion: "s2-05-v2",
  pricingVersion: "s2-04-v1",
  promptVersion: "capacity-local-v1",
  outputSchemaVersion: "capacity-local-v1",
  providers: {
    primary: { provider: "fake", model: "capacity" },
    fallback: { provider: "fake", model: "capacity" },
  },
};
const CAPACITY_CONFIGURATION: AnalysisConfiguration = {
  retrieval: {
    topK: 5,
    similarityThreshold: 0.75,
    chunksRevision: "capacity-local-v1",
    embeddingRevision: "gte-small-384-v1",
    fingerprint: "capacity-local-v1",
  },
  pricingVersion: "s2-04-v1",
  promptVersion: "capacity-local-v1",
  outputSchemaVersion: "capacity-local-v1",
  providers: CAPACITY_MANIFEST.providers,
};
const CAPACITY_CLAIM: ClaimedAnalysis = {
  id: "b0000000-0000-4000-8000-000000000001",
  workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  initiatorId: "10000000-0000-4000-8000-000000000001",
  operationId: "c0000000-0000-4000-8000-000000000001",
  attemptCount: 1,
  leaseExpiresAt: null,
  nextAttemptAt: null,
};
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface CandidatePair {
  source_version_id: string;
  comparison_version_id: string;
}

interface RetrievalMeasurement {
  candidatePairCount: number;
  transferBytes: number;
  truncated: boolean;
  versionIdsObserved: Set<string>;
}

interface WorkerSummaryMeasurement {
  chunkCount: number;
  candidatePairCount: number;
  chunksRevision: string;
  fingerprint: string;
  fixedCost: number;
}

interface WorkerPairPageRow {
  sourceChunkId: string;
  sourceVersionId: string;
  sourceDocumentId: string;
  comparisonChunkId: string;
  comparisonVersionId: string;
  comparisonDocumentId: string;
  lowChunkId: string;
  highChunkId: string;
  transferBytes: number;
}

interface WorkerRetrievalMeasurement {
  summarySampleCount: number;
  summaryFirstMs: number | null;
  summaryCachedMaxMs: number | null;
  summaryMaxMs: number | null;
  summary: WorkerSummaryMeasurement | null;
  summaryFingerprintMeasured: boolean;
  summaryFailureCode: string | null;
  keysetPageCount: number;
  keysetPairCount: number;
  keysetTransferBytes: number;
  keysetWallMs: number | null;
  keysetRetrievalComplete: boolean;
  keysetBudgetExceeded: boolean;
  pageFailureCode: string | null;
  firstPage: WorkerPairPageRow[];
}

function currentSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
  } catch {
    return "unknown";
  }
}

function currentWorkingTreeState() {
  try {
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return status.trim().length === 0 ? "clean" : "dirty";
  } catch {
    return "unknown";
  }
}

function supabaseCliVersion() {
  try {
    const packageInfo: unknown = JSON.parse(readFileSync(
      resolve(process.cwd(), "node_modules/supabase/package.json"),
      "utf8",
    ));
    if (typeof packageInfo === "object" && packageInfo !== null
      && "version" in packageInfo && typeof packageInfo.version === "string") {
      return packageInfo.version;
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

async function measureRetrieval(input: {
  fixture: Awaited<ReturnType<typeof createAnalysisCapacityFixture>>;
  workspaceId: string;
  versionIds: string[];
}): Promise<RetrievalMeasurement> {
  let offset = 0;
  let candidatePairCount = 0;
  let transferBytes = 0;
  let truncated = false;
  const versionIdsObserved = new Set<string>();
  while (true) {
    const { data, error } = await input.fixture.admin
      .rpc("retrieve_candidate_pairs", {
        p_workspace_id: input.workspaceId,
        p_source_version_ids: [input.versionIds[0]],
        p_comparison_version_ids: input.versionIds.slice(1),
        p_top_k: 5,
        p_threshold: 0.75,
      })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(`Local retrieval failed (${error.code ?? "unknown"}).`);

    const page = (data ?? []) as CandidatePair[];
    candidatePairCount += page.length;
    transferBytes += Buffer.byteLength(JSON.stringify(page));
    for (const row of page) {
      versionIdsObserved.add(row.source_version_id);
      versionIdsObserved.add(row.comparison_version_id);
    }
    if (page.length < PAGE_SIZE) break;
    offset += page.length;
    if (candidatePairCount >= MAX_CANDIDATE_PAIRS) {
      truncated = true;
      break;
    }
  }
  return { candidatePairCount, transferBytes, truncated, versionIdsObserved };
}

function sqlUuidArray(ids: string[]) {
  if (ids.some((id) => !UUID_PATTERN.test(id))) {
    throw new Error("Local capacity fixture returned an invalid version identifier.");
  }
  if (ids.length === 0) return "ARRAY[]::uuid[]";
  return `ARRAY[${ids.map((id) => `'${id}'::uuid`).join(",")}]::uuid[]`;
}

function sqlJson(value: unknown) {
  return `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
}

function workerSummarySql(fixture: Awaited<ReturnType<typeof createAnalysisCapacityFixture>>) {
  return `
    select chunk_count::text || '|' || candidate_pair_count::text || '|' ||
      chunks_revision || '|' || request_fingerprint || '|' || fixed_cost::text
    from private.analysis_retrieval_summary_for_run(
      '${fixture.analysisId}'::uuid,
      '${fixture.workspaceId}'::uuid,
      ${sqlUuidArray([fixture.versionIds[0] ?? ""])},
      ${sqlUuidArray(fixture.versionIds.slice(1))},
      ${sqlJson(CAPACITY_MANIFEST)}
    );
  `;
}

function parseWorkerSummary(raw: string): WorkerSummaryMeasurement {
  const row = raw.split(/\r?\n/).find((line) => line.length > 0);
  if (!row) throw new Error("Worker retrieval summary returned no row.");
  const [chunkCountText, pairCountText, chunksRevision, fingerprint, fixedCostText] = row.split("|");
  const chunkCount = Number(chunkCountText);
  const candidatePairCount = Number(pairCountText);
  const fixedCost = Number(fixedCostText);
  if (!Number.isInteger(chunkCount) || chunkCount < 0
    || !Number.isInteger(candidatePairCount) || candidatePairCount < 0
    || !Number.isInteger(fixedCost) || fixedCost < 0
    || !/^[0-9a-f]{64}$/.test(chunksRevision ?? "")
    || !/^[0-9a-f]{64}$/.test(fingerprint ?? "")) {
    throw new Error("Worker retrieval summary returned an invalid measurement.");
  }
  return { chunkCount, candidatePairCount, chunksRevision, fingerprint, fixedCost };
}

function workerPairPageSql(input: {
  fixture: Awaited<ReturnType<typeof createAnalysisCapacityFixture>>;
  afterLow: string | null;
  afterHigh: string | null;
}) {
  const low = input.afterLow === null ? "NULL" : `'${input.afterLow}'::uuid`;
  const high = input.afterHigh === null ? "NULL" : `'${input.afterHigh}'::uuid`;
  return `
    with page as (
      select * from private.analysis_candidate_pair_snapshot_page(
        '${input.fixture.analysisId}'::uuid,
        ${low}, ${high}, ${WORKER_LIMITS.N}
      )
    )
    select source_chunk_id::text || '|' || source_version_id::text || '|' ||
      source_document_id::text || '|' || comparison_chunk_id::text || '|' ||
      comparison_version_id::text || '|' || comparison_document_id::text || '|' ||
      pair_low_id::text || '|' || pair_high_id::text || '|' ||
      pg_catalog.octet_length(pg_catalog.to_jsonb(page)::text)::text
    from page
    order by pair_low_id, pair_high_id;
  `;
}

function parseWorkerPairPage(raw: string): WorkerPairPageRow[] {
  return raw.split(/\r?\n/).filter((line) => line.length > 0).map((line) => {
    const fields = line.split("|");
    const [sourceChunkId, sourceVersionId, sourceDocumentId, comparisonChunkId,
      comparisonVersionId, comparisonDocumentId, lowChunkId, highChunkId, bytesText] = fields;
    const ids = [sourceChunkId, sourceVersionId, sourceDocumentId, comparisonChunkId,
      comparisonVersionId, comparisonDocumentId, lowChunkId, highChunkId];
    const transferBytes = Number(bytesText);
    if (fields.length !== 9 || ids.some((id) => !id || !UUID_PATTERN.test(id))
      || !Number.isInteger(transferBytes) || transferBytes < 0) {
      throw new Error("Worker pair page returned an invalid measurement row.");
    }
    return {
      sourceChunkId: sourceChunkId as string,
      sourceVersionId: sourceVersionId as string,
      sourceDocumentId: sourceDocumentId as string,
      comparisonChunkId: comparisonChunkId as string,
      comparisonVersionId: comparisonVersionId as string,
      comparisonDocumentId: comparisonDocumentId as string,
      lowChunkId: lowChunkId as string,
      highChunkId: highChunkId as string,
      transferBytes,
    };
  });
}

function sqlFailureCode(error: unknown) {
  return error instanceof LocalSqlError
    ? error.sqlState ?? "local_sql_error"
    : error instanceof Error ? error.name : "unknown_error";
}

async function measureWorkerRetrieval(
  fixture: Awaited<ReturnType<typeof createAnalysisCapacityFixture>>,
): Promise<WorkerRetrievalMeasurement> {
  const summaryMeasurements: WorkerSummaryMeasurement[] = [];
  const summaryTimes: number[] = [];
  let summaryFailureCode: string | null = null;
  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    const startedAt = performance.now();
    try {
      summaryMeasurements.push(parseWorkerSummary(await fixture.sql.query(workerSummarySql(fixture))));
      summaryTimes.push(performance.now() - startedAt);
    } catch (error) {
      summaryFailureCode = sqlFailureCode(error);
      break;
    }
  }

  const summary = summaryMeasurements[0] ?? null;
  const stableSummary = summary !== null && summaryMeasurements.every((item) =>
    item.chunkCount === summary.chunkCount
      && item.candidatePairCount === summary.candidatePairCount
      && item.chunksRevision === summary.chunksRevision
      && item.fingerprint === summary.fingerprint
      && item.fixedCost === summary.fixedCost);
  if (summary && !stableSummary && !summaryFailureCode) summaryFailureCode = "unstable_summary";

  let keysetPageCount = 0;
  let keysetPairCount = 0;
  let keysetTransferBytes = 0;
  let keysetFailureCode: string | null = null;
  let keysetBudgetExceeded = false;
  let lastLow: string | null = null;
  let lastHigh: string | null = null;
  let previousCursor: { low: string; high: string } | null = null;
  let firstPage: WorkerPairPageRow[] = [];
  const keysetStartedAt = performance.now();

  if (summary) {
    while (keysetPairCount < summary.candidatePairCount) {
      if (performance.now() - keysetStartedAt >= KEYSET_MEASUREMENT_BUDGET_MS) {
        keysetBudgetExceeded = true;
        break;
      }
      let page: WorkerPairPageRow[];
      try {
        page = parseWorkerPairPage(await fixture.sql.query(workerPairPageSql({
          fixture,
          afterLow: lastLow,
          afterHigh: lastHigh,
        })));
      } catch (error) {
        keysetFailureCode = sqlFailureCode(error);
        break;
      }
      if (page.length === 0 || page.length > WORKER_LIMITS.N) {
        keysetFailureCode = page.length === 0 ? "empty_page_before_summary_count" : "page_limit_exceeded";
        break;
      }
      for (const row of page) {
        if (previousCursor && (row.lowChunkId < previousCursor.low
          || (row.lowChunkId === previousCursor.low && row.highChunkId <= previousCursor.high))) {
          keysetFailureCode = "page_cursor_not_increasing";
          break;
        }
        previousCursor = { low: row.lowChunkId, high: row.highChunkId };
      }
      if (keysetFailureCode) break;
      if (firstPage.length === 0) firstPage = page;
      keysetPageCount += 1;
      keysetPairCount += page.length;
      keysetTransferBytes += page.reduce((total, row) => total + row.transferBytes, 0);
      const last = page.at(-1);
      if (!last) break;
      lastLow = last.lowChunkId;
      lastHigh = last.highChunkId;
    }
  }

  const keysetWallMs = summary ? performance.now() - keysetStartedAt : null;
  return {
    summarySampleCount: summaryMeasurements.length,
    summaryFirstMs: summaryTimes[0] ?? null,
    summaryCachedMaxMs: summaryTimes.length > 1 ? Math.max(...summaryTimes.slice(1)) : null,
    summaryMaxMs: summaryTimes.length ? Math.max(...summaryTimes) : null,
    summary,
    summaryFingerprintMeasured: stableSummary,
    summaryFailureCode,
    keysetPageCount,
    keysetPairCount,
    keysetTransferBytes,
    keysetWallMs,
    keysetRetrievalComplete: Boolean(summary)
      && keysetPairCount === summary?.candidatePairCount
      && !keysetFailureCode
      && !keysetBudgetExceeded,
    keysetBudgetExceeded,
    pageFailureCode: keysetFailureCode,
    firstPage,
  };
}

function toAnalysisPair(row: WorkerPairPageRow): AnalysisCandidatePair {
  return {
    source: {
      documentId: row.sourceDocumentId,
      versionId: row.sourceVersionId,
      chunkId: row.sourceChunkId,
      role: "source",
      text: "Synthetic capacity benchmark chunk body.",
    },
    comparison: {
      documentId: row.comparisonDocumentId,
      versionId: row.comparisonVersionId,
      chunkId: row.comparisonChunkId,
      role: "comparison",
      text: "Synthetic capacity benchmark chunk body.",
    },
  };
}

function syntheticBatchPair(): WorkerPairPageRow {
  return {
    sourceChunkId: "40000000-0000-4000-8000-000000000001",
    sourceVersionId: "30000000-0000-4000-8000-000000000001",
    sourceDocumentId: "20000000-0000-4000-8000-000000000001",
    comparisonChunkId: "50000000-0000-4000-8000-000000000001",
    comparisonVersionId: "30000000-0000-4000-8000-000000000002",
    comparisonDocumentId: "20000000-0000-4000-8000-000000000002",
    lowChunkId: "40000000-0000-4000-8000-000000000001",
    highChunkId: "50000000-0000-4000-8000-000000000001",
    transferBytes: 0,
  };
}

async function measureWorkerBatch(
  rows: WorkerPairPageRow[],
  candidatePairCount: number | null,
) {
  const selectedRows = (rows.length > 0 ? rows : [syntheticBatchPair()]).slice(0, WORKER_LIMITS.N);
  const pairs = selectedRows.map(toAnalysisPair);
  const context: LoadedContext = {
    analysisId: CAPACITY_CLAIM.id,
    workspaceId: CAPACITY_CLAIM.workspaceId,
    sourceVersionIds: [],
    comparisonVersionIds: [],
    pairs,
    pairCursors: selectedRows.map((row) => ({ lowChunkId: row.lowChunkId, highChunkId: row.highChunkId })),
    cursor: null,
    fingerprint: "capacity-local-v1",
    chunkCount: pairs.length * 2,
    candidatePairCount: Math.max(candidatePairCount ?? 0, pairs.length),
  };
  const checkpoint: CheckpointState = {
    processedPairs: 0,
    totalPairs: context.candidatePairCount,
    findingsCount: 0,
    lastPairFingerprint: null,
    startedAt: new Date().toISOString(),
    cursor: null,
  };
  const client = {
    rpc: async () => ({ data: [], error: null }),
  } as unknown as AnalysisWorkerDb;
  const persistence = { persist: async () => ({ ok: true as const }) };
  const durations: number[] = [];
  let failureCode: string | null = null;

  for (let sample = 0; sample < 20; sample += 1) {
    const startedAt = performance.now();
    try {
      const result = await runBatch({
        claimed: CAPACITY_CLAIM,
        context,
        provider: new FakeAnalysisProvider(),
        client,
        persistence,
        configuration: CAPACITY_CONFIGURATION,
        checkpoint,
        heartbeatIntervalMs: 0,
        batchTimeoutMs: WORKER_LIMITS.MAX_BATCH_MS,
      });
      if (result.outcome.kind !== "completed" || result.outcome.processedPairs !== pairs.length) {
        failureCode = result.outcome.kind === "failed" ? result.outcome.code : "batch_not_completed";
        break;
      }
      durations.push(performance.now() - startedAt);
    } catch (error) {
      failureCode = error instanceof Error ? error.name : "unknown_error";
      break;
    }
  }

  const sorted = [...durations].sort((left, right) => left - right);
  const p99 = sorted.length > 0 ? sorted[Math.ceil(sorted.length * 0.99) - 1] ?? null : null;
  return {
    batchCount: pairs.length,
    batchSampleCount: durations.length,
    batchP99Ms: p99,
    workerBatchMeasured: durations.length === 20 && !failureCode,
    workerBatchFailureCode: failureCode,
  };
}

function hostedPending(scenario: keyof typeof ANALYSIS_CAPACITY_SCENARIOS) {
  const result = {
    purpose: "capacity",
    scenario,
    sha: currentSha(),
    runtime: "not measured",
    nodeVersion: process.version,
    supabaseCliVersion: supabaseCliVersion(),
    measuredAt: new Date().toISOString(),
    workingTree: currentWorkingTreeState(),
    limits: {
      wallClockMs: null,
      cpuMs: null,
      memoryBytes: null,
      attemptMs: WORKER_LIMITS.MAX_ATTEMPT_MS,
      analysisMs: WORKER_LIMITS.MAX_TOTAL_MS,
    },
    sampleCount: 0,
    versionCount: null,
    workspaceCount: null,
    chunkCount: null,
    candidatePairCount: null,
    transferBytes: null,
    wallMs: null,
    postgrestSampleCount: 0,
    postgrestCandidatePairCount: null,
    postgrestTransferBytes: null,
    postgrestWallMs: null,
    postgrestFailureCode: null,
    summarySampleCount: 0,
    summaryFirstMs: null,
    summaryCachedMaxMs: null,
    summaryMaxMs: null,
    keysetPageCount: 0,
    keysetPairCount: 0,
    keysetTransferBytes: null,
    keysetWallMs: null,
    keysetMeasurementBudgetMs: KEYSET_MEASUREMENT_BUDGET_MS,
    keysetBudgetExceeded: false,
    cpuMs: null,
    memoryBytes: null,
    batchP99Ms: null,
    batchCount: null,
    batchSampleCount: 0,
    attemptWallMs: null,
    analysisWallMs: null,
    summaryFingerprintMeasured: false,
    workerSummaryFailureCode: null,
    workerPageFailureCode: null,
    keysetRetrievalComplete: false,
    workerBatchMeasured: false,
    workerBatchFailureCode: null,
    truncated: false,
    source: { environment: "hosted", provider: "fake", method: "extrapolated" },
    gate: "pending",
    reasonCodes: ["hosted_measurement_not_authorized_or_configured"],
  };
  return result;
}

async function runLocal(scenario: keyof typeof ANALYSIS_CAPACITY_SCENARIOS) {
  const runtime = readLocalSupabaseRuntime();
  if (!runtime.serviceRoleKey) throw new Error("Local fixture cleanup capability is unavailable; refusing to start.");
  process.env.KDM_LOCAL_SUPABASE_URL = runtime.apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = runtime.publishableKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = runtime.serviceRoleKey ?? "";

  const shape = ANALYSIS_CAPACITY_SCENARIOS[scenario];
  const measuredAt = new Date().toISOString();
  const fixtures: Array<Awaited<ReturnType<typeof createAnalysisCapacityFixture>>> = [];
  try {
    for (let workspaceIndex = 0; workspaceIndex < shape.workspaceCount; workspaceIndex += 1) {
      fixtures.push(await createAnalysisCapacityFixture({
        versionCount: shape.versionCount,
        chunksPerVersion: shape.chunksPerVersion,
        sqlQueryTimeoutMs: SQL_QUERY_TIMEOUT_MS,
      }));
    }

    const sampleWallMs: number[] = [];
    const samplePairCounts: number[] = [];
    const sampleTransferBytes: number[] = [];
    let postgrestTruncated = false;
    let postgrestFailureCode: string | null = null;
    let postgrestFailedWallMs: number | null = null;
    let crossWorkspaceCandidates = 0;
    for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
      const startedAt = performance.now();
      let samplePairCount = 0;
      let sampleBytes = 0;
      for (const fixture of fixtures) {
        let measurement: RetrievalMeasurement;
        try {
          measurement = await measureRetrieval({
            fixture,
            workspaceId: fixture.workspaceId,
            versionIds: fixture.versionIds,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          const failure = message.match(/^Local retrieval failed \(([A-Z0-9_-]{1,32})\)\.$/);
          if (!failure) throw error;
          postgrestFailureCode = failure[1];
          postgrestFailedWallMs = performance.now() - startedAt;
          break;
        }
        if ([...measurement.versionIdsObserved].some((versionId) => !fixture.versionIds.includes(versionId))) {
          throw new Error("Local retrieval returned a version outside its fixture scope.");
        }
        samplePairCount += measurement.candidatePairCount;
        sampleBytes += measurement.transferBytes;
        postgrestTruncated ||= measurement.truncated;
      }
      if (postgrestFailureCode) break;
      samplePairCounts.push(samplePairCount);
      sampleTransferBytes.push(sampleBytes);
      sampleWallMs.push(performance.now() - startedAt);
    }

    if (!postgrestFailureCode && scenario === "multi-workspace" && fixtures.length === 2) {
      const ownFixture = fixtures[0];
      const foreignFixture = fixtures[1];
      const foreignRows = await measureRetrieval({
        fixture: ownFixture,
        workspaceId: foreignFixture.workspaceId,
        versionIds: foreignFixture.versionIds,
      });
      crossWorkspaceCandidates = foreignRows.candidatePairCount;
    }

    const postgrestCandidatePairCount = postgrestFailureCode ? null : samplePairCounts[0] ?? 0;
    if (!postgrestFailureCode && samplePairCounts.some((count) => count !== postgrestCandidatePairCount)) {
      postgrestFailureCode = "unstable_sample_count";
    }

    const workerMeasurements: WorkerRetrievalMeasurement[] = [];
    for (const fixture of fixtures) workerMeasurements.push(await measureWorkerRetrieval(fixture));
    const workerSummaries = workerMeasurements.map((measurement) => measurement.summary);
    const allSummariesMeasured = workerSummaries.length === fixtures.length
      && workerSummaries.every((summary): summary is WorkerSummaryMeasurement => summary !== null);
    const candidatePairCount = allSummariesMeasured
      ? workerSummaries.reduce((total, summary) => total + summary.candidatePairCount, 0)
      : null;
    const summaryFingerprintMeasured = workerMeasurements.length === fixtures.length
      && workerMeasurements.every((measurement) => measurement.summaryFingerprintMeasured);
    const workerSummaryFailureCode = workerMeasurements.find((measurement) => measurement.summaryFailureCode)
      ?.summaryFailureCode ?? null;
    const workerPageFailureCode = workerMeasurements.find((measurement) => measurement.pageFailureCode)
      ?.pageFailureCode ?? null;
    const summarySampleCount = workerMeasurements.reduce((total, measurement) => total + measurement.summarySampleCount, 0);
    const summaryMaxMs = workerMeasurements.some((measurement) => measurement.summaryMaxMs === null)
      ? null
      : Math.max(0, ...workerMeasurements.map((measurement) => measurement.summaryMaxMs ?? 0));
    const summaryFirstMs = workerMeasurements.every((measurement) => measurement.summaryFirstMs !== null)
      ? Math.max(0, ...workerMeasurements.map((measurement) => measurement.summaryFirstMs ?? 0))
      : null;
    const summaryCachedMaxMs = workerMeasurements.every((measurement) => measurement.summaryCachedMaxMs !== null)
      ? Math.max(0, ...workerMeasurements.map((measurement) => measurement.summaryCachedMaxMs ?? 0))
      : null;
    const summaryWallMs = workerMeasurements.every((measurement) => measurement.summaryMaxMs !== null)
      ? workerMeasurements.reduce((total, measurement) => total + (measurement.summaryMaxMs ?? 0), 0)
      : null;
    const keysetPageCount = workerMeasurements.reduce((total, measurement) => total + measurement.keysetPageCount, 0);
    const keysetPairCount = workerMeasurements.reduce((total, measurement) => total + measurement.keysetPairCount, 0);
    const keysetTransferBytes = workerMeasurements.reduce((total, measurement) => total + measurement.keysetTransferBytes, 0);
    const keysetWallMs = workerMeasurements.every((measurement) => measurement.keysetWallMs !== null)
      ? workerMeasurements.reduce((total, measurement) => total + (measurement.keysetWallMs ?? 0), 0)
      : null;
    const keysetRetrievalComplete = workerMeasurements.length === fixtures.length
      && workerMeasurements.every((measurement) => measurement.keysetRetrievalComplete);
    const keysetBudgetExceeded = workerMeasurements.some((measurement) => measurement.keysetBudgetExceeded);
    const workerBatch = await measureWorkerBatch(
      workerMeasurements[0]?.firstPage ?? [],
      workerMeasurements[0]?.summary?.candidatePairCount ?? candidatePairCount,
    );
    const retrievalCountMismatch = postgrestCandidatePairCount !== null
      && candidatePairCount !== null
      && postgrestCandidatePairCount !== candidatePairCount;
    const workerReadWallMs = summaryWallMs === null || keysetWallMs === null
      ? null
      : summaryWallMs + keysetWallMs;

    const base = {
      purpose: "capacity",
      scenario,
      sha: currentSha(),
      runtime: "local Postgres candidate snapshot materialization/cache + keyset SQL + analysis runBatch with fake provider",
      nodeVersion: process.version,
      supabaseCliVersion: supabaseCliVersion(),
      measuredAt,
      workingTree: currentWorkingTreeState(),
      limits: {
        wallClockMs: null,
        cpuMs: null,
        memoryBytes: null,
        attemptMs: WORKER_LIMITS.MAX_ATTEMPT_MS,
        analysisMs: WORKER_LIMITS.MAX_TOTAL_MS,
      },
      sampleCount: summarySampleCount,
      versionCount: shape.versionCount,
      workspaceCount: shape.workspaceCount,
      chunkCount: shape.versionCount * shape.chunksPerVersion * shape.workspaceCount,
      candidatePairCount,
      transferBytes: keysetRetrievalComplete ? keysetTransferBytes : null,
      wallMs: workerReadWallMs,
      postgrestSampleCount: sampleWallMs.length,
      postgrestCandidatePairCount,
      postgrestTransferBytes: sampleTransferBytes.length ? Math.max(...sampleTransferBytes) : null,
      postgrestWallMs: sampleWallMs.length ? Math.max(...sampleWallMs) : postgrestFailedWallMs,
      postgrestFailureCode,
      summarySampleCount,
      summaryFirstMs,
      summaryCachedMaxMs,
      summaryMaxMs,
      keysetPageCount,
      keysetPairCount,
      keysetTransferBytes: keysetRetrievalComplete ? keysetTransferBytes : null,
      keysetWallMs,
      keysetMeasurementBudgetMs: KEYSET_MEASUREMENT_BUDGET_MS,
      keysetBudgetExceeded,
      cpuMs: null,
      memoryBytes: null,
      batchP99Ms: workerBatch.batchP99Ms,
      batchCount: workerBatch.batchCount,
      batchSampleCount: workerBatch.batchSampleCount,
      attemptWallMs: null,
      analysisWallMs: null,
      summaryFingerprintMeasured,
      workerSummaryFailureCode,
      workerPageFailureCode,
      keysetRetrievalComplete,
      workerBatchMeasured: workerBatch.workerBatchMeasured,
      workerBatchFailureCode: workerBatch.workerBatchFailureCode,
      retrievalCountMismatch,
      postgrestTruncated,
      truncated: false,
      source: { environment: "local", provider: "fake", method: "measured" },
    };
    const policy = evaluateCapacityGate(base);
    const result = {
      ...base,
      crossWorkspaceCandidateCount: scenario === "multi-workspace" ? crossWorkspaceCandidates : null,
      gate: crossWorkspaceCandidates > 0 ? "failed" : policy.gate,
      reasonCodes: [
        ...policy.reasonCodes,
        ...(crossWorkspaceCandidates > 0 ? ["cross_workspace_candidates_visible"] : []),
      ],
    };
    return result;
  } finally {
    await disposeCapacityFixtures(fixtures);
  }
}

async function main() {
  const { target, scenario } = parseCapacityArgs(process.argv.slice(2)) as {
    target: "local" | "hosted";
    scenario: keyof typeof ANALYSIS_CAPACITY_SCENARIOS;
  };
  const result = target === "hosted" ? hostedPending(scenario) : await runLocal(scenario);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.gate === "passed" ? 0 : result.gate === "failed" ? 1 : 2;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  const reason = /^Local retrieval failed \([A-Z0-9_-]{1,32}\)\.$/.test(message)
    ? message
    : error instanceof Error ? error.name : "UnknownError";
  process.stderr.write(`Analysis capacity measurement stopped safely (${reason}).\n`);
  process.exitCode = 1;
});
