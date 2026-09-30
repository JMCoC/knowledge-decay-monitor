import { describe, expect, it } from "vitest";
import { createWorkspaceSchema } from "../../src/modules/workspace/schemas";

describe("Workspace bootstrap schema", () => {
  it("trims names and accepts 120 Unicode code points", () => {
    const name = "🧭".repeat(120);
    const result = createWorkspaceSchema.parse({ name: ` ${name} `, fullName: " Ada Lovelace " });

    expect(result).toEqual({ name, fullName: "Ada Lovelace" });
  });

  it("rejects empty or longer than 120-character names", () => {
    expect(createWorkspaceSchema.safeParse({ name: "   ", fullName: "Ada" }).success).toBe(false);
    expect(
      createWorkspaceSchema.safeParse({ name: "🧭".repeat(121), fullName: "Ada" }).success,
    ).toBe(false);
  });

  it.each(["role", "workspaceId", "userId", "email"])(
    "rejects caller-supplied %s fields",
    (field) => {
      expect(
        createWorkspaceSchema.safeParse({ name: "Acme", fullName: "Ada", [field]: "attacker" })
          .success,
      ).toBe(false);
    },
  );
});
