import { beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => {
  const scope = { setTag: vi.fn() };
  return {
    scope,
    withScope: vi.fn((callback: (value: { setTag: (...values: string[]) => void }) => void) => callback(scope)),
    captureMessage: vi.fn(),
  };
});

vi.mock("@sentry/nextjs", () => sentry);

import { filterSentryEvent, reportAuthFailure } from "../../src/lib/observability/auth-events";

const correlationId = "d2131057-f063-4b12-bafe-746728e8d7ad";
const sensitiveSentinels = [
  "PASSWORD_SENTINEL_924",
  "EMAIL_SENTINEL_924@example.test",
  "TOKEN_SENTINEL_924",
  "COOKIE_SENTINEL_924",
  "QUERY_SENTINEL_924",
];

describe("Auth telemetry privacy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("captures only closed fields from a safe Auth failure", () => {
    const untrusted = {
      operation: "bootstrap",
      code: "INTERNAL_ERROR",
      correlationId,
      password: sensitiveSentinels[0],
      email: sensitiveSentinels[1],
      token: sensitiveSentinels[2],
      cookie: sensitiveSentinels[3],
      callbackUrl: `http://127.0.0.1:3000/auth/callback?token_hash=${sensitiveSentinels[4]}`,
    };

    reportAuthFailure(untrusted as never);

    expect(sentry.withScope).toHaveBeenCalledTimes(1);
    expect(sentry.scope.setTag.mock.calls).toEqual([
      ["kdm.safe", "true"],
      ["module", "workspace"],
      ["operation", "bootstrap"],
      ["code", "INTERNAL_ERROR"],
      ["correlation_id", correlationId],
      ["runtime", "server"],
      ["synthetic", "false"],
    ]);
    expect(sentry.captureMessage).toHaveBeenCalledWith(
      "Product operation failed",
      "error",
    );
    expect(JSON.stringify(sentry.scope.setTag.mock.calls)).not.toContain("SENTINEL_924");
  });

  it("rejects an unknown operation, code, or correlation identifier", () => {
    reportAuthFailure({ operation: "unknown", code: "INTERNAL_ERROR", correlationId } as never);
    reportAuthFailure({ operation: "login", code: "provider secret", correlationId } as never);
    reportAuthFailure({ operation: "login", code: "INTERNAL_ERROR", correlationId: "email@example.test" } as never);

    expect(sentry.withScope).not.toHaveBeenCalled();
    expect(sentry.captureMessage).not.toHaveBeenCalled();
  });

  it("rebuilds an explicitly safe event without request, breadcrumb, or error payloads", () => {
    const event = {
      event_id: "0123456789abcdef0123456789abcdef",
      timestamp: 1_790_000_000,
      level: "error",
      message: "untrusted message",
      tags: {
        "kdm.safe": "true",
        module: "identity",
        operation: "recovery",
        code: "PROVIDER_ERROR",
        correlation_id: correlationId,
      },
      request: {
        url: `http://127.0.0.1:3000/auth/callback?token_hash=${sensitiveSentinels[4]}`,
        headers: { cookie: sensitiveSentinels[3] },
        data: { email: sensitiveSentinels[1], password: sensitiveSentinels[0] },
      },
      breadcrumbs: [{ message: sensitiveSentinels[2] }],
      exception: { values: [{ value: sensitiveSentinels[0] }] },
      extra: { token: sensitiveSentinels[2] },
    };

    const safeEvent = filterSentryEvent(event as never);

    expect(safeEvent).toEqual({
      type: undefined,
      event_id: "0123456789abcdef0123456789abcdef",
      timestamp: 1_790_000_000,
      level: "error",
      platform: "javascript",
      message: "Product operation failed",
      environment: "development",
      release: "0000000000000000000000000000000000000000",
      tags: {
        module: "identity",
        operation: "recovery",
        code: "PROVIDER_ERROR",
        correlation_id: correlationId,
        runtime: "server",
        synthetic: "false",
      },
    });
    expect(JSON.stringify(safeEvent)).not.toContain("SENTINEL_924");
  });

  it("drops automatic or malformed Sentry events", () => {
    expect(filterSentryEvent({ message: "captured callback URL" } as never)).toBeNull();
    expect(
      filterSentryEvent({
        tags: {
          "kdm.safe": "true",
          module: "identity",
          operation: "login",
          code: "INTERNAL_ERROR",
          correlation_id: "not-a-uuid",
        },
      } as never),
    ).toBeNull();
  });
});
