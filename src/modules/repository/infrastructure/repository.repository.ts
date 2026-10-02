import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { RepositoryQuery } from "@/types/contracts";

type DbClient = SupabaseClient<Database>;

export async function findRepositoryDocuments(
    supabase: DbClient,
    query: RepositoryQuery,
) {
    const page = Math.max(query.page ?? 1, 1);
    const pageSize = Math.min(Math.max(query.pageSize ?? 25, 1), 100);
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;
    const versionRelation =
        query.versionStatus === undefined
            ? "document_versions!document_versions_document_id_workspace_id_fkey"
            : "document_versions!document_versions_document_id_workspace_id_fkey!inner";

    let request = supabase
        .from("documents")
        .select(
            `
        id,
        name,
        category,
        owner_id,
        active_version_id,
        created_at,
        profiles!documents_owner_id_workspace_id_fkey (
          id,
          full_name
        ),
        ${versionRelation} (
          id,
          version_number,
          processing_status,
          version_status,
          analysis_status
        )
      `,
            { count: "exact" },
        )
        .order("created_at", { ascending: false })
        .range(from, to);

    if (query.name?.trim()) {
        request = request.ilike("name", `%${query.name.trim()}%`);
    }

    if (query.category) {
        request = request.eq("category", query.category);
    }

    if (query.ownerId !== undefined) {
        request =
            query.ownerId === null
                ? request.is("owner_id", null)
                : request.eq("owner_id", query.ownerId);
    }

    if (query.versionStatus !== undefined) {
        request =
            query.versionStatus === null
                ? request.is("document_versions.version_status", null)
                : request.eq("document_versions.version_status", query.versionStatus);
    }

    const { data, error, count } = await request;

    if (error) {
        throw error;
    }

    return {
        data: data ?? [],
        total: count ?? 0,
        page,
        pageSize,
    };
}

export async function findVersionStoragePath(
    supabase: DbClient,
    versionId: string,
    workspaceId: string,
): Promise<{ storagePath: string } | null> {
    const { data, error } = await supabase
        .from("document_versions")
        .select("storage_path")
        .eq("id", versionId)
        .eq("workspace_id", workspaceId)
        .maybeSingle();

    if (error || !data) {
        return null;
    }

    return { storagePath: data.storage_path };
}

export async function createDocumentSignedUrl(
    supabase: DbClient,
    storagePath: string,
    expiresInSeconds = 300,
): Promise<{ url: string; expiresAt: string } | null> {
    const { data, error } = await supabase.storage
        .from("documents")
        .createSignedUrl(storagePath, expiresInSeconds);

    if (error || !data?.signedUrl) {
        return null;
    }

    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

    return {
        url: data.signedUrl,
        expiresAt,
    };
}
