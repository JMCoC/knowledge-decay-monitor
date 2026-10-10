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

import { filterSentryEvent } from "../../src/lib/observability/auth-events";
import { captureOperationFailure } from "../../src/lib/observability/operation-events";

const correlationId = "d2131057-f063-4b12-bafe-746728e8d7ad";
const versionId = "fd23a0b7-8b95-4df0-a57f-887008ae9d12";
const attemptId = "88725091-ae4b-47d2-88dc-490b0baf1072";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("product operation telemetry privacy", () => {
  it("reconstructs an operation event from allowlisted fields only", () => {
    const event = {
      event_id: "0123456789abcdef0123456789abcdef",
      timestamp: 1_790_000_000,
      level: "error",
      message: "untrusted provider message",
      tags: {
        "kdm.safe": "true",
        module: "ingestion",
        operation: "verify",
        code: "INTERNAL_ERROR",
        correlation_id: correlationId,
        version_id: versionId,
        attempt_id: attemptId,
        filename: "sensitive.docx",
      },
      request: { url: "https://storage.invalid/signed?token=private" },
      exception: { values: [{ value: "provider body" }] },
      extra: { sha256: "private hash" },
      user: { email: "private@example.test" },
      breadcrumbs: [{ message: "private breadcrumb" }],
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
        module: "ingestion",
        operation: "verify",
        code: "INTERNAL_ERROR",
        correlation_id: correlationId,
        runtime: "server",
        synthetic: "false",
        version_id: versionId,
        attempt_id: attemptId,
      },
    });
    expect(JSON.stringify(safeEvent)).not.toMatch(/private|sensitive|signed|provider|filename|sha256/i);
  });

  it("emits only safe tags and drops malformed or automatic events", () => {
    captureOperationFailure({
      module: "repository",
      operation: "open",
      code: "INTERNAL_ERROR",
      correlationId,
      versionId,
      filename: "must-not-be-recorded.pdf",
    } as never);

    expect(sentry.scope.setTag.mock.calls).toEqual([
      ["kdm.safe", "true"],
      ["module", "repository"],
      ["operation", "open"],
      ["code", "INTERNAL_ERROR"],
      ["correlation_id", correlationId],
      ["runtime", "server"],
      ["synthetic", "false"],
      ["version_id", versionId],
    ]);
    expect(sentry.captureMessage).toHaveBeenCalledWith("Product operation failed", "error");
    expect(JSON.stringify(sentry.scope.setTag.mock.calls)).not.toContain("must-not-be-recorded");

    captureOperationFailure({
      module: "unknown",
      operation: "open",
      code: "INTERNAL_ERROR",
      correlationId,
    } as never);
    expect(filterSentryEvent({ message: "automatic error" } as never)).toBeNull();
    expect(filterSentryEvent({
      tags: {
        "kdm.safe": "true",
        module: "ingestion",
        operation: "verify",
        code: "INTERNAL_ERROR",
        correlation_id: correlationId,
        version_id: "not-a-uuid",
      },
    } as never)).not.toHaveProperty("tags.version_id");
    expect(sentry.withScope).toHaveBeenCalledTimes(1);
  });

  it("keeps retry telemetry identifier-only even when called with hostile extra fields", () => {
    captureOperationFailure({
      module: "ingestion",
      operation: "retry",
      code: "PARSING_FAILED",
      correlationId,
      versionId,
      attemptId,
      content: "DOCUMENT_SENTINEL",
      filename: "PRIVATE_FILENAME_SENTINEL",
      storagePath: "PRIVATE_PATH_SENTINEL",
      signedUrl: "SIGNED_URL_SENTINEL",
      request: { headers: { authorization: "TOKEN_SENTINEL" } },
      error: new Error("EXCEPTION_SENTINEL"),
    } as never);

    expect(sentry.scope.setTag.mock.calls).toEqual([
      ["kdm.safe", "true"],
      ["module", "ingestion"],
      ["operation", "retry"],
      ["code", "PARSING_FAILED"],
      ["correlation_id", correlationId],
      ["runtime", "server"],
      ["synthetic", "false"],
      ["version_id", versionId],
      ["attempt_id", attemptId],
    ]);
    expect(JSON.stringify(sentry.scope.setTag.mock.calls)).not.toMatch(
      /SENTINEL|PRIVATE_PATH|SIGNED_URL|authorization/,
    );

    const safeEvent = filterSentryEvent({
      message: "untrusted document text DOCUMENT_SENTINEL",
      tags: Object.fromEntries(sentry.scope.setTag.mock.calls),
      request: { url: "SIGNED_URL_SENTINEL" },
      exception: { values: [{ value: "EXCEPTION_SENTINEL" }] },
      extra: { content: "DOCUMENT_SENTINEL", filename: "PRIVATE_FILENAME_SENTINEL" },
    } as never);

    expect(safeEvent).toMatchObject({
      message: "Product operation failed",
      tags: { module: "ingestion", operation: "retry", code: "PARSING_FAILED", version_id: versionId, attempt_id: attemptId },
    });
    expect(JSON.stringify(safeEvent)).not.toMatch(/SENTINEL|PRIVATE_PATH|SIGNED_URL|authorization/);
  });
});
