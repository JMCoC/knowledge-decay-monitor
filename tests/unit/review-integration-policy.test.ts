import { describe, expect, it } from "vitest";
import {
  REVIEW_INTEGRATION_FILES,
  isReviewStartupPortConflict,
  normalizeReviewIntegrationFile,
  validateReviewIntegrationBatch,
} from "../../scripts/review-integration-policy.mjs";

describe("disposable review integration allowlist", () => {
  it("contains only the three reviewed S3-01/S3-02 integration suites", () => {
    expect(REVIEW_INTEGRATION_FILES).toEqual([
      "tests/integration/review-foundation-isolation.test.ts",
      "tests/integration/review-commands-isolation.test.ts",
      "tests/integration/review-command-concurrency.test.ts",
    ]);
  });

  it("normalizes an allowlisted Windows path without accepting path variants", () => {
    expect(normalizeReviewIntegrationFile("tests\\integration\\review-foundation-isolation.test.ts"))
      .toBe("tests/integration/review-foundation-isolation.test.ts");
    expect(normalizeReviewIntegrationFile("./tests/integration/review-foundation-isolation.test.ts"))
      .toBeNull();
    expect(normalizeReviewIntegrationFile("tests/integration/anything.test.ts")).toBeNull();
  });

  it("accepts a nonempty exact batch and rejects arbitrary or duplicate paths", () => {
    expect(validateReviewIntegrationBatch([
      "tests/integration/review-command-concurrency.test.ts",
      "tests/integration/review-commands-isolation.test.ts",
    ])).toEqual([
      "tests/integration/review-command-concurrency.test.ts",
      "tests/integration/review-commands-isolation.test.ts",
    ]);
    expect(validateReviewIntegrationBatch([])).toBeNull();
    expect(validateReviewIntegrationBatch([
      "tests/integration/review-foundation-isolation.test.ts",
      "tests/integration/not-reviewed.test.ts",
    ])).toBeNull();
    expect(validateReviewIntegrationBatch([
      "tests/integration/review-foundation-isolation.test.ts",
      "tests\\integration\\review-foundation-isolation.test.ts",
    ])).toBeNull();
  });
});

describe("disposable review startup port conflicts", () => {
  it("recognizes Docker's bind failure for the current API or database port", () => {
    expect(isReviewStartupPortConflict(
      "failed to bind host port 0.0.0.0:56576/tcp: address already in use",
      56575,
    )).toBe(true);
    expect(isReviewStartupPortConflict(
      "failed to bind host port [::]:24002/tcp: address already in use",
      24000,
    )).toBe(true);
  });

  it("rejects collisions outside the selected range and unrelated startup failures", () => {
    expect(isReviewStartupPortConflict(
      "failed to bind host port 0.0.0.0:24010/tcp: address already in use",
      24000,
    )).toBe(false);
    expect(isReviewStartupPortConflict(
      "failed to bind host port 0.0.0.0:24001/tcp: permission denied",
      24000,
    )).toBe(false);
    expect(isReviewStartupPortConflict("migration failed: duplicate key value", 24000)).toBe(false);
  });
});
