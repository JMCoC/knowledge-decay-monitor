import { describe, expect, it } from "vitest";
import { findingsQuerySchema, findingIdSchema } from "./schemas";

describe("findings schemas", () => {
  it("valida query de findings con valores válidos y aplica defaults", () => {
    const parsed = findingsQuerySchema.safeParse({
      analysisId: "123e4567-e89b-12d3-a456-426614174000",
      type: "contradiction",
      severity: "High",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.page).toBe(1);
      expect(parsed.data.pageSize).toBe(10);
      expect(parsed.data.type).toBe("contradiction");
      expect(parsed.data.severity).toBe("High");
    }
  });

  it("rechaza analysisId no uuid o página fuera de rango", () => {
    expect(findingsQuerySchema.safeParse({ analysisId: "invalid-id" }).success).toBe(false);
    expect(findingsQuerySchema.safeParse({
      analysisId: "123e4567-e89b-12d3-a456-426614174000",
      page: 0,
    }).success).toBe(false);
    expect(findingsQuerySchema.safeParse({
      analysisId: "123e4567-e89b-12d3-a456-426614174000",
      pageSize: 100,
    }).success).toBe(false);
  });

  it("valida findingId uuid", () => {
    expect(findingIdSchema.safeParse("123e4567-e89b-12d3-a456-426614174000").success).toBe(true);
    expect(findingIdSchema.safeParse("not-a-uuid").success).toBe(false);
  });
});
