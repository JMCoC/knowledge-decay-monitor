import "server-only";

import { createServiceClient } from "@/lib/supabase/service";

/** Frozen in Task 0: gte-small outputs 384 dims (local probe, HTTP 200). */
export const EMBEDDING_DIMS = 384;

/** A processing version never contains more than this many chunks. */
export const MAX_EMBEDDING_INPUTS = 500;

export type EmbeddingErrorCode = "EMBEDDING_FAILED";

/** Controlled pipeline failure. Task 5 maps `code` to the Sentry taxonomy. */
export class EmbeddingError extends Error {
  readonly code: EmbeddingErrorCode;

  constructor(code: EmbeddingErrorCode = "EMBEDDING_FAILED") {
    super("The embeddings provider failed.");
    this.name = "EmbeddingError";
    this.code = code;
  }
}

interface EmbedFunctionData {
  embeddings?: unknown;
  dims?: unknown;
}

function toPgvector(vector: unknown): string {
  if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMS) {
    throw new EmbeddingError();
  }
  for (const value of vector) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new EmbeddingError();
    }
  }
  return `[${(vector as number[]).join(",")}]`;
}

/**
 * Embeds up to 500 chunk texts via the Edge Function (`gte-small`, 384d),
 * one input per request and at most two requests in flight. Returns one
 * pgvector string per input in order and never persists anything. Failures
 * become `EmbeddingError("EMBEDDING_FAILED")` without provider details.
 */
export async function embedBatch(
  texts: string[],
  options: { signal?: AbortSignal; assertCanStart?: () => void } = {},
): Promise<string[]> {
  if (!Array.isArray(texts) || texts.length === 0 || texts.length > MAX_EMBEDDING_INPUTS) {
    throw new EmbeddingError();
  }
  for (const text of texts) {
    if (typeof text !== "string") {
      throw new EmbeddingError();
    }
  }

  const externalSignal = options.signal;
  if (externalSignal?.aborted) throw new EmbeddingError();

  const controller = new AbortController();
  const abortFromExternal = () => controller.abort();
  let nextIndex = 0;
  const results = new Array<string>(texts.length);
  let workers: Promise<void>[] = [];

  try {
    externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
    if (externalSignal?.aborted) {
      controller.abort();
      throw new EmbeddingError();
    }

    const service = createServiceClient();
    const runWorker = async () => {
      while (true) {
        if (controller.signal.aborted || externalSignal?.aborted) throw new EmbeddingError();
        const index = nextIndex;
        if (index >= texts.length) return;
        try {
          options.assertCanStart?.();
        } catch {
          controller.abort();
          throw new EmbeddingError();
        }
        if (controller.signal.aborted || externalSignal?.aborted) throw new EmbeddingError();
        nextIndex += 1;

        try {
          const { data: responseData, error } = await service.functions.invoke("embed", {
            body: { inputs: [texts[index] as string] },
            signal: controller.signal,
          });
          if (controller.signal.aborted || externalSignal?.aborted) throw new EmbeddingError();
          const data = (responseData ?? null) as EmbedFunctionData | null;
          if (
            error || data?.dims !== EMBEDDING_DIMS || !Array.isArray(data.embeddings)
            || data.embeddings.length !== 1
          ) {
            throw new EmbeddingError();
          }
          results[index] = toPgvector(data.embeddings[0]);
        } catch (error) {
          controller.abort();
          if (error instanceof EmbeddingError) throw error;
          throw new EmbeddingError();
        }
      }
    };

    workers = Array.from({ length: Math.min(2, texts.length) }, () => runWorker());
    await Promise.all(workers);
    if (controller.signal.aborted || results.some((result) => typeof result !== "string")) {
      throw new EmbeddingError();
    }
    return results;
  } catch (error) {
    controller.abort();
    await Promise.allSettled(workers);
    if (error instanceof EmbeddingError) throw error;
    throw new EmbeddingError();
  } finally {
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}
