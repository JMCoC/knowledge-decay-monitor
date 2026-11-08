import { describe, expect, it } from "vitest";
import type { AnalysisCandidatePair } from "../../src/types/analysis-internal";
import { createCerebrasGroqProvider } from "../../src/modules/analysis/worker/provider.cerebras-groq";
import {
  canonicalConfiguration,
  canonicalEnv,
  chatCompletion,
} from "../support/provider-fixtures";
import { fetchQueue, jsonResponse } from "../support/provider-http";

const PAIR: AnalysisCandidatePair = {
  source: {
    documentId: "doc-s",
    versionId: "v-s",
    chunkId: "c-s",
    role: "source",
    text: "alpha beta",
  },
  comparison: {
    documentId: "doc-c",
    versionId: "v-c",
    chunkId: "c-c",
    role: "comparison",
    text: "gamma delta",
  },
};

const PAIR_SAME_VERSION: AnalysisCandidatePair = {
  ...PAIR,
  comparison: { ...PAIR.comparison, versionId: "v-s" },
};

const PAIR_SAME_DOCUMENT: AnalysisCandidatePair = {
  ...PAIR,
  comparison: { ...PAIR.comparison, documentId: "doc-s" },
};

const PAIR_UNICODE: AnalysisCandidatePair = {
  ...PAIR,
  source: { ...PAIR.source, text: "café" },
};

const PAIR_SHARED_QUOTE: AnalysisCandidatePair = {
  ...PAIR,
  source: { ...PAIR.source, text: "x" },
  comparison: { ...PAIR.comparison, text: "x" },
};

function evidence(side: "source" | "comparison", quote: string) {
  return { side, quote };
}

function finding(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "contradiction",
    severity: "High",
    confidence: 0.9,
    explanation: "the texts disagree",
    evidence: [evidence("source", "alpha"), evidence("comparison", "gamma")],
    ...overrides,
  };
}

function providerFor(response: Response) {
  const { fetchFn } = fetchQueue(response);
  return createCerebrasGroqProvider({
    fetchFn,
    timeoutMs: 20,
    env: canonicalEnv,
  });
}

function analyzeResponse(
  response: Response,
  pair: AnalysisCandidatePair = PAIR,
) {
  return providerFor(response).analyzePair({
    pair,
    configuration: canonicalConfiguration,
  });
}

function analyzeWire(
  findings: unknown[],
  pair: AnalysisCandidatePair = PAIR,
) {
  return analyzeResponse(
    chatCompletion(JSON.stringify({ findings })),
    pair,
  );
}

function expectInvalid(result: unknown) {
  expect(result).toEqual({
    ok: false,
    error: { code: "INVALID_PROVIDER_OUTPUT" },
  });
}

