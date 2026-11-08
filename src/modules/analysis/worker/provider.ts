import type { AIProvider } from "../../../types/analysis-internal.ts";
import {
  createCerebrasGroqProvider,
  type ProviderEnvironment,
} from "./provider.cerebras-groq.ts";

function readEnv(): ProviderEnvironment {
  const denoEnv = (
    globalThis as {
      Deno?: { env?: { get(key: string): string | undefined } };
    }
  ).Deno?.env;
  const nodeEnv = (
    globalThis as {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process?.env;
  const read = (key: string): string | undefined =>
    denoEnv ? denoEnv.get(key) : nodeEnv?.[key];

  return {
    CEREBRAS_API_KEY: read("CEREBRAS_API_KEY"),
    GROQ_API_KEY: read("GROQ_API_KEY"),
    CEREBRAS_BASE_URL: read("CEREBRAS_BASE_URL"),
    GROQ_BASE_URL: read("GROQ_BASE_URL"),
    NODE_ENV: read("NODE_ENV"),
  };
}

export function createProvider(): AIProvider {
  return createCerebrasGroqProvider({
    fetchFn: (input, init) => fetch(input, init),
    env: readEnv(),
  });
}
