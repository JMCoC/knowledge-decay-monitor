import * as Sentry from "@sentry/deno";
import { sanitizeSafeEnvelope } from "../../../src/lib/observability/safe-envelope.ts";
import { createNotificationReporter } from "../../../src/modules/notifications/telemetry.ts";
import { NotificationReadinessError, type NotificationConfig, type NotificationSentrySdk } from "../../../src/modules/notifications/types.ts";
import type { TelemetryContext } from "../../../src/lib/observability/safe-event.ts";

type DenoSentryOptions = NonNullable<Parameters<typeof Sentry.init>[0]>;
type DenoTransportFactory = NonNullable<DenoSentryOptions["transport"]>;
type DenoTransport = ReturnType<DenoTransportFactory>;
type DenoEnvelope = Parameters<DenoTransport["send"]>[0];

export type NotificationsSentryConfig = Pick<NotificationConfig, "sentryDsn" | "environment" | "release">;

function wrapTransport(
  transport: DenoTransport,
  context: TelemetryContext,
  deliveryStatuses: Map<string, number>,
): void {
  const send = transport.send.bind(transport);
  transport.send = async (envelope: DenoEnvelope) => {
    const safeEnvelope = sanitizeSafeEnvelope(envelope, context);
    if (!safeEnvelope) return { statusCode: 200 };

    const eventId = safeEnvelope[0].event_id;
    const result = await send(safeEnvelope as DenoEnvelope);
    if (typeof result.statusCode === "number") deliveryStatuses.set(eventId, result.statusCode);
    return result;
  };
}

/** Initializes the official Deno SDK and returns a reporter backed by its selected transport. */
export function initNotificationsSentry(
  config: NotificationsSentryConfig,
  transportOverride?: DenoTransportFactory,
): ReturnType<typeof createNotificationReporter> {
  const context: TelemetryContext = {
    environment: config.environment,
    release: config.release,
    runtime: "edge",
  };
  const deliveryStatuses = new Map<string, number>();
  Sentry.init({
    dsn: config.sentryDsn,
    environment: context.environment,
    release: context.release,
    defaultIntegrations: false,
    integrations: [],
    sendDefaultPii: false,
    enableLogs: false,
    maxBreadcrumbs: 0,
    tracesSampleRate: 0,
    skipOpenTelemetrySetup: true,
    ...(transportOverride ? { transport: transportOverride } : {}),
  });

  const transport = Sentry.getClient()?.getTransport();
  if (!transport) throw new NotificationReadinessError();
  wrapTransport(transport, context, deliveryStatuses);

  const sdk: NotificationSentrySdk = {
    captureEvent(event) {
      return Sentry.captureEvent(event as Sentry.Event);
    },
    flush(timeoutMs) {
      return Sentry.flush(timeoutMs);
    },
    clearDeliveryStatus(eventId) {
      deliveryStatuses.delete(eventId);
    },
    deliveryStatus(eventId) {
      return deliveryStatuses.get(eventId);
    },
  };

  return createNotificationReporter(sdk, context);
}
