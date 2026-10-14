"use server";

import { IdentityError, requireDocumentActor } from "@/modules/identity";
import { captureOperationFailure } from "@/lib/observability/operation-events";
import type {
  ActionError,
  ActionErrorCode,
  ActionResult,
  AnalysisEstimate,
  AnalysisSelectionInput,
} from "@/types/contracts";
import {
  buildChunksRevision,
  computeRequestFingerprint,
} from "./retrieval";
import { ANALYSIS_PRICING, computeFixedCost } from "./pricing";
import { selectionSchema } from "./schemas";
import {
  callRetrieveCandidatePairs,
  getEligibleVersions,
  insertEstimate,
} from "./queries";

const ESTIMATE_TTL_MS = 30 * 60 * 1000;

type FailedResult = { ok: false; error: ActionError };

function failure(code: ActionErrorCode, message: string, correlationId?: string): FailedResult {
  return { ok: false, error: { code, message, ...(correlationId ? { correlationId } : {}) } };
}

/** Reports an internal estimate failure using the closed telemetry catalog. */
function reportEstimateFailure(): { correlationId: string } {
  const correlationId = crypto.randomUUID();
  try {
    captureOperationFailure({
      module: "analysis",
      operation: "estimate",
      code: "INTERNAL_ERROR",
      correlationId,
    });
  } catch {
    // Telemetry must not change the controlled product result.
  }
  return { correlationId };
}

function identityFailure(error: unknown): FailedResult {
  if (error instanceof IdentityError) {
    switch (error.code) {
      case "UNAUTHENTICATED":
        return failure("UNAUTHENTICATED", "Please sign in to continue.");
      case "FORBIDDEN":
      case "WORKSPACE_REQUIRED":
        return failure(
          "FORBIDDEN",
          "Only Admins and QA Leads can request an analysis estimate.",
        );
      default:
        break;
    }
  }
  const { correlationId } = reportEstimateFailure();
  return failure(
    "INTERNAL_ERROR",
    "We could not verify your workspace. Try again.",
    correlationId,
  );
}

/**
 * Bounded retrieval estimate (contract §§1-2, 8-9). Session-scoped end to
 * end: no service_role, no credit reservation, no LLM. Retrieved pairs are
 * counted, hashed into the fingerprint, and discarded; the estimate row is
 * the only effect.
 */
export async function estimateAnalysis(
  input: AnalysisSelectionInput,
): Promise<ActionResult<AnalysisEstimate>> {
  let actor;
  try {
    actor = await requireDocumentActor();
  } catch (error) {
    return identityFailure(error);
  }

  const parsed = selectionSchema.safeParse(input);
  if (!parsed.success) {
    const duplicates = parsed.error.issues.some((issue) => issue.code === "custom");
    return failure(
      "INVALID_INPUT",
      duplicates
        ? "Duplicates within the same list are not allowed."
        : "Select between 1 and 20 source documents.",
    );
  }

  const sources = [...parsed.data.sourceVersionIds].sort();
  const comparisons = [...parsed.data.comparisonVersionIds].sort();
  const distinctScopeSize = new Set([...sources, ...comparisons]).size;
  if (distinctScopeSize > 20) {
    return failure(
      "INVALID_INPUT",
      "Analysis scope cannot exceed 20 distinct versions.",
    );
  }

  let eligible: Set<string>;
  try {
    eligible = await getEligibleVersions([...sources, ...comparisons]);
  } catch {
    const { correlationId } = reportEstimateFailure();
    return failure(
      "INTERNAL_ERROR",
      "We could not load the selected documents. Try again.",
      correlationId,
    );
  }
  if (eligible.size !== new Set([...sources, ...comparisons]).size) {
    return failure(
      "NOT_FOUND",
      "The selected documents are no longer available.",
    );
  }

  let pairs;
  try {
    pairs = await callRetrieveCandidatePairs(actor.workspaceId, sources, comparisons);
  } catch {
    const { correlationId } = reportEstimateFailure();
    return failure(
      "INTERNAL_ERROR",
      "We could not estimate this analysis. Try again.",
      correlationId,
    );
  }

  const uniqueChunkIds = new Set<string>();
  for (const pair of pairs) {
    uniqueChunkIds.add(pair.source_chunk_id);
    uniqueChunkIds.add(pair.comparison_chunk_id);
  }
  const chunkIds = [...uniqueChunkIds].sort();
  const chunkCount = uniqueChunkIds.size;
  const candidatePairCount = pairs.length;
  const fixedCost = computeFixedCost(chunkCount, candidatePairCount);
  const pairInputs = pairs.map((pair) => ({
    sourceChunkId: pair.source_chunk_id,
    comparisonChunkId: pair.comparison_chunk_id,
  }));
  const chunksRevision = buildChunksRevision(chunkIds);
  const fingerprint = computeRequestFingerprint({
    chunkCount,
    candidatePairCount,
    sortedSourceVersionIds: sources,
    sortedComparisonVersionIds: comparisons,
    pairs: pairInputs,
    chunkIds,
  });
  const retrievalConfig = {
    topK: 5,
    similarityThreshold: 0.75,
    chunksRevision,
    embeddingRevision: "gte-small-384-v1",
    fingerprint,
  };
  const expiresAt = new Date(Date.now() + ESTIMATE_TTL_MS).toISOString();

  let estimateId: string;
  try {
    ({ id: estimateId } = await insertEstimate({
      workspaceId: actor.workspaceId,
      initiatorId: actor.userId,
      sourceVersionIds: sources,
      comparisonVersionIds: comparisons,
      requestFingerprint: fingerprint,
      retrievalConfig,
      chunkCount,
      candidatePairCount,
      fixedCost,
      pricingVersion: ANALYSIS_PRICING.version,
      expiresAt,
    }));
  } catch {
    const { correlationId } = reportEstimateFailure();
    return failure(
      "INTERNAL_ERROR",
      "We could not save this estimate. Try again.",
      correlationId,
    );
  }

  return {
    ok: true,
    data: {
      sourceVersionIds: sources,
      comparisonVersionIds: comparisons,
      estimateRef: estimateId,
      fixedCost,
      expiresAt,
    },
  };
}
