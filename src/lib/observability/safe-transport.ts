import * as Sentry from "@sentry/nextjs";
import { filterCanonicalSafeEvent, type TelemetryContext } from "./safe-event";

type SentryInitOptions = Parameters<typeof Sentry.init>[0];
type TransportFactory = NonNullable<SentryInitOptions["transport"]>;
type SentryTransport = ReturnType<TransportFactory>;
type SentryEnvelope = Parameters<SentryTransport["send"]>[0];
type EnvelopeHeader = Record<string, unknown>;
type EnvelopeItem = [Record<string, unknown>, unknown];
type ClientWithTransport = { getTransport: () => SentryTransport | undefined };
const installedTransports = new WeakSet<object>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidEventId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/i.test(value);
}

function isValidSentAt(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 30 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function asSafeEnvelope(
  envelope: unknown,
  context: TelemetryContext,
): SentryEnvelope | null {
  if (!Array.isArray(envelope) || envelope.length !== 2) return null;
  const [rawHeader, rawItems] = envelope;
  if (!isRecord(rawHeader) || !Array.isArray(rawItems)) return null;
  const eventId = rawHeader.event_id;
  const sentAt = rawHeader.sent_at;
  if (!isValidEventId(eventId) || !isValidSentAt(sentAt)) return null;

  const items: EnvelopeItem[] = [];
  for (const rawItem of rawItems) {
    if (!Array.isArray(rawItem) || rawItem.length !== 2) continue;
    const [rawItemHeader, payload] = rawItem;
    if (!isRecord(rawItemHeader) || rawItemHeader.type !== "event") continue;

    const event = filterCanonicalSafeEvent(payload, context);
    if (event?.event_id === eventId) items.push([{ type: "event" }, event]);
  }
  if (items.length === 0) return null;

  const header: EnvelopeHeader = { event_id: eventId, sent_at: sentAt };

  return [header, items] as SentryEnvelope;
}

/** Keeps the official SDK transport, but forwards only reconstructed error events. */
export function wrapSafeTransport(base: SentryTransport, context: TelemetryContext): SentryTransport {
  return {
    send(envelope) {
      const safeEnvelope = asSafeEnvelope(envelope, context);
      return safeEnvelope ? base.send(safeEnvelope) : Promise.resolve({ statusCode: 200 });
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
