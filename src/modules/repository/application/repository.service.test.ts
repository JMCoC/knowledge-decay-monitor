import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRepositoryService } from "./repository.service";
import type { Actor } from "@/types/contracts";
import { IdentityError } from "@/modules/identity/errors";
import * as repoInfra from "../infrastructure/repository.repository";

// Mocks de dependencias externas
vi.mock("@/lib/supabase/server", () => ({
    createReadOnlyClient: vi.fn().mockResolvedValue({}),
}));

vi.mock("../infrastructure/repository.repository", () => ({
    findRepositoryDocuments: vi.fn(),
    findVersionStoragePath: vi.fn(),
    createDocumentSignedUrl: vi.fn(),
}));

vi.mock("server-only", () => ({}));

describe("RepositoryService - S1-05", () => {
    const adminActor: Actor = {
        userId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        role: "Admin",
    };

    const qaLeadActor: Actor = {
        userId: "22222222-2222-4222-8222-222222222222",
        workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        role: "QA Lead",
    };

    const memberActor: Actor = {
        userId: "33333333-3333-4333-8333-333333333333",
        workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        role: "Member",
    };

    const validVersionId = "30000000-0000-4000-8000-000000000001";

    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe("listDocuments", () => {
        it("debe permitir listar documentos a un Admin", async () => {
            const mockIdentity = { requireDocumentActor: vi.fn().mockResolvedValue(adminActor) };
            vi.mocked(repoInfra.findRepositoryDocuments).mockResolvedValue({
                data: [],
                total: 0,
                page: 1,
                pageSize: 25,
            });

            const service = createRepositoryService(mockIdentity);
            const result = await service.listDocuments({});

            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.data.items).toEqual([]);
                expect(result.data.total).toBe(0);
            }
        });

        it("debe permitir listar documentos a un QA Lead", async () => {
            const mockIdentity = { requireDocumentActor: vi.fn().mockResolvedValue(qaLeadActor) };
            vi.mocked(repoInfra.findRepositoryDocuments).mockResolvedValue({
                data: [],
                total: 0,
                page: 1,
                pageSize: 25,
            });

            const service = createRepositoryService(mockIdentity);
            const result = await service.listDocuments({});

            expect(result.ok).toBe(true);
        });

        it("uses the latest version projection and keeps pending originals closed", async () => {
            const mockIdentity = { requireDocumentActor: vi.fn().mockResolvedValue(adminActor) };
            vi.mocked(repoInfra.findRepositoryDocuments).mockResolvedValue({
                data: [{
                    id: "20000000-0000-4000-8000-000000000001",
                    name: "Runbook",
                    category: "SOP",
                    owner_id: adminActor.userId,
                    owner_profile_id: adminActor.userId,
                    owner_full_name: "Admin A",
                    active_version_id: validVersionId,
                    created_at: "2026-10-03T00:00:00.000Z",
                    latest_version_id: "30000000-0000-4000-8000-000000000002",
                    latest_version_number: 2,
                    latest_processing_status: "uploaded",
                    latest_version_status: null,
                    latest_analysis_status: "pending_reanalysis",
                    latest_upload_state: "pending",
                }],
                total: 1,
                page: 1,
                pageSize: 25,
            });

            const result = await createRepositoryService(mockIdentity).listDocuments({});

            expect(result).toMatchObject({
                ok: true,
                data: { items: [{ activeVersionId: validVersionId, latestVersion: {
                    id: "30000000-0000-4000-8000-000000000002",
                    version_number: 2,
                    uploadState: "pending",
                    canOpen: false,
                } }] },
            });
        });

        it("rejects malformed filters before querying the repository", async () => {
            const mockIdentity = { requireDocumentActor: vi.fn().mockResolvedValue(adminActor) };
            const result = await createRepositoryService(mockIdentity).listDocuments({ page: 1.5 });

            expect(result).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
            expect(repoInfra.findRepositoryDocuments).not.toHaveBeenCalled();
        });

        it("debe bloquear con FORBIDDEN si un Member intenta listar el repositorio", async () => {
            const mockIdentity = { requireDocumentActor: vi.fn().mockRejectedValue(new IdentityError("FORBIDDEN")) };
            const service = createRepositoryService(mockIdentity);

            const result = await service.listDocuments({});

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error.code).toBe("FORBIDDEN");
            }
        });

        it("debe retornar UNAUTHENTICATED si no hay sesión activa", async () => {
            const mockIdentity = {
                requireDocumentActor: vi.fn().mockRejectedValue(new IdentityError("UNAUTHENTICATED")),
            };
            const service = createRepositoryService(mockIdentity);

            const result = await service.listDocuments({});

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error.code).toBe("UNAUTHENTICATED");
            }
        });
    });

    describe("getOriginalUrl (Apertura segura de archivos)", () => {
        it("debe rechazar con INVALID_INPUT si versionId no es un UUID válido (Validación Zod)", async () => {
            const mockIdentity = { requireDocumentActor: vi.fn().mockResolvedValue(adminActor) };
            const service = createRepositoryService(mockIdentity);

            const result = await service.getOriginalUrl("id-invalido-no-uuid");

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error.code).toBe("INVALID_INPUT");
            }
        });

        it("debe rechazar con FORBIDDEN si un Member intenta solicitar una signed URL", async () => {
            const mockIdentity = { requireDocumentActor: vi.fn().mockRejectedValue(new IdentityError("FORBIDDEN")) };
            const service = createRepositoryService(mockIdentity);

            const result = await service.getOriginalUrl(validVersionId);

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error.code).toBe("FORBIDDEN");
            }
        });

        it("debe rechazar con NOT_FOUND si la versión pertenece a otro Workspace (Tenant Isolation)", async () => {
            const mockIdentity = { requireDocumentActor: vi.fn().mockResolvedValue(adminActor) };
            // El repo no encuentra la versión dentro del tenant del actor
            vi.mocked(repoInfra.findVersionStoragePath).mockResolvedValue(null);

            const service = createRepositoryService(mockIdentity);
            const result = await service.getOriginalUrl(validVersionId);

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error.code).toBe("NOT_FOUND");
            }
            expect(repoInfra.createDocumentSignedUrl).not.toHaveBeenCalled();
        });

        it("debe generar la URL firmada exitosamente para un QA Lead", async () => {
            const mockIdentity = { requireDocumentActor: vi.fn().mockResolvedValue(qaLeadActor) };
            const fakeStoragePath = `${qaLeadActor.workspaceId}/doc-1/ver-1/original.md`;
            const fakeSigned = {
                url: "https://supabase.local/storage/v1/object/sign/documents/test.md?token=xyz",
                expiresAt: new Date(Date.now() + 300000).toISOString(),
            };

            vi.mocked(repoInfra.findVersionStoragePath).mockResolvedValue({
                storagePath: fakeStoragePath,
            });
            vi.mocked(repoInfra.createDocumentSignedUrl).mockResolvedValue(fakeSigned);

            const service = createRepositoryService(mockIdentity);
            const result = await service.getOriginalUrl(validVersionId);

            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.data.url).toBe(fakeSigned.url);
                expect(result.data.expiresAt).toBe(fakeSigned.expiresAt);
            }
            // Verifica que se invoque con 300 segundos (5 minutos)
            expect(repoInfra.createDocumentSignedUrl).toHaveBeenCalledWith(
                expect.anything(),
                fakeStoragePath,
                300,
            );
        });

        it("returns INTERNAL_ERROR instead of treating infrastructure failure as an empty repository", async () => {
            const mockIdentity = { requireDocumentActor: vi.fn().mockResolvedValue(adminActor) };
            vi.mocked(repoInfra.findVersionStoragePath).mockRejectedValue(
                new Error("Database connection lost"),
            );

            const service = createRepositoryService(mockIdentity);
            const result = await service.getOriginalUrl(validVersionId);

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error.code).toBe("INTERNAL_ERROR");
                expect(result.error.message).toBe("We couldn't open the file.");
            }
        });
    });
});
