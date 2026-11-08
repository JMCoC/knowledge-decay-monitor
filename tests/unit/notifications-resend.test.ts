import { afterEach, describe, expect, it, vi } from "vitest";

import { createResendSender } from "../../src/modules/notifications/resend";
import type { PreparedNotification } from "../../src/modules/notifications/types";

const API_KEY = "re_test_key_with_sufficient_fake_length";
const PROVIDER_ID = "10000000-0000-4000-8000-000000000021";

const PREPARED: PreparedNotification = {
  body: {
    from: "Knowledge Decay Monitor <notifications@knowledge-decay-monitor.online>",
    to: ["operator@example.test"],
    subject: "Your analysis is complete",
    html: "<p>Your analysis is complete.</p>",
    text: "Your analysis is complete.",
  },
  requestJson: "{\"from\":\"Knowledge Decay Monitor <notifications@knowledge-decay-monitor.online>\",\"to\":[\"operator@example.test\"],\"subject\":\"Your analysis is complete\",\"html\":\"<p>Your analysis is complete.</p>\",\"text\":\"Your analysis is complete.\"}",
  idempotencyKey: "kdm-terminal/10000000-0000-4000-8000-000000000011/v1",
  firstSubmissionAt: "2026-11-01T17:23:45.000Z",
};

function response(body: string, status = 200, headers?: HeadersInit) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json", ...Object.fromEntries(new Headers(headers).entries()) },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Resend notification sender", () => {
  it("sends the exact persisted body once with fixed endpoint and idempotency", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(JSON.stringify({ id: PROVIDER_ID })));
    const send = createResendSender({ apiKey: API_KEY, fetchFn });

    await expect(send(PREPARED)).resolves.toEqual({ ok: true, providerMessageId: PROVIDER_ID });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toMatchObject({
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": PREPARED.idempotencyKey,
    });
    expect(init?.body).toBe(PREPARED.requestJson);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([401, 429, 500])("maps HTTP %i without exposing the provider body or retrying", async status => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(
      "provider body sentinel operator@example.test re_secret_sentinel",
      status,
      status === 429 ? { "Retry-After": "90" } : undefined,
    ));
    const send = createResendSender({ apiKey: API_KEY, fetchFn });

    const result = await send(PREPARED);
    expect(result).toMatchObject({ ok: false, code: "DELIVERY_FAILED" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    if (status === 429 && !result.ok) expect(result.retryAfterSeconds).toBe(90);
    expect(JSON.stringify(result)).not.toMatch(/provider body sentinel|operator@example\.test|re_secret_sentinel/);
  });

  it("normalizes Retry-After dates and ignores invalid values", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T17:23:45.000Z"));
    const retryDate = new Date(Date.now() + 120_000).toUTCString();
    const datedFetch = vi.fn<typeof fetch>().mockResolvedValue(response("{}", 429, { "Retry-After": retryDate }));
    const datedResult = await createResendSender({ apiKey: API_KEY, fetchFn: datedFetch })(PREPARED);
    expect(datedResult).toMatchObject({ ok: false, retryAfterSeconds: 120 });

    const invalidFetch = vi.fn<typeof fetch>().mockResolvedValue(response("{}", 429, { "Retry-After": "tomorrow" }));
    const invalidResult = await createResendSender({ apiKey: API_KEY, fetchFn: invalidFetch })(PREPARED);
    expect(invalidResult).toEqual({ ok: false, code: "DELIVERY_FAILED" });
  });

  it("clamps Retry-After and keeps a valid delay when the response body is oversized", async () => {
    const clampedFetch = vi.fn<typeof fetch>().mockResolvedValue(response("{}", 429, { "Retry-After": "5000" }));
    const clamped = await createResendSender({ apiKey: API_KEY, fetchFn: clampedFetch })(PREPARED);
    expect(clamped).toMatchObject({ ok: false, retryAfterSeconds: 3600 });

    const oversizedFetch = vi.fn<typeof fetch>().mockResolvedValue(response("{}", 429, {
      "Content-Length": "65537",
      "Retry-After": "90",
    }));
    const oversized = await createResendSender({ apiKey: API_KEY, fetchFn: oversizedFetch })(PREPARED);
    expect(oversized).toMatchObject({ ok: false, code: "DELIVERY_FAILED", retryAfterSeconds: 90 });
  });

  it.each([
    ["invalid JSON", response("not-json")],
    ["missing provider ID", response("{}")],
    ["invalid provider ID", response(JSON.stringify({ id: "resend-id-not-a-uuid" }))],
    ["oversized declared body", response("{}", 200, { "Content-Length": "65537" })],
  ])("rejects %s", async (_name, providerResponse) => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(providerResponse);
    await expect(createResendSender({ apiKey: API_KEY, fetchFn })(PREPARED))
      .resolves.toEqual({ ok: false, code: "DELIVERY_FAILED" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("bounds the actual streamed response when Content-Length is absent", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(65_537)));
        controller.close();
      },
    });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { status: 200 }));

    await expect(createResendSender({ apiKey: API_KEY, fetchFn })(PREPARED))
      .resolves.toEqual({ ok: false, code: "DELIVERY_FAILED" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("times out while reading a slow body and cancels its stream", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    let streamTimer: ReturnType<typeof setTimeout> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        streamTimer = setTimeout(() => {
          controller.enqueue(new TextEncoder().encode("{}"));
        }, 1000);
      },
      cancel() {
        if (streamTimer !== undefined) clearTimeout(streamTimer);
        cancel();
      },
    });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { status: 200 }));
    const send = createResendSender({ apiKey: API_KEY, fetchFn, timeoutMs: 50 });
    const resultPromise = send(PREPARED);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(50);

    await expect(resultPromise).resolves.toEqual({ ok: false, code: "DELIVERY_FAILED" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("rejects empty keys and maps network failures without leaking exception text", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(new Error("re_secret_sentinel operator@example.test"));
    const log = vi.spyOn(console, "log");
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    expect(() => createResendSender({ apiKey: "   ", fetchFn })).toThrow(
      "Notification service is not ready.",
    );
    const result = await createResendSender({ apiKey: API_KEY, fetchFn })(PREPARED);
    expect(result).toEqual({ ok: false, code: "DELIVERY_FAILED" });
    expect(JSON.stringify(result)).not.toMatch(/re_secret_sentinel|operator@example\.test/);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
