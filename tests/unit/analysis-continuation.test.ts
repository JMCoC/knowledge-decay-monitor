import { describe, expect, it } from "vitest";
import { analysisContinuationPath, parseAnalysisContinuation } from "../../src/modules/identity/analysis-continuation";

const analysisId = "8c02e64a-761a-4d7b-9811-927e62f6f1c8";

describe("analysis login continuation", () => {
  it("accepts one UUID and builds only an internal analysis path", () => {
    expect(parseAnalysisContinuation(analysisId)).toBe(analysisId);
    expect(analysisContinuationPath(analysisId)).toBe(`/analysis/${analysisId}`);
  });

  it("rejects unsafe or ambiguous continuation input", () => {
    expect(parseAnalysisContinuation([analysisId, analysisId])).toBeNull();
    expect(parseAnalysisContinuation("https://example.org")).toBeNull();
    expect(parseAnalysisContinuation("//example.org")).toBeNull();
    expect(parseAnalysisContinuation(`%2Fanalysis%2F${analysisId}`)).toBeNull();
    expect(parseAnalysisContinuation("not-a-uuid")).toBeNull();
  });

  it("rejects missing and repeated query values", () => {
    expect(parseAnalysisContinuation(undefined)).toBeNull();
    expect(parseAnalysisContinuation([analysisId, analysisId])).toBeNull();
    expect(analysisContinuationPath(null)).toBeNull();
  });
});
