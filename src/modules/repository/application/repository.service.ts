import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import type {
    ActionResult,
    RepositoryItem,
    RepositoryPage,
    RepositoryQuery,
    RepositoryApi,
    Actor,
} from "@/types/contracts";

import { createClient } from "@/lib/supabase/server";
import {
    findRepositoryDocuments,
    findVersionStoragePath,
    createDocumentSignedUrl,
} from "../infrastructure/repository.repository";

const REPOSITORY_ROLES = ["Admin", "QA Lead"] as const;

function canAccessRepository(actor: Actor): boolean {
    return REPOSITORY_ROLES.includes(
        actor.role as (typeof REPOSITORY_ROLES)[number],
    );
}

const versionIdSchema = z.string().uuid({ message: "ID de versión inválido" });

export function createRepositoryService(identity: {
    requireActor(): Promise<Actor>;
}): RepositoryApi {
    return {
        async listDocuments(query: RepositoryQuery): Promise<
            ActionResult<RepositoryPage>
        > {
            try {
                const actor = await identity.requireActor();

                if (!canAccessRepository(actor)) {
                    return {
                        ok: false,
                        error: {
                            code: "FORBIDDEN",
                            message: "No tienes permisos para acceder al repositorio.",
                        },
                    };
                }

                const supabase = await createClient();

                const result = await findRepositoryDocuments(supabase, query);

                const items: RepositoryItem[] = result.data.map((document) => {
                    const versions = document.document_versions ?? [];

                    const latestVersion =
                        versions.length > 0
                            ? [...versions].sort(
                                (a, b) => b.version_number - a.version_number,
                            )[0]
                            : null;

                    return {
                        id: document.id,
                        name: document.name,
                        category: document.category,
                        owner: document.profiles
                            ? {
                                id: document.profiles.id,
                                full_name: document.profiles.full_name,
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
                if (error instanceof Error && error.message === "UNAUTHENTICATED") {
                    return {
                        ok: false,
                        error: {
                            code: "UNAUTHENTICATED",
                            message: "Debes iniciar sesión para acceder al repositorio.",
                        },
                    };
                }

                Sentry.captureException(error, {
                    tags: {
                        module: "repository",
                        action: "listDocuments",
                    },
                    extra: {
                        // Nota: nunca enviar texto de documentos ni datos confidenciales
                        query: {
                            category: query.category,
                            hasNameFilter: Boolean(query.name),
                            page: query.page,
                        },
                    },
                });

                return {
                    ok: false,
                    error: {
                        code: "INTERNAL_ERROR",
                        message: "No fue posible cargar el repositorio.",
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
                                "Parámetro de versión inválido.",
                        },
                    };
                }

                const actor = await identity.requireActor();

                if (!canAccessRepository(actor)) {
                    return {
                        ok: false,
                        error: {
                            code: "FORBIDDEN",
                            message: "No tienes permisos para abrir este documento.",
                        },
                    };
                }

                const supabase = await createClient();

                const versionData = await findVersionStoragePath(
                    supabase,
                    parseResult.data,
                    actor.workspaceId,
                );

                if (!versionData) {
                    return {
                        ok: false,
                        error: {
                            code: "NOT_FOUND",
                            message: "La versión solicitada no existe en este Workspace.",
                        },
                    };
                }

                const signed = await createDocumentSignedUrl(
                    supabase,
                    versionData.storagePath,
                    300,
                );

                if (!signed) {
                    return {
                        ok: false,
                        error: {
                            code: "INTERNAL_ERROR",
                            message: "No se pudo generar el enlace seguro al archivo.",
                        },
                    };
                }

                return {
                    ok: true,
                    data: signed,
                };
            } catch (error) {
                if (error instanceof Error && error.message === "UNAUTHENTICATED") {
                    return {
                        ok: false,
                        error: {
                            code: "UNAUTHENTICATED",
                            message: "Debes iniciar sesión para abrir documentos.",
                        },
                    };
                }

                Sentry.captureException(error, {
                    tags: {
                        module: "repository",
                        action: "getOriginalUrl",
                    },
                    extra: {
                        versionId, // Solo UUID
                    },
                });

                return {
                    ok: false,
                    error: {
                        code: "INTERNAL_ERROR",
                        message: "Error interno al solicitar el archivo.",
                    },
                };
            }
        },
    };
}