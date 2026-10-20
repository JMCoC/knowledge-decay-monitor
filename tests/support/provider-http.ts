import type { ProviderFetch } from "../../src/modules/analysis/worker/provider.cerebras-groq";

export function jsonResponse(body: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function streamResponse(
  chunks: Uint8Array[],
  init?: ResponseInit,
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
  return new Response(stream, init);
}

type FetchStep = Response | Error | (() => Promise<Response>);

export interface FetchCall {
  input: string;
  init: RequestInit;
}

export function fetchQueue(...steps: FetchStep[]): {
  fetchFn: ProviderFetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let index = 0;
  const fetchFn: ProviderFetch = async (input, init) => {
    calls.push({ input, init });
    const step = steps[index];
    index += 1;
    if (step === undefined) {
      throw new Error("fetchQueue exhausted");
    }
    if (step instanceof Error) {
      throw step;
    }
    if (typeof step === "function") {
      return step();
    }
    return step;
  };
  return { fetchFn, calls };
}

export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolveFn, rejectFn) => {
    resolve = resolveFn;
    reject = rejectFn;
  });
  return { promise, resolve, reject };
}

export function hangingFetch(): ProviderFetch {
  return (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init.signal;
      const fail = () => {
        reject(new DOMException("Aborted", "AbortError"));
      };
      if (signal?.aborted) {
        fail();
        return;
      }
      signal?.addEventListener("abort", fail, { once: true });
    });
}
