import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { readAnalysisExecutionManifest } from "../../src/modules/analysis/execution-config";

const valid = {
  fingerprintVersion: "s2-05-v2",
  pricingVersion: "s2-04-v1",
  promptVersion: "prompt-v1",
  outputSchemaVersion: "schema-v1",
  providers: {
    primary: { provider: "provider-a", model: "model-a" },
    fallback: { provider: "provider-b", model: "model-b" },
  },
};

describe("readAnalysisExecutionManifest", () => {
  it("reads the immutable execution versions and provider/model references", () => {
    expect(readAnalysisExecutionManifest(JSON.stringify(valid))).toEqual(valid);
  });

  it.each([undefined, "", "{invalid json", "null", "[]"])(
    "fails closed for missing or malformed private configuration: %s",
    (raw) => expect(readAnalysisExecutionManifest(raw)).toBeNull(),
  );

  it.each([
    { ...valid, fingerprintVersion: "s2-04-v1" },
    { ...valid, pricingVersion: "unknown-pricing" },
    { ...valid, promptVersion: " " },
    { ...valid, outputSchemaVersion: "" },
    { ...valid, providers: { ...valid.providers, primary: { provider: "provider-a", model: " " } } },
    { ...valid, providers: { ...valid.providers, fallback: { provider: "", model: "model-b" } } },
    { ...valid, providers: { ...valid.providers, fallback: { provider: "provider-b", model: "model-b", apiKey: "must-not-be-accepted" } } },
  ])("rejects an unknown revision or invalid provider reference", (value) => {
    expect(readAnalysisExecutionManifest(JSON.stringify(value))).toBeNull();
  });
});
