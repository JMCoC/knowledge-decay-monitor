import { describe, expect, it, vi } from "vitest";
import type { Actor } from "../../src/types/contracts";
import { assertDocumentActor } from "../../src/modules/identity/session";

vi.mock("server-only", () => ({}));

function actor(role: Actor["role"]): Actor {
  return { userId: "user-1", workspaceId: "workspace-1", role };
}

describe("document actor authorization", () => {
  it.each(["Admin", "QA Lead"] as const)("admits %s from the persisted Actor", (role) => {
    const verifiedActor = actor(role);
    expect(assertDocumentActor(verifiedActor)).toBe(verifiedActor);
  });

  it("denies a Member even when they own an assigned document", () => {
    expect(() => assertDocumentActor(actor("Member"))).toThrowError(
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
  });
});
