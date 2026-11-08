import { describe, expect, it } from "vitest";
import {
  computeFindingFingerprint,
  normalizeEvidenceText,
} from "../../src/modules/analysis/worker/fingerprint";
import type { InternalFinding } from "../../src/types/analysis-internal";
import type { AnalysisScopeRole } from "../../src/types/contracts";

const V1 = "11111111-1111-4111-8111-111111111111";
const V2 = "22222222-2222-4222-8222-222222222222";
const V3 = "33333333-3333-4333-8333-333333333333";
const C1 = "aaaaaaaa-0000-4000-8000-000000000001";
const C2 = "bbbbbbbb-0000-4000-8000-000000000002";
const C3 = "cccccccc-0000-4000-8000-000000000003";
const D1 = "dddddddd-0000-4000-8000-000000000001";
const D2 = "eeeeeeee-0000-4000-8000-000000000002";

function evidence(
  versionId: string,
  chunkId: string,
  snapshot: string,
  role: AnalysisScopeRole = "source",
) {
  return {
    documentId: role === "source" ? D1 : D2,
    versionId,
    chunkId,
    role,
    snapshot,
    pageNumber: null,
    section: null,
    sectionHeading: null,
  };
}

function finding(
  overrides: Partial<InternalFinding> & Pick<InternalFinding, "evidence">,
): InternalFinding {
  return {
    type: "contradiction",
    severity: "Medium",
    confidence: 0.8,
    explanation: "fixture",
    ...overrides,
  };
}

describe("normalizeEvidenceText", () => {
  it("applies NFC so canonical composition does not change the digest input", () => {
    expect(normalizeEvidenceText("cafe\u0301")).toBe("caf\u00e9");
  });

  it("trims and collapses every whitespace run to one ASCII space", () => {
    expect(normalizeEvidenceText("  a \n\t b  ")).toBe("a b");
    expect(normalizeEvidenceText("a\n b")).toBe("a b");
    expect(normalizeEvidenceText("a  b")).toBe("a b");
  });

  it("is case-sensitive and leaves punctuation untouched", () => {
    expect(normalizeEvidenceText("Active, v1.")).toBe("Active, v1.");
  });

  it("does not collapse U+0085 (NEL) in ASCII-only normalization", () => {
    expect(normalizeEvidenceText("a\u0085b")).toBe("a\u0085b");
  });

  it("does not collapse U+FEFF (BOM) in ASCII-only normalization", () => {
    expect(normalizeEvidenceText("a\uFEFFb")).toBe("a\uFEFFb");
  });

  it("does not collapse NBSP (U+00A0)", () => {
    expect(normalizeEvidenceText("a\u00A0b")).toBe("a\u00A0b");
  });
});

describe("computeFindingFingerprint — collapsing vectors", () => {
  it("collapses an inverted A/B pair", () => {
    const forward = finding({
      evidence: [
        evidence(V1, C1, "A", "source"),
        evidence(V2, C2, "B", "comparison"),
      ],
    });
    const inverted = finding({
      evidence: [
        evidence(V2, C2, "B", "source"),
        evidence(V1, C1, "A", "comparison"),
      ],
    });
    expect(computeFindingFingerprint(forward)).toBe(
      computeFindingFingerprint(inverted),
    );
  });

  it("collapses NFC vs NFD composition", () => {
    const nfc = finding({
      evidence: [evidence(V1, C1, "caf\u00e9", "source")],
    });
    const nfd = finding({
      evidence: [evidence(V1, C1, "cafe\u0301", "source")],
    });
    expect(computeFindingFingerprint(nfc)).toBe(computeFindingFingerprint(nfd));
  });

  it("collapses different whitespace runs", () => {
    const variants = ["a\n b", "a  b", "a b"].map((snapshot) =>
      finding({ evidence: [evidence(V1, C1, snapshot, "source")] }),
    );
    const [first, second, third] = variants;
    expect(computeFindingFingerprint(second)).toBe(
      computeFindingFingerprint(first),
    );
    expect(computeFindingFingerprint(third)).toBe(
      computeFindingFingerprint(first),
    );
  });

  it("ignores role: same version/chunk/content with swapped source/comparison", () => {
    const left = finding({
      evidence: [
        evidence(V1, C1, "same", "source"),
        evidence(V1, C1, "same", "comparison"),
      ],
    });
    const right = finding({
      evidence: [
        evidence(V1, C1, "same", "comparison"),
        evidence(V1, C1, "same", "source"),
      ],
    });
    expect(computeFindingFingerprint(left)).toBe(
      computeFindingFingerprint(right),
    );
  });
});

