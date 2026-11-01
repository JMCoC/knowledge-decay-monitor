import { describe, expect, it, vi } from "vitest";

import { readNotificationsConfig } from "../../src/modules/notifications/config";
import { renderTerminalNotification } from "../../src/modules/notifications/templates";
import type { NotificationContext } from "../../src/modules/notifications/types";

const CONTEXT: NotificationContext = {
  eventId: "10000000-0000-4000-8000-000000000011",
  analysisId: "10000000-0000-4000-8000-000000000012",
  workspaceId: "10000000-0000-4000-8000-000000000013",
  recipientId: "10000000-0000-4000-8000-000000000014",
  recipientEmail: "operator@example.test",
  type: "analysis_completed",
  finishedAt: "2026-11-01T17:23:45.000Z",
};

const CONFIG = {
  from: "Knowledge Decay Monitor <notifications@knowledge-decay-monitor.online>",
  appOrigin: "https://knowledge-decay-monitor.online",
};

describe("terminal notification templates", () => {
  it("renders the approved completed message and authenticated analysis link", () => {
    const completed = renderTerminalNotification(CONTEXT, CONFIG);

    expect(completed.subject).toBe("Your analysis is complete");
    expect(completed.to).toEqual([CONTEXT.recipientEmail]);
    expect(completed.text).toContain("Your analysis is complete. Sign in to review the results.");
    expect(completed.text).toContain(`/login?analysisId=${CONTEXT.analysisId}`);
    expect(completed.text).toContain("Completed at: 2026-11-01T17:23:45.000Z");
    expect(completed.html).toContain("View analysis");
    expect(completed.html).toContain("Completed at");
  });

  it("renders the approved failed message without promising a retry", () => {
    const failed = renderTerminalNotification({ ...CONTEXT, type: "analysis_failed" }, CONFIG);

    expect(failed.subject).toBe("Your analysis could not be completed");
    expect(failed.text).toContain(
      "Your analysis could not be completed. Sign in to review its status and available next steps.",
    );
    expect(failed.text).toContain("Failed at: 2026-11-01T17:23:45.000Z");
    expect(failed.html).toContain("View analysis");
    expect(failed.html).toContain("Failed at");
    expect(failed.text).not.toMatch(/retry|provider|exception|error code/i);
  });

  it("contains no document, snapshot, or prompt content", () => {
    const completed = renderTerminalNotification({
      ...CONTEXT,
      type: "analysis_completed",
    }, CONFIG);

    expect(JSON.stringify(completed)).not.toMatch(/DOCUMENT_SENTINEL|SNAPSHOT_SENTINEL|PROMPT_SENTINEL/);
    expect(JSON.stringify(completed)).not.toContain(CONTEXT.workspaceId);
    expect(JSON.stringify(completed)).not.toContain(CONTEXT.recipientId);
  });

  it("rejects invalid context or an unsafe origin", () => {
    expect(() => renderTerminalNotification({
      ...CONTEXT,
      analysisId: "not-a-uuid",
    }, CONFIG)).toThrow();
    expect(() => renderTerminalNotification({
      ...CONTEXT,
      finishedAt: "not-a-date",
    }, CONFIG)).toThrow();
    expect(() => renderTerminalNotification(CONTEXT, {
      ...CONFIG,
      appOrigin: "http://example.test",
    })).toThrow();
    expect(() => renderTerminalNotification(CONTEXT, {
      ...CONFIG,
      appOrigin: "https://knowledge-decay-monitor.online/login?next=/admin",
    })).toThrow();
  });
});

function environment(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    NOTIFICATIONS_ENABLED: "true",
    NOTIFICATIONS_INTERNAL_TOKEN: "local-notification-token-with-32-chars",
    RESEND_API_KEY: "re_test_key_with_sufficient_fake_length",
    NOTIFICATIONS_FROM: CONFIG.from,
    APP_ORIGIN: "http://localhost:3000",
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_SERVICE_ROLE_KEY: "local-test-service-role-key",
    SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
    NOTIFICATIONS_ENVIRONMENT: "development",
    NOTIFICATIONS_RELEASE_SHA: "d".repeat(40),
    ...overrides,
  };
}

