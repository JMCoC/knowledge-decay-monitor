import { describe, expect, it } from "vitest";
import { canonicalizePair } from "@/modules/analysis/retrieval";

describe("canonicalizePair", () => {
  it('returns [least, greatest] when a < b', () => {
    expect(canonicalizePair("a", "b")).toEqual(["a", "b"]);
  });

  it('collapses the swapped order to [least, greatest]', () => {
    expect(canonicalizePair("b", "a")).toEqual(["a", "b"]);
  });

  it("returns null for a self-pair", () => {
    expect(canonicalizePair("a", "a")).toBeNull();
  });
});
