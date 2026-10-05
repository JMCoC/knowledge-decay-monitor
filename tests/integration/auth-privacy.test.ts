import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Sentry from "@sentry/nextjs";
import {
  authSafeSentryOptions,
  reportAuthFailure,
} from "../../src/lib/observability/auth-events";
import { captureOperationFailure } from "../../src/lib/observability/operation-events";
import { wrapSafeTransport } from "../../src/lib/observability/safe-transport";
import type { TelemetryContext } from "../../src/lib/observability/safe-event";

const correlationId = "d2131057-f063-4b12-bafe-746728e8d7ad";
const sentinels = [
  "PASSWORD_SENTINEL_924",
  "EMAIL_SENTINEL_924@example.test",
  "TOKEN_SENTINEL_924",
  "COOKIE_SENTINEL_924",
  "QUERY_SENTINEL_924",
];
const callbackUrl = `http://127.0.0.1:3000/auth/callback?token_hash=${sentinels[2]}&type=recovery`;
const envelopes: unknown[] = [];
const telemetryContext: TelemetryContext = {
  environment: "development",
  release: "0000000000000000000000000000000000000000",
  runtime: "server",
};

beforeAll(() => {
  Sentry.init({
    dsn: "https://public@example.ingest.sentry.io/1",
    ...authSafeSentryOptions,
    transport: () =>
      wrapSafeTransport(
        {
          send: async (envelope: unknown) => {
            envelopes.push(envelope);
            return { statusCode: 200 };
          },
          flush: async () => true,
        } as never,
        telemetryContext,
      ),
  });
});

afterAll(async () => {
  await Sentry.close(1000);
});

describe("Auth telemetry transport privacy", () => {
  it("sends only allowlisted Auth telemetry and drops callback/request payloads", async () => {
    Sentry.addBreadcrumb({
      category: "http",
      data: { url: callbackUrl, cookie: sentinels[3] },
      message: sentinels[4],
    });
    Sentry.captureEvent({
      message: `automatic error ${sentinels[0]} ${sentinels[1]}`,
      request: {
        url: callbackUrl,
        headers: { cookie: sentinels[3] },
        data: { password: sentinels[0], email: sentinels[1] },
      },
    });
    reportAuthFailure({ operation: "recovery", code: "PROVIDER_ERROR", correlationId });
    captureOperationFailure({
      module: "ingestion",
      operation: "verify",
      code: "INTERNAL_ERROR",
      correlationId,
      versionId: "fd23a0b7-8b95-4df0-a57f-887008ae9d12",
      attemptId: "88725091-ae4b-47d2-88dc-490b0baf1072",
    });

    expect(await Sentry.flush(1000)).toBe(true);

    const serialized = JSON.stringify(envelopes);
    for (const sentinel of sentinels) expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain("token_hash=");

    const sentItems = (envelopes as [unknown, [unknown, unknown][]][])
      .flatMap(([, items]) => items)
      .filter(([headers]) => (headers as { type?: string }).type === "event");
    expect(sentItems).toHaveLength(2);
    expect(sentItems[0]?.[1]).toMatchObject({
      message: "Product operation failed",
      level: "error",
      tags: {
        module: "identity",
        operation: "recovery",
        code: "PROVIDER_ERROR",
        correlation_id: correlationId,
        runtime: "server",
        synthetic: "false",
      },
    });
    expect(sentItems[0]?.[1]).not.toHaveProperty("request");
    expect(sentItems[0]?.[1]).not.toHaveProperty("exception");
    expect(sentItems[0]?.[1]).not.toHaveProperty("breadcrumbs");
    expect(sentItems[1]?.[1]).toMatchObject({
      message: "Product operation failed",
      level: "error",
      tags: {
        module: "ingestion",
        operation: "verify",
        code: "INTERNAL_ERROR",
        correlation_id: correlationId,
        version_id: "fd23a0b7-8b95-4df0-a57f-887008ae9d12",
        attempt_id: "88725091-ae4b-47d2-88dc-490b0baf1072",
      },
    });
    expect(sentItems[1]?.[1]).not.toHaveProperty("request");
    expect(sentItems[1]?.[1]).not.toHaveProperty("exception");
    expect(sentItems[1]?.[1]).not.toHaveProperty("breadcrumbs");
  });
});
