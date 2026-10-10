import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { createInterface } from "node:readline";

export async function createTestWorker() {
  if (process.env.KDM_LOCAL_SUPABASE_URL !== "http://127.0.0.1:54321") throw new Error("Local worker only.");
  const listener = createServer();
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0,"127.0.0.1",resolve); });
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Local port unavailable.");
  const port = address.port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  let child: ChildProcess | undefined;
  const stop = async (abrupt = false) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child!.once("exit",() => resolve()));
    child.kill(abrupt ? "SIGKILL" : "SIGTERM");
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    child = undefined;
  };
  const start = async () => {
    if (child && child.exitCode === null && child.signalCode === null) return;
    let modelReady = false;
    child = spawn(process.execPath,["--conditions=react-server","--import","tsx",resolve("scripts/ingestion-worker.ts")],{
      cwd:process.cwd(),env:{...process.env,SUPABASE_URL:"http://127.0.0.1:54321",INGESTION_WORKER_PORT:String(port)},
      stdio:["ignore","pipe","pipe"],windowsHide:true,
    });
    // Retain one controlled readiness bit, never child logs or provider messages.
    createInterface({input:child.stdout!}).on("line", line => {
      if (line === '{"event":"ingestion_worker_model_ready"}') modelReady = true;
    });
    child.stderr!.resume();
    const deadline = Date.now()+60_000;
    while (Date.now()<deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Local worker exited (modelReady=${modelReady}).`);
      try {
        const response=await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(1_000)});
        if (response.ok) return;
      } catch { /* Wait for model and DB readiness. */ }
      await new Promise((resolve) => setTimeout(resolve,200));
    }
    await stop();
    throw new Error(`Local worker readiness timed out (modelReady=${modelReady}).`);
  };
  return { start, stop };
}
