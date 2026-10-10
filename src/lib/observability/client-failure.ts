"use client";

import type { ActionError } from "../../types/contracts";
import { captureSafeFailure } from "./capture";

/** Converts a lost client/server response into a fixed reportable failure. */
export function captureClientTransportFailure(): ActionError {
  let correlationId: string | undefined;
  try {
    correlationId = captureSafeFailure({
      module: "application",
      operation: "transport",
      code: "INTERNAL_ERROR",
    })?.correlationId;
  } catch {
    // Preserve a controlled message even if telemetry is unavailable.
  }

  return {
    code: "INTERNAL_ERROR",
    message: "We couldn't confirm the operation. Refresh and try again.",
    ...(correlationId ? { correlationId } : {}),
  };
}
