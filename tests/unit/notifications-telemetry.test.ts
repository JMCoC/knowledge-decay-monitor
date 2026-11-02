import { afterEach, describe, expect, it, vi } from "vitest";
import { createNotificationReporter } from "../../src/modules/notifications/telemetry";
import type { NotificationAlertLease, NotificationSentrySdk } from "../../src/modules/notifications/types";
import type { TelemetryContext } from "../../src/lib/observability/safe-event";

const context: TelemetryContext = {
  environment: "development",
  release: "d".repeat(40),
  runtime: "edge",
};
const alert: NotificationAlertLease = {
  eventId: "7aa95f5b-f37e-44ce-9555-dc4fb42de31f",
  operationId: "88725091-ae4b-47d2-88dc-490b0baf1072",
  code: "DELIVERY_FAILED",
};

function createSdk(options: {
  status?: number;
  flush?: boolean;
  eventId?: string;
} = {}) {
  let status: number | undefined;
  const sdk: NotificationSentrySdk = {
    captureEvent: vi.fn((event: Record<string, unknown>) => {
      status = options.status;
      return options.eventId ?? String(event.event_id);
    }),
    flush: vi.fn(async () => options.flush ?? true),
    clearDeliveryStatus: vi.fn(() => {
      status = undefined;
    }),
    deliveryStatus: vi.fn(() => status),
  };
  return sdk;
}

describe("notification Sentry reporter", () => {
  afterEach(() => vi.useRealTimers());

  it("reports a rebuilt event with a stable event ID and no recipient or message data", async () => {
    const sdk = createSdk({ status: 202 });
    const report = createNotificationReporter(sdk, context);

    await expect(report(alert)).resolves.toBe(true);

    expect(sdk.captureEvent).toHaveBeenCalledWith({
      type: undefined,
      event_id: "7aa95f5bf37e44ce9555dc4fb42de31f",
      level: "error",
      platform: "javascript",
      message: "Product operation failed",
      environment: "development",
      release: "d".repeat(40),
      tags: {
        "kdm.safe": "true",
        module: "notifications",
        operation: "alert",
        code: "DELIVERY_FAILED",
        correlation_id: alert.eventId,
        attempt_id: alert.operationId,
        runtime: "edge",
        synthetic: "false",
      },
    });
    expect(sdk.clearDeliveryStatus).toHaveBeenCalledWith("7aa95f5bf37e44ce9555dc4fb42de31f");
    expect(sdk.flush).toHaveBeenCalledWith(2000);
    expect(JSON.stringify(vi.mocked(sdk.captureEvent).mock.calls)).not.toMatch(/recipient|email|html|subject|authorization/);
  });

  it.each([429, 500])( "does not treat an HTTP %s transport result as reported", async (status) => {
    const report = createNotificationReporter(createSdk({ status, flush: true }), context);

    await expect(report(alert)).resolves.toBe(false);
  });

  it("does not treat a discarded envelope without observed transport status as reported", async () => {
    const report = createNotificationReporter(createSdk({ flush: true }), context);

    await expect(report(alert)).resolves.toBe(false);
  });

  it("does not treat a failed SDK flush as reported even with a success status", async () => {
    const report = createNotificationReporter(createSdk({ status: 200, flush: false }), context);

    await expect(report(alert)).resolves.toBe(false);
  });

  it("does not accept a status recorded for a different SDK event identity", async () => {
    const report = createNotificationReporter(createSdk({
      status: 200,
      eventId: "ffffffffffffffffffffffffffffffff",
    }), context);

    await expect(report(alert)).resolves.toBe(false);
  });

  it("returns false when flushing exceeds the two second reporting deadline", async () => {
    vi.useFakeTimers();
    const sdk = createSdk();
    vi.mocked(sdk.flush).mockImplementation(() => new Promise<boolean>(() => {}));
    const reportResult = createNotificationReporter(sdk, context)(alert);

    await vi.advanceTimersByTimeAsync(2000);

    await expect(reportResult).resolves.toBe(false);
  });
});
