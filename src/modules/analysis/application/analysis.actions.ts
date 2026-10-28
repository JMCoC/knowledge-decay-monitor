"use server";

import type {
  ActionResult,
  AnalysisPage,
  AnalysisSelectionItem,
  EligibleDocumentsQuery,
  AnalysisSelectionInput,
  AnalysisEstimate,
  AnalysisSnapshot,
} from "@/types/contracts";
import { requireDocumentActor, IdentityError } from "@/modules/identity";
import { createReadOnlyClient } from "@/lib/supabase/server";
import { z } from "zod";
import { captureOperationFailure } from "@/lib/observability/operation-events";
import { estimateAnalysis } from "@/modules/analysis/actions";
import {
  listEligibleDocumentsService,
  resolveFilteredScopeService,
  validateAnalysisScopeService,
} from "./analysis.service";

type AnalysisOperation = "selection" | "scope_validation";

const analysisIdSchema = z.string().uuid();

async function readAnalysisSnapshot(analysisId?: string): Promise<ActionResult<AnalysisSnapshot | null>> {
  try {
    await requireDocumentActor();
    if (analysisId !== undefined && !analysisIdSchema.safeParse(analysisId).success) {
      return { ok: false, error: { code: "INVALID_INPUT", message: "The analysis ID is invalid." } };
    }
    const client = await createReadOnlyClient();
    let query = client.from("analysis_runs").select("id,status,fixed_cost,initiator_id,initiator_full_name,created_at,started_at,finished_at,retry_of_analysis_id,public_error_code");
    if (analysisId) query = query.eq("id", analysisId);
    else query = query.in("status", ["queued", "processing"]).order("created_at", { ascending: false }).limit(1);
    const { data: run, error } = await query.maybeSingle();
    if (error) return reportInternalFailure("selection", "We couldn't load this analysis.");
    if (!run || !run.id || !run.status || run.fixed_cost === null || !run.initiator_id || !run.initiator_full_name || !run.created_at) {
      return { ok: true, data: null };
    }
    const { data: scope, error: scopeError } = await client.from("analysis_scope")
      .select("document_id,version_id,version_number,document_name,document_category,owner_id,owner_full_name,role")
      .eq("analysis_id", run.id);
    if (scopeError || !scope) return reportInternalFailure("selection", "We couldn't load this analysis.");
    const sources = scope.filter((row) => row.role === "source");
    const comparisons = scope.filter((row) => row.role === "comparison");
    let canRetry = false;
    if (run.status === "failed") {
      const { data: release, error: releaseError } = await client.from("credit_ledger")
        .select("amount")
        .eq("analysis_id", run.id)
        .eq("event_type", "Released")
        .maybeSingle();
      if (releaseError) return reportInternalFailure("selection", "We couldn't verify credit release for this analysis.");
      canRetry = release?.amount === run.fixed_cost;
    }
    const toItems = (rows: typeof scope) => rows.flatMap((row) => {
      if (!row.document_id || !row.version_id || row.version_number === null || !row.document_name || !row.document_category) return [];
      return [{ documentId: row.document_id, versionId: row.version_id, versionNumber: row.version_number,
        name: row.document_name, category: row.document_category,
        owner: row.owner_id && row.owner_full_name ? { id: row.owner_id, fullName: row.owner_full_name } : null }];
    });
    const result: AnalysisSnapshot = {
      analysisId: run.id, status: run.status, fixedCost: run.fixed_cost,
      initiator: { id: run.initiator_id, fullName: run.initiator_full_name },
      sources: toItems(sources), comparisons: toItems(comparisons), createdAt: run.created_at,
      startedAt: run.started_at, finishedAt: run.finished_at, retryOfAnalysisId: run.retry_of_analysis_id,
      error: run.public_error_code === "ANALYSIS_FAILED"
        ? { code: "ANALYSIS_FAILED", message: "This analysis failed." }
        : null,
      canRetry,
    };
    return { ok: true, data: result };
  } catch (error) {
    const mapped = mapIdentityError(error, "selection");
    return mapped ?? reportInternalFailure("selection", "We couldn't verify your access to analysis.");
  }
}

export async function getAnalysisAction(analysisId: string): Promise<ActionResult<AnalysisSnapshot>> {
  const result = await readAnalysisSnapshot(analysisId);
  if (!result.ok) return result;
  return result.data ? { ok: true, data: result.data } : { ok: false, error: { code: "NOT_FOUND", message: "This analysis is unavailable." } };
}

export async function getActiveAnalysisAction(): Promise<ActionResult<AnalysisSnapshot | null>> {
  return readAnalysisSnapshot();
}

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
