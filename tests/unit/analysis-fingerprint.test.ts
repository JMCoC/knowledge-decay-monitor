import { describe, expect, it } from "vitest";
import {
  FROZEN_FINGERPRINT_VERSIONS,
  buildPairHashes,
  buildChunksRevision,
  computeRequestFingerprint,
  type FingerprintInput,
} from "@/modules/analysis/retrieval";

const S1 = "40000000-0000-4000-8000-0000000000d1";
const S2 = "40000000-0000-4000-8000-0000000000d2";
const C1 = "40000000-0000-4000-8000-0000000000d3";
const C2 = "40000000-0000-4000-8000-0000000000d4";

const baseInput = (): FingerprintInput => ({
  chunkCount: 2,
  candidatePairCount: 2,
  sortedSourceVersionIds: [
    "30000000-0000-4000-8000-0000000000d1",
  ],
  sortedComparisonVersionIds: [
    "30000000-0000-4000-8000-0000000000d2",
  ],
  pairs: [
    { sourceChunkId: S1, comparisonChunkId: C1 },
    { sourceChunkId: S2, comparisonChunkId: C2 },
  ],
  chunkIds: [S1, S2, C1, C2],
});

describe("computeRequestFingerprint", () => {
  it("is deterministic for the same input", () => {
    expect(computeRequestFingerprint(baseInput())).toBe(
      computeRequestFingerprint(baseInput()),
    );
  });

  it("ignores key insertion order (canonical JSON)", () => {
    const base = baseInput();
    const reordered: FingerprintInput = {
      chunkIds: base.chunkIds,
      pairs: base.pairs,
      sortedComparisonVersionIds: base.sortedComparisonVersionIds,
      sortedSourceVersionIds: base.sortedSourceVersionIds,
      candidatePairCount: base.candidatePairCount,
      chunkCount: base.chunkCount,
    };
    expect(computeRequestFingerprint(reordered)).toBe(
      computeRequestFingerprint(baseInput()),
    );
  });

  it("changes when a version id changes", () => {
    const input = baseInput();
    input.sortedSourceVersionIds = ["30000000-0000-4000-8000-0000000000d9"];
    expect(computeRequestFingerprint(input)).not.toBe(
      computeRequestFingerprint(baseInput()),
    );
  });

  it("changes when the threshold changes", () => {
    expect(
      computeRequestFingerprint(baseInput(), { similarityThreshold: 0.8 }),
    ).not.toBe(computeRequestFingerprint(baseInput()));
  });

  it("changes when topK changes", () => {
    expect(computeRequestFingerprint(baseInput(), { topK: 10 })).not.toBe(
      computeRequestFingerprint(baseInput()),
    );
  });

  it("changes when pricingVersion changes", () => {
    expect(
      computeRequestFingerprint(baseInput(), {
        pricingVersion: "s2-04-v2",
      }),
    ).not.toBe(computeRequestFingerprint(baseInput()));
  });

  it("changes when promptVersion changes", () => {
    expect(
      computeRequestFingerprint(baseInput(), {
        promptVersion: "v2",
      }),
    ).not.toBe(computeRequestFingerprint(baseInput()));
  });

  it("changes when outputSchemaVersion changes", () => {
    expect(
      computeRequestFingerprint(baseInput(), {
        outputSchemaVersion: "v2",
      }),
    ).not.toBe(computeRequestFingerprint(baseInput()));
  });

  it("changes when chunkCount changes", () => {
    const input = baseInput();
    input.chunkCount = 3;
    expect(computeRequestFingerprint(input)).not.toBe(
      computeRequestFingerprint(baseInput()),
    );
  });

  it("changes when candidatePairCount changes", () => {
    const input = baseInput();
    input.candidatePairCount = 3;
    expect(computeRequestFingerprint(input)).not.toBe(
      computeRequestFingerprint(baseInput()),
    );
  });

  it("changes when pairHashes change", () => {
    const input = baseInput();
    input.pairs = [{ sourceChunkId: S1, comparisonChunkId: C2 }];
    expect(computeRequestFingerprint(input)).not.toBe(
      computeRequestFingerprint(baseInput()),
    );
  });

  it("returns a 64-char lowercase hex digest", () => {
    expect(computeRequestFingerprint(baseInput())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("freezes the contract versions", () => {
    expect(FROZEN_FINGERPRINT_VERSIONS).toEqual({
      embeddingRevision: "gte-small-384-v1",
      pricingVersion: "s2-04-v1",
      promptVersion: "none",
      outputSchemaVersion: "none",
    });
  });
});

describe("buildPairHashes", () => {
  it("orders hashes by (source, comparison)", () => {
    const hashes = buildPairHashes([
      { sourceChunkId: S2, comparisonChunkId: C2 },
      { sourceChunkId: S1, comparisonChunkId: C1 },
    ]);
    expect(hashes).toHaveLength(2);
    expect(hashes[0]).toBe(hashes.slice().sort()[0]);
    expect(hashes).toEqual(hashes.slice().sort());
  });

  it("hashes source|comparison with a pipe separator", () => {
    const [hash] = buildPairHashes([
      { sourceChunkId: S1, comparisonChunkId: C1 },
    ]);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(buildPairHashes([{ sourceChunkId: C1, comparisonChunkId: S1 }])[0]).not.toBe(
      hash,
    );
  });
});

describe("buildChunksRevision", () => {
  it("sorts chunk ids before hashing", () => {
    expect(buildChunksRevision([S2, S1, C1])).toBe(
      buildChunksRevision([S1, S2, C1]),
    );
    expect(buildChunksRevision([S1, S2, C1])).toMatch(/^[0-9a-f]{64}$/);
  });
});
