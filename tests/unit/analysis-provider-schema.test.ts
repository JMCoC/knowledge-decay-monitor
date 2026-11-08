import { describe, expect, it } from "vitest";
import {
  WIRE_JSON_SCHEMA,
  wireSchema,
} from "../../src/modules/analysis/prompts/v1-schema";

function finding(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "contradiction",
    severity: "High",
    confidence: 0.5,
    explanation: "the texts disagree",
    evidence: [
      { side: "source", quote: "alpha" },
      { side: "comparison", quote: "gamma" },
    ],
    ...overrides,
  };
}

function parse(value: unknown) {
  return wireSchema.safeParse(value);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error("expected an object");
  }
  return value as Record<string, unknown>;
}

function properties(value: unknown): Record<string, unknown> {
  return record(record(value).properties);
}

function items(value: unknown): Record<string, unknown> {
  return record(record(value).items);
}

describe("wire schema", () => {
  it("accepts an empty findings array", () => {
    expect(parse({ findings: [] }).success).toBe(true);
  });

  it("rejects an extra root field", () => {
    expect(parse({ findings: [], extra: true }).success).toBe(false);
  });

  it("rejects extra finding fields", () => {
    expect(
      parse({ findings: [finding({ is_contradiction: true })] }).success,
    ).toBe(false);
    expect(
      parse({ findings: [finding({ reasoning_category: "direct" })] }).success,
    ).toBe(false);
  });

  it("rejects an extra evidence field", () => {
    const evidence = [
      { side: "source", quote: "alpha", pageNumber: 1 },
      { side: "comparison", quote: "gamma" },
    ];

    expect(parse({ findings: [finding({ evidence })] }).success).toBe(false);
  });

  it("rejects evidence with a single entry", () => {
    const evidence = [{ side: "source", quote: "alpha" }];

    expect(parse({ findings: [finding({ evidence })] }).success).toBe(false);
  });

  it("rejects evidence with three entries", () => {
    const evidence = [
      { side: "source", quote: "alpha" },
      { side: "comparison", quote: "gamma" },
      { side: "comparison", quote: "delta" },
    ];

    expect(parse({ findings: [finding({ evidence })] }).success).toBe(false);
  });

  it("rejects two source entries", () => {
    const evidence = [
      { side: "source", quote: "alpha" },
      { side: "source", quote: "beta" },
    ];

    expect(parse({ findings: [finding({ evidence })] }).success).toBe(false);
  });

  it("rejects two comparison entries", () => {
    const evidence = [
      { side: "comparison", quote: "gamma" },
      { side: "comparison", quote: "delta" },
    ];

    expect(parse({ findings: [finding({ evidence })] }).success).toBe(false);
  });

  it("accepts one source and one comparison entry", () => {
    expect(parse({ findings: [finding()] }).success).toBe(true);
  });

  it("accepts 20 findings", () => {
    const findings = Array.from({ length: 20 }, () => finding());

    expect(parse({ findings }).success).toBe(true);
  });

  it("rejects 21 findings", () => {
    const findings = Array.from({ length: 21 }, () => finding());

    expect(parse({ findings }).success).toBe(false);
  });

  it("accepts a 2000 code point quote", () => {
    const evidence = [
      { side: "source", quote: "😀".repeat(2000) },
      { side: "comparison", quote: "gamma" },
    ];

    expect(parse({ findings: [finding({ evidence })] }).success).toBe(true);
  });

  it("rejects a 2001 code point quote", () => {
    const evidence = [
      { side: "source", quote: "😀".repeat(2001) },
      { side: "comparison", quote: "gamma" },
    ];

    expect(parse({ findings: [finding({ evidence })] }).success).toBe(false);
  });

  it("accepts a 2000 code point explanation", () => {
    expect(
      parse({ findings: [finding({ explanation: "😀".repeat(2000) })] }).success,
    ).toBe(true);
  });

  it("rejects a 2001 code point explanation", () => {
    expect(
      parse({ findings: [finding({ explanation: "😀".repeat(2001) })] }).success,
    ).toBe(false);
  });

  it("rejects an empty quote", () => {
    const evidence = [
      { side: "source", quote: "" },
      { side: "comparison", quote: "gamma" },
    ];

    expect(parse({ findings: [finding({ evidence })] }).success).toBe(false);
  });

  it("rejects a whitespace-only quote", () => {
    const evidence = [
      { side: "source", quote: "   " },
      { side: "comparison", quote: "gamma" },
    ];

    expect(parse({ findings: [finding({ evidence })] }).success).toBe(false);
  });

  it("rejects confidence below 0", () => {
    expect(
      parse({ findings: [finding({ confidence: -0.1 })] }).success,
    ).toBe(false);
  });

  it("rejects confidence above 1", () => {
    expect(
      parse({ findings: [finding({ confidence: 1.1 })] }).success,
    ).toBe(false);
  });

  it("accepts confidence 0", () => {
    expect(parse({ findings: [finding({ confidence: 0 })] }).success).toBe(true);
  });

  it("accepts confidence 1", () => {
    expect(parse({ findings: [finding({ confidence: 1 })] }).success).toBe(true);
  });

  it("accepts confidence 0.2 without filtering it", () => {
    expect(
      parse({ findings: [finding({ confidence: 0.2 })] }).success,
    ).toBe(true);
  });

  it("rejects an invalid finding type", () => {
    expect(parse({ findings: [finding({ type: "summary" })] }).success).toBe(
      false,
    );
  });

  it("rejects an invalid severity", () => {
    expect(parse({ findings: [finding({ severity: "Critical" })] }).success).toBe(
      false,
    );
  });

  it("generates a closed root object", () => {
    expect(WIRE_JSON_SCHEMA).toBeTypeOf("object");
    expect(record(WIRE_JSON_SCHEMA).additionalProperties).toBe(false);
  });

  it("generates a closed finding object", () => {
    const findingItem = items(properties(WIRE_JSON_SCHEMA).findings);

    expect(findingItem.additionalProperties).toBe(false);
  });

  it("generates a closed evidence object", () => {
    const findingItem = items(properties(WIRE_JSON_SCHEMA).findings);
    const evidenceItem = items(properties(findingItem).evidence);

    expect(evidenceItem.additionalProperties).toBe(false);
  });
});
