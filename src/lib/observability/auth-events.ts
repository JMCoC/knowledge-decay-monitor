import { captureSafeFailure } from "./capture";
import { createTelemetrySentryOptions } from "./config";
import type { SafeFailureCode, SafeOperation } from "./safe-event";

export type AuthOperation =
  | "register"
  | "login"
  | "logout"
  | "bootstrap"
  | "recovery"
  | "password-update";

export type SafeAuthEvent = {
  operation: AuthOperation;
  code: string;
  correlationId: string;
};

const operations = new Set<AuthOperation>([
  "register",
  "login",
  "logout",
  "bootstrap",
  "recovery",
  "password-update",
]);

export type SafeOperationModule = SafeOperation["module"];
export type SafeOperationName = SafeOperation["operation"];

/** Drops automatic events and rebuilds marked failures from allowlisted fields only. */
export function filterSentryEvent(event: unknown) {
  return createTelemetrySentryOptions({
    enabled: true,
    context: {
      environment: "development",
      release: "0".repeat(40),
      runtime: "server",
    },
  }).beforeSend(event);
}

export const authSafeSentryOptions = createTelemetrySentryOptions({
  enabled: true,
  context: {
    environment: "development",
    release: "0".repeat(40),
    runtime: "server",
  },
});

/** Sends a controlled Auth failure without accepting provider errors or request data. */
export function reportAuthFailure(event: SafeAuthEvent) {
  if (!event || typeof event !== "object" || !operations.has(event.operation)) return undefined;
  const operation = event.operation === "bootstrap" ? "bootstrap" : event.operation;
  const moduleName = event.operation === "bootstrap" ? "workspace" : "identity";

  return captureSafeFailure({
    module: moduleName,
    operation,
    code: event.code as SafeFailureCode,
    correlationId: event.correlationId,
  } as never);
}
