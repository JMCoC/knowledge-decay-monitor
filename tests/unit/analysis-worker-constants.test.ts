import { describe, expect, it } from "vitest";

import {
  BACKOFF_ATTEMPT_1_MS,
  BACKOFF_ATTEMPT_2_MS,
  HEARTBEAT_SECONDS,
  LEASE_SECONDS,
  MAX_ATTEMPT_MS,
  MAX_BATCH_MS,
  MAX_TOTAL_MS,
  N,
  RETRIEVAL_TIMEOUT_MS,
  WORKER_LIMITS,
} from "../../src/modules/analysis/worker/constants";

describe("analysis worker constants", () => {
  it("freezes the Task 0 batch size", () => {
    expect(N).toBe(10);
  });

  it("freezes the lease and heartbeat", () => {
    expect(LEASE_SECONDS).toBe(180);
    expect(HEARTBEAT_SECONDS).toBe(30);
  });

  it("freezes the provider backoffs", () => {
    expect(BACKOFF_ATTEMPT_1_MS).toBe(30_000);
    expect(BACKOFF_ATTEMPT_2_MS).toBe(120_000);
  });

  it("freezes the time budgets", () => {
    expect(MAX_BATCH_MS).toBe(60_000);
    expect(MAX_ATTEMPT_MS).toBe(30 * 60 * 1000);
    expect(MAX_TOTAL_MS).toBe(90 * 60 * 1000);
    expect(RETRIEVAL_TIMEOUT_MS).toBe(60_000);
  });

  it("freezes the aggregate limits object", () => {
    expect(Object.isFrozen(WORKER_LIMITS)).toBe(true);
    expect(WORKER_LIMITS).toEqual({
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
  });
});
