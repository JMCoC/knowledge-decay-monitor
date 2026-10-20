import { afterEach, describe, expect, it, vi } from "vitest";
import { createCerebrasGroqProvider } from "../../src/modules/analysis/worker/provider.cerebras-groq";
import { createProvider } from "../../src/modules/analysis/worker/provider";
import type { ProviderFetch } from "../../src/modules/analysis/worker/provider.cerebras-groq";
import { CEREBRAS_MODEL } from "../../src/modules/analysis/provider-config";
import {
  ANALYSIS_PROMPT_V1,
  buildAnalysisPromptV1,
} from "../../src/modules/analysis/prompts/v1";
import { WIRE_JSON_SCHEMA } from "../../src/modules/analysis/prompts/v1-schema";
import {
  fetchQueue,
  hangingFetch,
} from "../support/provider-http";
import {
  canonicalConfiguration,
  canonicalEnv,
  canonicalPair,
  chatCompletion,
} from "../support/provider-fixtures";

function providerWith(fetchFn: ProviderFetch, timeoutMs = 20) {
  return createCerebrasGroqProvider({
    fetchFn,
    timeoutMs,
    env: canonicalEnv,
  });
}

function analyze(fetchFn: ProviderFetch, timeoutMs?: number) {
  return providerWith(fetchFn, timeoutMs).analyzePair({
    pair: canonicalPair,
    configuration: canonicalConfiguration,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Cerebras provider transport", () => {
  it("sends a single Cerebras request and returns empty findings", async () => {
    const { fetchFn, calls } = fetchQueue(
      chatCompletion(JSON.stringify({ findings: [] })),
    );

    const result = await analyze(fetchFn);

    expect(result).toEqual({ ok: true, findings: [] });
    expect(calls).toHaveLength(1);
  });

  it("uses the configured endpoint, headers, method and redirect policy", async () => {
    const { fetchFn, calls } = fetchQueue(
      chatCompletion(JSON.stringify({ findings: [] })),
    );

    await analyze(fetchFn);

    const call = calls[0];
    if (!call) {
      throw new Error("expected one fetch call");
    }
    expect(call.input).toBe(
      "https://cerebras.test/v1/chat/completions",
    );
    const headers = new Headers(call.init.headers);
    expect(headers.get("authorization")).toBe(
      `Bearer ${canonicalEnv.CEREBRAS_API_KEY}`,
    );
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("accept")).toBe("application/json");
    expect(call.init.method).toBe("POST");
    expect(call.init.redirect).toBe("error");
  });

  it("sends model, prompt messages and strict JSON schema response format", async () => {
    const { fetchFn, calls } = fetchQueue(
      chatCompletion(JSON.stringify({ findings: [] })),
    );

    await analyze(fetchFn);

    const call = calls[0];
    if (!call) {
      throw new Error("expected one fetch call");
    }
    const body = JSON.parse(String(call.init.body)) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      response_format: {
        type: string;
        json_schema: {
          name: string;
          strict: boolean;
          schema: unknown;
        };
      };
    };

    expect(body.model).toBe(CEREBRAS_MODEL);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]?.role).toBe("system");
    expect(body.messages[0]?.content).toBe(ANALYSIS_PROMPT_V1);
    expect(body.messages[1]?.role).toBe("user");
    expect(body.messages[1]?.content).toBe(
      buildAnalysisPromptV1(canonicalPair),
    );
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.name).toBe("analysis_findings");
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format.json_schema.schema).toEqual(WIRE_JSON_SCHEMA);
  });

  it("rejects an already-aborted caller signal without fetching", async () => {
    const { fetchFn, calls } = fetchQueue(
      chatCompletion(JSON.stringify({ findings: [] })),
    );
    const controller = new AbortController();
    controller.abort();

    const result = await providerWith(fetchFn).analyzePair({
      pair: canonicalPair,
      configuration: canonicalConfiguration,
      signal: controller.signal,
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "INTERNAL_ERROR" },
    });
    expect(calls).toHaveLength(0);
  });

  it("maps an internal timeout while waiting for headers to unavailable", async () => {
    const result = await analyze(hangingFetch(), 5);

    expect(result).toEqual({
      ok: false,
      error: { code: "PROVIDER_UNAVAILABLE" },
    });
  });

  it("rejects a declared Content-Length over 262144 without reading the body", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode("x"));
      },
    });
    const response = new Response(body, {
      status: 200,
      headers: { "content-length": "262145" },
    });
    const { fetchFn } = fetchQueue(response);
    await Promise.resolve();
    const pullsBeforeRequest = pulls;

    const result = await analyze(fetchFn);

    expect(result).toEqual({
      ok: false,
      error: { code: "INVALID_PROVIDER_OUTPUT" },
    });
    expect(pulls).toBe(pullsBeforeRequest);
  });

  it("cancels a stream exceeding 262144 bytes", async () => {
    let cancels = 0;
    const chunk = new Uint8Array(64 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
      cancel() {
        cancels += 1;
      },
    });
    const response = new Response(body, { status: 200 });
    const { fetchFn } = fetchQueue(response);

    const result = await analyze(fetchFn);

    expect(result).toEqual({
      ok: false,
      error: { code: "INVALID_PROVIDER_OUTPUT" },
    });
    expect(cancels).toBe(1);
  });

  it("times out while reading the body and aborts the request signal", async () => {
    let aborted = false;
    const slowFetch: ProviderFetch = (_input, init) => {
      const signal = init.signal;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              controller.enqueue(
                new TextEncoder().encode(JSON.stringify({ findings: [] })),
              );
              resolve();
            }, 50);
            signal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
              },
              { once: true },
            );
          });
        },
      });
      return Promise.resolve(
        new Response(stream, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };

    const result = await analyze(slowFetch, 5);

    expect(result).toEqual({
      ok: false,
      error: { code: "PROVIDER_UNAVAILABLE" },
    });
    expect(aborted).toBe(true);
  });
});

