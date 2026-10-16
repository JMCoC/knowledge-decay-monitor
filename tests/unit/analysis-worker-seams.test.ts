import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { AnalysisFinalization } from "../../src/modules/analysis/worker/finalization";
import { createFinalization } from "../../src/modules/analysis/worker/finalization";
import { createProvider } from "../../src/modules/analysis/worker/provider";
import { FakeAnalysisFinalization } from "../fakes/analysis-finalization.fake";

describe("analysis seams", () => {
  it("createProvider throws until S2-07 merges", () => {
    expect(() => createProvider()).toThrow(
      "S2-07 not merged: AIProvider unavailable.",
    );
  });

  it("createFinalization throws until S2-08 merges", () => {
    expect(() => createFinalization()).toThrow(
      "S2-08 not merged: AnalysisFinalization unavailable.",
    );
  });

  it("factories throw even with production resolution", () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(() => createProvider()).toThrow();
      expect(() => createFinalization()).toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("no file under src imports tests/fakes", () => {
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
