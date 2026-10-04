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

export type SafeOperationModule = "ingestion" | "repository";
export type SafeOperationName =
  | "reserve"
  | "verify"
  | "resume"
  | "recover"
  | "cleanup"
  | "reconcile"
  | "list"
  | "open";

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
const operationModules = new Set<SafeOperationModule>(["ingestion", "repository"]);
const operationNames = new Set<SafeOperationName>([
  "reserve",
  "verify",
  "resume",
  "recover",
  "cleanup",
  "reconcile",
  "list",
  "open",
]);
const operationCodes = new Set([
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "INVALID_INPUT",
  "NOT_FOUND",
  "CONFLICT",
  "PROCESSING_FAILED",
  "INTERNAL_ERROR",
  "PROVIDER_ERROR",
]);

const correlationPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeMarker = "kdm.auth.safe";
const operationSafeMarker = "kdm.operation.safe";
const safeMessage = "Authentication operation failed";
const operationSafeMessage = "Product operation failed";

type CandidateEvent = {
  event_id?: string;
  timestamp?: number;
  tags?: Record<string, unknown>;
};

type SafeAuthSentryEvent = {
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

type SafeOperationSentryEvent = {
  type: undefined;
  event_id?: string;
  timestamp?: number;
  level: "error";
  platform: "javascript";
  message: typeof operationSafeMessage;
  tags: {
    module: SafeOperationModule;
    operation: SafeOperationName;
    code: string;
    correlation_id: string;
    version_id?: string;
    attempt_id?: string;
  };
};

type SafeSentryEvent = SafeAuthSentryEvent | SafeOperationSentryEvent;

function isOperation(value: unknown): value is AuthOperation {
  return typeof value === "string" && operations.has(value as AuthOperation);
}

function isSafeCode(value: unknown): value is string {
  return typeof value === "string" && codes.has(value);
}

function isOperationModule(value: unknown): value is SafeOperationModule {
  return typeof value === "string" && operationModules.has(value as SafeOperationModule);
}

function isOperationName(value: unknown): value is SafeOperationName {
  return typeof value === "string" && operationNames.has(value as SafeOperationName);
}

function isOperationCode(value: unknown): value is string {
  return typeof value === "string" && operationCodes.has(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && correlationPattern.test(value);
}

function eventIdentity(event: CandidateEvent) {
  return {
    type: undefined as undefined,
    ...(typeof event.event_id === "string" ? { event_id: event.event_id } : {}),
    ...(typeof event.timestamp === "number" ? { timestamp: event.timestamp } : {}),
  };
}

/** Drops automatic events and rebuilds marked events from allowlisted fields only. */
export function filterSentryEvent(event: CandidateEvent): SafeSentryEvent | null {
  const tags = event.tags;

  if (tags?.[safeMarker] === "true") {
  const operation = tags?.operation;
  const code = tags?.code;
  const correlationId = tags?.correlation_id;

  if (
    tags?.[safeMarker] !== "true" ||
    !isOperation(operation) ||
    !isSafeCode(code) ||
    !isUuid(correlationId)
  ) {
    return null;
  }

  return {
    ...eventIdentity(event),
    level: "warning",
    platform: "javascript",
    message: safeMessage,
    tags: { operation, code, correlation_id: correlationId },
  };
  }

  if (tags?.[operationSafeMarker] !== "true") return null;

  const moduleName = tags.module;
  const operation = tags.operation;
  const code = tags.code;
  const correlationId = tags.correlation_id;
  const versionId = tags.version_id;
  const attemptId = tags.attempt_id;
  if (
    !isOperationModule(moduleName) ||
    !isOperationName(operation) ||
    !isOperationCode(code) ||
    !isUuid(correlationId) ||
    (versionId !== undefined && !isUuid(versionId)) ||
    (attemptId !== undefined && !isUuid(attemptId))
  ) {
    return null;
  }

  return {
    ...eventIdentity(event),
    level: "error",
    platform: "javascript",
    message: operationSafeMessage,
    tags: {
      module: moduleName,
      operation,
      code,
      correlation_id: correlationId,
      ...(typeof versionId === "string" ? { version_id: versionId } : {}),
      ...(typeof attemptId === "string" ? { attempt_id: attemptId } : {}),
    },
  };
}

export const authSafeSentryOptions = {
  tracesSampleRate: 0,
  maxBreadcrumbs: 0,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
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
