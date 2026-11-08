import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { listFindingsAction, getFindingDetailAction } from "./analysis.actions";


describe("findings server actions", () => {
  it("rechaza la consulta con FORBIDDEN o UNAUTHENTICATED si no hay sesión autorizada", async () => {
    const result = await listFindingsAction({ analysisId: "123e4567-e89b-12d3-a456-426614174000" });
    expect(result.ok).toBe(false);
  });

  it("rechaza IDs inválidos con INVALID_INPUT", async () => {
    const result = await getFindingDetailAction("invalid-uuid");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
    }
  });
});
