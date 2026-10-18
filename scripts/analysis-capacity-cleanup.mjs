/**
 * Runs every synthetic fixture cleanup even if one fixture cannot be removed.
 * The rejection intentionally omits provider/auth/database error messages.
 * @param {{ dispose(): Promise<void> }[]} fixtures
 */
export async function disposeCapacityFixtures(fixtures) {
  const outcomes = await Promise.allSettled(
    [...fixtures].reverse().map((fixture) => fixture.dispose()),
  );
  const failedCount = outcomes.filter((outcome) => outcome.status === "rejected").length;
  if (failedCount > 0) {
    throw new Error(`Local capacity fixture cleanup failed for ${failedCount} fixture(s).`);
  }
}
