import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createCerebrasGroqProvider,
  type ProviderFetch,
} from "../../src/modules/analysis/worker/provider.cerebras-groq";
import { GROQ_MODEL } from "../../src/modules/analysis/provider-config";
import type { FetchCall } from "../support/provider-http";
import { hangingFetch } from "../support/provider-http";
import {
  canonicalConfiguration,
  canonicalEnv,
  canonicalPair,
  chatCompletion,
} from "../support/provider-fixtures";

const VALID_CONTENT = JSON.stringify({
  findings: [
    {
      type: "contradiction",
      severity: "High",
      confidence: 0.9,
      explanation: "the texts disagree",
      evidence: [
        { side: "source", quote: "alpha" },
        { side: "comparison", quote: "gamma" },
      ],
    },
  ],
});

const INVALID_CONTENT = JSON.stringify({
  findings: [
    {
      type: "contradiction",
      severity: "Critical",
      confidence: 0.9,
      explanation: "the texts disagree",
      evidence: [
        { side: "source", quote: "alpha" },
        { side: "comparison", quote: "gamma" },
      ],
    },
  ],
});

const EMPTY_CONTENT = JSON.stringify({ findings: [] });

const CHAT_CONTENT = JSON.stringify({
  choices: [{ message: { content: VALID_CONTENT } }],
});

type FetchStep = (input: string, init: RequestInit) => Promise<Response>;

function scriptedFetch(...steps: FetchStep[]) {
  const calls: FetchCall[] = [];
  const fetchFn: ProviderFetch = (input, init) => {
    calls.push({ input, init });
    const step = steps[calls.length - 1];
    if (!step) {
      throw new Error("fetch exhausted");
    }
    return step(input, init);
  };
  return { fetchFn, calls };
}

function providerWith(fetchFn: ProviderFetch, timeoutMs = 20) {
  return createCerebrasGroqProvider({
    fetchFn,
    timeoutMs,
    env: canonicalEnv,
  });
}

function analyze(
  fetchFn: ProviderFetch,
  signal?: AbortSignal,
  timeoutMs?: number,
) {
  return providerWith(fetchFn, timeoutMs).analyzePair({
    pair: canonicalPair,
    configuration: canonicalConfiguration,
    signal,
  });
}

