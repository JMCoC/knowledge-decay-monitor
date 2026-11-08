import {
  filterSafeEvent,
  isValidSafeCorrelationId,
  type TelemetryContext,
} from "../../lib/observability/safe-event.ts";
import type { NotificationAlertLease, NotificationSentrySdk } from "./types.ts";

const REPORT_TIMEOUT_MS = 2000;

function flushWithinDeadline(sdk: NotificationSentrySdk): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), REPORT_TIMEOUT_MS);
  });
  const flush = Promise.resolve()
    .then(() => sdk.flush(REPORT_TIMEOUT_MS))
    .catch(() => false);

  return Promise.race([flush, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** Creates a Sentry event containing only the stable event identity and controlled failure code. */
export function createNotificationReporter(
  sdk: NotificationSentrySdk,
  context: TelemetryContext,
): (alert: NotificationAlertLease) => Promise<boolean> {
  return async (alert) => {
    try {
      if (!isValidSafeCorrelationId(alert.eventId) || !isValidSafeCorrelationId(alert.operationId)) {
        return false;
      }

      const eventId = alert.eventId.replaceAll("-", "");
      const safeEvent = filterSafeEvent({
        type: undefined,
        event_id: eventId,
        level: "error",
        platform: "javascript",
        message: "Product operation failed",
        tags: {
          "kdm.safe": "true",
          module: "notifications",
          operation: "alert",
          code: alert.code,
          correlation_id: alert.eventId,
          attempt_id: alert.operationId,
        },
      }, context);
      if (!safeEvent) return false;

      sdk.clearDeliveryStatus(eventId);
      const captureId = sdk.captureEvent({
        ...safeEvent,
        tags: { ...safeEvent.tags, "kdm.safe": "true" },
      });
      if (captureId.toLowerCase() !== eventId.toLowerCase()) return false;

      const flushed = await flushWithinDeadline(sdk);
      if (!flushed) return false;

      const status = sdk.deliveryStatus(eventId);
      return Number.isInteger(status) && status! >= 200 && status! < 300;
    } catch {
      return false;
    }
  };
}
