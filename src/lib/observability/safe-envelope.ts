import { filterCanonicalSafeEvent, type SafeEvent, type TelemetryContext } from "./safe-event.ts";

export type SafeEnvelope = [
  { event_id: string; sent_at: string },
  Array<[{ type: "event" }, SafeEvent]>,
];

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
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

/** Rebuilds only approved error events and drops all other envelope data. */
export function sanitizeSafeEnvelope(
  envelope: unknown,
  context: TelemetryContext,
): SafeEnvelope | null {
  try {
    if (!Array.isArray(envelope) || envelope.length !== 2) return null;
    const [rawHeader, rawItems] = envelope;
    if (!isRecord(rawHeader) || !Array.isArray(rawItems)) return null;
    const eventId = rawHeader.event_id;
    const sentAt = rawHeader.sent_at;
    if (!isValidEventId(eventId) || !isValidSentAt(sentAt)) return null;

    const items: Array<[{ type: "event" }, SafeEvent]> = [];
    for (const rawItem of rawItems) {
      if (!Array.isArray(rawItem) || rawItem.length !== 2) continue;
      const [rawItemHeader, payload] = rawItem;
      if (!isRecord(rawItemHeader) || rawItemHeader.type !== "event") continue;

      const event = filterCanonicalSafeEvent(payload, context);
      if (event?.event_id === eventId) items.push([{ type: "event" }, event]);
    }
    if (items.length === 0) return null;

    return [{ event_id: eventId, sent_at: sentAt }, items];
  } catch {
    return null;
  }
}
