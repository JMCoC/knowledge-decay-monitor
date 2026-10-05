import { describe, expect, it, vi } from "vitest";
import {
  installSafeTransport,
  wrapSafeTransport,
} from "../../src/lib/observability/safe-transport";
import type { TelemetryContext } from "../../src/lib/observability/safe-event";

const context: TelemetryContext = {
  environment: "vercel-preview",
  release: "a".repeat(40),
  runtime: "server",
};
const correlationId = "d2131057-f063-4b12-bafe-746728e8d7ad";

function envelope() {
  return [
    {
      event_id: "0123456789abcdef0123456789abcdef",
      sent_at: "2026-10-04T12:00:00.000Z",
      trace: { user_id: "ENVELOPE_SENTINEL" },
      dsn: "https://public@example.ingest.sentry.io/1",
    },
    [
      [
        { type: "event", content_type: "application/json" },
        {
          event_id: "0123456789abcdef0123456789abcdef",
          timestamp: 1_790_000_000,
          message: "DOCUMENT_SENTINEL",
          environment: "attacker",
          release: "TOKEN_SENTINEL",
          tags: {
            module: "repository",
            operation: "open",
            code: "INTERNAL_ERROR",
            correlation_id: correlationId,
            version_id: "fd23a0b7-8b95-4df0-a57f-887008ae9d12",
          },
          request: { headers: { authorization: "TOKEN_SENTINEL" } },
          exception: { values: [{ value: "DOCUMENT_SENTINEL" }] },
        },
      ],
      [{ type: "attachment", filename: "PRIVATE_SENTINEL" }, "BYTES_SENTINEL"],
      [{ type: "session" }, { did: "USER_SENTINEL" }],
      [{ type: "log" }, { body: "LOG_SENTINEL" }],
      [{ type: "span" }, { user_id: "SPAN_SENTINEL" }],
    ],
  ];
}

describe("safe Sentry transport", () => {
  it("sends only reconstructed event items and strips envelope metadata", async () => {
    const sent: unknown[] = [];
    const base = {
      send: vi.fn(async (value: unknown) => {
        sent.push(value);
        return { statusCode: 200 };
      }),
      flush: vi.fn(async () => true),
    };
    const transport = wrapSafeTransport(base as never, context);

    await transport.send(envelope() as never);

    expect(base.send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(sent)).not.toMatch(
      /SENTINEL|attachment|session|user_id|authorization|dsn|trace|content_type/,
    );
    expect(sent).toEqual([
      [
        {
          event_id: "0123456789abcdef0123456789abcdef",
          sent_at: "2026-10-04T12:00:00.000Z",
        },
        [
          [
            { type: "event" },
            {
              type: undefined,
              event_id: "0123456789abcdef0123456789abcdef",
              timestamp: 1_790_000_000,
              level: "error",
              platform: "javascript",
              message: "Product operation failed",
              environment: "vercel-preview",
              release: "a".repeat(40),
              tags: {
                module: "repository",
                operation: "open",
                code: "INTERNAL_ERROR",
                correlation_id: correlationId,
                runtime: "server",
                synthetic: "false",
                version_id: "fd23a0b7-8b95-4df0-a57f-887008ae9d12",
              },
            },
          ],
        ],
      ],
    ]);
    expect(await transport.flush(2000)).toBe(true);
    expect(base.flush).toHaveBeenCalledWith(2000);
  });

  it("does not call the network for empty or rejected envelopes", async () => {
    const base = {
      send: vi.fn(async () => ({ statusCode: 200 })),
      flush: vi.fn(async () => true),
    };
    const transport = wrapSafeTransport(base as never, context);

    await transport.send([{ trace: { secret: true } }, []] as never);
    await transport.send([{}, [[{ type: "event" }, { message: "unmarked" }]]] as never);

    expect(base.send).not.toHaveBeenCalled();
  });

  it("drops envelopes when the Sentry event identity or send time is invalid", async () => {
    const base = {
      send: vi.fn(async () => ({ statusCode: 200 })),
      flush: vi.fn(async () => true),
    };
    const transport = wrapSafeTransport(base as never, context);
    const mismatchedEventId = envelope() as [Record<string, unknown>, unknown[]];
    mismatchedEventId[0].event_id = "ffffffffffffffffffffffffffffffff";
    const invalidSendTime = envelope() as [Record<string, unknown>, unknown[]];
    invalidSendTime[0].sent_at = "NOT_A_DATE";

    await transport.send(mismatchedEventId as never);
    await transport.send(invalidSendTime as never);

    expect(base.send).not.toHaveBeenCalled();
  });

  it("propagates a base transport rejection once without retry recursion", async () => {
    const base = {
      send: vi.fn(() => Promise.reject(new Error("network unavailable"))),
      flush: vi.fn(async () => true),
    };
    const transport = wrapSafeTransport(base as never, context);

    await expect(transport.send(envelope() as never)).rejects.toThrow("network unavailable");
    expect(base.send).toHaveBeenCalledTimes(1);
  });

  it("installs the filter around the SDK-owned transport without replacing its network implementation", async () => {
    const sent: unknown[] = [];
    const sdkTransport = {
      send: vi.fn(async (value: unknown) => {
        sent.push(value);
        return { statusCode: 200 };
      }),
      flush: vi.fn(async (timeout?: number) => {
        void timeout;
        return true;
      }),
    };
    const originalSend = sdkTransport.send;
    const originalFlush = sdkTransport.flush;
    const client = { getTransport: () => sdkTransport };

    expect(installSafeTransport(client as never, context)).toBe(true);
    expect(sdkTransport.send).not.toBe(originalSend);
    await sdkTransport.send(envelope() as never);
    await sdkTransport.flush(500);

    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent)).not.toMatch(/SENTINEL|attachment|session|user_id/);
    expect(sdkTransport.flush).not.toBe(originalFlush);
  });
});
