import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { listRepositoryDocuments } = vi.hoisted(() => ({
    listRepositoryDocuments: vi.fn(),
}));

vi.mock("@/modules/repository", () => ({
    listRepositoryDocuments,
}));

vi.mock("@/modules/identity", () => ({
    requireDocumentActor: vi.fn(async () => ({
        userId: "10000000-0000-4000-8000-000000000001",
        workspaceId: "20000000-0000-4000-8000-000000000001",
        role: "Admin",
    })),
}));

vi.mock("@/modules/workspace", () => ({
    listEligibleOwners: vi.fn(async () => ({
        ok: true,
        data: [{ id: "10000000-0000-4000-8000-000000000001", fullName: "Workspace Admin" }],
    })),
}));

vi.mock("@/modules/ingestion/ui/upload-panel", () => ({
    UploadPanel: () => createElement("section", { "data-testid": "upload-panel" }),
}));

vi.mock("@/modules/ingestion/ui/recover-upload-button", () => ({
    RecoverUploadButton: ({ versionId }: { versionId: string }) =>
        createElement("button", { "data-recover-version": versionId }, "Recover upload"),
}));

vi.mock("@/modules/repository/ui/retry-processing-button", () => ({
    RetryProcessingButton: ({ versionId, action }: { versionId: string; action: "start" | "retry" }) =>
        createElement("button", { "data-retry-version": versionId, "data-action": action },
            action === "start" ? "Start Processing" : "Retry Processing"),
}));

vi.mock("@/modules/repository/ui/processing-lease-refresh", () => ({
    ProcessingLeaseRefresh: ({ enabled }: { enabled: boolean }) =>
        createElement("span", { "data-refresh-enabled": enabled }),
}));

vi.mock("@/modules/repository/ui/processing-status-badge", () => ({
    ProcessingStatusBadge: ({ uploadState }: { uploadState: string | null }) =>
        createElement("span", null, uploadState === null ? "Needs reconciliation" : "status"),
}));

vi.mock("@/modules/repository/ui/open-document-button", () => ({
    OpenDocumentButton: () => createElement("span", null, "open"),
}));

vi.mock("@/modules/repository/ui/repository-filters", () => ({
    RepositoryFilters: () => createElement("section", { "data-testid": "repository-filters" }),
}));

import RepositoryPage from "./page";

