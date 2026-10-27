import { describe, expect, it } from "vitest";

import {
  createFakeProvider,
  parseFakeBehaviorSafe,
} from "../../supabase/functions/analyze/_test_doubles/analysis-provider.fake";
import type {
  AnalysisCandidatePair,
  AnalysisConfiguration,
  InternalFinding,
} from "../../src/types/analysis-internal";

const sourceEvidence: InternalFinding["evidence"][number] = {
  documentId: "doc-source",
  versionId: "version-source",
  chunkId: "chunk-source",
  role: "source",
  snapshot: "The source text.",
  pageNumber: 1,
  section: "1.1",
  sectionHeading: "Source",
};

const comparisonEvidence: InternalFinding["evidence"][number] = {
  documentId: "doc-comparison",
  versionId: "version-comparison",
  chunkId: "chunk-comparison",
  role: "comparison",
  snapshot: "The comparison text.",
  pageNumber: 2,
  section: "2.1",
  sectionHeading: "Comparison",
};

function validFinding(
  overrides: Partial<InternalFinding> = {},
): InternalFinding {
  return {
    type: "contradiction",
    severity: "High",
    confidence: 0.9,
    explanation: "The source contradicts the comparison.",
    evidence: [sourceEvidence, comparisonEvidence],
    ...overrides,
  };
}

const input = {
  pair: {} as unknown as AnalysisCandidatePair,
  configuration: {} as unknown as AnalysisConfiguration,
};

describe("fake provider custom findings", () => {
  it("parses valid findings and preserves the internal evidence pair", () => {
    const finding = validFinding();
    const parsed = parseFakeBehaviorSafe({ findings: [finding] });
    expect(parsed.findings).toEqual([finding]);
  });

  it("silently drops malformed findings and keeps valid ones", () => {
    const valid = validFinding();
    const malformed = [
      validFinding({ evidence: [sourceEvidence] }),
      validFinding({ confidence: 1.1 }),
      validFinding({ type: "not-a-finding" as InternalFinding["type"] }),
      validFinding({ evidence: [sourceEvidence, sourceEvidence] }),
      validFinding({
        evidence: [sourceEvidence, comparisonEvidence, sourceEvidence],
      }),
    ];
    const parsed = parseFakeBehaviorSafe({ findings: [valid, ...malformed] });
    expect(parsed.findings).toEqual([valid]);
  });

  it("returns no findings when every entry is malformed and never throws", () => {
    const parsed = parseFakeBehaviorSafe({
      findings: [
        null,
        42,
        "not a finding",
        validFinding({ severity: "Critical" as InternalFinding["severity"] }),
        validFinding({ evidence: [] }),
      ],
    });
    expect(parsed.findings).toEqual([]);
  });

  it("copies findings deeply so mutating the source behavior does not change the provider", async () => {
    const finding = validFinding();
    const original = structuredClone(finding);
    const behavior = { findings: [finding] };
    const provider = createFakeProvider({}, behavior);

    behavior.findings[0]!.explanation = "mutated";
    behavior.findings.push(validFinding({ explanation: "added later" }));

    const result = await provider.analyzePair(input);
    expect(result).toEqual({ ok: true, findings: [original] });
  });

  it("returns a deep copy so mutating one result does not change later results", async () => {
    const finding = validFinding();
    const original = structuredClone(finding);
    const provider = createFakeProvider({}, { findings: [finding] });

    const first = await provider.analyzePair(input);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    first.findings[0]!.explanation = "mutated result";
    first.findings.push(validFinding({ explanation: "added to result" }));

    const second = await provider.analyzePair(input);
    expect(second).toEqual({ ok: true, findings: [original] });
  });
});
