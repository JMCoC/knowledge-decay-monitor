import "server-only";

import { z } from "zod";
import type { AnalysisExecutionManifest } from "@/types/analysis-internal";

const providerReference = z.string().trim().min(1).max(120);

const executionManifestSchema = z.object({
  fingerprintVersion: z.literal("s2-05-v2"),
  pricingVersion: z.literal("s2-04-v1"),
  promptVersion: providerReference,
  outputSchemaVersion: providerReference,
  providers: z.object({
    primary: z.object({
      provider: providerReference,
      model: providerReference,
    }).strict(),
    fallback: z.object({
      provider: providerReference,
      model: providerReference,
    }).strict(),
  }).strict(),
}).strict();

/**
 * Parse the private, reference-only execution manifest. Prompts and provider
 * credentials are deliberately not part of this contract.
 */
export function readAnalysisExecutionManifest(
  raw: string | undefined,
): AnalysisExecutionManifest | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) {
    return null;
  }

  try {
    const result = executionManifestSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
