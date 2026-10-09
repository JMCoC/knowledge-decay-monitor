import { loadEmbeddingModel } from "../src/modules/ingestion/worker/model";
import { embedTexts } from "../src/modules/ingestion/worker/embeddings";
async function main() {
  const model = await loadEmbeddingModel();
  const started = Date.now();
  const vectors = await embedTexts(Array(32).fill("Synthetic document ingestion acceptance."), model.infer, new AbortController().signal);
  console.info(JSON.stringify({ status: "ready", vectors: vectors.length, dims: 384, durationMs: Date.now() - started }));
  await model.dispose();
}
main().catch(() => {
  console.error("Embedding model readiness failed.");
  process.exit(1);
});
