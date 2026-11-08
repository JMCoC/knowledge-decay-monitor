import { describe, expect, it, vi } from "vitest";

import {
  reportAnalysisFailure,
} from "../../src/modules/analysis/worker/telemetry";

describe("reportAnalysisFailure", () => {
  it("builds an event with only whitelist fields", () => {
    const sink = vi.fn();
    reportAnalysisFailure(
      {
        module: "analysis",
        operation: "batch",
        code: "PROVIDER_UNAVAILABLE",
        correlation_id: "corr-1",
        analysis_id: "analysis-1",
        workspace_id: "workspace-1",
        attempt_count: 2,
        batch_index: 3,
        duration_ms: 1500,
      },
      sink,
    );
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0]?.[0]).toEqual({
      module: "analysis",
      operation: "batch",
      code: "PROVIDER_UNAVAILABLE",
      correlation_id: "corr-1",
      analysis_id: "analysis-1",
      workspace_id: "workspace-1",
      attempt_count: 2,
      batch_index: 3,
      duration_ms: 1500,
    });
  });

  it("never leaks chunk text into the event", () => {
    const sink = vi.fn();
    reportAnalysisFailure(
      {
        module: "analysis",
        operation: "batch",
        code: "PROVIDER_UNAVAILABLE",
        correlation_id: "corr-2",
        pair_text: "SECRET DOCUMENT CONTENT",
        chunk_text: "SECRET CHUNK",
        prompt: "SECRET PROMPT",
        token: "SECRET-TOKEN",
      } as unknown as Parameters<typeof reportAnalysisFailure>[0],
      sink,
    );
    const sent = sink.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty("pair_text");
    expect(sent).not.toHaveProperty("chunk_text");
    expect(sent).not.toHaveProperty("prompt");
    expect(sent).not.toHaveProperty("token");
    expect(JSON.stringify(sent)).not.toContain("SECRET");
  });

  it("never passes a raw Error to the SDK sink", () => {
    const sink = vi.fn();
    reportAnalysisFailure(
      {
        module: "analysis",
        operation: "finalize",
        code: "INTERNAL_ERROR",
        correlation_id: "corr-3",
        error: new Error("raw boom"),
      } as unknown as Parameters<typeof reportAnalysisFailure>[0],
      sink,
    );
    expect(sink).toHaveBeenCalledTimes(1);
    const sent = sink.mock.calls[0]?.[0];
    expect(sent).not.toBeInstanceOf(Error);
    expect(sent).not.toHaveProperty("error");
  });

  it("keeps shape parity with the S1-08 safe-event contract", () => {
    const sink = vi.fn();
    reportAnalysisFailure(
      {
        module: "analysis",
        operation: "claim",
        code: "TIMEOUT",
        correlation_id: "corr-4",
        analysis_id: "analysis-9",
      },
      sink,
    );
    const sent = sink.mock.calls[0]?.[0] as Record<string, unknown>;
    // Same semantic core as captureOperationFailure
    // (src/lib/observability/operation-events.ts:5-12): module,
    // operation, code and a correlation identifier, no content fields.
    // Key mapping: S1-08 uses camelCase correlationId; the S2-06
    // whitelist (spec §8) uses snake_case correlation_id.
    expect(sent["module"]).toBe("analysis");
    expect(sent["operation"]).toBe("claim");
    expect(sent["code"]).toBe("TIMEOUT");
    expect(sent["correlation_id"]).toBe("corr-4");
    expect(sent["analysis_id"]).toBe("analysis-9");
    expect(Object.keys(sent).sort()).toEqual(
      ["analysis_id", "code", "correlation_id", "module", "operation"].sort(),
    );
  });

  it("writes a one-line JSON record to stdout within the whitelist", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      reportAnalysisFailure({
        module: "analysis",
        operation: "recover",
        code: "ATTEMPTS_EXHAUSTED",
        correlation_id: "corr-5",
      });
      expect(log).toHaveBeenCalledTimes(1);
      const line = String(log.mock.calls[0]?.[0]);
      expect(line.includes("\n")).toBe(false);
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const allowed = new Set([
        "module",
        "operation",
        "code",
        "correlation_id",
        "analysis_id",
        "workspace_id",
        "attempt_count",
        "batch_index",
        "duration_ms",
      ]);
      for (const key of Object.keys(parsed)) {
        expect(allowed.has(key)).toBe(true);
      }
    } finally {
      log.mockRestore();
    }
  });

  it("generates a correlation id when the caller omits it", () => {
    const sink = vi.fn();
    reportAnalysisFailure({ module: "analysis", operation: "renew" }, sink);
    const sent = sink.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(typeof sent["correlation_id"]).toBe("string");
    expect((sent["correlation_id"] as string).length).toBeGreaterThan(0);
  });
});
