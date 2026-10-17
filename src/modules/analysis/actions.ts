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
import { readAnalysisExecutionManifest } from "./execution-config";
import { AnalysisQueryError, createAnalysisEstimate } from "./queries";
import { selectionSchema } from "./schemas";

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

function mapEstimateQueryFailure(error: unknown): FailedResult {
  if (error instanceof AnalysisQueryError) {
    if (error.code === "42501") {
      return failure(
        "FORBIDDEN",
        "Only Admins and QA Leads can request an analysis estimate.",
      );
    }
    if (error.code === "22023" || error.code === "P0002") {
      return failure(
        "NOT_FOUND",
        "The selected documents are no longer available.",
      );
    }
  }
  const { correlationId } = reportEstimateFailure();
  return failure(
    "INTERNAL_ERROR",
    "We could not estimate this analysis. Try again.",
    correlationId,
  );
}

/**
 * Estimate with server-held configuration and an authoritative SQL snapshot.
 * The public DTO remains limited to the selected scope, price, reference, and
 * expiry; retrieval text, counts, and provider references stay server-side.
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

  const manifest = readAnalysisExecutionManifest(
    process.env.ANALYSIS_EXECUTION_MANIFEST,
  );
  if (!manifest) {
    const { correlationId } = reportEstimateFailure();
    return failure(
      "INTERNAL_ERROR",
      "Analysis estimation is temporarily unavailable.",
      correlationId,
    );
  }

  try {
    const estimate = await createAnalysisEstimate(
      actor.userId,
      {
        sourceVersionIds: sources,
        comparisonVersionIds: comparisons,
      },
      manifest,
    );
    return { ok: true, data: estimate };
  } catch (error) {
    return mapEstimateQueryFailure(error);
  }
}
