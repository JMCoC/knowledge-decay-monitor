import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/observability/operation-events", () => ({
  captureOperationFailure: vi.fn(),
}));

import { toReviewFailure } from "./errors";
import { captureOperationFailure } from "@/lib/observability/operation-events";

describe("review failure mapping", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps only the known SQLSTATEs to closed product errors", () => {
    const cases = [
      ["P0002", "NOT_FOUND"],
      ["42501", "FORBIDDEN"],
      ["22023", "INVALID_INPUT"],
      ["P0001", "CONFLICT"],
      ["55P03", "CONFLICT"],
      ["40P01", "CONFLICT"],
    ] as const;

    for (const [code, expected] of cases) {
      const result = toReviewFailure({
        code,
        message: "PRIVATE_SQL_MESSAGE",
        details: "PRIVATE_SQL_DETAILS",
        hint: "PRIVATE_SQL_HINT",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(expected);
      expect(JSON.stringify(result)).not.toContain("PRIVATE_SQL");
    }
    expect(captureOperationFailure).not.toHaveBeenCalled();
  });

  it("reports unexpected failures with only a correlation ID and controlled text", () => {
    const result = toReviewFailure({
      code: "23505",
      message: "PRIVATE_CONSTRAINT_NAME",
      details: "PRIVATE_ROW_VALUES",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INTERNAL_ERROR");
    expect(result.error.correlationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
    expect(captureOperationFailure).toHaveBeenCalledWith({
      module: "review",
      operation: "read",
      code: "INTERNAL_ERROR",
      correlationId: result.error.correlationId,
    });
  });

  it("keeps the controlled failure if telemetry itself throws", () => {
    vi.mocked(captureOperationFailure).mockImplementation(() => {
      throw new Error("PRIVATE_TELEMETRY_FAILURE");
    });

    const result = toReviewFailure(new Error("PRIVATE_DB_FAILURE"));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  });
});
