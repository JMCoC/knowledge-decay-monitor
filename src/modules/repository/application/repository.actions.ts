"use server";

import type {
    ActionResult,
    RepositoryPage,
    RepositoryQuery,
} from "@/types/contracts";

import { requireDocumentActor } from "@/modules/identity";
import { createRepositoryService } from "./repository.service";

export async function listRepositoryDocuments(
    query: RepositoryQuery = {},
): Promise<ActionResult<RepositoryPage>> {
    const repository = createRepositoryService({ requireDocumentActor });
    return repository.listDocuments(query);
}

export async function getDocumentOriginalUrlAction(
    versionId: string,
): Promise<ActionResult<{ url: string; expiresAt: string }>> {
    const repository = createRepositoryService({ requireDocumentActor });

    return repository.getOriginalUrl(versionId);
}
