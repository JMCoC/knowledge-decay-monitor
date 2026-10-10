import type { ActionErrorCode } from "../../types/contracts";
import { captureSafeFailure } from "./capture";
import type { SafeFailureCode, SafeFailureInput, SafeOperation } from "./safe-event";

export type SafeOperationEvent = {
  module: SafeOperation["module"];
  operation: SafeOperation["operation"];
  code: ActionErrorCode | SafeFailureCode | "PROVIDER_ERROR";
  correlationId: string;
  versionId?: string;
  attemptId?: string;
};

/** Sends only the product's closed, identifier-only operation event contract. */
export function captureOperationFailure(event: SafeOperationEvent) {
  if (!event || typeof event !== "object") return undefined;

  return captureSafeFailure({
    module: event.module,
    operation: event.operation,
    code: event.code as SafeFailureCode,
    correlationId: event.correlationId,
    versionId: event.versionId,
    attemptId: event.attemptId,
  } as SafeFailureInput);
}
