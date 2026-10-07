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

  it("preserves input order across multiple texts", async () => {
    const first = vec(384, 0.1);
    const second = vec(384, 0.2);
    const third = vec(384, 0.3);
    mocks.invoke.mockResolvedValue({
      data: { embeddings: [first, second, third], dims: 384 },
      error: null,
    });

    const result = await embedBatch(["a", "b", "c"]);

    expect(result).toHaveLength(3);
    expect(JSON.parse(result[0] ?? "")[0]).toBeCloseTo(0.1);
    expect(JSON.parse(result[1] ?? "")[0]).toBeCloseTo(0.2);
    expect(JSON.parse(result[2] ?? "")[0]).toBeCloseTo(0.3);
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith("embed", { body: { inputs: ["a", "b", "c"] } });
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

  it("rejects dims != 384 with EMBEDDING_FAILED", async () => {
    mocks.invoke.mockResolvedValue({ data: { embeddings: [vec(383)], dims: 383 }, error: null });
    await expect(embedBatch(["hi"])).rejects.toMatchObject({ code: "EMBEDDING_FAILED" });

    mocks.invoke.mockResolvedValue({ data: { embeddings: [vec(385)], dims: 385 }, error: null });
    await expect(embedBatch(["hi"])).rejects.toMatchObject({ code: "EMBEDDING_FAILED" });
  });

  it("rejects empty input before invoking the provider", async () => {
    await expect(embedBatch([])).rejects.toMatchObject({ code: "EMBEDDING_FAILED" });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("rejects batch > 8 before invoking the provider", async () => {
    const texts = Array.from({ length: 9 }, (_, i) => `text ${i}`);
    await expect(embedBatch(texts)).rejects.toMatchObject({ code: "EMBEDDING_FAILED" });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe("embedBatch provider failures", () => {
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
