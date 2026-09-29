"use server";

import type {
    ActionResult,
    RepositoryPage,
    RepositoryQuery,
} from "@/types/contracts";

import { createIdentityService } from "@/modules/identity/application/identity.service";
import { createRepositoryService } from "./repository.service";

export async function listRepositoryDocuments(
    query: RepositoryQuery = {},
): Promise<RepositoryPage | { error: string }> {
    const identity = createIdentityService();
    const repository = createRepositoryService(identity);

    const result = await repository.listDocuments(query);

    if (!result.ok) {
        return {
            error: result.error.message,
        };
    }

    return result.data;
}

export async function getDocumentOriginalUrlAction(
    versionId: string,
): Promise<ActionResult<{ url: string; expiresAt: string }>> {
    const identity = createIdentityService();
    const repository = createRepositoryService(identity);

    return repository.getOriginalUrl(versionId);
}