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

  it("never forwards confidence from an unexpected review failure to telemetry", () => {
    const result = toReviewFailure({
      code: "23505",
      message: "PRIVATE_REVIEW_FAILURE",
      confidence: 0.97,
      finding: { confidence: 0.97 },
    }, "change");

    expect(JSON.stringify(result).toLowerCase()).not.toContain("confidence");
    const telemetryPayload = vi.mocked(captureOperationFailure).mock.calls[0]?.[0];
    expect(telemetryPayload).toMatchObject({
      module: "review",
      operation: "change",
      code: "INTERNAL_ERROR",
    });
    expect(JSON.stringify(telemetryPayload).toLowerCase()).not.toContain("confidence");
    expect(JSON.stringify(telemetryPayload)).not.toContain("0.97");
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

  it("uses operation-specific allowlisted telemetry for review commands", () => {
    toReviewFailure(new Error("PRIVATE_CHANGE_FAILURE"), "change");
    toReviewFailure(new Error("PRIVATE_ASSIGN_FAILURE"), "assign");
    toReviewFailure(new Error("PRIVATE_PREPARE_FAILURE"), "prepare_round");
    toReviewFailure(new Error("PRIVATE_UPDATE_FAILURE"), "update_round_draft");
    toReviewFailure(new Error("PRIVATE_OPEN_FAILURE"), "open_round");
    toReviewFailure(new Error("PRIVATE_CANCEL_FAILURE"), "cancel_round");

    expect(captureOperationFailure).toHaveBeenNthCalledWith(1, expect.objectContaining({
      module: "review",
      operation: "change",
      code: "INTERNAL_ERROR",
    }));
    expect(captureOperationFailure).toHaveBeenNthCalledWith(2, expect.objectContaining({
      module: "review",
      operation: "assign",
      code: "INTERNAL_ERROR",
    }));
    expect(captureOperationFailure).toHaveBeenNthCalledWith(3, expect.objectContaining({
      module: "review",
      operation: "prepare_round",
      code: "INTERNAL_ERROR",
    }));
    expect(captureOperationFailure).toHaveBeenNthCalledWith(4, expect.objectContaining({
      module: "review",
      operation: "update_round_draft",
      code: "INTERNAL_ERROR",
    }));
    expect(captureOperationFailure).toHaveBeenNthCalledWith(5, expect.objectContaining({
      module: "review",
      operation: "open_round",
      code: "INTERNAL_ERROR",
    }));
    expect(captureOperationFailure).toHaveBeenNthCalledWith(6, expect.objectContaining({
      module: "review",
      operation: "cancel_round",
      code: "INTERNAL_ERROR",
    }));
  });
});
