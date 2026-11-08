import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { AnalysisFinalization } from "../../src/modules/analysis/worker/finalization";
import { createFinalization } from "../../src/modules/analysis/worker/finalization";
import { createBatchPersistence } from "../../src/modules/analysis/worker/batch-persistence";
import { createProvider } from "../../src/modules/analysis/worker/provider";
import { FakeAnalysisFinalization } from "../../supabase/functions/analyze/_test_doubles/analysis-finalization.fake";

describe("analysis seams", () => {
  it("createProvider returns a real AIProvider", () => {
    vi.stubEnv("CEREBRAS_API_KEY", "test-cerebras-key");
    vi.stubEnv("GROQ_API_KEY", "test-groq-key");
    vi.stubEnv("CEREBRAS_BASE_URL", "https://cerebras.test/v1");
    vi.stubEnv("GROQ_BASE_URL", "https://groq.test/openai/v1");
    try {
      const provider = createProvider();
      expect(provider).not.toBeInstanceOf(Promise);
      expect(typeof provider.analyzePair).toBe("function");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("builds both factories with an injected client", () => {
    const client = { rpc: vi.fn() } as never;
    expect(() => createFinalization(client)).not.toThrow();
    expect(() => createBatchPersistence(client)).not.toThrow();
  });

  it.each([undefined, null])(
    "createFinalization requires an AnalysisWorkerDb (%s)",
    (client) => {
      expect(() => createFinalization(client as never)).toThrow(
        "AnalysisWorkerDb is required",
      );
    },
  );

  it.each([undefined, null])(
    "createBatchPersistence requires an AnalysisWorkerDb (%s)",
    (client) => {
      expect(() => createBatchPersistence(client as never)).toThrow(
        "AnalysisWorkerDb is required",
      );
    },
  );

  it("still fails loud without provider configuration", () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(() => createProvider()).toThrow();
      expect(() => createFinalization(undefined as never)).toThrow(
        "AnalysisWorkerDb is required",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("no file under src imports test doubles", () => {
    const workerDir = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "src",
      "modules",
      "analysis",
      "worker",
    );
    const files = readdirSync(workerDir).filter((name) =>
      name.endsWith(".ts"),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const content = readFileSync(join(workerDir, name), "utf8");
      expect(content).not.toContain("tests/fakes");
      expect(content).not.toContain("_test_doubles");
    }
  });

  it("the finalization seam keeps its frozen signature", async () => {
    const finalization: AnalysisFinalization = new FakeAnalysisFinalization();
    await expect(
      finalization.finalize({
        analysisId: "analysis-id",
        operationId: "operation-id",
        outcome: { kind: "completed", findings: [] },
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      finalization.finalize({
        analysisId: "analysis-id",
        operationId: "operation-id",
        outcome: { kind: "failed", code: "PROVIDER_UNAVAILABLE" },
      }),
    ).resolves.toEqual({ ok: true });
  });
});