describe("computeFindingFingerprint — non-collapsing vectors", () => {
  const base = () =>
    finding({
      evidence: [
        evidence(V1, C1, "same text", "source"),
        evidence(V2, C2, "other text", "comparison"),
      ],
    });

  it("separates different finding types", () => {
    expect(
      computeFindingFingerprint({ ...base(), type: "obsolescence" }),
    ).not.toBe(computeFindingFingerprint(base()));
  });

  it("separates different chunk ids even with the same snapshot", () => {
    const moved = finding({
      evidence: [
        evidence(V1, C3, "same text", "source"),
        evidence(V2, C2, "other text", "comparison"),
      ],
    });
    expect(computeFindingFingerprint(moved)).not.toBe(
      computeFindingFingerprint(base()),
    );
  });

  it("separates different version ids", () => {
    const moved = finding({
      evidence: [
        evidence(V3, C1, "same text", "source"),
        evidence(V2, C2, "other text", "comparison"),
      ],
    });
    expect(computeFindingFingerprint(moved)).not.toBe(
      computeFindingFingerprint(base()),
    );
  });

  it("is case-sensitive", () => {
    const upper = finding({
      evidence: [evidence(V1, C1, "Active", "source")],
    });
    const lower = finding({
      evidence: [evidence(V1, C1, "active", "source")],
    });
    expect(computeFindingFingerprint(upper)).not.toBe(
      computeFindingFingerprint(lower),
    );
  });

  it("separates an extra evidence entry", () => {
    const extra = finding({
      evidence: [
        evidence(V1, C1, "same text", "source"),
        evidence(V2, C2, "other text", "comparison"),
        evidence(V3, C3, "third text", "comparison"),
      ],
    });
    expect(computeFindingFingerprint(extra)).not.toBe(
      computeFindingFingerprint(base()),
    );
  });

  it("separates different evidence pairings with the same snapshot multiset", () => {
    const pairingX = finding({
      evidence: [
        evidence(V1, C1, "A", "source"),
        evidence(V2, C2, "B", "comparison"),
      ],
    });
    const pairingY = finding({
      evidence: [
        evidence(V1, C2, "A", "source"),
        evidence(V2, C1, "B", "comparison"),
      ],
    });
    expect(computeFindingFingerprint(pairingX)).not.toBe(
      computeFindingFingerprint(pairingY),
    );
  });

  it("sorts snapshots by UTF-8 bytes (astral vs BMP)", () => {
    const findingA = finding({
      evidence: [
        evidence(V1, C1, "😀", "source"),
        evidence(V1, C1, "\uE000", "comparison"),
      ],
    });
    const findingB = finding({
      evidence: [
        evidence(V1, C1, "\uE000", "source"),
        evidence(V1, C1, "😀", "comparison"),
      ],
    });
    expect(computeFindingFingerprint(findingA)).toBe(
      computeFindingFingerprint(findingB),
    );
    expect(computeFindingFingerprint(findingA)).toBe(
      "ce102d8863f0f7cba24be6cf6e1b2dd5dfc870a2f537cb675e2e2b4b2311d77b",
    );
  });
});

describe("computeFindingFingerprint — frozen golden vectors", () => {
  it("matches the frozen hash for a plain contradiction", () => {
    const golden = finding({
      evidence: [
        evidence(V1, C1, "Deploy is manual", "source"),
        evidence(V2, C2, "Deploy is automated", "comparison"),
      ],
    });
    expect(computeFindingFingerprint(golden)).toBe(
      "a0b6c1003ed74ae73c1a76aba1c43c80a0c1cd47503bf627c8c8de2868652da9",
    );
  });

  it("matches the frozen hash for an obsolescence with whitespace noise", () => {
    const golden = finding({
      type: "obsolescence",
      evidence: [
        evidence(V1, C1, "Use Node 18", "source"),
        evidence(V2, C2, "  Use   Node 22  ", "comparison"),
      ],
    });
    expect(computeFindingFingerprint(golden)).toBe(
      "cd58d8f5153b11f5ca5f0b07079dc3696dce9c148da13961f7f40daa1bd89e45",
    );
  });

  it("matches the frozen hash for an NFC/NFD pair", () => {
    const golden = finding({
      evidence: [
        evidence(V1, C1, "caf\u00e9", "source"),
        evidence(V2, C2, "cafe\u0301", "comparison"),
      ],
    });
    expect(computeFindingFingerprint(golden)).toBe(
      "ca8e448658a753496c17ac1dce14dc4e678cdb7100569356f4e56cc4e7214e81",
    );
  });
});

describe("computeFindingFingerprint — determinism", () => {
  it("is deterministic across repeated calls", () => {
    const f = finding({ evidence: [evidence(V1, C1, "x", "source")] });
    expect(computeFindingFingerprint(f)).toBe(computeFindingFingerprint(f));
  });

  it("does not mutate the input evidence array", () => {
    const original = [
      evidence(V1, C1, "a", "source"),
      evidence(V2, C2, "b", "comparison"),
    ];
    const f = finding({ evidence: original });
    const copy = JSON.parse(JSON.stringify(original));
    computeFindingFingerprint(f);
    expect(f.evidence).toEqual(copy);
  });
});