describe("createProvider environment validation", () => {
  function stubValidEnv() {
    vi.stubEnv("CEREBRAS_API_KEY", "test-cerebras-key");
    vi.stubEnv("GROQ_API_KEY", "test-groq-key");
    vi.stubEnv("CEREBRAS_BASE_URL", "https://cerebras.test/v1");
    vi.stubEnv("GROQ_BASE_URL", "https://groq.test/openai/v1");
    vi.stubEnv("NODE_ENV", "test");
  }

  it("throws when CEREBRAS_API_KEY is missing", () => {
    stubValidEnv();
    vi.stubEnv("CEREBRAS_API_KEY", "");

    expect(() => createProvider()).toThrow(/CEREBRAS_API_KEY/);
  });

  it("throws when GROQ_API_KEY is missing", () => {
    stubValidEnv();
    vi.stubEnv("GROQ_API_KEY", "");

    expect(() => createProvider()).toThrow(/GROQ_API_KEY/);
  });

  it("throws when CEREBRAS_BASE_URL is not a valid URL, even in test", () => {
    stubValidEnv();
    vi.stubEnv("CEREBRAS_BASE_URL", "not-a-url");

    expect(() => createProvider()).toThrow(/CEREBRAS_BASE_URL/);
  });

  it("allows http:// base URL when NODE_ENV=test", () => {
    vi.stubEnv("CEREBRAS_API_KEY", "test-cerebras-key");
    vi.stubEnv("GROQ_API_KEY", "test-groq-key");
    vi.stubEnv("CEREBRAS_BASE_URL", "http://cerebras.test/v1");
    vi.stubEnv("GROQ_BASE_URL", "http://groq.test/v1");
    vi.stubEnv("NODE_ENV", "test");

    expect(() => createProvider()).not.toThrow();
  });

  it("returns a provider when all required environment values exist", () => {
    stubValidEnv();

    const provider = createProvider();

    expect(provider.analyzePair).toBeTypeOf("function");
  });
});
