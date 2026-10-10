import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  captureOperationFailure: vi.fn(),
  flush: vi.fn(),
}));

vi.mock("@/lib/observability/operation-events", () => ({
  captureOperationFailure: mocks.captureOperationFailure,
}));

vi.mock("@sentry/nextjs", () => ({ flush: mocks.flush }));

import { reportProcessingFailure } from "@/lib/observability/processing-failure.server";

const event = {
  module: "ingestion" as const,
  operation: "process" as const,
  code: "PROCESSING_FAILED" as const,
  correlationId: "d2131057-f063-4b12-bafe-746728e8d7ad",
  versionId: "fd23a0b7-8b95-4df0-a57f-887008ae9d12",
};

beforeEach(() => {
  mocks.captureOperationFailure.mockReset();
  mocks.flush.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("processing failure telemetry", () => {
  it("captures only the safe event and flushes within the 500ms cap", async () => {
    await reportProcessingFailure(event, 1_500);

    expect(mocks.captureOperationFailure).toHaveBeenCalledWith(event);
    expect(mocks.flush).toHaveBeenCalledWith(500);
  });

  it("resolves within the assigned budget when capture throws and flush hangs", async () => {
    vi.useFakeTimers();
    mocks.captureOperationFailure.mockImplementation(() => {
      throw new Error("SENTRY_EXCEPTION_SENTINEL");
    });
    mocks.flush.mockReturnValue(new Promise(() => undefined));

    const pending = reportProcessingFailure(event, 300);
    await vi.advanceTimersByTimeAsync(300);
    await expect(pending).resolves.toBeUndefined();

    expect(mocks.flush).toHaveBeenCalledWith(300);
  });

  it("absorbs a rejected flush without changing the worker result", async () => {
    mocks.flush.mockRejectedValue(new Error("SENTRY_TRANSPORT_SENTINEL"));

    await expect(reportProcessingFailure(event)).resolves.toBeUndefined();
    expect(mocks.captureOperationFailure).toHaveBeenCalledWith(event);
  });
});
