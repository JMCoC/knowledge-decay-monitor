import type { RepositoryItem } from "@/types/contracts";
import { INGESTION_PROCESSING_LEASE_MS } from "@/types/contracts";

export type ProcessingRecoveryAction = "start" | "retry";

/** Presentation only: the server action reauthorizes and rechecks every claim. */
export function processingRecoveryAction(
  version: NonNullable<RepositoryItem["latestVersion"]>,
  nowMs: number,
): ProcessingRecoveryAction | null {
  if (
    version.version_number !== 1 ||
    version.uploadState !== "confirmed" ||
    version.version_status !== null
  ) {
    return null;
  }

  if (version.processing_status === "uploaded") return version.processingQueued ? null : "start";
  if (version.processing_status === "processing_failed") return "retry";
  if (version.processing_status !== "processing" || !Number.isFinite(nowMs)) return null;

  if (version.processingLeaseExpiresAt) {
    const expiresAt = Date.parse(version.processingLeaseExpiresAt);
    return Number.isFinite(expiresAt) && nowMs >= expiresAt ? "retry" : null;
  }
  // Compatibility for unqueued versions created before the worker migration.
  const startedAtMs = version.processingStartedAt === null
    ? Number.NaN
    : Date.parse(version.processingStartedAt);
  if (!Number.isFinite(startedAtMs)) return null;
  return nowMs - startedAtMs > INGESTION_PROCESSING_LEASE_MS ? "retry" : null;
}