describe("RepositoryPage", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("renders a controlled action error message", async () => {
        listRepositoryDocuments.mockResolvedValue({
            ok: false,
            error: { code: "INTERNAL_ERROR", message: "Repository unavailable." },
        });

        const markup = renderToStaticMarkup(await RepositoryPage({ searchParams: Promise.resolve({}) }));

        expect(markup).toContain("Repository unavailable.");
        expect(markup).toContain('role="alert"');
    });

    it("renders successful ActionResult data", async () => {
        listRepositoryDocuments.mockResolvedValue({
            ok: true,
            data: {
                items: [
                    {
                        id: "document-1",
                        name: "Runbook",
                        category: "Technical",
                        owner: { id: "owner-1", full_name: "Workspace Admin" },
                        activeVersionId: null,
                        latestVersion: {
                            id: "version-1",
                            version_number: 1,
                            processing_status: "uploaded",
                            version_status: null,
                            analysis_status: null,
                            uploadState: "pending",
                            canOpen: false,
                        },
                        createdAt: "2026-10-03T00:00:00.000Z",
                    },
                    {
                        id: "document-legacy",
                        name: "Legacy record",
                        category: "Technical",
                        owner: null,
                        activeVersionId: null,
                        latestVersion: {
                            id: "version-legacy",
                            version_number: 1,
                            processing_status: "uploaded",
                            version_status: null,
                            analysis_status: null,
                            uploadState: null,
                            canOpen: false,
                        },
                        createdAt: "2026-10-03T00:00:00.000Z",
                    },
                ],
                total: 1,
                page: 1,
                pageSize: 25,
                asOfMs: Date.now(),
            },
        });

        const markup = renderToStaticMarkup(await RepositoryPage({ searchParams: Promise.resolve({}) }));

        expect(markup).toContain("Runbook");
        expect(markup).toContain("Workspace Admin");
        expect(markup).toContain("upload-panel");
        expect(markup).toContain('data-recover-version="version-1"');
        expect(markup).toContain("Legacy record");
        expect(markup).toContain("Needs reconciliation");
        expect(markup).not.toContain('data-recover-version="version-legacy"');
    });

    it("offers retry only for a confirmed processing_failed version", async () => {
        listRepositoryDocuments.mockResolvedValue({
            ok: true,
            data: {
                items: [{
                    id: "document-failed",
                    name: "Failed handbook",
                    category: "SOP",
                    owner: null,
                    activeVersionId: null,
                    latestVersion: {
                        id: "version-failed",
                        version_number: 1,
                        processing_status: "processing_failed",
                        version_status: null,
                        analysis_status: "pending_reanalysis",
                        uploadState: "confirmed",
                        canOpen: false,
                    },
                    createdAt: "2026-10-07T00:00:00.000Z",
                }],
                total: 1,
                page: 1,
                pageSize: 25,
                asOfMs: Date.now(),
            },
        });

        const markup = renderToStaticMarkup(await RepositoryPage({ searchParams: Promise.resolve({}) }));

        expect(markup).toContain('data-retry-version="version-failed"');
        expect(markup).toContain("Retry Processing");
        expect(markup).not.toContain('data-recover-version="version-failed"');
    });

    it("offers Start for confirmed uploaded v1 and keeps the confirmed original open action", async () => {
        listRepositoryDocuments.mockResolvedValue({
            ok: true,
            data: {
                items: [{
                    id: "document-uploaded",
                    name: "Uploaded handbook",
                    category: "SOP",
                    owner: null,
                    activeVersionId: null,
                    latestVersion: {
                        id: "version-uploaded",
                        version_number: 1,
                        processing_status: "uploaded",
                        version_status: null,
                        analysis_status: "pending_reanalysis",
                        uploadState: "confirmed",
                        canOpen: true,
                        processingStartedAt: null,
                    },
                    createdAt: "2026-10-07T00:00:00.000Z",
                }],
                total: 1,
                page: 1,
                pageSize: 25,
                asOfMs: Date.now(),
            },
        });

        const markup = renderToStaticMarkup(await RepositoryPage({ searchParams: Promise.resolve({}) }));

        expect(markup).toContain('data-retry-version="version-uploaded"');
        expect(markup).toContain('data-action="start"');
        expect(markup).toContain("Start Processing");
        expect(markup).toContain("open");
    });

    it("offers Retry for a stale processing lease and enables lease refresh", async () => {
        listRepositoryDocuments.mockResolvedValue({
            ok: true,
            data: {
                items: [{
                    id: "document-stale",
                    name: "Stale handbook",
                    category: "SOP",
                    owner: null,
                    activeVersionId: null,
                    latestVersion: {
                        id: "version-stale",
                        version_number: 1,
                        processing_status: "processing",
                        version_status: null,
                        analysis_status: "pending_reanalysis",
                        uploadState: "confirmed",
                        canOpen: true,
                        processingStartedAt: new Date(Date.now() - 181_000).toISOString(),
                    },
                    createdAt: "2026-10-07T00:00:00.000Z",
                }],
                total: 1,
                page: 1,
                pageSize: 25,
                asOfMs: Date.now(),
            },
        });

        const markup = renderToStaticMarkup(await RepositoryPage({ searchParams: Promise.resolve({}) }));

        expect(markup).toContain('data-retry-version="version-stale"');
        expect(markup).toContain('data-action="retry"');
        expect(markup).toContain("Retry Processing");
        expect(markup).toContain('data-refresh-enabled="true"');
        expect(markup).toContain("open");
    });

    it("does not render the upload panel when document access is denied", async () => {
        listRepositoryDocuments.mockResolvedValue({
            ok: false,
            error: { code: "FORBIDDEN", message: "You don't have permission to access documents." },
        });

        const markup = renderToStaticMarkup(await RepositoryPage({ searchParams: Promise.resolve({}) }));

        expect(markup).toContain("You don&#x27;t have permission to access documents.");
        expect(markup).not.toContain("upload-panel");
    });
});
