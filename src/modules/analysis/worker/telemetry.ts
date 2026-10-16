import type { AnalysisFailureCode } from "../../../types/analysis-internal.ts";

export type AnalysisWorkerTelemetryOperation =
  | "claim"
  | "batch"
  | "renew"
  | "finalize"
  | "recover";

export interface AnalysisWorkerTelemetryEvent {
  module: "analysis";
  operation: AnalysisWorkerTelemetryOperation;
  code?: AnalysisFailureCode | string;
  correlation_id?: string;
  analysis_id?: string;
  workspace_id?: string;
  attempt_count?: number;
  batch_index?: number;
  duration_ms?: number;
}

/** Optional sink (e.g. a Sentry SDK wrapper). Never receives raw errors. */
export type TelemetrySink = (event: Record<string, unknown>) => void;

const ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  "module",
  "operation",
  "code",
  "correlation_id",
  "analysis_id",
  "workspace_id",
  "attempt_count",
  "batch_index",
  "duration_ms",
]);

function newCorrelationId(): string {
  try {
    const randomUuid = globalThis.crypto?.randomUUID?.();
    if (typeof randomUuid === "string" && randomUuid.length > 0) {
      return randomUuid;
    }
  } catch {
    // Fall through to the Math.random fallback below.
  }
  return `local-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(16)}`;
}

function sanitize(
  event: AnalysisWorkerTelemetryEvent,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (value !== undefined && ALLOWED_FIELDS.has(key)) {
      sanitized[key] = value;
    }
  }
  if (typeof sanitized["correlation_id"] !== "string") {
    sanitized["correlation_id"] = newCorrelationId();
  }
  return sanitized;
}

/**
 * Emits a sanitized worker event as one-line JSON on stdout and,
 * optionally, to an injected sink. Only whitelist fields survive;
 * raw exceptions, pair/chunk text, prompts and tokens are dropped
 * before serialization (spec §8). Telemetry never breaks the worker.
 */
export function reportAnalysisFailure(
  event: AnalysisWorkerTelemetryEvent,
  sink?: TelemetrySink | null,
): void {
  const sanitized = sanitize(event);
  console.log(JSON.stringify(sanitized));
  if (sink) {
    try {
      sink(sanitized);
    } catch {
      // Telemetry delivery must not change worker behavior.
    }
  }
}
