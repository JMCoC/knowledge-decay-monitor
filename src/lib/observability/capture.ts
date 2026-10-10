import * as Sentry from "@sentry/nextjs";
import {
  isSafeFailureCode,
  isValidSafeCorrelationId,
  operationCatalog,
  type CaptureReceipt,
  type SafeFailureInput,
} from "./safe-event";

const moduleOperations = new Map<string, ReadonlySet<string>>(
  Object.entries(operationCatalog).map(([moduleName, operations]) => [
    moduleName,
    new Set<string>(operations),
  ]),
);
const processingCodes = new Set([
  "PROCESSING_FAILED",
  "PARSING_FAILED",
  "CHUNKING_FAILED",
  "EMBEDDING_FAILED",
  "PERSISTENCE_FAILED",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeFailureInput(value: unknown): value is SafeFailureInput {
  if (!isRecord(value)) return false;
  const moduleName = value.module;
  const operation = value.operation;
  const code = value.code;

  return (
    typeof moduleName === "string" &&
    typeof operation === "string" &&
    (moduleOperations.get(moduleName)?.has(operation) ?? false) &&
    isSafeFailureCode(code) &&
    (!processingCodes.has(code) || (moduleName === "ingestion" && (operation === "process" || operation === "retry"))) &&
    (value.correlationId === undefined || isValidSafeCorrelationId(value.correlationId))
  );
}

function newCorrelationId(): string | undefined {
  try {
    const correlationId = globalThis.crypto?.randomUUID?.();
    return isValidSafeCorrelationId(correlationId) ? correlationId : undefined;
  } catch {
    return undefined;
  }
}

function currentRuntime(): "browser" | "server" | "edge" {
  if (typeof window !== "undefined") return "browser";
  if ("EdgeRuntime" in globalThis) return "edge";
  return "server";
}

function safeEventId(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f]{32}$/i.test(value) ? value : undefined;
}

/** Emits only closed tags; SDK failures never replace the product failure. */
export function captureSafeFailure(input: SafeFailureInput): CaptureReceipt | undefined {
  if (!isSafeFailureInput(input)) return undefined;

  const correlationId = input.correlationId ?? newCorrelationId();
  if (!correlationId) return undefined;

  try {
    let eventId: string | undefined;
    Sentry.withScope((scope) => {
      scope.setTag("kdm.safe", "true");
      scope.setTag("module", input.module);
      scope.setTag("operation", input.operation);
      scope.setTag("code", input.code);
      scope.setTag("correlation_id", correlationId);
      scope.setTag("runtime", currentRuntime());
      scope.setTag("synthetic", input.synthetic === true ? "true" : "false");

      if (typeof input.versionId === "string" && isValidSafeCorrelationId(input.versionId)) {
        scope.setTag("version_id", input.versionId);
      }
      if (typeof input.attemptId === "string" && isValidSafeCorrelationId(input.attemptId)) {
        scope.setTag("attempt_id", input.attemptId);
      }

      eventId = safeEventId(Sentry.captureMessage("Product operation failed", "error"));
    });
    return { correlationId, ...(eventId ? { eventId } : {}) };
  } catch {
    return { correlationId };
  }
}