describe("wire to InternalFinding mapping", () => {
  it("maps a valid finding to the authorized pair references", async () => {
    const result = await analyzeWire([finding()]);

    expect(result).toEqual({
      ok: true,
      findings: [
        {
          type: "contradiction",
          severity: "High",
          confidence: 0.9,
          explanation: "the texts disagree",
          evidence: [
            {
              documentId: "doc-s",
              versionId: "v-s",
              chunkId: "c-s",
              role: "source",
              snapshot: "alpha",
              pageNumber: null,
              section: null,
              sectionHeading: null,
            },
            {
              documentId: "doc-c",
              versionId: "v-c",
              chunkId: "c-c",
              role: "comparison",
              snapshot: "gamma",
              pageNumber: null,
              section: null,
              sectionHeading: null,
            },
          ],
        },
      ],
    });
  });

  it("rejects a quote absent from the matching side", async () => {
    const result = await analyzeWire([
      finding({
        evidence: [
          evidence("source", "zeta"),
          evidence("comparison", "gamma"),
        ],
      }),
    ]);

    expectInvalid(result);
  });

  it("rejects a quote whose text does not appear in the corresponding side", async () => {
    const result = await analyzeWire([
      finding({
        evidence: [
          evidence("source", "gamma"),
          evidence("comparison", "delta"),
        ],
      }),
    ]);

    expectInvalid(result);
  });

  it("rejects a swap that puts the source quote under comparison and vice versa", async () => {
    const result = await analyzeWire([
      finding({
        evidence: [
          evidence("source", "gamma"),
          evidence("comparison", "alpha"),
        ],
      }),
    ]);

    expectInvalid(result);
  });

  it("rejects a quote with leading or trailing spaces", async () => {
    const leading = await analyzeWire([
      finding({
        evidence: [
          evidence("source", " alpha"),
          evidence("comparison", "gamma"),
        ],
      }),
    ]);
    const trailing = await analyzeWire([
      finding({
        evidence: [
          evidence("source", "beta "),
          evidence("comparison", "gamma"),
        ],
      }),
    ]);

    expectInvalid(leading);
    expectInvalid(trailing);
  });

  it("rejects a quote with collapsed internal whitespace", async () => {
    const result = await analyzeWire([
      finding({
        evidence: [
          evidence("source", "alpha  beta"),
          evidence("comparison", "gamma"),
        ],
      }),
    ]);

    expectInvalid(result);
  });

  it("rejects a quote with a case change", async () => {
    const result = await analyzeWire([
      finding({
        evidence: [
          evidence("source", "Alpha"),
          evidence("comparison", "gamma"),
        ],
      }),
    ]);

    expectInvalid(result);
  });

  it("rejects a quote that differs only by unicode normalization", async () => {
    const result = await analyzeWire(
      [
        finding({
          evidence: [
            evidence("source", "cafe\u0301"),
            evidence("comparison", "gamma"),
          ],
        }),
      ],
      PAIR_UNICODE,
    );

    expectInvalid(result);
  });

  it("allows duplicate verbatim quotes across findings", async () => {
    const result = await analyzeWire([finding(), finding()]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.findings).toHaveLength(2);
    }
  });

  it("rejects duplicate quotes within a single finding", async () => {
    const result = await analyzeWire(
      [
        finding({
          evidence: [evidence("source", "x"), evidence("comparison", "x")],
        }),
      ],
      PAIR_SHARED_QUOTE,
    );

    expectInvalid(result);
  });

  it("accepts obsolescence when only versionId is equal (document differs)", async () => {
    const result = await analyzeWire(
      [finding({ type: "obsolescence" })],
      PAIR_SAME_VERSION,
    );

    expect(result.ok).toBe(true);
  });

  it("accepts obsolescence when versions and documents differ", async () => {
    const result = await analyzeWire([finding({ type: "obsolescence" })]);

    expect(result.ok).toBe(true);
  });

  it("accepts obsolescence when only documentId is equal (version differs)", async () => {
    const result = await analyzeWire(
      [finding({ type: "obsolescence" })],
      PAIR_SAME_DOCUMENT,
    );

    expect(result.ok).toBe(true);
  });

  it("rejects obsolescence when versionId and documentId are both equal", async () => {
    const pairBothSame: AnalysisCandidatePair = {
      ...PAIR,
      comparison: {
        ...PAIR.comparison,
        versionId: "v-s",
        documentId: "doc-s",
      },
    };
    const result = await analyzeWire(
      [finding({ type: "obsolescence" })],
      pairBothSame,
    );

    expectInvalid(result);
  });

  it("accepts contradiction when both versions are equal", async () => {
    const result = await analyzeWire([finding()], PAIR_SAME_VERSION);

    expect(result.ok).toBe(true);
  });

  it("rejects a 2xx body without choices", async () => {
    const result = await analyzeResponse(jsonResponse({}));

    expectInvalid(result);
  });

  it("rejects a 2xx body with non-string content", async () => {
    const result = await analyzeResponse(
      jsonResponse({ choices: [{ message: { content: 42 } }] }),
    );

    expectInvalid(result);
  });

  it("rejects content JSON that is not an object", async () => {
    const result = await analyzeResponse(
      chatCompletion(JSON.stringify(["not", "an", "object"])),
    );

    expectInvalid(result);
  });

  it("rejects malformed content JSON", async () => {
    const result = await analyzeResponse(chatCompletion("{not-json"));

    expectInvalid(result);
  });

  it("preserves low confidence without filtering", async () => {
    const result = await analyzeWire([finding({ confidence: 0.1 })]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.findings[0]?.confidence).toBe(0.1);
    }
  });
});
