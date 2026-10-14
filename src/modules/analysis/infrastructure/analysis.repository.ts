import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { EligibleDocumentsQuery } from "@/types/contracts";
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
