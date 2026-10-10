import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const apiUrl = "http://127.0.0.1:54321";
const deadline = Date.now() + 3 * 60_000;
let status;
try {
  status = JSON.parse(execFileSync(process.execPath, [
    resolve("node_modules/supabase/dist/supabase.js"), "status", "-o", "json",
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }));
} catch {
  console.log(JSON.stringify({ warmupCalls: 0, sampleCalls: 0, durationMs: 0, maxInFlight: 0, category: "local_status_unavailable" }));
  process.exitCode = 1;
}

if (process.exitCode !== 1 && (status.API_URL !== apiUrl || !status.SERVICE_ROLE_KEY)) {
  console.log(JSON.stringify({ warmupCalls: 0, sampleCalls: 0, durationMs: 0, maxInFlight: 0, category: "wrong_local_project" }));
  process.exitCode = 1;
}

if (process.exitCode !== 1) {
  const headers = {
    apikey: status.SERVICE_ROLE_KEY,
    Authorization: `Bearer ${status.SERVICE_ROLE_KEY}`,
    "content-type": "application/json",
  };
  const url = `${apiUrl}/functions/v1/embed`;
  const makeText = (index) => `${"Synthetic local runbook procedure with safe operational wording. ".repeat(40)} Sample ${index}`.slice(0, 1800);
  const sampleTexts = Array.from({ length: 8 }, (_, index) => makeText(index));
  let warmupCalls = 0;
  let sampleCalls = 0;
  let sampleSuccesses = 0;
  let live = 0;
  let peak = 0;
  const startedAt = Date.now();

  class WarmupFailure extends Error {
    constructor(category) {
      super(category);
      this.category = category;
    }
  }

  async function request(text, signal) {
    return fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ inputs: [text] }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
        : AbortSignal.timeout(60_000),
    });
  }

  async function readAndValidate(response) {
    if (!response.ok) {
      throw new WarmupFailure(response.status === 546 ? "WORKER_LIMIT" : `http_${response.status}`);
    }
    let body;
    try {
      body = await response.json();
    } catch {
      throw new WarmupFailure("invalid_response");
    }
    const vector = body?.embeddings?.[0];
    if (
      body?.dims !== 384 || !Array.isArray(body.embeddings) || body.embeddings.length !== 1
      || !Array.isArray(vector) || vector.length !== 384
      || !vector.every((value) => typeof value === "number" && Number.isFinite(value))
    ) {
      throw new WarmupFailure("invalid_response");
    }
  }

  async function waitUntilReady() {
    let lastCategory = "runtime_not_ready";
    while (Date.now() < deadline) {
      warmupCalls += 1;
      try {
        const response = await request(makeText(-1));
        await readAndValidate(response);
        return;
      } catch (error) {
        if (error instanceof WarmupFailure) {
          if (error.category === "WORKER_LIMIT") throw error;
          lastCategory = error.category;
        } else if (error instanceof DOMException && error.name === "TimeoutError") {
          lastCategory = "timeout";
        }
      }
      await new Promise((resolveTimer) => setTimeout(resolveTimer, 1500));
    }
    throw new WarmupFailure(lastCategory);
  }

  const sampleController = new AbortController();
  let nextIndex = 0;
  async function runSampleWorker() {
    while (true) {
      if (sampleController.signal.aborted) return;
      const index = nextIndex;
      if (index >= sampleTexts.length) return;
      nextIndex += 1;
      sampleCalls = nextIndex;
      live += 1;
      peak = Math.max(peak, live);
      try {
        const response = await request(sampleTexts[index], sampleController.signal);
        await readAndValidate(response);
        sampleSuccesses += 1;
      } catch (error) {
        sampleController.abort();
        throw error;
      } finally {
        live -= 1;
      }
    }
  }

  let category = "success";
  try {
    await waitUntilReady();
    const workers = [runSampleWorker(), runSampleWorker()];
    try {
      await Promise.all(workers);
    } catch (error) {
      sampleController.abort();
      await Promise.allSettled(workers);
      throw error;
    }
    if (peak > 2 || sampleSuccesses !== sampleTexts.length) {
      category = "incomplete_run";
      process.exitCode = 1;
    }
  } catch (error) {
    category = error instanceof WarmupFailure
      ? error.category
      : error instanceof DOMException && error.name === "TimeoutError"
        ? "timeout"
        : "provider_error";
    process.exitCode = 1;
  }

  console.log(JSON.stringify({
    warmupCalls,
    sampleCalls,
    durationMs: Date.now() - startedAt,
    maxInFlight: peak,
    category,
  }));
}
