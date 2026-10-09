vi.mock("server-only", () => ({}));

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    functions: { invoke: mocks.invoke },
  }),
}));

import { EmbeddingError, embedBatch } from "@/modules/ingestion/embeddings";

const vec = (dims: number, value = 0.1): number[] => Array.from({ length: dims }, () => value);
const pgvectorPattern = /^\[(-?\d+(\.\d+)?(e-?\d+)?,){383}-?\d+(\.\d+)?(e-?\d+)?\]$/;
type InvokeOptions = { body: { inputs: string[] }; signal?: AbortSignal };

beforeEach(() => {
  mocks.invoke.mockReset();
});

describe("embedBatch happy path", () => {
  it("serializes 384 finite numbers to a pgvector string", async () => {
    mocks.invoke.mockResolvedValue({ data: { embeddings: [vec(384)], dims: 384 }, error: null });

    const result = await embedBatch(["hello world"]);

    expect(result).toHaveLength(1);
    expect(pgvectorPattern.test(result[0] ?? "")).toBe(true);
    const parsed = JSON.parse(result[0] ?? "[]") as number[];
    expect(parsed).toHaveLength(384);
    expect(parsed.every((n) => Number.isFinite(n))).toBe(true);
  });

  it("embeds nine texts individually, at most two in flight, preserving input order", async () => {
    let live = 0;
    let peak = 0;
    mocks.invoke.mockImplementation(async (_name: string, options: InvokeOptions) => {
      expect(options.body.inputs).toHaveLength(1);
      const index = Number(options.body.inputs[0]);
      peak = Math.max(peak, ++live);
      await new Promise((resolve) => setTimeout(resolve, index % 2 ? 1 : 8));
      live -= 1;
      return { data: { embeddings: [vec(384, index)], dims: 384 }, error: null };
    });

    const result = await embedBatch(Array.from({ length: 9 }, (_, index) => String(index)));

    expect(peak).toBe(2);
    expect(mocks.invoke).toHaveBeenCalledTimes(9);
    expect(result.map((value) => Number(JSON.parse(value)[0]))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe("embedBatch validation", () => {
  it("rejects NaN with EMBEDDING_FAILED", async () => {
    const bad = vec(384);
    bad[0] = Number.NaN;
    mocks.invoke.mockResolvedValue({ data: { embeddings: [bad], dims: 384 }, error: null });

    await expect(embedBatch(["hi"])).rejects.toMatchObject({
      name: "EmbeddingError",
      code: "EMBEDDING_FAILED",
    });
  });

  it("rejects Inf with EMBEDDING_FAILED", async () => {
    const bad = vec(384);
    bad[10] = Number.POSITIVE_INFINITY;
    mocks.invoke.mockResolvedValue({ data: { embeddings: [bad], dims: 384 }, error: null });

    await expect(embedBatch(["hi"])).rejects.toBeInstanceOf(EmbeddingError);
    await expect(embedBatch(["hi"])).rejects.toMatchObject({ code: "EMBEDDING_FAILED" });
  });

  it("rejects a response whose dims metadata does not match the model", async () => {
    mocks.invoke.mockResolvedValue({ data: { embeddings: [vec(384)], dims: 383 }, error: null });

    await expect(embedBatch(["hi"])).rejects.toMatchObject({ code: "EMBEDDING_FAILED" });
  });

  it("rejects an empty embedding response", async () => {
    mocks.invoke.mockResolvedValue({ data: { embeddings: [], dims: 384 }, error: null });

    await expect(embedBatch(["hi"])).rejects.toMatchObject({ code: "EMBEDDING_FAILED" });
  });

  it("rejects empty input before invoking the provider", async () => {
    await expect(embedBatch([])).rejects.toMatchObject({ code: "EMBEDDING_FAILED" });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("rejects more than 500 inputs before invoking the provider", async () => {
    const texts = Array.from({ length: 501 }, (_, index) => `text ${index}`);
    await expect(embedBatch(texts)).rejects.toMatchObject({ code: "EMBEDDING_FAILED" });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("does not invoke the provider when the work signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(embedBatch(["hi"], { signal: controller.signal })).rejects.toMatchObject({
      code: "EMBEDDING_FAILED",
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("does not start work when the budget assertion rejects", async () => {
    const assertCanStart = vi.fn(() => { throw new Error("synthetic budget exhausted"); });

    await expect(embedBatch(["hi"], { assertCanStart })).rejects.toMatchObject({
      code: "EMBEDDING_FAILED",
    });
    expect(assertCanStart).toHaveBeenCalledOnce();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe("embedBatch provider failures", () => {
  it("aborts the first pair on failure without starting the backlog", async () => {
    mocks.invoke.mockImplementation((_name: string, options: InvokeOptions) => {
      const index = Number(options.body.inputs[0]);
      if (index === 0) return Promise.reject(new Error("private provider payload"));
      return new Promise((_resolve, reject) => {
        const signal = options.signal;
        if (!signal) {
          reject(new Error("missing cancellation signal"));
          return;
        }
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    });

    await expect(embedBatch(Array.from({ length: 9 }, (_, index) => String(index))))
      .rejects.toMatchObject({ code: "EMBEDDING_FAILED" });
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(mocks.invoke.mock.calls.every(([, options]) => options.body.inputs.length === 1)).toBe(true);
  });

  it("maps a thrown invoke error to EMBEDDING_FAILED", async () => {
    mocks.invoke.mockRejectedValue(new Error("private provider payload"));

    const result = embedBatch(["hi"]);
    await expect(result).rejects.toMatchObject({ code: "EMBEDDING_FAILED" });
    await expect(result).rejects.toBeInstanceOf(EmbeddingError);
  });

  it("maps { error } responses to EMBEDDING_FAILED without leaking details", async () => {
    mocks.invoke.mockResolvedValue({ data: null, error: new Error("private edge detail") });

    const result = embedBatch(["hi"]);
    await expect(result).rejects.toMatchObject({ code: "EMBEDDING_FAILED" });
    try {
      await result;
      expect.unreachable("must throw EMBEDDING_FAILED");
    } catch (error) {
      expect(String(error)).not.toContain("private edge detail");
    }
  });
});
