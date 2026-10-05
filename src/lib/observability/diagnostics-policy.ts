import type { Actor } from "../../types/contracts";

export type DiagnosticPolicy = {
  enabled: boolean;
  operatorIds: readonly string[];
  expiresAt: string;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
const MAX_DIAGNOSTIC_WINDOW_MS = 60 * 60 * 1000;

function parseUtcTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parts = UTC_TIMESTAMP_PATTERN.exec(value);
  if (!parts) return undefined;

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== Number(parts[1]) ||
    date.getUTCMonth() + 1 !== Number(parts[2]) ||
    date.getUTCDate() !== Number(parts[3]) ||
    date.getUTCHours() !== Number(parts[4]) ||
    date.getUTCMinutes() !== Number(parts[5]) ||
    date.getUTCSeconds() !== Number(parts[6])
  ) {
    return undefined;
  }
  return timestamp;
}

export function isDiagnosticOperatorId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function isDiagnosticExpiryActive(expiresAt: string, nowMs: number): boolean {
  const expiry = parseUtcTimestamp(expiresAt);
  return (
    Number.isFinite(nowMs) &&
    expiry !== undefined &&
    expiry > nowMs &&
    expiry - nowMs <= MAX_DIAGNOSTIC_WINDOW_MS
  );
}

export function canRunDiagnostics(
  actor: Actor,
  config: DiagnosticPolicy,
  nowMs: number,
): boolean {
  if (
    !actor ||
    actor.role !== "Admin" ||
    !isDiagnosticOperatorId(actor.userId) ||
    !config ||
    config.enabled !== true ||
    !Array.isArray(config.operatorIds) ||
    !Number.isFinite(nowMs)
  ) {
    return false;
  }

  const expiry = parseUtcTimestamp(config.expiresAt);
  if (
    expiry === undefined ||
    !isDiagnosticExpiryActive(config.expiresAt, nowMs) ||
    config.operatorIds.length === 0 ||
    !config.operatorIds.every(isDiagnosticOperatorId)
  ) {
    return false;
  }

  return config.operatorIds.some((operatorId) => operatorId.toLowerCase() === actor.userId.toLowerCase());
}
