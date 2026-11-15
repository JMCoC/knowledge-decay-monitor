export const REVIEW_INTEGRATION_FILES = Object.freeze([
  "tests/integration/review-foundation-isolation.test.ts",
  "tests/integration/review-commands-isolation.test.ts",
  "tests/integration/review-command-concurrency.test.ts",
]);

const reviewIntegrationFileSet = new Set(REVIEW_INTEGRATION_FILES);

/** @param {unknown} argument */
export function normalizeReviewIntegrationFile(argument) {
  if (typeof argument !== "string") return null;
  const normalized = argument.replaceAll("\\", "/");
  return reviewIntegrationFileSet.has(normalized) ? normalized : null;
}

/** @param {unknown} argumentsList */
export function validateReviewIntegrationBatch(argumentsList) {
  if (!Array.isArray(argumentsList) || argumentsList.length === 0) return null;
  const files = argumentsList.map(normalizeReviewIntegrationFile);
  if (files.some((file) => file === null) || new Set(files).size !== files.length) return null;
  return /** @type {string[]} */ (files);
}
