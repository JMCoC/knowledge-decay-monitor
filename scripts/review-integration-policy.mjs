export const REVIEW_INTEGRATION_FILES = Object.freeze([
  "tests/integration/review-foundation-isolation.test.ts",
  "tests/integration/review-commands-isolation.test.ts",
  "tests/integration/review-command-concurrency.test.ts",
]);

const reviewIntegrationFileSet = new Set(REVIEW_INTEGRATION_FILES);
export const REVIEW_PORT_COUNT = 10;

/**
 * @param {string} message
 * @param {number} portBase
 */
export function isReviewStartupPortConflict(message, portBase) {
  const reportedPort = message.match(
    /failed to bind host port (?:0\.0\.0\.0|127\.0\.0\.1|\[::\]):(\d{1,5})\/tcp: address already in use\b/i,
  )?.[1];
  if (reportedPort === undefined) return false;
  const port = Number(reportedPort);
  return port >= portBase && port < portBase + REVIEW_PORT_COUNT;
}

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
