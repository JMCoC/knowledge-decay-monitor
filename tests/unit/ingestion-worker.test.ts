import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { vectorToSql, embedTexts } from "@/modules/ingestion/worker/embeddings";

describe("worker embeddings", () => {
  it("rejects wrong dimensions and nonfinite values", () => {
    expect(() => vectorToSql([1])).toThrow();
    expect(() => vectorToSql(Array(384).fill(Infinity))).toThrow();
    expect(vectorToSql(Array(384).fill(0))).toBe(`[${Array(384).fill(0).join(",")}]`);
  });
  it("bounds inference to one call and preserves order", async () => {
    let live=0; let peak=0;
    const infer=vi.fn(async (text:string) => {live++;peak=Math.max(peak,live);await Promise.resolve();live--;return [Array(384).fill(text==='a'?1:2)];});
    const results=await embedTexts(['a','b'],infer,new AbortController().signal);
    expect(results[0]).toBe(vectorToSql(Array(384).fill(1)));
    expect(results[1]).toBe(vectorToSql(Array(384).fill(2)));
    expect(peak).toBe(1);
  });
  it("does not start inference after cancellation", async () => {
    const infer=vi.fn();
    await expect(embedTexts(['a'],infer,AbortSignal.abort())).rejects.toThrow();
    expect(infer).not.toHaveBeenCalled();
  });
  it("rejects incomplete provider output",async()=>{
    await expect(embedTexts(['a'],async()=>[],new AbortController().signal)).rejects.toThrow();
  });
  it("rejects content beyond the supported chunk cap",async()=>{
    await expect(embedTexts(Array(501).fill('a'),vi.fn(),new AbortController().signal)).rejects.toThrow();
  });
});
