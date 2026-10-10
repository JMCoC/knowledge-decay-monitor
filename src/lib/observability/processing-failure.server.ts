import "server-only";

import * as Sentry from "@sentry/nextjs";
import { captureOperationFailure, type SafeOperationEvent } from "./operation-events";

export async function reportProcessingFailure(
  event: SafeOperationEvent,
  flushMs = 500,
): Promise<void> {
  try {
    captureOperationFailure(event);
  } catch {
    // Telemetry must never change the controlled worker result.
  }

  const timeoutMs = Number.isFinite(flushMs)
    ? Math.min(500, Math.max(0, Math.floor(flushMs)))
    : 500;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });

  try {
    await Promise.race([
      Promise.resolve().then(() => Sentry.flush(timeoutMs)).then(() => undefined, () => undefined),
      timeout,
    ]);
  } catch {
    // A transport failure is intentionally not reported recursively.
  } finally {
    if (timer) clearTimeout(timer);
  }
}
