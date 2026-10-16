import type { ClaimedAnalysis } from "./types";
import { AnalysisWorkerError } from "./types";

export type { ClaimArgs, ClaimedAnalysis } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requiredString(
  row: Record<string, unknown>,
  field: string,
): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new AnalysisWorkerError(
      "INTERNAL_ERROR",
      `Invalid claimed row: ${field}`,
    );
  }
  return value;
}

function optionalString(
  row: Record<string, unknown>,
  field: string,
): string | null {
  const value = row[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new AnalysisWorkerError(
      "INTERNAL_ERROR",
      `Invalid claimed row: ${field}`,
    );
  }
  return value;
}

/**
 * Validates a claim_analysis result row into the seven RPC fields
 * (spec §5.1). Throws AnalysisWorkerError on any shape mismatch.
 */
export function parseClaimedRow(row: unknown): ClaimedAnalysis {
  if (!isRecord(row)) {
    throw new AnalysisWorkerError("INTERNAL_ERROR", "Invalid claimed row");
  }
  const attemptCount = row["attempt_count"];
  if (typeof attemptCount !== "number" || !Number.isInteger(attemptCount)) {
    throw new AnalysisWorkerError(
      "INTERNAL_ERROR",
      "Invalid claimed row: attempt_count",
    );
  }
  return {
    id: requiredString(row, "id"),
    workspaceId: requiredString(row, "workspace_id"),
    initiatorId: requiredString(row, "initiator_id"),
    operationId: requiredString(row, "operation_id"),
    attemptCount,
    leaseExpiresAt: optionalString(row, "lease_expires_at"),
    nextAttemptAt: optionalString(row, "next_attempt_at"),
  };
}

/** FIFO comparator mirroring the sweep ORDER BY (created_at, id). */
export function compareByCreatedAtId(
  left: { created_at: string; id: string },
  right: { created_at: string; id: string },
): number {
  if (left.created_at !== right.created_at) {
    return left.created_at < right.created_at ? -1 : 1;
  }
  if (left.id !== right.id) {
    return left.id < right.id ? -1 : 1;
  }
  return 0;
}
