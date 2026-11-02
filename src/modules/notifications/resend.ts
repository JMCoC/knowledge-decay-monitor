import { NotificationReadinessError } from "./types.ts";
import type { PreparedNotification, SendNotificationResult } from "./types.ts";

export const RESEND_ENDPOINT = "https://api.resend.com/emails";
export const RESEND_TIMEOUT_MS = 10_000;
export const MAX_RESEND_RESPONSE_BYTES = 65_536;
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;
const PROVIDER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_IDEMPOTENCY_KEY_PATTERN = /^kdm-terminal\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/v1$/i;

class ResponseLimitError extends Error {}
class ResponseEncodingError extends Error {}

function boundedRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (value === null) return undefined;
  const header = value.trim();
  if (/^\d+$/.test(header)) {
    return Math.min(3600, Number(header));
  }

  const validHttpDate = /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2} \d{2}:\d{2}:\d{2} GMT|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}\d{1,2} \d{2}:\d{2}:\d{2} \d{4})$/;
  if (!validHttpDate.test(header)) return undefined;
  const retryAt = Date.parse(header);
  if (!Number.isFinite(retryAt)) return undefined;
  return Math.min(3600, Math.max(0, Math.ceil((retryAt - nowMs) / 1000)));
}

async function readBoundedResponse(
  response: Response,
  setActiveReader: (reader: ReadableStreamDefaultReader<Uint8Array> | undefined) => void,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const normalizedLength = contentLength.trim();
    if (!/^\d+$/.test(normalizedLength) || Number(normalizedLength) > MAX_RESEND_RESPONSE_BYTES) {
      throw new ResponseLimitError();
    }
  }

  if (response.body === null) return "";

  const reader = response.body.getReader();
  setActiveReader(reader);
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      byteLength += part.value.byteLength;
      if (byteLength > MAX_RESEND_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new ResponseLimitError();
      }
      chunks.push(part.value);
    }
  } finally {
    setActiveReader(undefined);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ResponseEncodingError();
  }
}

function failure(retryAfterSeconds?: number): SendNotificationResult {
  return retryAfterSeconds === undefined
    ? { ok: false, code: "DELIVERY_FAILED" }
    : { ok: false, code: "DELIVERY_FAILED", retryAfterSeconds };
}

export function createResendSender(options: {
  apiKey: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}): (prepared: PreparedNotification) => Promise<SendNotificationResult> {
  const { apiKey, fetchFn = fetch, timeoutMs = RESEND_TIMEOUT_MS } = options;
  if (!apiKey || apiKey.trim() !== apiKey || /\s/.test(apiKey)) {
    throw new NotificationReadinessError();
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > RESEND_TIMEOUT_MS) {
    throw new NotificationReadinessError();
  }

  return async prepared => {
    if (
      typeof prepared.requestJson !== "string"
      || new TextEncoder().encode(prepared.requestJson).byteLength > 16_384
      || typeof prepared.idempotencyKey !== "string"
      || prepared.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH
      || !EVENT_IDEMPOTENCY_KEY_PATTERN.test(prepared.idempotencyKey)
    ) {
      return failure();
    }

    const controller = new AbortController();
    let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        if (activeReader) void activeReader.cancel().catch(() => undefined);
        reject(new Error("notification request timed out"));
      }, timeoutMs);
    });

    const request = (async (): Promise<SendNotificationResult> => {
      const response = await fetchFn(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": prepared.idempotencyKey,
        },
        body: prepared.requestJson,
        redirect: "error",
        signal: controller.signal,
      });
      const retryAfterSeconds = boundedRetryAfter(response.headers.get("retry-after"), Date.now());
      let responseBody: string;
      try {
        responseBody = await readBoundedResponse(response, reader => {
          activeReader = reader;
        });
      } catch {
        return failure(retryAfterSeconds);
      }

      if (!response.ok) return failure(retryAfterSeconds);
      let parsed: unknown;
      try {
        parsed = JSON.parse(responseBody);
      } catch {
        return failure();
      }
      if (
        typeof parsed !== "object"
        || parsed === null
        || !("id" in parsed)
        || typeof parsed.id !== "string"
        || !PROVIDER_ID_PATTERN.test(parsed.id)
      ) {
        return failure();
      }
      return { ok: true, providerMessageId: parsed.id };
    })();

    try {
      return await Promise.race([request, timeout]);
    } catch {
      return failure();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    }
  };
}
