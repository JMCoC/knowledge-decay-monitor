import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ANALYSIS_PRICING, computeFixedCost } from "@/modules/analysis/pricing";

describe("computeFixedCost", () => {
  it("prices the ticket case: 10 chunks + 5 pairs -> 3", () => {
    expect(computeFixedCost(10, 5)).toBe(3);
  });

  it("prices the empty case: 0 + 0 -> 1", () => {
    expect(computeFixedCost(0, 0)).toBe(1);
  });

  it("prices chunks without pairs: 100 + 0 -> 6", () => {
    expect(computeFixedCost(100, 0)).toBe(6);
  });

  it("always returns an integer >= 1 for non-negative inputs", () => {
    let seed = 0x2f6e2b1;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let i = 0; i < 50; i += 1) {
      const chunks = next() % 10001;
      const pairs = next() % 5001;
      const cost = computeFixedCost(chunks, pairs);
      expect(Number.isInteger(cost)).toBe(true);
      expect(cost).toBeGreaterThanOrEqual(1);
    }
  });

  it("pins the exact contract formula", () => {
    const source = readFileSync(
      resolve(__dirname, "../../src/modules/analysis/pricing.ts"),
      "utf-8",
    );
    expect(source).toMatch(
      /const numerator = 100 \+ 5 \* chunkCount \+ 20 \* candidatePairCount;/,
    );
    expect(source).toMatch(/return Math\.floor\(\(numerator \+ 99\) \/ 100\);/);
  });

  it("freezes the pricing version", () => {
    expect(ANALYSIS_PRICING.version).toBe("s2-04-v1");
  });
});
