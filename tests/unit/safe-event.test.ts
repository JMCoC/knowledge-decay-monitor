import { beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({
  withScope: vi.fn((callback: (scope: { setTag: (...values: string[]) => void }) => void) =>
    callback({ setTag: vi.fn() }),
  ),
  captureMessage: vi.fn(() => "0123456789abcdef0123456789abcdef"),
}));

vi.mock("@sentry/nextjs", () => sentry);

import { captureSafeFailure } from "../../src/lib/observability/capture";
import {
  filterSafeEvent,
  type SafeFailureInput,
  type TelemetryContext,
} from "../../src/lib/observability/safe-event";

const correlationId = "d2131057-f063-4b12-bafe-746728e8d7ad";
const context: TelemetryContext = {
  environment: "vercel-preview",
  release: "a".repeat(40),
  runtime: "server",
};

function safeCandidate(overrides: Record<string, unknown> = {}) {
  return {
    message: "DOCUMENT_SENTINEL",
    environment: "attacker",
    release: "TOKEN_SENTINEL",
    tags: {
      "kdm.safe": "true",
      module: "repository",
      operation: "open",
      code: "INTERNAL_ERROR",
      correlation_id: correlationId,
    },
    request: { headers: { authorization: "TOKEN_SENTINEL" } },
    exception: { values: [{ value: "DOCUMENT_SENTINEL" }] },
    ...overrides,
  };
}

describe("safe Sentry events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rebuilds a marked failure from the allowlist and trusted context", () => {
    const event = filterSafeEvent(safeCandidate(), context);

    expect(event).toMatchObject({
      message: "Product operation failed",
      level: "error",
      platform: "javascript",
      environment: "vercel-preview",
      release: context.release,
      tags: {
        module: "repository",
        operation: "open",
        code: "INTERNAL_ERROR",
        correlation_id: correlationId,
        runtime: "server",
        synthetic: "false",
      },
    });
    expect(JSON.stringify(event)).not.toMatch(/SENTINEL|attacker|authorization/);
    expect(event).not.toHaveProperty("exception");
    expect(event).not.toHaveProperty("request");
  });

  it.each([
    ["operation from the wrong module", { tags: { ...safeCandidate().tags as object, module: "ingestion" } }],
    ["expected FORBIDDEN code", { tags: { ...safeCandidate().tags as object, code: "FORBIDDEN" } }],
    ["malformed correlation id", { tags: { ...safeCandidate().tags as object, correlation_id: "not-a-uuid" } }],
    ["an event type other than error or message", { type: "transaction" }],
    ["unbounded operation string", { tags: { ...safeCandidate().tags as object, operation: "x".repeat(500) } }],
  ])("rejects %s", (_reason, override) => {
    expect(filterSafeEvent(safeCandidate(override), context)).toBeNull();
  });

  it("omits malformed optional SDK event identity fields", () => {
    const event = filterSafeEvent(
      safeCandidate({ event_id: "not-hexadecimal", timestamp: Number.NaN }),
      context,
    );

    expect(event).not.toBeNull();
    expect(event).not.toHaveProperty("event_id");
    expect(event).not.toHaveProperty("timestamp");
    expect(
      filterSafeEvent(safeCandidate({ timestamp: Number.POSITIVE_INFINITY }), context),
    ).not.toHaveProperty("timestamp");
  });

  it("rejects an invalid trusted release instead of taking release from the event", () => {
    expect(
      filterSafeEvent(safeCandidate(), { ...context, release: "attacker-release" }),
    ).toBeNull();
  });

  it("returns a correlation receipt and emits only closed tags", () => {
    const failure: SafeFailureInput = {
      module: "repository",
      operation: "open",
      code: "INTERNAL_ERROR",
      correlationId,
      synthetic: true,
    };

    const receipt = captureSafeFailure(failure);

    expect(receipt).toEqual({ correlationId, eventId: "0123456789abcdef0123456789abcdef" });
    expect(sentry.captureMessage).toHaveBeenCalledWith("Product operation failed", "error");
  });

  it("keeps the correlation receipt when the Sentry SDK throws", () => {
    sentry.captureMessage.mockImplementationOnce(() => {
      throw new Error("SDK_SENTINEL");
    });

    expect(
      captureSafeFailure({
        module: "repository",
        operation: "open",
        code: "INTERNAL_ERROR",
        correlationId,
      }),
    ).toEqual({ correlationId });
  });
});
