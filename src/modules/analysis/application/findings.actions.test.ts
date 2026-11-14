import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireDocumentActor: vi.fn(),
  createReadOnlyClient: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/identity")>();
  return { ...actual, requireDocumentActor: mocks.requireDocumentActor };
});
vi.mock("@/lib/supabase/server", () => ({ createReadOnlyClient: mocks.createReadOnlyClient }));

import { listFindingsAction, getFindingDetailAction } from "./analysis.actions";
import { IdentityError } from "@/modules/identity";


describe("findings server actions", () => {
  beforeEach(() => {
    mocks.requireDocumentActor.mockReset();
    mocks.createReadOnlyClient.mockReset();
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
});
