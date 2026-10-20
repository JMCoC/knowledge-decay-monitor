import type {
  AIProvider,
  AIProviderResult,
  AnalysisCandidatePair,
  AnalysisConfiguration,
} from "../../../types/analysis-internal.ts";
import {
  CEREBRAS_PROVIDER,
  GROQ_PROVIDER,
  PROVIDER_TIMEOUT_MS,
} from "../provider-config.ts";
import {
  ANALYSIS_PROMPT_V1,
  ANALYSIS_PROMPT_VERSION,
  OUTPUT_SCHEMA_VERSION,
  buildAnalysisPromptV1,
} from "../prompts/v1.ts";
import { WIRE_JSON_SCHEMA, wireSchema } from "../prompts/v1-schema.ts";

const BODY_LIMIT_BYTES = 262_144;
const VERSION_NONE = "none";

export type ProviderFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export interface ProviderEnvironment {
  CEREBRAS_API_KEY?: string;
  GROQ_API_KEY?: string;
  CEREBRAS_BASE_URL?: string;
  GROQ_BASE_URL?: string;
  NODE_ENV?: string;
}

export interface CerebrasGroqProviderOptions {
  fetchFn: ProviderFetch;
  timeoutMs?: number;
  env?: ProviderEnvironment;
}

const INVALID_OUTPUT: AIProviderResult = {
  ok: false,
  error: { code: "INVALID_PROVIDER_OUTPUT" },
};

const INTERNAL_ERROR: AIProviderResult = {
  ok: false,
  error: { code: "INTERNAL_ERROR" },
};

const UNAVAILABLE: AIProviderResult = {
  ok: false,
  error: { code: "PROVIDER_UNAVAILABLE" },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateConfig(configuration: AnalysisConfiguration): void {
  const providers = configuration.providers;
  if (providers.primary.provider !== CEREBRAS_PROVIDER) {
    throw new Error("primary provider must be cerebras");
  }
  if (providers.fallback.provider !== GROQ_PROVIDER) {
    throw new Error("fallback provider must be groq");
  }
  if (!providers.primary.model || !providers.fallback.model) {
    throw new Error("provider models must be non-empty");
  }
  if (
    configuration.promptVersion !== VERSION_NONE &&
    configuration.promptVersion !== ANALYSIS_PROMPT_VERSION
  ) {
    throw new Error("unsupported promptVersion");
  }
  if (
    configuration.outputSchemaVersion !== VERSION_NONE &&
    configuration.outputSchemaVersion !== OUTPUT_SCHEMA_VERSION
  ) {
    throw new Error("unsupported outputSchemaVersion");
  }
}

function validateEnv(env: ProviderEnvironment): void {
  const requiredSecrets = ["CEREBRAS_API_KEY", "GROQ_API_KEY"] as const;
  for (const name of requiredSecrets) {
    if (!env[name]) {
      throw new Error(`missing ${name}`);
    }
  }
  const requiredUrls = ["CEREBRAS_BASE_URL", "GROQ_BASE_URL"] as const;
  for (const name of requiredUrls) {
    if (!env[name]) {
      throw new Error(`missing ${name}`);
    }
  }
  const isTest = env.NODE_ENV === "test";
  for (const name of requiredUrls) {
    const value = env[name] as string;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${name} must be a valid URL`);
    }
    if (!isTest && url.protocol !== "https:") {
      throw new Error(`${name} must be https`);
    }
  }
}

function abortToError(
  callerSignal: AbortSignal | undefined,
): AIProviderResult {
  return callerSignal?.aborted ? INTERNAL_ERROR : UNAVAILABLE;
}

type BodyReadResult =
  | { ok: true; text: string }
  | { ok: false; kind: "too_large" | "invalid" | "read_error" };

async function readBoundedBody(response: Response): Promise<BodyReadResult> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > BODY_LIMIT_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, kind: "too_large" };
    }
  }

  const reader = response.body?.getReader();
  if (!reader) {
    return { ok: false, kind: "invalid" };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        total += value.length;
        if (total > BODY_LIMIT_BYTES) {
          await reader.cancel().catch(() => undefined);
          return { ok: false, kind: "too_large" };
        }
        chunks.push(value);
      }
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return { ok: false, kind: "read_error" };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { ok: true, text: new TextDecoder().decode(bytes) };
}

function extractContent(payload: unknown): string | null {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    return null;
  }
  const choice = payload.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) {
    return null;
  }
  const content = choice.message.content;
  return typeof content === "string" ? content : null;
}

async function callCerebras(
  fetchFn: ProviderFetch,
  env: ProviderEnvironment,
  timeoutMs: number,
  pair: AnalysisCandidatePair,
  configuration: AnalysisConfiguration,
  callerSignal: AbortSignal | undefined,
): Promise<AIProviderResult> {
  if (callerSignal?.aborted) {
    return INTERNAL_ERROR;
  }

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = callerSignal
    ? AbortSignal.any([callerSignal, timeoutSignal])
    : timeoutSignal;

  const baseUrl = (env.CEREBRAS_BASE_URL ?? "").replace(/\/$/, "");
  const requestBody = JSON.stringify({
    model: configuration.providers.primary.model,
    messages: [
      { role: "system", content: ANALYSIS_PROMPT_V1 },
      {
        role: "user",
        content: buildAnalysisPromptV1(pair),
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "analysis_findings",
        strict: true,
        schema: WIRE_JSON_SCHEMA,
      },
    },
  });

  let response: Response;
  try {
    response = await fetchFn(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.CEREBRAS_API_KEY ?? ""}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: requestBody,
      signal: combinedSignal,
      redirect: "error",
    });
  } catch {
    return abortToError(callerSignal);
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return abortToError(callerSignal);
  }

  const body = await readBoundedBody(response);
  if (!body.ok) {
    if (body.kind === "too_large" || body.kind === "invalid") {
      return INVALID_OUTPUT;
    }
    return abortToError(callerSignal);
  }

  let outer: unknown;
  try {
    outer = JSON.parse(body.text);
  } catch {
    return INVALID_OUTPUT;
  }

  const content = extractContent(outer);
  if (content === null) {
    return INVALID_OUTPUT;
  }

  let inner: unknown;
  try {
    inner = JSON.parse(content);
  } catch {
    return INVALID_OUTPUT;
  }

  const validated = wireSchema.safeParse(inner);
  if (!validated.success) {
    return INVALID_OUTPUT;
  }

  if (validated.data.findings.length === 0) {
    return { ok: true, findings: [] };
  }

  // TODO(Task 3): map non-empty wire findings to InternalFinding.
  return INVALID_OUTPUT;
}

export function createCerebrasGroqProvider(
  options: CerebrasGroqProviderOptions,
): AIProvider {
  const env = options.env ?? {};
  const timeoutMs = options.timeoutMs ?? PROVIDER_TIMEOUT_MS;
  validateEnv(env);

  return {
    async analyzePair({ pair, configuration, signal }) {
      try {
        validateConfig(configuration);
      } catch {
        return INTERNAL_ERROR;
      }
      return callCerebras(
        options.fetchFn,
        env,
        timeoutMs,
        pair,
        configuration,
        signal,
      );
    },
  };
}
