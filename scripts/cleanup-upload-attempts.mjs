import { pathToFileURL } from "node:url";
import {
  createMaintenanceClient,
  parseMaintenanceArgs,
  resolveMaintenanceRuntime,
  runAttemptCleanup,
} from "./upload-maintenance.mjs";

export async function runCleanupCommand(args, dependencies = {}) {
  const options = parseMaintenanceArgs(args);
  const runtime = resolveMaintenanceRuntime(options, dependencies);
  const client = (dependencies.createClient ?? createMaintenanceClient)(runtime);
  const result = await runAttemptCleanup(client, runtime, options.mode);
  return { ...result, mode: options.mode, target: options.target };
}

async function main() {
  try {
    const result = await runCleanupCommand(process.argv.slice(2));
    console.log(JSON.stringify(result));
    if (result.failed > 0) process.exitCode = 1;
  } catch {
    console.error("Cleanup stopped. No credentials, paths, or provider payloads were written.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
