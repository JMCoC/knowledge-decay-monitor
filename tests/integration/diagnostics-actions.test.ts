import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/nextjs";
import {
  createTelemetrySentryOptions,
} from "../../src/lib/observability/config";
import type { TelemetryContext } from "../../src/lib/observability/safe-event";
import { wrapSafeTransport } from "../../src/lib/observability/safe-transport";

const mocks = vi.hoisted(() => ({ requireActor: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("../../src/modules/identity/session", () => ({ requireActor: mocks.requireActor }));

import { runServerDiagnostic } from "../../src/app/sentry-example-page/actions";

const operator = {
  userId: "10000000-0000-4000-8000-000000000001",
  workspaceId: "20000000-0000-4000-8000-000000000001",
  role: "Admin" as const,
};
const envelopes: unknown[] = [];
const context: TelemetryContext = {
  environment: "development",
  release: "a".repeat(40),
  runtime: "server",
};

beforeAll(() => {
  vi.stubEnv("KDM_SENTRY_DIAGNOSTICS_ENABLED", "1");
  vi.stubEnv("KDM_SENTRY_DIAGNOSTICS_OPERATOR_IDS", operator.userId);
  vi.stubEnv("KDM_SENTRY_DIAGNOSTICS_EXPIRES_AT", new Date(Date.now() + 15 * 60_000).toISOString());
  mocks.requireActor.mockResolvedValue(operator);
  Sentry.init({
    dsn: "https://public@example.ingest.sentry.io/1",
    ...createTelemetrySentryOptions({ enabled: true, context }),
    transport: () => wrapSafeTransport({
      send: async (envelope: unknown) => {
        envelopes.push(envelope);
        return { statusCode: 200 };
      },
      flush: async () => true,
    } as never, context),
  });
});

afterAll(async () => {
  await Sentry.close(1000);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("authorized diagnostic SDK integration", () => {
  it("passes a fixed synthetic failure through the SDK and in-memory safe transport", async () => {
    const result = await runServerDiagnostic();

    expect(result).toMatchObject({
      ok: true,
      data: {
        correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
        eventId: expect.stringMatching(/^[0-9a-f]{32}$/i),
        flushed: true,
      },
    });
    expect(envelopes).toHaveLength(1);
    const items = (envelopes[0] as [unknown, [unknown, unknown][]])[1];
    expect(items).toHaveLength(1);
    expect(items[0]?.[1]).toMatchObject({
      message: "Product operation failed",
      environment: "development",
      release: context.release,
      tags: {
        module: "application",
        operation: "diagnostic",
        code: "INTERNAL_ERROR",
        synthetic: "true",
        runtime: "server",
      },
    });
    expect(JSON.stringify(envelopes)).not.toContain("Synthetic observability diagnostic.");
  });
});
