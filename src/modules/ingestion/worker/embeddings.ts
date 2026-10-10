export const EMBEDDING_DIMS = 384;
export type Infer = (text: string) => Promise<number[][]>;

export function vectorToSql(vector: unknown): string {
  if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMS
    || !vector.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw new Error("EMBEDDING_FAILED");
  }
  return `[${vector.join(",")}]`;
}

/** One native call at a time: SQL also limits the entire fleet to one active job. */
export async function embedTexts(texts: string[], infer: Infer, signal: AbortSignal): Promise<string[]> {
  if (texts.length === 0 || texts.length > 500) throw new Error("EMBEDDING_FAILED");
  const results: string[] = [];
  for (const text of texts) {
    signal.throwIfAborted();
    const output = await infer(text);
    signal.throwIfAborted();
    if (output.length !== 1) throw new Error("EMBEDDING_FAILED");
    results.push(vectorToSql(output[0]));
  }
  return results;
}
