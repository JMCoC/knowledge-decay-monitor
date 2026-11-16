import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireDocumentActor: vi.fn(),
  createReadOnlyClient: vi.fn(),
  getFindingDetailService: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/identity")>();
  return { ...actual, requireDocumentActor: mocks.requireDocumentActor };
});
vi.mock("@/lib/supabase/server", () => ({ createReadOnlyClient: mocks.createReadOnlyClient }));
vi.mock("./analysis.service", async (importOriginal) => ({
  ...await importOriginal<typeof import("./analysis.service")>(),
  getFindingDetailService: mocks.getFindingDetailService,
}));

import { listFindingsAction, getFindingDetailAction, listFindingsForDocumentAction } from "./analysis.actions";
import { IdentityError } from "@/modules/identity";


describe("findings server actions", () => {
  beforeEach(() => {
    mocks.requireDocumentActor.mockReset();
    mocks.createReadOnlyClient.mockReset();
    mocks.getFindingDetailService.mockReset();
    mocks.requireDocumentActor.mockRejectedValue(new IdentityError("UNAUTHENTICATED"));
  });

  it("rechaza la consulta con UNAUTHENTICATED si no hay sesión", async () => {
    const result = await listFindingsAction({ analysisId: "123e4567-e89b-12d3-a456-426614174000" });
    expect(result).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
  });

  it("rechaza IDs inválidos con INVALID_INPUT", async () => {
    const result = await getFindingDetailAction("invalid-uuid");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
    }
  });

  it("member_cannot_browse_analysis_history", async () => {
    mocks.requireDocumentActor.mockRejectedValue(new IdentityError("FORBIDDEN"));

    const listResult = await listFindingsAction({ analysisId: "123e4567-e89b-12d3-a456-426614174000" });
    const detailResult = await getFindingDetailAction("223e4567-e89b-12d3-a456-426614174000");

    expect(listResult).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(detailResult).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(mocks.createReadOnlyClient).not.toHaveBeenCalled();
  });

  it("loads only confirmed/planned findings whose evidence references the requested document", async () => {
    const analysisId = "123e4567-e89b-12d3-a456-426614174000";
    const documentId = "223e4567-e89b-12d3-a456-426614174000";
    const findingId = "323e4567-e89b-12d3-a456-426614174000";
    mocks.requireDocumentActor.mockResolvedValue({ userId: "423e4567-e89b-12d3-a456-426614174000", workspaceId: "523e4567-e89b-12d3-a456-426614174000", role: "QA Lead" });
    const analysisQuery = {
      select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { id: analysisId, status: "completed" }, error: null }),
    };
    const evidenceQuery = {
      select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [{ finding_id: findingId }], error: null }),
    };
    const supabase = { from: vi.fn((table: string) => table === "analyses" ? analysisQuery : evidenceQuery) };
    mocks.createReadOnlyClient.mockResolvedValue(supabase);
    mocks.getFindingDetailService.mockResolvedValue({
      id: findingId,
      analysisId,
      type: "contradiction",
      explanation: "A controlled finding",
      severityOriginal: "High",
      severityCurrent: "Medium",
      status: "confirmed",
      assignee: null,
      createdAt: "2026-11-15T00:00:00.000Z",
      evidence: [{ id: "e-1", documentId, documentName: "Policy.pdf", versionId: "v-1", versionNumber: 1, chunkId: "c-1", pageNumber: null, section: null, sectionHeading: null, snapshot: "Quote" }],
    });

    const result = await listFindingsForDocumentAction({ analysisId, documentId });
    expect(result.ok).toBe(true);
    expect(evidenceQuery.eq).toHaveBeenCalledWith("analysis_id", analysisId);
    expect(evidenceQuery.eq).toHaveBeenCalledWith("document_id", documentId);
    expect(mocks.getFindingDetailService).toHaveBeenCalledWith(supabase, "523e4567-e89b-12d3-a456-426614174000", findingId);
    if (result.ok) expect(result.data.map(({ id }) => id)).toEqual([findingId]);
  });
});
