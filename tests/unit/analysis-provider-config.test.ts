import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createProvider } from "../../src/modules/analysis/worker/provider";
import { createCerebrasGroqProvider } from "../../src/modules/analysis/worker/provider.cerebras-groq";
import type { AnalysisConfiguration } from "../../src/types/analysis-internal";
import {
  canonicalConfiguration,
  canonicalEnv,
  canonicalPair,
  chatCompletion,
} from "../support/provider-fixtures";

const ENV_KEYS = [
  "CEREBRAS_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_BASE_URL",
  "GROQ_BASE_URL",
] as const;

function stubProviderEnv(overrides: Record<string, string> = {}): void {
  const values: Record<string, string> = {
    CEREBRAS_API_KEY: "test-cerebras-key",
    GROQ_API_KEY: "test-groq-key",
    CEREBRAS_BASE_URL: "https://cerebras.test/v1",
    GROQ_BASE_URL: "https://groq.test/openai/v1",
    NODE_ENV: "test",
    ...overrides,
  };
  for (const [key, value] of Object.entries(values)) {
    vi.stubEnv(key, value);
  }
}

function withConfig(
  patch: {
    primaryProvider?: string;
    fallbackProvider?: string;
    primaryModel?: string;
    fallbackModel?: string;
    promptVersion?: string;
    outputSchemaVersion?: string;
  } = {},
): AnalysisConfiguration {
  return {
    ...canonicalConfiguration,
    ...(patch.promptVersion !== undefined
      ? { promptVersion: patch.promptVersion }
      : {}),
    ...(patch.outputSchemaVersion !== undefined
      ? { outputSchemaVersion: patch.outputSchemaVersion }
      : {}),
    providers: {
      primary: {
        provider:
          patch.primaryProvider ??
          canonicalConfiguration.providers.primary.provider,
        model:
          patch.primaryModel ?? canonicalConfiguration.providers.primary.model,
      },
      fallback: {
        provider:
          patch.fallbackProvider ??
          canonicalConfiguration.providers.fallback.provider,
        model:
          patch.fallbackModel ??
          canonicalConfiguration.providers.fallback.model,
      },
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("analysis provider configuration", () => {
  it("createProvider returns an AIProvider synchronously", () => {
    stubProviderEnv();
    const provider = createProvider();
    expect(provider).not.toBeInstanceOf(Promise);
    expect(typeof provider.analyzePair).toBe("function");
  });

  it.each(ENV_KEYS)("throws when %s is missing", (key) => {
    stubProviderEnv({ [key]: "" });
    expect(() => createProvider()).toThrow(`missing ${key}`);
  });

  it.each(["CEREBRAS_BASE_URL", "GROQ_BASE_URL"] as const)(
    "throws when %s is not a valid URL",
    (key) => {
      stubProviderEnv({ [key]: "not-a-url" });
      expect(() => createProvider()).toThrow(`${key} must be a valid URL`);
    },
  );

  it("requires https outside the test environment", () => {
    stubProviderEnv({
      NODE_ENV: "production",
      CEREBRAS_BASE_URL: "http://cerebras.test/v1",
    });
    expect(() => createProvider()).toThrow("CEREBRAS_BASE_URL must be https");
  });

  it("allows http only in the test environment", () => {
    stubProviderEnv({
      NODE_ENV: "test",
      CEREBRAS_BASE_URL: "http://cerebras.test/v1",
    });
    expect(() => createProvider()).not.toThrow();
  });

  it.each<[string, AnalysisConfiguration]>([
    ["primary provider", withConfig({ primaryProvider: "openai" })],
    ["fallback provider", withConfig({ fallbackProvider: "cerebras" })],
    ["primary model", withConfig({ primaryModel: "" })],
    ["fallback model", withConfig({ fallbackModel: "" })],
    [
      "prompt version",
      withConfig({ promptVersion: "s2-06-prompt-v0" }),
    ],
    [
      "output schema version",
      withConfig({ outputSchemaVersion: "s2-06-findings-v0" }),
    ],
  ])("rejects an invalid %s before fetch", async (_label, configuration) => {
    const fetchFn = vi.fn(async () =>
      chatCompletion(JSON.stringify({ findings: [] })),
    );
    const provider = createCerebrasGroqProvider({
      fetchFn,
      timeoutMs: 20,
      env: canonicalEnv,
    });

    await expect(
      provider.analyzePair({ pair: canonicalPair, configuration }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "INTERNAL_ERROR" },
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("accepts the none prompt/schema versions", async () => {
    const fetchFn = vi.fn(async () =>
      chatCompletion(JSON.stringify({ findings: [] })),
    );
    const provider = createCerebrasGroqProvider({
      fetchFn,
      timeoutMs: 20,
      env: canonicalEnv,
    });

    await expect(
      provider.analyzePair({
        pair: canonicalPair,
        configuration: withConfig({
          promptVersion: "none",
          outputSchemaVersion: "none",
        }),
      }),
    ).resolves.toEqual({ ok: true, findings: [] });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("uses shared provider constants and no vendor SDK", () => {
    const providerSource = readFileSync(
      new URL(
        "../../src/modules/analysis/worker/provider.cerebras-groq.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const sources = [
      providerSource,
      readFileSync(
        new URL("../../src/modules/analysis/worker/provider.ts", import.meta.url),
        "utf8",
      ),
      readFileSync(
        new URL("../../src/modules/analysis/provider-config.ts", import.meta.url),
        "utf8",
      ),
      readFileSync(
        new URL("../../src/modules/analysis/prompts/v1.ts", import.meta.url),
        "utf8",
      ),
      readFileSync(
        new URL(
          "../../src/modules/analysis/prompts/v1-schema.ts",
          import.meta.url,
        ),
        "utf8",
      ),
    ];

    expect(providerSource).toContain("../provider-config.ts");
    expect(providerSource).toContain("CEREBRAS_PROVIDER");
    expect(providerSource).toContain("GROQ_PROVIDER");
    expect(providerSource).toContain("PROVIDER_TIMEOUT_MS");
    expect(providerSource).not.toContain('"qwen-3.8-27b"');
    expect(providerSource).not.toContain('"openai/gpt-oss-20b"');
    for (const source of sources) {
      expect(source).not.toMatch(
        /from\s+["'](?:@?cerebras|@?groq|cerebras-sdk|groq-sdk)/i,
      );
    }
  });
});
