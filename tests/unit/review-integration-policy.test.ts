import { describe, expect, it } from "vitest";
import {
  REVIEW_INTEGRATION_FILES,
  normalizeReviewIntegrationFile,
  validateReviewIntegrationBatch,
} from "../../scripts/review-integration-policy.mjs";

describe("disposable review integration allowlist", () => {
  it("contains only the reviewed S3 review integration suites", () => {
    expect(REVIEW_INTEGRATION_FILES).toEqual([
      "tests/integration/review-foundation-isolation.test.ts",
      "tests/integration/review-commands-isolation.test.ts",
      "tests/integration/review-command-concurrency.test.ts",
      "tests/integration/review-assignment-reads-isolation.test.ts",
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
