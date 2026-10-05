export const operationCatalog = {
  identity: ["register", "login", "logout", "recovery", "password-update", "session"],
  workspace: ["bootstrap", "reconcile", "owners"],
  ingestion: ["reserve", "verify", "resume", "recover", "cleanup", "reconcile", "process", "retry"],
  repository: ["list", "open"],
  application: ["request", "render", "unhandled", "transport", "diagnostic"],
} as const;

export type SafeOperation = {
  [M in keyof typeof operationCatalog]: {
    module: M;
    operation: (typeof operationCatalog)[M][number];
  };
}[keyof typeof operationCatalog];

export type SafeFailureCode =
  | "INTERNAL_ERROR"
  | "PROVIDER_ERROR"
  | "PROFILE_LOOKUP_FAILED"
  | "SESSION_UNAVAILABLE"
  | "PROCESSING_FAILED"
  | "PARSING_FAILED"
  | "CHUNKING_FAILED"
  | "EMBEDDING_FAILED"
  | "PERSISTENCE_FAILED";

export type SafeFailureInput = SafeOperation & {
  code: SafeFailureCode;
  correlationId?: string;
  versionId?: string;
  attemptId?: string;
  synthetic?: boolean;
};

export type TelemetryContext = {
  environment: "development" | "vercel-preview" | "vercel-production";
  release: string;
  runtime: "browser" | "server" | "edge";
};

export type CaptureReceipt = { correlationId: string; eventId?: string };

export type SafeEvent = {
  type: undefined;
  event_id?: string;
  timestamp?: number;
  level: "error";
  platform: "javascript";
  message: "Product operation failed";
  environment: TelemetryContext["environment"];
  release: string;
  tags: {
    module: SafeOperation["module"];
    operation: SafeOperation["operation"];
    code: SafeFailureCode;
    correlation_id: string;
    runtime: TelemetryContext["runtime"];
    synthetic: "true" | "false";
    version_id?: string;
    attempt_id?: string;
  };
};

const moduleOperations = new Map<string, ReadonlySet<string>>(
  Object.entries(operationCatalog).map(([moduleName, operations]) => [
    moduleName,
    new Set<string>(operations),
  ]),
);
const failureCodes = new Set<SafeFailureCode>([
  "INTERNAL_ERROR",
  "PROVIDER_ERROR",
  "PROFILE_LOOKUP_FAILED",
  "SESSION_UNAVAILABLE",
  "PROCESSING_FAILED",
  "PARSING_FAILED",
  "CHUNKING_FAILED",
  "EMBEDDING_FAILED",
  "PERSISTENCE_FAILED",
]);
const processingCodes = new Set<SafeFailureCode>([
  "PROCESSING_FAILED",
  "PARSING_FAILED",
  "CHUNKING_FAILED",
  "EMBEDDING_FAILED",
  "PERSISTENCE_FAILED",
]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const eventIdPattern = /^[0-9a-f]{32}$/i;
const releasePattern = /^[0-9a-f]{40}(?:-dirty)?$/i;
const safeMarker = "kdm.safe";

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

function isEventId(value: unknown): value is string {
  return typeof value === "string" && eventIdPattern.test(value);
}

function isTelemetryContext(value: unknown): value is TelemetryContext {
  if (!isRecord(value)) return false;

  const environment = value.environment;
  const release = value.release;
  const runtime = value.runtime;
  const isEnvironment =
    environment === "development" ||
    environment === "vercel-preview" ||
    environment === "vercel-production";
  const isRuntime = runtime === "browser" || runtime === "server" || runtime === "edge";
  const isRelease = typeof release === "string" && releasePattern.test(release);

  return (
    isEnvironment &&
    isRuntime &&
    isRelease &&
    (environment === "development" || !release.endsWith("-dirty"))
  );
}

function isSafePair(moduleName: unknown, operation: unknown): boolean {
  return (
    typeof moduleName === "string" &&
    typeof operation === "string" &&
    (moduleOperations.get(moduleName)?.has(operation) ?? false)
  );
}

function isSafeCode(value: unknown): value is SafeFailureCode {
  return typeof value === "string" && failureCodes.has(value as SafeFailureCode);
}

function hasSafeMarker(tags: RecordValue): boolean {
  return tags[safeMarker] === "true";
}

function rebuildSafeEvent(
  candidate: unknown,
  context: TelemetryContext,
  requireMarker: boolean,
): SafeEvent | null {
  if (!isRecord(candidate) || !isTelemetryContext(context)) return null;

  const type = candidate.type;
  if (type !== undefined && type !== "error" && type !== "message") return null;

  const tags = candidate.tags;
  if (!isRecord(tags) || (requireMarker && !hasSafeMarker(tags))) return null;

  const moduleName = tags.module;
  const operation = tags.operation;
  const code = tags.code;
  const correlationId = tags.correlation_id;
  if (
    !isSafePair(moduleName, operation) ||
    !isSafeCode(code) ||
    !isUuid(correlationId) ||
    (processingCodes.has(code) &&
      (moduleName !== "ingestion" || (operation !== "process" && operation !== "retry")))
  ) {
    return null;
  }

  const versionId = isUuid(tags.version_id) ? tags.version_id : undefined;
  const attemptId = isUuid(tags.attempt_id) ? tags.attempt_id : undefined;
  const synthetic = tags.synthetic === "true" ? "true" : "false";
  const event: SafeEvent = {
    type: undefined,
    ...(isEventId(candidate.event_id) ? { event_id: candidate.event_id } : {}),
    ...(typeof candidate.timestamp === "number" &&
    Number.isFinite(candidate.timestamp) &&
    candidate.timestamp >= 0
      ? { timestamp: candidate.timestamp }
      : {}),
    level: "error",
    platform: "javascript",
    message: "Product operation failed",
    environment: context.environment,
    release: context.release,
    tags: {
      module: moduleName as SafeOperation["module"],
      operation: operation as SafeOperation["operation"],
      code,
      correlation_id: correlationId,
      runtime: context.runtime,
      synthetic,
      ...(versionId ? { version_id: versionId } : {}),
      ...(attemptId ? { attempt_id: attemptId } : {}),
    },
  };

  return event;
}

/** Drops unmarked events and rebuilds marked failures from validated fields only. */
export function filterSafeEvent(candidate: unknown, context: TelemetryContext): SafeEvent | null {
  try {
    return rebuildSafeEvent(candidate, context, true);
  } catch {
    return null;
  }
}

/** Revalidates an event after the SDK's beforeSend hook removed the private marker. */
export function filterCanonicalSafeEvent(
  candidate: unknown,
  context: TelemetryContext,
): SafeEvent | null {
  try {
    return rebuildSafeEvent(candidate, context, false);
  } catch {
    return null;
  }
}

export function isSafeFailureCode(value: unknown): value is SafeFailureCode {
  return isSafeCode(value);
}

export function isValidSafeCorrelationId(value: unknown): value is string {
  return isUuid(value);
}
