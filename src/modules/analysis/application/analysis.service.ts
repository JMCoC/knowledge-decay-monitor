import type {
  ActionResult,
  AnalysisPage,
  AnalysisSelectionItem,
  EligibleDocumentsQuery,
  AnalysisSelectionInput,
} from "@/types/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import {
  findEligibleDocuments,
  resolveEligibleVersionIds,
  verifyVersionsEligibility,
} from "../infrastructure/analysis.repository";
import { eligibleDocumentsQuerySchema, analysisSelectionInputSchema, resolveFilteredScopeSchema } from "../schemas";

export function calculateDistinctScopeUnion(sources: string[], comparisons: string[]): string[] {
  return Array.from(new Set([...sources, ...comparisons]));
}
export function validateScopeLimit(distinctVersionIds: string[]): ActionResult<{ distinctCount: number }> {
  if (distinctVersionIds.length > 20) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: `Analysis scope contains ${distinctVersionIds.length} versions, which exceeds the maximum limit of 20 distinct versions.`,
      },
    };
  }
  return { ok: true, data: { distinctCount: distinctVersionIds.length } };
}

export async function listEligibleDocumentsService(
  supabase: SupabaseClient<Database>,
  query: EligibleDocumentsQuery,
): Promise<ActionResult<AnalysisPage<AnalysisSelectionItem>>> {
  const parsed = eligibleDocumentsQuerySchema.safeParse(query);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "INVALID_INPUT", message: "The document query filters are invalid." },
    };
  }
  try {
    const result = await findEligibleDocuments(supabase, parsed.data);
    const items: AnalysisSelectionItem[] = result.data
      .filter(
        (row) =>
          row.document_id !== null &&
          row.version_id !== null &&
          row.version_number !== null &&
          row.name !== null &&
          row.category !== null,
      )
      .map((row) => ({
        documentId: row.document_id as string,
        versionId: row.version_id as string,
        versionNumber: row.version_number as number,
        name: row.name as string,
        category: row.category as import("@/types/contracts").DocumentCategory,
        owner: row.owner_profile_id ? { id: row.owner_profile_id, fullName: row.owner_full_name ?? "" } : null,
      }));
    return {
      ok: true,
      data: {
        items,
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
      },
    };
  } catch {
    return {
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "We couldn't retrieve eligible documents. Please try again." },
    };
  }
}

export async function resolveFilteredScopeService(
  supabase: SupabaseClient<Database>,
  input: {
    query: EligibleDocumentsQuery;
    targetRole: "source" | "comparison";
    currentSourceVersionIds: string[];
    currentComparisonVersionIds: string[];
  },
): Promise<ActionResult<{ versionIds: string[]; totalUnion: number }>> {
  try {
    const parsed = resolveFilteredScopeSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: { code: "INVALID_INPUT", message: "The document selection is invalid." } };
    }
    const currentSources = Array.from(new Set(parsed.data.currentSourceVersionIds));
    const currentComparisons = Array.from(new Set(parsed.data.currentComparisonVersionIds));
    const currentUnion = calculateDistinctScopeUnion(currentSources, currentComparisons);
    if (currentUnion.length > 20) {
      return { ok: false, error: { code: "INVALID_INPUT", message: "Analysis scope cannot exceed 20 distinct versions." } };
    }
    const eligibleCurrentIds = await verifyVersionsEligibility(supabase, currentUnion);
    if (eligibleCurrentIds.length !== currentUnion.length) {
      return {
        ok: false,
        error: { code: "INVALID_INPUT", message: "One or more selected documents are not eligible for analysis." },
      };
    }

    const resolvedIds = await resolveEligibleVersionIds(supabase, parsed.data.query);
    const nextSources = parsed.data.targetRole === "source"
      ? Array.from(new Set([...currentSources, ...resolvedIds]))
      : currentSources;
    const nextComparisons = parsed.data.targetRole === "comparison"
      ? Array.from(new Set([...currentComparisons, ...resolvedIds]))
      : currentComparisons;
    const combinedUnion = calculateDistinctScopeUnion(nextSources, nextComparisons);
    if (combinedUnion.length > 20) {
      return {
        ok: false,
        error: {
          code: "INVALID_INPUT",
          message: `The filtered selection contains ${resolvedIds.length} versions, which would result in ${combinedUnion.length} total versions (exceeding the limit of 20).`,
        },
      };
    }
    return { ok: true, data: { versionIds: resolvedIds, totalUnion: combinedUnion.length } };
  } catch {
    return {
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "Failed to resolve filtered documents." },
    };
  }
}

export async function validateAnalysisScopeService(
  supabase: SupabaseClient<Database>,
  input: AnalysisSelectionInput,
): Promise<ActionResult<{ distinctCount: number; isInternalOnly: boolean }>> {
  const parsed = analysisSelectionInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "INVALID_INPUT", message: parsed.error.issues[0]?.message ?? "Invalid selection." },
    };
  }
  const distinctIds = calculateDistinctScopeUnion(parsed.data.sourceVersionIds, parsed.data.comparisonVersionIds);
  const limitCheck = validateScopeLimit(distinctIds);
  if (!limitCheck.ok) return limitCheck;

  try {
    const validIds = await verifyVersionsEligibility(supabase, distinctIds);
    if (validIds.length !== distinctIds.length) {
      return {
        ok: false,
        error: { code: "INVALID_INPUT", message: "One or more selected documents are not eligible for analysis." },
      };
    }
    return {
      ok: true,
      data: {
        distinctCount: distinctIds.length,
        isInternalOnly: parsed.data.comparisonVersionIds.length === 0,
      },
    };
  } catch {
    return {
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "Failed to validate analysis scope." },
    };
  }
}
