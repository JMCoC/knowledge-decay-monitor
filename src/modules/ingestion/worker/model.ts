import { env, pipeline } from "@huggingface/transformers";
import { resolve } from "node:path";
import type { Infer } from "./embeddings";

export const MODEL_ID = "Supabase/gte-small";
export const MODEL_REVISION = "93b36ff09519291b77d6000d2e86bd8565378086";

export async function loadEmbeddingModel(): Promise<{ infer: Infer; dispose(): Promise<void> }> {
  env.cacheDir = resolve(process.env.INGESTION_MODEL_CACHE ?? ".artifacts/models");
  env.allowLocalModels = false;
  const extractor = await pipeline("feature-extraction", MODEL_ID, {
    revision: MODEL_REVISION,
    dtype: "q8",
    device: "cpu",
    local_files_only: process.env.INGESTION_MODEL_OFFLINE === "1",
    session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 },
  });
  const infer: Infer = async (text) => {
    const result = await extractor(text, { pooling: "mean", normalize: true });
    return result.tolist() as number[][];
  };
  // Warm native session before any job/lease is taken.
  await infer("Synthetic worker readiness.");
  return { infer, dispose: () => extractor.dispose() };
}
