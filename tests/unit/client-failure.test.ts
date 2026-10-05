import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureSafeFailure: vi.fn(),
}));

vi.mock("../../src/lib/observability/capture", () => ({
  captureSafeFailure: mocks.captureSafeFailure,
}));

import { captureClientTransportFailure } from "../../src/lib/observability/client-failure";

describe("client transport failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.captureSafeFailure.mockReturnValue({
      correlationId: "40000000-0000-4000-8000-000000000009",
    });
  });

  it("captures only the fixed application transport contract and preserves its reference", () => {
    expect(captureClientTransportFailure()).toEqual({
      code: "INTERNAL_ERROR",
      message: "We couldn't confirm the operation. Refresh and try again.",
      correlationId: "40000000-0000-4000-8000-000000000009",
    });
    expect(mocks.captureSafeFailure).toHaveBeenCalledWith({
      module: "application",
      operation: "transport",
      code: "INTERNAL_ERROR",
    });
  });

  it("keeps a controlled message if telemetry itself throws", () => {
    mocks.captureSafeFailure.mockImplementation(() => {
      throw new Error("PRIVATE_SENTINEL");
    });

    expect(captureClientTransportFailure()).toEqual({
      code: "INTERNAL_ERROR",
      message: "We couldn't confirm the operation. Refresh and try again.",
    });
  });
});
