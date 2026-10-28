import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { EligibleDocumentsQuery, FindingsQuery } from "@/types/contracts";
import { eligibleDocumentsQuerySchema } from "../schemas";

type DbClient = SupabaseClient<Database>;

export function escapeLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

async function countEligibleDocuments(supabase: DbClient, query: EligibleDocumentsQuery) {
  let request = supabase
    .from("eligible_analysis_documents")
    .select("document_id", { count: "exact", head: true });

  if (query.name) request = request.ilike("name", `%${escapeLikeLiteral(query.name)}%`);
  if (query.category) request = request.eq("category", query.category);
  if (query.ownerId !== undefined) {
    request = query.ownerId === null ? request.is("owner_id", null) : request.eq("owner_id", query.ownerId);
  }

  return request;
}

export async function findEligibleDocuments(supabase: DbClient, query: EligibleDocumentsQuery) {
  const parsed = eligibleDocumentsQuerySchema.parse(query);
  const { page, pageSize } = parsed;
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let request = supabase
    .from("eligible_analysis_documents")
    .select(
      "document_id,name,category,owner_id,owner_profile_id,owner_full_name,version_id,version_number,analysis_status,created_at",
      { count: "exact" },
    )
    .order("created_at", { ascending: false })
    .order("document_id", { ascending: false })
    .range(from, to);

  if (parsed.name) request = request.ilike("name", `%${escapeLikeLiteral(parsed.name)}%`);
  if (parsed.category) request = request.eq("category", parsed.category);
  if (parsed.ownerId !== undefined) {
    request = parsed.ownerId === null ? request.is("owner_id", null) : request.eq("owner_id", parsed.ownerId);
  }

  const { data, error, count } = await request;
  if (error?.code === "PGRST103") {
    const { count: total, error: countError } = await countEligibleDocuments(supabase, parsed);
    if (countError) throw new Error("Eligible documents count query failed.");
    return { data: [], total: total ?? 0, page, pageSize };
  }
  if (error) throw new Error("Eligible documents query failed.");
  return { data: data ?? [], total: count ?? 0, page, pageSize };
}

export async function resolveEligibleVersionIds(supabase: DbClient, query: EligibleDocumentsQuery): Promise<string[]> {
  const parsed = eligibleDocumentsQuerySchema.parse(query);
  // At most 21 IDs are needed: >20 matching rows cannot fit in a scope whose
  // other list is capped at 20. This bounded probe avoids PostgREST row limits
  // turning bulk selection into a partial selection that appears successful.
  let request = supabase.from("eligible_analysis_documents").select("version_id", { count: "exact" });

  if (parsed.name) request = request.ilike("name", `%${escapeLikeLiteral(parsed.name)}%`);
  if (parsed.category) request = request.eq("category", parsed.category);
  if (parsed.ownerId !== undefined) {
    request = parsed.ownerId === null ? request.is("owner_id", null) : request.eq("owner_id", parsed.ownerId);
  }

  request = request.range(0, 20);
  const { data, error } = await request;
  if (error) throw new Error("Failed to resolve eligible version IDs.");
  return (data ?? []).filter((row) => row.version_id !== null).map((row) => row.version_id as string);
}

export async function verifyVersionsEligibility(supabase: DbClient, versionIds: string[]): Promise<string[]> {
  if (versionIds.length === 0) return [];
  const { data, error } = await supabase
    .from("eligible_analysis_documents")
    .select("version_id")
    .in("version_id", versionIds);
  if (error) throw new Error("Failed to verify version eligibility.");
  return (data ?? []).filter((row) => row.version_id !== null).map((row) => row.version_id as string);
}

export interface FindFindingsParams {
  workspaceId: string;
  analysisId: FindingsQuery["analysisId"];
  type?: FindingsQuery["type"];
  severity?: FindingsQuery["severity"];
  status?: FindingsQuery["status"];
  assignee?: FindingsQuery["assignee"];
  offset: number;
  limit: number;
}

export async function findFindingsByAnalysis(
  supabase: DbClient,
  params: FindFindingsParams,
) {
  let query = supabase
    .from("analysis_findings")
    .select(
      "id, workspace_id, analysis_id, type, severity_original, severity_current, explanation, status, created_at, updated_at",
      { count: "exact" },
    )
    .eq("workspace_id", params.workspaceId)
    .eq("analysis_id", params.analysisId);

  if (params.type) {
    query = query.eq("type", params.type);
  }
  if (params.severity) {
    query = query.eq("severity_current", params.severity);
  }
  if (params.status) {
    query = query.eq("status", params.status);
  }

  // S2 exposes only unassigned findings. The validated `all` and `unassigned`
  // options therefore return the same set until assignment is introduced in S3.
  void params.assignee;

  query = query
    .order("severity_current", { ascending: true })
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(params.offset, params.offset + params.limit - 1);

  const { data, error, count } = await query;
  if (error) {
    throw new Error("Failed to query analysis findings.");
  }

  return {
    data: data ?? [],
    total: count ?? 0,
  };
}

export async function findFindingWithEvidence(
  supabase: DbClient,
  params: { workspaceId: string; findingId: string },
) {
  const { data: finding, error: findingError } = await supabase
    .from("analysis_findings")
    .select("id, workspace_id, analysis_id, type, severity_original, severity_current, explanation, status, created_at, updated_at")
    .eq("workspace_id", params.workspaceId)
    .eq("id", params.findingId)
    .maybeSingle();

  if (findingError || !finding) {
    return null;
  }

  const { data: evidenceRows, error: evidenceError } = await supabase
    .from("analysis_finding_evidence")
    .select(`
      id,
      workspace_id,
      analysis_id,
      finding_id,
      document_id,
      version_id,
      chunk_id,
      page_number,
      section,
      section_heading,
      snapshot
    `)
    .eq("workspace_id", params.workspaceId)
    .eq("finding_id", params.findingId);

  if (evidenceError) {
    throw new Error("Failed to query finding evidence.");
  }

  const rows = evidenceRows ?? [];
  const documentIds = [...new Set(rows.flatMap((row) => row.document_id ? [row.document_id] : []))];
  const versionIds = [...new Set(rows.flatMap((row) => row.version_id ? [row.version_id] : []))];
  const [documentsResult, versionsResult] = await Promise.all([
    documentIds.length
      ? supabase
          .from("documents")
          .select("id, name")
          .eq("workspace_id", params.workspaceId)
          .in("id", documentIds)
      : Promise.resolve({ data: [], error: null }),
    versionIds.length
      ? supabase
          .from("document_versions")
          .select("id, version_number")
          .eq("workspace_id", params.workspaceId)
          .in("id", versionIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (documentsResult.error || versionsResult.error) {
    throw new Error("Failed to query finding evidence references.");
  }

  const documentNames = new Map((documentsResult.data ?? []).map((row) => [row.id, row.name]));
  const versionNumbers = new Map((versionsResult.data ?? []).map((row) => [row.id, row.version_number]));
  const evidence = rows.map((row) => ({
    ...row,
    documentName: row.document_id ? documentNames.get(row.document_id) ?? "Unknown Document" : "Unknown Document",
    versionNumber: row.version_id ? versionNumbers.get(row.version_id) ?? 1 : 1,
  }));

  return {
    finding,
    evidence,
  };
}
