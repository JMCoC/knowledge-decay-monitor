/**
 * Versioned worker budgets for S2-06.
 *
 * Source: spec §4.3 (lease 180s, heartbeat 30s, backoffs 30s/2min, caps
 * 60s/30min/90min) with Task 0 calibration (N=10 validated, no
 * recalibration; see the Task 0 appendix in the implementation plan).
 * Do not retune here: changes require a Task 0 re-measurement.
 */

export const N = 10;

export const LEASE_SECONDS = 180;

export const HEARTBEAT_SECONDS = 30;

export const BACKOFF_ATTEMPT_1_MS = 30_000;

export const BACKOFF_ATTEMPT_2_MS = 120_000;

export const MAX_BATCH_MS = 60_000;

export const MAX_ATTEMPT_MS = 30 * 60 * 1000;

export const MAX_TOTAL_MS = 90 * 60 * 1000;

export const RETRIEVAL_TIMEOUT_MS = 60_000;

export const WORKER_LIMITS = Object.freeze({
  N,
  LEASE_SECONDS,
  HEARTBEAT_SECONDS,
  BACKOFF_ATTEMPT_1_MS,
  BACKOFF_ATTEMPT_2_MS,
  MAX_BATCH_MS,
  MAX_ATTEMPT_MS,
  MAX_TOTAL_MS,
  RETRIEVAL_TIMEOUT_MS,
});
