import { createHash } from "node:crypto";

/**
 * Pure retrieval helpers for S2-04 estimates (no DB, no I/O, no server-only).
 *
 * Canonicalization contract for S2-05/S2-06 (must reproduce byte-identically):
 * - Fingerprint payload keys are sorted alphabetically, recursively.
 * - Zero whitespace: arrays joined with ",", object entries joined with ",",
 *   key and value joined with ":" (no spaces anywhere).
 * - Strings are JSON-encoded (`JSON.stringify`); numbers use their shortest
 *   JSON form (`0.75`, `5`); arrays keep document order after the explicit
 *   sorts below (pairHashes by (source, comparison); chunk ids ascending).
 * - `pairHashes[i] = sha256Hex(source_chunk_id + "|" + comparison_chunk_id)`.
 * - `chunksRevision = sha256Hex(sorted chunk ids joined with ",")`.
 * - Digest: SHA-256 over UTF-8, lowercase hex (64 chars).
 *
 * `canonicalizePair` mirrors the SQL `(least, greatest)` + self-pair
 * exclusion for unit tests only; the database DISTINCT ON is the source
 * of truth for persisted behaviour.
 */

export const FROZEN_FINGERPRINT_VERSIONS = {
  embeddingRevision: "gte-small-384-v1",
  pricingVersion: "s2-04-v1",
  promptVersion: "none",
  outputSchemaVersion: "none",
} as const;

export const FROZEN_RETRIEVAL_PARAMS = {
  similarityThreshold: 0.75,
  topK: 5,
} as const;

export interface RetrievalPairInput {
  sourceChunkId: string;
  comparisonChunkId: string;
}

export interface FingerprintInput {
  chunkCount: number;
  candidatePairCount: number;
  sortedSourceVersionIds: string[];
  sortedComparisonVersionIds: string[];
  pairs: RetrievalPairInput[];
  chunkIds: string[];
}

export interface FingerprintOverrides {
  similarityThreshold?: number;
  topK?: number;
  embeddingRevision?: string;
  pricingVersion?: string;
  promptVersion?: string;
  outputSchemaVersion?: string;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
    );
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) as string;
}

/** Ordered `[least, greatest]`, or `null` for a self-pair. */
export function canonicalizePair(a: string, b: string): [string, string] | null {
  if (a === b) return null;
  return a < b ? [a, b] : [b, a];
}

/** Pair hashes ordered by (source_chunk_id, comparison_chunk_id). */
export function buildPairHashes(pairs: RetrievalPairInput[]): string[] {
  const ordered = [...pairs].sort((left, right) => {
    if (left.sourceChunkId !== right.sourceChunkId) {
      return left.sourceChunkId < right.sourceChunkId ? -1 : 1;
    }
    if (left.comparisonChunkId !== right.comparisonChunkId) {
      return left.comparisonChunkId < right.comparisonChunkId ? -1 : 1;
    }
    return 0;
  });
  return ordered.map((pair) =>
    sha256Hex(`${pair.sourceChunkId}|${pair.comparisonChunkId}`),
  );
}

/** Revision over the scope's chunk ids, sorted ascending before hashing. */
export function buildChunksRevision(chunkIds: string[]): string {
  return sha256Hex([...chunkIds].sort().join(","));
}

/**
 * SHA-256 fingerprint over the contract §7 payload. Array inputs are
 * sorted defensively so caller order never changes the digest.
 */
export function computeRequestFingerprint(
  input: FingerprintInput,
  overrides: FingerprintOverrides = {},
): string {
  const versions: {
    embeddingRevision: string;
    pricingVersion: string;
    promptVersion: string;
    outputSchemaVersion: string;
  } = { ...FROZEN_FINGERPRINT_VERSIONS };
  if (overrides.embeddingRevision !== undefined) {
    versions.embeddingRevision = overrides.embeddingRevision;
  }
  if (overrides.pricingVersion !== undefined) {
    versions.pricingVersion = overrides.pricingVersion;
  }
  if (overrides.promptVersion !== undefined) {
    versions.promptVersion = overrides.promptVersion;
  }
  if (overrides.outputSchemaVersion !== undefined) {
    versions.outputSchemaVersion = overrides.outputSchemaVersion;
  }
  const payload = {
    candidatePairCount: input.candidatePairCount,
    chunkCount: input.chunkCount,
    embeddingRevision: versions.embeddingRevision,
    outputSchemaVersion: versions.outputSchemaVersion,
    pairHashes: buildPairHashes(input.pairs),
    pricingVersion: versions.pricingVersion,
    promptVersion: versions.promptVersion,
    retrieval: {
      chunksRevision: buildChunksRevision(input.chunkIds),
      similarityThreshold:
        overrides.similarityThreshold ?? FROZEN_RETRIEVAL_PARAMS.similarityThreshold,
      topK: overrides.topK ?? FROZEN_RETRIEVAL_PARAMS.topK,
    },
    sortedComparisonVersionIds: [...input.sortedComparisonVersionIds].sort(),
    sortedSourceVersionIds: [...input.sortedSourceVersionIds].sort(),
  };
  return sha256Hex(canonicalJson(payload));
}
