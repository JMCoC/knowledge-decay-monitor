import { pathToFileURL } from "node:url";
import {
  createMaintenanceClient,
  parseMaintenanceArgs,
  resolveMaintenanceRuntime,
  runLegacyReconciliation,
} from "./upload-maintenance.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseReconciliationArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!["--target", "--mode", "--project-ref", "--actor-user-id"].includes(flag) || values.has(flag)) {
      throw new Error("Invalid reconciliation arguments.");
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error("A reconciliation argument is missing its value.");
    values.set(flag, value);
    index += 1;
  }

  const { target, mode, projectRef } = parseMaintenanceArgs([
    "--target", values.get("--target") ?? "",
    "--mode", values.get("--mode") ?? "",
    ...(values.has("--project-ref") ? ["--project-ref", values.get("--project-ref")] : []),
  ]);
  const actorUserId = values.get("--actor-user-id");
  if (!actorUserId || !UUID.test(actorUserId)) throw new Error("An explicit operator identity is required.");
  return { target, mode, projectRef, actorUserId };
}

export async function runReconciliationCommand(args, dependencies = {}) {
  const options = parseReconciliationArgs(args);
  const runtime = (dependencies.resolveRuntime ?? resolveMaintenanceRuntime)(options, dependencies);
  const client = (dependencies.createClient ?? createMaintenanceClient)(runtime);
  const counts = await (dependencies.run ?? runLegacyReconciliation)(
    client,
    runtime,
    options.mode,
    options.actorUserId,
    dependencies.inspectOriginal,
  );
  return { ...counts, mode: options.mode, target: options.target };
}

async function main() {
  try {
    const result = await runReconciliationCommand(process.argv.slice(2));
    console.log(JSON.stringify(result));
    if (result.failed > 0) process.exitCode = 1;
  } catch {
    console.error("Reconciliation stopped. Credentials, paths, hashes, and provider payloads were not written.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
