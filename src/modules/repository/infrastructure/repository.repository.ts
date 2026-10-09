import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { createServiceClient } from "@/lib/supabase/service";
import { IdentityError } from "@/modules/identity";
import type { RepositoryQuery } from "@/types/contracts";
import { repositoryQuerySchema } from "../schemas";

type DbClient = SupabaseClient<Database>;

async function countRepositoryDocuments(supabase: DbClient, query: RepositoryQuery) {
  let request = supabase
    .from("repository_documents")
    .select("id", { count: "exact", head: true });

  if (query.name) request = request.ilike("name", `%${escapeLikeLiteral(query.name)}%`);
  if (query.category !== undefined) request = request.eq("category", query.category);
  if (query.ownerId !== undefined) {
    request = query.ownerId === null
      ? request.is("owner_id", null)
      : request.eq("owner_id", query.ownerId);
  }
  if (query.versionStatus !== undefined) {
    request = query.versionStatus === null
      ? request.is("latest_version_status", null)
      : request.eq("latest_version_status", query.versionStatus);
  }

  return request;
}

export function escapeLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export async function findRepositoryDocuments(supabase: DbClient, query: RepositoryQuery) {
  const parsed = repositoryQuerySchema.parse(query);
  const page = parsed.page;
  const pageSize = parsed.pageSize;
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let request = supabase
    .from("repository_documents")
    .select(
      "id,name,category,owner_id,owner_profile_id,owner_full_name,active_version_id,created_at,latest_version_id,latest_version_number,latest_processing_status,latest_processing_started_at,latest_processing_queued,latest_processing_lease_expires_at,latest_version_status,latest_analysis_status,latest_upload_state",
      { count: "exact" },
    )
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, to);

  if (parsed.name) request = request.ilike("name", `%${escapeLikeLiteral(parsed.name)}%`);
  if (parsed.category !== undefined) request = request.eq("category", parsed.category);
  if (parsed.ownerId !== undefined) {
    request = parsed.ownerId === null
      ? request.is("owner_id", null)
      : request.eq("owner_id", parsed.ownerId);
  }
  if (parsed.versionStatus !== undefined) {
    request = parsed.versionStatus === null
      ? request.is("latest_version_status", null)
      : request.eq("latest_version_status", parsed.versionStatus);
  }

  const { data, error, count } = await request;
  if (error?.code === "PGRST103") {
    // PostgREST rejects ranges beyond the last row instead of returning an empty page.
    // Preserve normal pagination semantics while keeping the exact count and RLS filters.
    const { count: total, error: countError } = await countRepositoryDocuments(supabase, parsed);
    if (countError) throw new Error("Repository count query failed.");
    return { data: [], total: total ?? 0, page, pageSize };
  }
  if (error) throw new Error("Repository query failed.");
  return { data: data ?? [], total: count ?? 0, page, pageSize };
}

/** Resolves only a confirmed canonical original through a service-only RPC that rechecks Profile. */
export async function findVersionStoragePath(
  userId: string,
  versionId: string,
): Promise<{ storagePath: string } | null> {
  const { data, error } = await createServiceClient().rpc("get_confirmed_document_path", {
    p_user_id: userId,
    p_version_id: versionId,
  });
  if (error?.code === "42501") throw new IdentityError("FORBIDDEN");
  if (error) throw new Error("Repository access check failed.");
  return typeof data === "string" ? { storagePath: data } : null;
}

export async function createDocumentSignedUrl(
  supabase: DbClient,
  storagePath: string,
  expiresInSeconds = 300,
): Promise<{ url: string; expiresAt: string } | null> {
  const { data, error } = await supabase.storage
    .from("documents")
    .createSignedUrl(storagePath, expiresInSeconds);

  if (error || !data?.signedUrl) return null;

  return {
    url: data.signedUrl,
    expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
  };
}
