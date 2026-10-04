import * as Sentry from "@sentry/nextjs";
import type { ActionErrorCode } from "../../types/contracts";
import type { SafeOperationModule, SafeOperationName } from "./auth-events";

export type SafeOperationEvent = {
  module: SafeOperationModule;
  operation: SafeOperationName;
  code: ActionErrorCode | "PROVIDER_ERROR";
  correlationId: string;
  versionId?: string;
  attemptId?: string;
};

const correlationPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const eventCode = new Set([
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "INVALID_INPUT",
  "NOT_FOUND",
  "CONFLICT",
  "PROCESSING_FAILED",
  "INTERNAL_ERROR",
  "PROVIDER_ERROR",
]);
const safeMarker = "kdm.operation.safe";
const safeMessage = "Product operation failed";

function isUuid(value: unknown): value is string {
  return typeof value === "string" && correlationPattern.test(value);
}

/** Sends only the product's closed, identifier-only operation event contract. */
export function captureOperationFailure(event: SafeOperationEvent): void {
  if (
    (event.module !== "ingestion" && event.module !== "repository") ||
    !["reserve", "verify", "resume", "recover", "cleanup", "reconcile", "list", "open"].includes(event.operation) ||
    !eventCode.has(event.code) ||
    !isUuid(event.correlationId) ||
    (event.versionId !== undefined && !isUuid(event.versionId)) ||
    (event.attemptId !== undefined && !isUuid(event.attemptId))
  ) {
    return;
  }

  try {
    Sentry.withScope((scope) => {
      scope.setTag(safeMarker, "true");
      scope.setTag("module", event.module);
      scope.setTag("operation", event.operation);
      scope.setTag("code", event.code);
      scope.setTag("correlation_id", event.correlationId);
      if (event.versionId) scope.setTag("version_id", event.versionId);
      if (event.attemptId) scope.setTag("attempt_id", event.attemptId);
      Sentry.captureMessage(safeMessage, "error");
    });
  } catch {
    // Telemetry must not change the product operation result.
  }
}
