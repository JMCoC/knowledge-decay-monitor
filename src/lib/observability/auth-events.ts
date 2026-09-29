import * as Sentry from "@sentry/nextjs";

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

const codes = new Set([
  "INTERNAL_ERROR",
  "PROVIDER_ERROR",
  "PROFILE_LOOKUP_FAILED",
  "SESSION_UNAVAILABLE",
]);

const correlationPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeMarker = "kdm.auth.safe";
const safeMessage = "Authentication operation failed";

type CandidateEvent = {
  event_id?: string;
  timestamp?: number;
  tags?: Record<string, unknown>;
};

type SafeSentryEvent = {
  type: undefined;
  event_id?: string;
  timestamp?: number;
  level: "warning";
  platform: "javascript";
  message: typeof safeMessage;
  tags: {
    operation: AuthOperation;
    code: string;
    correlation_id: string;
  };
};

function isOperation(value: unknown): value is AuthOperation {
  return typeof value === "string" && operations.has(value as AuthOperation);
}

function isSafeCode(value: unknown): value is string {
  return typeof value === "string" && codes.has(value);
}

/** Drops automatic events and rebuilds marked events from allowlisted fields only. */
export function filterSentryEvent(event: CandidateEvent): SafeSentryEvent | null {
  const tags = event.tags;
  const operation = tags?.operation;
  const code = tags?.code;
  const correlationId = tags?.correlation_id;

  if (
    tags?.[safeMarker] !== "true" ||
    !isOperation(operation) ||
    !isSafeCode(code) ||
    typeof correlationId !== "string" ||
    !correlationPattern.test(correlationId)
  ) {
    return null;
  }

  return {
    type: undefined,
    ...(typeof event.event_id === "string" ? { event_id: event.event_id } : {}),
    ...(typeof event.timestamp === "number" ? { timestamp: event.timestamp } : {}),
    level: "warning",
    platform: "javascript",
    message: safeMessage,
    tags: { operation, code, correlation_id: correlationId },
  };
}

export const authSafeSentryOptions = {
  tracesSampleRate: 0,
  maxBreadcrumbs: 0,
  sendDefaultPii: false,
  beforeSend: filterSentryEvent,
  beforeSendTransaction: () => null,
  beforeBreadcrumb: () => null,
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpHeaders: false,
    httpBodies: [],
    urlQueryParams: false,
    graphQL: { document: false, variables: false },
    genAI: { inputs: false, outputs: false },
    databaseQueryData: false,
    stackFrameVariables: false,
    frameContextLines: 0,
  },
};

/** Sends a controlled Auth failure without accepting provider errors or request data. */
export function reportAuthFailure(event: SafeAuthEvent): void {
  const operation = event.operation;
  const code = event.code;
  const correlationId = event.correlationId;

  if (
    !isOperation(operation) ||
    !isSafeCode(code) ||
    typeof correlationId !== "string" ||
    !correlationPattern.test(correlationId)
  ) {
    return;
  }

  try {
    Sentry.withScope((scope) => {
      scope.setTag(safeMarker, "true");
      scope.setTag("operation", operation);
      scope.setTag("code", code);
      scope.setTag("correlation_id", correlationId);
      Sentry.captureMessage(safeMessage, "warning");
    });
  } catch {
    // Telemetry must not change the Auth result.
  }
}
