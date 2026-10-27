import type {
  AnalysisCandidatePair,
  AnalysisConfiguration,
} from "../../src/types/analysis-internal";
import {
  CEREBRAS_MODEL,
  CEREBRAS_PROVIDER,
  GROQ_MODEL,
  GROQ_PROVIDER,
} from "../../src/modules/analysis/provider-config";
import {
  ANALYSIS_PROMPT_VERSION,
  OUTPUT_SCHEMA_VERSION,
} from "../../src/modules/analysis/prompts/v1";
import type { ProviderEnvironment } from "../../src/modules/analysis/worker/provider.cerebras-groq";
import { jsonResponse } from "./provider-http";

export const canonicalPair: AnalysisCandidatePair = {
  source: {
    documentId: "doc-source",
    versionId: "version-source",
    chunkId: "chunk-source",
    role: "source",
    text: "alpha beta",
  },
  comparison: {
    documentId: "doc-comparison",
    versionId: "version-comparison",
    chunkId: "chunk-comparison",
    role: "comparison",
    text: "gamma delta",
  },
};

export const canonicalConfiguration: AnalysisConfiguration = {
  retrieval: {
    topK: 5,
    similarityThreshold: 0.75,
    chunksRevision: "x",
    embeddingRevision: "y",
    fingerprint: "z",
  },
  pricingVersion: "p",
  promptVersion: ANALYSIS_PROMPT_VERSION,
  outputSchemaVersion: OUTPUT_SCHEMA_VERSION,
  providers: {
    primary: { provider: CEREBRAS_PROVIDER, model: CEREBRAS_MODEL },
    fallback: { provider: GROQ_PROVIDER, model: GROQ_MODEL },
  },
};

export const canonicalEnv: ProviderEnvironment = {
  CEREBRAS_BASE_URL: "https://cerebras.test/v1",
  GROQ_BASE_URL: "https://groq.test/openai/v1",
  CEREBRAS_API_KEY: "test-cerebras-key",
  GROQ_API_KEY: "test-groq-key",
  NODE_ENV: "test",
};

export function chatCompletion(content: string, init?: ResponseInit): Response {
  return jsonResponse(
    { choices: [{ message: { content } }] },
    init,
  );
}
