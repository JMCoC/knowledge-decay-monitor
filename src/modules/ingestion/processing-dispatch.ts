import "server-only";

import { getAppOrigin } from "@/lib/app-origin";

export class ProcessingDispatchError extends Error {
  constructor() {
    super("Processing dispatch failed.");
    this.name = "ProcessingDispatchError";
  }
}

export type ProcessingDispatchConfig = {
  origin: string;
  token: string;
};

export type ProcessingDispatchInput =
  | { versionId: string; operation: "process" }
  | { versionId: string; operation: "retry"; operationId: string };

/** Resolves only trusted server configuration; failures never include its values. */
export function resolveProcessingDispatchConfig(): ProcessingDispatchConfig {
  const token = process.env.INGESTION_INTERNAL_TOKEN;
  if (!token || token !== token.trim()) throw new ProcessingDispatchError();

  try {
    const origin = getAppOrigin();
    if (!origin) throw new Error();
    return { origin, token };
  } catch {
    throw new ProcessingDispatchError();
  }
}

/** Makes the single bounded internal HTTP dispatch used by finalize and retry. */
export async function dispatchProcessing(
  input: ProcessingDispatchInput,
  config: ProcessingDispatchConfig = resolveProcessingDispatchConfig(),
): Promise<void> {
  const body = input.operation === "retry"
    ? { versionId: input.versionId, operationId: input.operationId, operation: "retry" }
    : { versionId: input.versionId };

  let response: Response;
  try {
    response = await fetch(`${config.origin}/api/ingestion/process`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-token": config.token,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new ProcessingDispatchError();
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProcessingDispatchError();
  }
  await response.body?.cancel().catch(() => undefined);
}
