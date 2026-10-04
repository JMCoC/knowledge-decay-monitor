import { z } from "zod";
import type {
    ActionResult,
    RepositoryItem,
    RepositoryPage,
    RepositoryQuery,
    RepositoryApi,
    IdentityApi,
} from "@/types/contracts";
import { IdentityError } from "@/modules/identity";
import { repositoryQuerySchema } from "../schemas";
import { captureOperationFailure } from "@/lib/observability/operation-events";

import { createReadOnlyClient } from "@/lib/supabase/server";
import {
    findRepositoryDocuments,
    findVersionStoragePath,
    createDocumentSignedUrl,
} from "../infrastructure/repository.repository";

const versionIdSchema = z.string().uuid({ message: "The version ID is invalid." });

function identityFailure(error: unknown): ActionResult<never> | null {
    if (!(error instanceof IdentityError)) return null;
    const code = error.code === "WORKSPACE_REQUIRED" ? "FORBIDDEN" : error.code;
    if (code !== "UNAUTHENTICATED" && code !== "FORBIDDEN" && code !== "INTERNAL_ERROR") return null;
    return {
        ok: false,
        error: {
            code,
            message:
                code === "UNAUTHENTICATED"
                    ? "Please sign in to access the Repository."
                    : code === "FORBIDDEN"
                        ? "You don't have permission to access documents."
                        : "We couldn't verify your access to the Repository.",
        },
    };
}

export function createRepositoryService(identity: Pick<IdentityApi, "requireDocumentActor">): RepositoryApi {
    return {
        async listDocuments(query: RepositoryQuery): Promise<
            ActionResult<RepositoryPage>
        > {
            const parsed = repositoryQuerySchema.safeParse(query);
            if (!parsed.success) {
                return {
                    ok: false,
                    error: { code: "INVALID_INPUT", message: "The Repository filters are invalid." },
                };
            }
            try {
                await identity.requireDocumentActor();

                const supabase = await createReadOnlyClient();

                const result = await findRepositoryDocuments(supabase, parsed.data);

                const items: RepositoryItem[] = result.data.map((document) => {
                    if (document.id === null || document.name === null
                        || document.category === null || document.created_at === null) {
                        throw new Error("Repository projection returned an incomplete document row.");
                    }
                    const latestVersion = document.latest_version_id
                        ? {
                            id: document.latest_version_id,
                            version_number: document.latest_version_number!,
                            processing_status: document.latest_processing_status,
                            version_status: document.latest_version_status,
                            analysis_status: document.latest_analysis_status,
                            uploadState: document.latest_upload_state,
                            canOpen: document.latest_upload_state === "confirmed",
                        }
                        : null;
                    return {
                        id: document.id,
                        name: document.name,
                        category: document.category,
                        owner: document.owner_profile_id !== null && document.owner_full_name !== null
                            ? {
                                id: document.owner_profile_id,
                                full_name: document.owner_full_name!,
                            }
                            : null,
                        activeVersionId: document.active_version_id,
                        latestVersion,
                        createdAt: document.created_at,
                    };
                });

                return {
                    ok: true,
                    data: {
                        items,
                        total: result.total,
                        page: result.page,
                        pageSize: result.pageSize,
                    },
                };
            } catch (error) {
                const denied = identityFailure(error);
                if (denied) return denied;
                captureOperationFailure({
                    module: "repository",
                    operation: "list",
                    code: "INTERNAL_ERROR",
                    correlationId: crypto.randomUUID(),
                });

                return {
                    ok: false,
                    error: {
                        code: "INTERNAL_ERROR",
                        message: "We couldn't load the Repository.",
                    },
                };
            }
        },

        async getOriginalUrl(
            versionId: string,
        ): Promise<ActionResult<{ url: string; expiresAt: string }>> {
            try {
                const parseResult = versionIdSchema.safeParse(versionId);
                if (!parseResult.success) {
                    return {
                        ok: false,
                        error: {
                        code: "INVALID_INPUT",
                        message:
                            parseResult.error.issues[0]?.message ??
                                "The version ID is invalid.",
                        },
                    };
                }

                const actor = await identity.requireDocumentActor();

                const versionData = await findVersionStoragePath(
                    actor.userId,
                    parseResult.data,
                );

                if (!versionData) {
                    return {
                        ok: false,
                        error: {
                            code: "NOT_FOUND",
                            message: "The requested version was not found.",
                        },
                    };
                }

                const supabase = await createReadOnlyClient();
                const signed = await createDocumentSignedUrl(
                    supabase,
                    versionData.storagePath,
                    300,
                );

                if (!signed) {
                    captureOperationFailure({
                        module: "repository",
                        operation: "open",
                        code: "INTERNAL_ERROR",
                        correlationId: crypto.randomUUID(),
                        versionId: parseResult.data,
                    });
                    return {
                        ok: false,
                        error: {
                            code: "INTERNAL_ERROR",
                            message: "We couldn't create a secure link to the file.",
                        },
                    };
                }

                return {
                    ok: true,
                    data: signed,
                };
            } catch (error) {
                const denied = identityFailure(error);
                if (denied) return denied;
                captureOperationFailure({
                    module: "repository",
                    operation: "open",
                    code: "INTERNAL_ERROR",
                    correlationId: crypto.randomUUID(),
                    versionId,
                });

                return {
                    ok: false,
                    error: {
                        code: "INTERNAL_ERROR",
                        message: "We couldn't open the file.",
                    },
                };
            }
        },
    };
}
