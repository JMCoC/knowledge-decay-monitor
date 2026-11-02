import * as Sentry from "@sentry/nextjs";
import { sanitizeSafeEnvelope } from "./safe-envelope";
import type { TelemetryContext } from "./safe-event";

type SentryInitOptions = Parameters<typeof Sentry.init>[0];
type TransportFactory = NonNullable<SentryInitOptions["transport"]>;
type SentryTransport = ReturnType<TransportFactory>;
type SentryEnvelope = Parameters<SentryTransport["send"]>[0];
type ClientWithTransport = { getTransport: () => SentryTransport | undefined };
const installedTransports = new WeakSet<object>();

/** Keeps the official SDK transport, but forwards only reconstructed error events. */
export function wrapSafeTransport(base: SentryTransport, context: TelemetryContext): SentryTransport {
  return {
    send(envelope) {
      const safeEnvelope = sanitizeSafeEnvelope(envelope, context);
      return safeEnvelope
        ? base.send(safeEnvelope as SentryEnvelope)
        : Promise.resolve({ statusCode: 200 });
    },
    flush(timeout) {
      return base.flush(timeout);
    },
  };
}

/** Wraps the SDK-selected fetch/Node transport in place without replacing its network executor. */
export function installSafeTransport(
  client: ClientWithTransport | undefined,
  context: TelemetryContext,
): boolean {
  try {
    const transport = client?.getTransport();
    if (!transport) return false;
    if (installedTransports.has(transport)) return true;

    const base: SentryTransport = {
      send: transport.send.bind(transport),
      flush: transport.flush.bind(transport),
    };
    const safe = wrapSafeTransport(base, context);
    transport.send = safe.send.bind(safe);
    transport.flush = safe.flush.bind(safe);
    installedTransports.add(transport);
    return true;
  } catch {
    return false;
  }
}
