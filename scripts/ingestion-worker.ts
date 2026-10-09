import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { createServiceClient } from "../src/lib/supabase/service";
import { loadEmbeddingModel } from "../src/modules/ingestion/worker/model";
import { processJob } from "../src/modules/ingestion/worker/process-job";
import { initWorkerTelemetry, reportWorkerFailure, flushWorkerTelemetry } from "../src/modules/ingestion/worker/telemetry";

/** Standalone entry; service credentials never enter arguments, URLs, logs or artifacts. */
async function main() {
  initWorkerTelemetry();
  process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const port = Number(process.env.INGESTION_WORKER_PORT ?? "8788");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("INVALID_CONFIG");
  const service = createServiceClient();
  const shutdown = new AbortController();
  let modelReady = false;
  let lastDbSuccess = 0;
  const server = createServer((req, res) => {
    if (req.url !== "/health") { res.writeHead(404).end(); return; }
    const ready = modelReady && !shutdown.signal.aborted && Date.now() - lastDbSuccess < 60_000;
    res.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: ready ? "ready" : "unavailable" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, process.env.INGESTION_WORKER_HOST ?? "127.0.0.1", resolve);
  });
  const stop = () => shutdown.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const forceExitOnShutdown = () => setTimeout(() => process.exit(0), 10_000).unref();
  shutdown.signal.addEventListener("abort", forceExitOnShutdown, { once: true });
  let model: Awaited<ReturnType<typeof loadEmbeddingModel>> | undefined;
  try {
    model = await loadEmbeddingModel();
    modelReady = true;
    console.info(JSON.stringify({ event: "ingestion_worker_model_ready" }));
    while (!shutdown.signal.aborted) {
      try {
        const claim = await service.rpc("claim_ingestion_job").abortSignal(AbortSignal.timeout(5_000));
        if (claim.error) throw new Error("CLAIM_FAILED");
        lastDbSuccess = Date.now();
        const job = claim.data?.[0];
        if (!job) { await sleep(1_000, undefined, { signal: shutdown.signal }); continue; }
        const lease = new AbortController();
        const signal = AbortSignal.any([shutdown.signal, lease.signal, AbortSignal.timeout(15 * 60_000)]);
        let heartbeatBusy = false;
        const heartbeat = setInterval(async () => {
          if (heartbeatBusy || signal.aborted) return;
          heartbeatBusy = true;
          try {
            const result = await service.rpc("heartbeat_ingestion_job", {
              p_version_id: job.version_id, p_operation_id: job.operation_id,
            }).abortSignal(AbortSignal.timeout(5_000));
            if (result.error || !result.data) lease.abort();
            else lastDbSuccess = Date.now();
          } catch { lease.abort(); }
          finally { heartbeatBusy = false; }
        }, 30_000);
        try {
          const outcome = await processJob(job, service, model.infer, signal);
          if(outcome==="queued" || outcome==="failed" || outcome==="uncertain") reportWorkerFailure(job.version_id,outcome==="uncertain");
          console.info(JSON.stringify({ event: "ingestion_job_finished", versionId: job.version_id, outcome }));
        } finally { clearInterval(heartbeat); }
      } catch {
        if (!shutdown.signal.aborted) {
          console.error(JSON.stringify({ event: "ingestion_worker_poll_failed" }));
          reportWorkerFailure(undefined,true);
          await sleep(5_000, undefined, { signal: shutdown.signal }).catch(() => undefined);
        }
      }
    }
  } finally {
    modelReady = false;
    server.close();
    await model?.dispose();
    await flushWorkerTelemetry();
  }
}

main().catch(() => {
  console.error(JSON.stringify({ event: "ingestion_worker_start_failed" }));
  process.exit(1);
});