describe("notification environment readiness", () => {
  it("defaults to disabled without reading unrelated Auth mail credentials", () => {
    const read = vi.fn(() => undefined);
    const config = readNotificationsConfig(read);

    expect(config.enabled).toBe(false);
    expect(config.apiKey).toBe("");
    expect(config.internalToken).toBe("");
    expect(read).toHaveBeenCalledExactlyOnceWith("NOTIFICATIONS_ENABLED");
  });

  it("treats the planned zero value as disabled", () => {
    const read = vi.fn((name: string) => name === "NOTIFICATIONS_ENABLED" ? "0" : undefined);
    const config = readNotificationsConfig(read);

    expect(config.enabled).toBe(false);
    expect(read).toHaveBeenCalledExactlyOnceWith("NOTIFICATIONS_ENABLED");
  });

  it("reads the approved private configuration through the injected reader", () => {
    const values = environment();
    const read = (name: string) => values[name];
    const config = readNotificationsConfig(read);

    expect(config).toMatchObject({
      enabled: true,
      from: CONFIG.from,
      appOrigin: "http://localhost:3000",
      environment: "development",
      release: "d".repeat(40),
    });
    expect(config.apiKey).toBe(values.RESEND_API_KEY);
    expect(config.internalToken).toBe(values.NOTIFICATIONS_INTERNAL_TOKEN);
  });

  it("accepts the explicit one value for an enabled runtime", () => {
    const values = environment({ NOTIFICATIONS_ENABLED: "1" });
    expect(readNotificationsConfig(name => values[name]).enabled).toBe(true);
  });

  it.each([
    ["unknown enabled flag", { NOTIFICATIONS_ENABLED: "yes" }],
    ["short internal token", { NOTIFICATIONS_INTERNAL_TOKEN: "too-short" }],
    ["whitespace in internal token", { NOTIFICATIONS_INTERNAL_TOKEN: "invalid token that is longer than 32 chars" }],
    ["unverified sender", { NOTIFICATIONS_FROM: "Other <other@example.test>" }],
    ["insecure hosted origin", { APP_ORIGIN: "http://example.test" }],
    ["origin with a query", { APP_ORIGIN: "https://example.test/?next=/login" }],
    ["origin with an empty query", { APP_ORIGIN: "https://example.test?" }],
    ["origin with credentials", { APP_ORIGIN: "https://operator@example.test" }],
    ["origin with a normalized path", { APP_ORIGIN: "https://example.test/.." }],
    ["missing provider key", { RESEND_API_KEY: "" }],
    ["missing environment label", { NOTIFICATIONS_ENVIRONMENT: "" }],
    ["missing release SHA", { NOTIFICATIONS_RELEASE_SHA: "" }],
    ["short release SHA", { NOTIFICATIONS_RELEASE_SHA: "a".repeat(39) }],
    ["dirty release outside development", {
      NOTIFICATIONS_ENVIRONMENT: "vercel-production",
      NOTIFICATIONS_RELEASE_SHA: `${"a".repeat(40)}-dirty`,
    }],
    ["uppercase dirty release outside development", {
      NOTIFICATIONS_ENVIRONMENT: "vercel-production",
      NOTIFICATIONS_RELEASE_SHA: `${"A".repeat(40)}-DIRTY`,
    }],
  ])("fails readiness for %s", (_name, overrides) => {
    const values = environment(overrides);
    expect(() => readNotificationsConfig(name => values[name])).toThrow(
      "Notification service is not ready.",
    );
  });

  it("allows a dirty SHA only for the development environment", () => {
    const values = environment({ NOTIFICATIONS_RELEASE_SHA: `${"a".repeat(40)}-dirty` });
    expect(readNotificationsConfig(name => values[name]).release).toBe(`${"a".repeat(40)}-dirty`);
  });

  it("normalizes hexadecimal release values before enforcing the dirty suffix", () => {
    const values = environment({ NOTIFICATIONS_RELEASE_SHA: "A".repeat(40) });
    expect(readNotificationsConfig(name => values[name]).release).toBe("a".repeat(40));
  });
});