function abortAfterEnqueue(
  controller: AbortController,
  content: string,
): Response {
  const bytes = new TextEncoder().encode(content);
  const stream = new ReadableStream<Uint8Array>({
    pull(streamController) {
      streamController.enqueue(bytes);
      streamController.close();
      controller.abort();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const INTERNAL_ERROR = {
  ok: false,
  error: { code: "INTERNAL_ERROR" },
} as const;

const INVALID_OUTPUT = {
  ok: false,
  error: { code: "INVALID_PROVIDER_OUTPUT" },
} as const;

const UNAVAILABLE = {
  ok: false,
  error: { code: "PROVIDER_UNAVAILABLE" },
} as const;

describe("Cerebras to Groq fallback", () => {
  it("does not call Groq when Cerebras returns valid findings", async () => {
    const { fetchFn, calls } = scriptedFetch(
      async () => chatCompletion(VALID_CONTENT),
    );

    const result = await analyze(fetchFn);

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("does not call Groq when Cerebras returns empty findings", async () => {
    const { fetchFn, calls } = scriptedFetch(
      async () => chatCompletion(EMPTY_CONTENT),
    );

    const result = await analyze(fetchFn);

    expect(result).toEqual({ ok: true, findings: [] });
    expect(calls).toHaveLength(1);
  });

  it("falls back to Groq when Cerebras returns 2xx invalid", async () => {
    const { fetchFn, calls } = scriptedFetch(
      async () => chatCompletion(INVALID_CONTENT),
      async () => chatCompletion(VALID_CONTENT),
    );

    const result = await analyze(fetchFn);

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    const groqCall = calls[1];
    if (!groqCall) {
      throw new Error("expected a Groq call");
    }
    expect(groqCall.input).toBe("https://groq.test/openai/v1/chat/completions");
    expect(new Headers(groqCall.init.headers).get("authorization")).toBe(
      `Bearer ${canonicalEnv.GROQ_API_KEY}`,
    );
    const body = JSON.parse(String(groqCall.init.body)) as {
      model: string;
    };
    expect(body.model).toBe(GROQ_MODEL);
  });

  it.each([400, 401, 403, 404, 408, 409, 425, 429, 500])(
    "falls back to Groq on Cerebras HTTP %i",
    async (status) => {
      const { fetchFn, calls } = scriptedFetch(
        async () => new Response(null, { status }),
        async () => chatCompletion(VALID_CONTENT),
      );

      const result = await analyze(fetchFn);

      expect(result.ok).toBe(true);
      expect(calls).toHaveLength(2);
    },
  );

  it("falls back to Groq when Cerebras times out", async () => {
    const { fetchFn, calls } = scriptedFetch(
      (input, init) => hangingFetch()(input, init),
      async () => chatCompletion(VALID_CONTENT),
    );

    const result = await analyze(fetchFn, undefined, 5);

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("falls back to Groq when Cerebras has a network error", async () => {
    const { fetchFn, calls } = scriptedFetch(
      async () => {
        throw new Error("network");
      },
      async () => chatCompletion(VALID_CONTENT),
    );

    const result = await analyze(fetchFn);

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("returns INTERNAL_ERROR when caller aborts before Cerebras", async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetchFn, calls } = scriptedFetch(
      async () => chatCompletion(VALID_CONTENT),
    );

    const result = await analyze(fetchFn, controller.signal);

    expect(result).toEqual(INTERNAL_ERROR);
    expect(calls).toHaveLength(0);
  });

  it("returns INTERNAL_ERROR when caller aborts during Cerebras fetch", async () => {
    const controller = new AbortController();
    const { fetchFn, calls } = scriptedFetch(
      async () => {
        controller.abort();
        throw new DOMException("Aborted", "AbortError");
      },
      async () => chatCompletion(VALID_CONTENT),
    );

    const result = await analyze(fetchFn, controller.signal);

    expect(result).toEqual(INTERNAL_ERROR);
    expect(calls).toHaveLength(1);
  });

  it("returns INTERNAL_ERROR when caller aborts after Cerebras body but before Groq", async () => {
    const controller = new AbortController();
    const { fetchFn, calls } = scriptedFetch(
      async () => abortAfterEnqueue(controller, CHAT_CONTENT),
      async () => chatCompletion(VALID_CONTENT),
    );

    const result = await analyze(fetchFn, controller.signal);

    expect(result).toEqual(INTERNAL_ERROR);
    expect(calls).toHaveLength(1);
  });

  it("returns INTERNAL_ERROR when caller aborts during Groq after Cerebras invalid", async () => {
    const controller = new AbortController();
    const { fetchFn, calls } = scriptedFetch(
      async () => chatCompletion(INVALID_CONTENT),
      async () => {
        controller.abort();
        throw new DOMException("Aborted", "AbortError");
      },
    );

    const result = await analyze(fetchFn, controller.signal);

    expect(result).toEqual(INTERNAL_ERROR);
    expect(calls).toHaveLength(2);
  });

  it("returns INTERNAL_ERROR when caller aborts after Groq body but before mapping", async () => {
    const controller = new AbortController();
    const { fetchFn, calls } = scriptedFetch(
      async () => chatCompletion(INVALID_CONTENT),
      async () => abortAfterEnqueue(controller, CHAT_CONTENT),
    );

    const result = await analyze(fetchFn, controller.signal);

    expect(result).toEqual(INTERNAL_ERROR);
    expect(calls).toHaveLength(2);
  });

  it("returns INVALID_PROVIDER_OUTPUT when both providers return 2xx invalid", async () => {
    const { fetchFn, calls } = scriptedFetch(
      async () => chatCompletion(INVALID_CONTENT),
      async () => chatCompletion(INVALID_CONTENT),
    );

    const result = await analyze(fetchFn);

    expect(result).toEqual(INVALID_OUTPUT);
    expect(calls).toHaveLength(2);
  });

  it("returns INVALID_PROVIDER_OUTPUT when Cerebras 2xx invalid and Groq returns 500", async () => {
    const { fetchFn, calls } = scriptedFetch(
      async () => chatCompletion(INVALID_CONTENT),
      async () => new Response(null, { status: 500 }),
    );

    const result = await analyze(fetchFn);

    expect(result).toEqual(INVALID_OUTPUT);
    expect(calls).toHaveLength(2);
  });

  it("returns INVALID_PROVIDER_OUTPUT when Cerebras returns 500 and Groq 2xx invalid", async () => {
    const { fetchFn, calls } = scriptedFetch(
      async () => new Response(null, { status: 500 }),
      async () => chatCompletion(INVALID_CONTENT),
    );

    const result = await analyze(fetchFn);

    expect(result).toEqual(INVALID_OUTPUT);
    expect(calls).toHaveLength(2);
  });

  it("returns INVALID_PROVIDER_OUTPUT when Cerebras 2xx invalid and Groq times out", async () => {
    const { fetchFn, calls } = scriptedFetch(
      async () => chatCompletion(INVALID_CONTENT),
      (input, init) => hangingFetch()(input, init),
    );

    const result = await analyze(fetchFn, undefined, 5);

    expect(result).toEqual(INVALID_OUTPUT);
    expect(calls).toHaveLength(2);
  });

  it("returns PROVIDER_UNAVAILABLE when both providers fail by transport", async () => {
    const { fetchFn, calls } = scriptedFetch(
      async () => new Response(null, { status: 500 }),
      (input, init) => hangingFetch()(input, init),
    );

    const result = await analyze(fetchFn, undefined, 5);

    expect(result).toEqual(UNAVAILABLE);
    expect(calls).toHaveLength(2);
  });

  it("makes at most two fetch calls and never retries a provider", async () => {
    const { fetchFn, calls } = scriptedFetch(
      async () => {
        throw new Error("network");
      },
      async () => new Response(null, { status: 500 }),
      async () => chatCompletion(VALID_CONTENT),
    );

    const result = await analyze(fetchFn);

    expect(result).toEqual(UNAVAILABLE);
    expect(calls).toHaveLength(2);
  });

  it("does not inspect Retry-After and has no sleep between attempts", () => {
    const source = readFileSync(
      new URL(
        "../../src/modules/analysis/worker/provider.cerebras-groq.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source.toLowerCase()).not.toContain("retry-after");
    expect(source).not.toMatch(/\bsetTimeout\b/);
    expect(source).not.toMatch(/\bsleep\s*\(/);
  });
});
