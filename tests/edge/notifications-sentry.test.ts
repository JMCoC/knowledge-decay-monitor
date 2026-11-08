import * as Sentry from "@sentry/deno";
import { initNotificationsSentry } from "../../supabase/functions/dispatch-notifications/sentry.ts";

declare const Deno: {
  test(name: string, fn: () => void | Promise<void>): void;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("official Deno SDK sends only the sanitized notification event to its transport", async () => {
  const delivered: unknown[] = [];
  let rejectNext = false;
  const report = initNotificationsSentry({
    sentryDsn: "https://public@example.ingest.sentry.io/1",
    environment: "development",
    release: "d".repeat(40),
  }, () => ({
    async send(envelope) {
      delivered.push(envelope);
      return { statusCode: 202 };
    },
    async flush() {
      return true;
    },
  }));

  Sentry.addEventProcessor((event) => {
    const reject = rejectNext;
    rejectNext = false;
    return {
      ...event,
      ...(reject ? { tags: { ...event.tags, code: "UNAPPROVED_CODE" } } : {}),
      request: { url: "https://private.example/PRIVATE_URL_SENTINEL", headers: { authorization: "PRIVATE_TOKEN_SENTINEL" } },
      exception: { values: [{ value: "PRIVATE_EXCEPTION_SENTINEL" }] },
      extra: { body: "PRIVATE_BODY_SENTINEL", email: "PRIVATE_EMAIL_SENTINEL" },
      contexts: { trace: { trace_id: "PRIVATE_TRACE_SENTINEL", span_id: "PRIVATE_SPAN_SENTINEL" } },
    };
  });

  const accepted = await report({
    eventId: "7aa95f5b-f37e-44ce-9555-dc4fb42de31f",
    operationId: "88725091-ae4b-47d2-88dc-490b0baf1072",
    code: "DELIVERY_FAILED",
  });

  assert(accepted, "the SDK transport accepted the safe event");
  assert(delivered.length === 1, "one event envelope reached the injected transport");
  const envelope = JSON.stringify(delivered);
  assert(!/PRIVATE_URL|PRIVATE_TOKEN|PRIVATE_EXCEPTION|PRIVATE_TRACE|PRIVATE_BODY|PRIVATE_EMAIL/.test(envelope), "private sentinel fields were removed");
  assert(envelope.includes("7aa95f5bf37e44ce9555dc4fb42de31f"), "the stable event ID reached the transport");
  assert(envelope.includes("DELIVERY_FAILED"), "the controlled alert code was preserved");

  rejectNext = true;
  const rejected = await report({
    eventId: "1102bc74-d1d8-4db1-85de-147fa6ff6c26",
    operationId: "88725091-ae4b-47d2-88dc-490b0baf1072",
    code: "DELIVERY_FAILED",
  });
  assert(!rejected, "a synthetically acknowledged but discarded envelope is not reported");
  assert(delivered.length === 1, "the rejected envelope never reached the base transport");
  await Sentry.close(0);
});
