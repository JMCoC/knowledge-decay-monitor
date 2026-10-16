import type { AIProvider } from "../../../types/analysis-internal";

/**
 * Real provider factory, unavailable until S2-07 merges (spec §7).
 * The worker only ever receives its provider by explicit dependency
 * injection; this factory exists so the missing integration fails
 * loudly at startup (readiness, spec §11 G2) instead of running jobs
 * against a test double. Only explicit dependency injection supplies
 * the provider; this module must stay free of test-only imports.
 */
export function createProvider(): AIProvider {
  throw new Error("S2-07 not merged: AIProvider unavailable.");
}
