/**
 * Exact credit pricing for S2-04 estimates.
 *
 * Verbatim contract §6 (`docs/contracts/S2-04-retrieval-estimation.md`).
 * Pure integer arithmetic: the cosine `similarity` (double) filters and
 * orders inside SQL and never enters this formula. `pricingVersion`
 * "s2-04-v1" freezes these coefficients; S2-05 detects any change as
 * ESTIMATE_STALE by comparing the persisted version.
 */
export const ANALYSIS_PRICING = {
  version: "s2-04-v1",
  base: 100,
  perChunk: 5,
  perPair: 20,
  scale: 100,
  roundUp: 99,
} as const;

/**
 * Exact fixed cost in credits for non-negative integer counts.
 * Always an integer >= 1 (0 + 0 prices to 1: the ticket's zero-pair case).
 */
export function computeFixedCost(chunkCount: number, candidatePairCount: number): number {
  const numerator = 100 + 5 * chunkCount + 20 * candidatePairCount;
  return Math.floor((numerator + 99) / 100);
}
