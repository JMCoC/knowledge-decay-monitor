"use server";

import type {
  ActionResult,
  AnalysisPage,
  AnalysisSelectionItem,
  EligibleDocumentsQuery,
  AnalysisSelectionInput,
  AnalysisEstimate,
} from "@/types/contracts";
import { requireDocumentActor, IdentityError } from "@/modules/identity";
import { createReadOnlyClient } from "@/lib/supabase/server";
import { captureOperationFailure } from "@/lib/observability/operation-events";
import { estimateAnalysis } from "@/modules/analysis/actions";
import {
  listEligibleDocumentsService,
  resolveFilteredScopeService,
  validateAnalysisScopeService,
} from "./analysis.service";

type AnalysisOperation = "selection" | "scope_validation";

function reportInternalFailure<T>(operation: AnalysisOperation, message: string): ActionResult<T> {
  const correlationId = crypto.randomUUID();
  try {
    captureOperationFailure({ module: "analysis", operation, code: "INTERNAL_ERROR", correlationId });
  } catch {
    // Telemetry must not change the controlled product result.
  }
  return { ok: false, error: { code: "INTERNAL_ERROR", message, correlationId } };
}

function withReportedInternalFailure<T>(
  result: ActionResult<T>,
  operation: AnalysisOperation,
): ActionResult<T> {
  if (result.ok || result.error.code !== "INTERNAL_ERROR" || result.error.correlationId) return result;
  return reportInternalFailure(operation, result.error.message);
}

function mapIdentityError(error: unknown, operation: AnalysisOperation): ActionResult<never> | null {
  if (error instanceof IdentityError) {
    if (error.code === "INTERNAL_ERROR") {
      return reportInternalFailure(operation, "We couldn't verify your access to analysis.");
    }
    const code = error.code === "WORKSPACE_REQUIRED" ? "FORBIDDEN" : error.code;
    return {
      ok: false,
      error: {
        code: code as "UNAUTHENTICATED" | "FORBIDDEN",
        message: code === "UNAUTHENTICATED" ? "Please sign in to access analysis." : "You don't have permission to perform document analysis.",
      },
    };
  }
  return null;
}

export async function listEligibleDocumentsAction(
  query: EligibleDocumentsQuery = {},
): Promise<ActionResult<AnalysisPage<AnalysisSelectionItem>>> {
  try {
    await requireDocumentActor();
    const supabase = await createReadOnlyClient();
    return withReportedInternalFailure(await listEligibleDocumentsService(supabase, query), "selection");
  } catch (error) {
    const mapped = mapIdentityError(error, "selection");
    if (mapped) return mapped;
    return reportInternalFailure("selection", "An unexpected error occurred.");
  }
}

export async function resolveFilteredScopeAction(
  input: {
    query: EligibleDocumentsQuery;
    targetRole: "source" | "comparison";
    currentSourceVersionIds: string[];
    currentComparisonVersionIds: string[];
  },
): Promise<ActionResult<{ versionIds: string[]; totalUnion: number }>> {
  try {
    await requireDocumentActor();
    const supabase = await createReadOnlyClient();
    return withReportedInternalFailure(await resolveFilteredScopeService(supabase, input), "selection");
  } catch (error) {
    const mapped = mapIdentityError(error, "selection");
    if (mapped) return mapped;
    return reportInternalFailure("selection", "An unexpected error occurred.");
  }
}

export async function validateAnalysisScopeAction(
  input: AnalysisSelectionInput,
): Promise<ActionResult<{ distinctCount: number; isInternalOnly: boolean }>> {
  try {
    await requireDocumentActor();
    const supabase = await createReadOnlyClient();
    return withReportedInternalFailure(await validateAnalysisScopeService(supabase, input), "scope_validation");
  } catch (error) {
    const mapped = mapIdentityError(error, "scope_validation");
    if (mapped) return mapped;
    return reportInternalFailure("scope_validation", "An unexpected error occurred.");
  }
}

export async function estimateAnalysisAction(
  input: AnalysisSelectionInput,
): Promise<ActionResult<AnalysisEstimate>> {
  try {
    await requireDocumentActor();
    const supabase = await createReadOnlyClient();
    const validation = withReportedInternalFailure(
      await validateAnalysisScopeService(supabase, input),
      "scope_validation",
    );
    if (!validation.ok) return validation;
    // S2-03 keeps the 20-version union guard; S2-04 performs the authoritative
    // session, eligibility, retrieval, pricing, and estimate persistence flow.
    return estimateAnalysis(input);
  } catch (error) {
    const mapped = mapIdentityError(error, "scope_validation");
    if (mapped) return mapped;
    return reportInternalFailure("scope_validation", "An unexpected error occurred.");
  }
}
