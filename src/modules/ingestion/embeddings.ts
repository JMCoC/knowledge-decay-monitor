import "server-only";

import { createServiceClient } from "@/lib/supabase/service";

/** Frozen in Task 0: gte-small outputs 384 dims (local probe, HTTP 200). */
export const EMBEDDING_DIMS = 384;

/** Frozen in Task 0: 12+ texts per call trips the isolate CPU limit (HTTP 546). */
export const EMBEDDING_BATCH_SIZE = 8;

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
 * Embeds up to 8 chunk texts via the Task 0 Edge Function
 * (`supabase/functions/embed`, gte-small 384d). Returns one pgvector string
 * per input, in order. Never persists anything; validation failures and
 * provider failures both surface as `EmbeddingError("EMBEDDING_FAILED")`
 * so Task 5 can map them without leaking provider details.
 */
export async function embedBatch(texts: string[]): Promise<string[]> {
  if (!Array.isArray(texts) || texts.length === 0 || texts.length > EMBEDDING_BATCH_SIZE) {
    throw new EmbeddingError();
  }
  for (const text of texts) {
    if (typeof text !== "string") {
      throw new EmbeddingError();
    }
  }

  let data: EmbedFunctionData | null;
  try {
    const service = createServiceClient();
    const { data: responseData, error } = await service.functions.invoke("embed", {
      body: { inputs: texts },
    });
    if (error) {
      throw new EmbeddingError();
    }
    data = (responseData ?? null) as EmbedFunctionData | null;
  } catch (error) {
    if (error instanceof EmbeddingError) throw error;
    throw new EmbeddingError();
  }

  const embeddings = data?.embeddings;
  if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
    throw new EmbeddingError();
  }
  return embeddings.map((vector) => toPgvector(vector));
}
