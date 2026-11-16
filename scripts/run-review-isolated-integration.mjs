// Runs only the allowlisted S3-01/S3-02 review suites against a runner-owned project.
// The review model intentionally retains immutable history, so the whole generated
// local stack is the cleanup boundary for these real Auth/PostgREST/Storage fixtures.
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { redactCliOutput } from "./cli-output-redaction.mjs";
import {
  validateReviewIntegrationBatch,
} from "./review-integration-policy.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const supabaseCli = resolve(projectRoot, "node_modules/supabase/dist/supabase.js");
const portOffsets = Array.from({ length: 11 }, (_, index) => index);

function runCaptured(command, args, stage, cwd = projectRoot) {
  try {
    const result = execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return result.trim();
  } catch (error) {
    const captured = [error?.stdout, error?.stderr]
      .filter((part) => typeof part === "string" && part.length > 0)
      .join("\n");
    const detail = redactCliOutput(captured);
    throw new Error(detail ? `${stage} failed.\n${detail}` : `${stage} failed.`);
  }
}

function runCli(args, stage, cwd) {
  return runCaptured(process.execPath, [supabaseCli, ...args], stage, cwd);
}

function dockerList(args, stage) {
  try {
    return execFileSync("docker", args, {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }).trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    throw new Error(`${stage} failed.`);
  }
}

function projectContainers(projectId) {
  return dockerList(["ps", "-a", "--filter", `name=${projectId}`, "--format", "{{.Names}}"], "Docker container inventory")
    .filter((name) => name.endsWith(`_${projectId}`));
}

function projectVolumes(projectId) {
  return dockerList(["volume", "ls", "--filter", `name=${projectId}`, "--format", "{{.Name}}"], "Docker volume inventory")
    .filter((name) => name.endsWith(`_${projectId}`) || name === projectId);
}

function assertNoStack(projectId) {
  if (projectContainers(projectId).length || projectVolumes(projectId).length) {
    throw new Error("Refusing to reuse an existing disposable review project.");
  }
}

function ownedContainers(projectId, temporaryRoot) {
  const expectedRoot = resolve(temporaryRoot);
  return projectContainers(projectId).filter((name) => {
    let labels;
    try {
      labels = JSON.parse(runCaptured("docker", ["inspect", "--format", "{{json .Config.Labels}}", name], "Docker ownership check"));
    } catch {
      return false;
    }
    return labels?.["com.supabase.cli.project"] === projectId
      && typeof labels?.["com.supabase.cli.workdir"] === "string"
      && resolve(labels["com.supabase.cli.workdir"]) === expectedRoot;
  });
}

function availablePort(port) {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.once("error", () => resolvePort(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolvePort(true)));
  });
}

async function choosePortBase() {
  const first = 56000 + Math.floor(Math.random() * 3000);
  for (let offset = 0; offset < 200; offset += 1) {
    const base = first + offset * 10;
    if (base + 10 > 65535) break;
    let available = true;
    for (const portOffset of portOffsets) {
      if (!(await availablePort(base + portOffset))) {
        available = false;
        break;
      }
    }
    if (available) return base;
  }
  throw new Error("Could not reserve a free loopback port range for the review project.");
}

function copySupabaseTree(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if ([".temp", ".branches"].includes(entry.name) || /^\.env(?:\.|$)/i.test(entry.name)) continue;
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    const entryInfo = lstatSync(sourcePath);
    if (entryInfo.isSymbolicLink()) throw new Error("Supabase fixture copy encountered a symbolic link.");
    if (entryInfo.isDirectory()) copySupabaseTree(sourcePath, destinationPath);
    else if (entryInfo.isFile()) copyFileSync(sourcePath, destinationPath);
  }
}

function renderTemporaryConfig(sourcePath, destinationPath, projectId, portBase) {
  let config = readFileSync(sourcePath, "utf8");
  const idLine = /^[ \t]*project_id[ \t]*=[ \t]*"[^"]+"[ \t]*\r?$/m;
  if (!idLine.test(config)) throw new Error("Supabase config has no project ID to replace.");
  config = config.replace(idLine, `project_id = "${projectId}"`);
  config = config.replace(/^([ \t]*)(port|shadow_port)[ \t]*=[ \t]*(\d+)[ \t]*\r?$/gm, (line, indent, field, rawPort) => {
    const configuredPort = Number(rawPort);
    if (configuredPort < 54320 || configuredPort > 54329) return line;
    return `${indent}${field} = ${portBase + configuredPort - 54320}`;
  });
  const lines = config.split(/\r?\n/);
  const renderedLines = [];
  let inSeedSection = false;
  let inFunctionSection = false;
  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      inSeedSection = /^\s*\[db\.seed\]\s*$/.test(line);
      inFunctionSection = /^\s*\[functions\.[^\]]+\]\s*$/.test(line);
      renderedLines.push(line);
      if (inFunctionSection) renderedLines.push("enabled = false");
      continue;
    }
    if (inFunctionSection && /^\s*enabled\s*=/.test(line)) continue;
    if (inSeedSection && /^\s*enabled\s*=/.test(line)) {
      renderedLines.push("enabled = false");
      continue;
    }
    if (inSeedSection && /^\s*sql_paths\s*=/.test(line)) {
      renderedLines.push("sql_paths = []");
      continue;
    }
    renderedLines.push(line);
  }
  mkdirSync(dirname(destinationPath), { recursive: true });
  writeFileSync(destinationPath, renderedLines.join("\n"), "utf8");
}

function copyTemporaryProject(temporaryRoot, projectId, portBase) {
  const sourceSupabase = resolve(projectRoot, "supabase");
  const destinationSupabase = resolve(temporaryRoot, "supabase");
  copySupabaseTree(sourceSupabase, destinationSupabase);
  renderTemporaryConfig(
    resolve(sourceSupabase, "config.toml"),
    resolve(destinationSupabase, "config.toml"),
    projectId,
    portBase,
  );
}

function assertOwnedDatabase(projectId, temporaryRoot) {
  const expected = `supabase_db_${projectId}`;
  if (!ownedContainers(projectId, temporaryRoot).includes(expected)) {
    throw new Error("The disposable review database is not owned by this runner.");
  }
  const running = runCaptured("docker", ["inspect", "--format", "{{.State.Running}}", expected], "Review database health check");
  if (running !== "true") throw new Error("The disposable review database is not running.");
  return expected;
}

function statusFor(projectRootPath) {
  let status;
  try {
    status = JSON.parse(runCli(["status", "-o", "json", "--workdir", projectRootPath], "Review Supabase status"));
  } catch {
    throw new Error("Could not read local runtime details for the disposable review project.");
  }
  const publishableKey = status.PUBLISHABLE_KEY ?? status.ANON_KEY;
  if (!/^http:\/\/127\.0\.0\.1:\d{4,5}$/.test(status.API_URL ?? "")
      || typeof publishableKey !== "string" || !publishableKey
      || typeof status.SERVICE_ROLE_KEY !== "string" || !status.SERVICE_ROLE_KEY
      || typeof status.JWT_SECRET !== "string" || !status.JWT_SECRET) {
    throw new Error("Disposable review project runtime details were incomplete.");
  }
  return { ...status, PUBLISHABLE_KEY: publishableKey };
}

function stopAndRemove(projectId, temporaryRoot, failures) {
  if (!temporaryRoot) return true;
  try {
    const containers = projectContainers(projectId);
    if (containers.length) {
      const owned = ownedContainers(projectId, temporaryRoot);
      if (owned.length !== containers.length) throw new Error("A review project container is not owned by this run.");
      runCli(["stop", "--no-backup", "--workdir", temporaryRoot], "Disposable review project stop");
    }
    if (projectContainers(projectId).length || projectVolumes(projectId).length) {
      throw new Error("The disposable review project left containers or volumes behind.");
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : "Disposable review project cleanup failed.");
    return false;
  }

  const normalizedRoot = resolve(temporaryRoot);
  const normalizedTemp = resolve(tmpdir());
  const relativeRoot = relative(normalizedTemp, normalizedRoot);
  if (!relativeRoot || relativeRoot.startsWith(`..${sep}`) || relativeRoot === ".."
      || !relativeRoot.startsWith("kdm-s3-02-review-")) {
    failures.push("Refusing to remove a path outside the generated review temp workspace.");
    return false;
  }
  try {
    rmSync(normalizedRoot, { recursive: true, force: true });
    return true;
  } catch {
    failures.push("Disposable review project temp workspace cleanup failed.");
    return false;
  }
}

function runVitest(testArgs, env) {
  const vitest = resolve(projectRoot, "node_modules/vitest/vitest.mjs");
  const result = spawnSync(process.execPath, [vitest, "run", "--config", "vitest.integration.config.ts", ...testArgs], {
    cwd: projectRoot,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw new Error("Could not start the review integration suite.");
  return result.status ?? 1;
}

function runReviewE2E(testArgs, env) {
  const nextCli = resolve(projectRoot, "node_modules/next/dist/bin/next");
  const build = spawnSync(process.execPath, [nextCli, "build"], {
    cwd: projectRoot,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (build.error || build.status !== 0) throw new Error("Could not build the application for review E2E.");
  const playwright = resolve(projectRoot, "node_modules/@playwright/test/cli.js");
  const result = spawnSync(process.execPath, [playwright, "test", "--config", "playwright.config.ts", ...testArgs], {
    cwd: projectRoot,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw new Error("Could not start the review E2E suite.");
  return result.status ?? 1;
}

async function main(args) {
  const isE2E = args[0] === "--e2e";
  const selectedArgs = isE2E ? args.slice(1) : args;
  const e2eFile = "tests/e2e/human-review.spec.ts";
  const reviewFiles = isE2E
    ? selectedArgs.some((argument) => argument.replaceAll("\\", "/") === e2eFile) ? [e2eFile] : null
    : validateReviewIntegrationBatch(selectedArgs);
  const firstE2EFile = isE2E && selectedArgs.find((argument) => !argument.startsWith("-"));
  if (!reviewFiles || (isE2E && firstE2EFile?.replaceAll("\\", "/") !== e2eFile)) {
    throw new Error("The disposable review runner accepts reviewed integration suites or the S3-03 E2E spec.");
  }
  const testArgs = isE2E ? selectedArgs : reviewFiles;

  const temporaryRoot = mkdtempSync(join(tmpdir(), "kdm-s3-02-review-"));
  const projectId = `kdm-review-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const failures = [];
  let code = 1;
  try {
    assertNoStack(projectId);
    const portBase = await choosePortBase();
    copyTemporaryProject(temporaryRoot, projectId, portBase);
    console.log(`Starting isolated local Supabase for ${isE2E ? "S3-03 E2E" : `${reviewFiles.length} review integration test(s)`}.`);
    const excludedServices = [
      "studio", "edge-runtime", "logflare", "vector", "supavisor",
      "realtime", "analytics", "postgres-meta", "mailpit", "imgproxy",
    ];
    runCli(["start", "--exclude", excludedServices.join(","), "--workdir", temporaryRoot], "Disposable review project start");
    const database = assertOwnedDatabase(projectId, temporaryRoot);
    if (database !== `supabase_db_${projectId}`) throw new Error("Unexpected disposable review database container.");
    runCli(["db", "reset", "--local", "--workdir", temporaryRoot], "Disposable review migration setup");
    const runtime = statusFor(temporaryRoot);
    const expectedApiUrl = `http://127.0.0.1:${portBase + 1}`;
    if (runtime.API_URL !== expectedApiUrl) throw new Error("Disposable Supabase API did not use its reserved loopback port.");
    const env = {
      ...process.env,
      NEXT_PUBLIC_SUPABASE_URL: runtime.API_URL,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: runtime.PUBLISHABLE_KEY,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
      KDM_LOCAL_SUPABASE_URL: runtime.API_URL,
      KDM_LOCAL_SUPABASE_PROJECT_ID: projectId,
      KDM_LOCAL_SUPABASE_WORKDIR: temporaryRoot,
      KDM_LOCAL_SUPABASE_DISPOSABLE: "review",
      PLAYWRIGHT_TEST_BASE_URL: `http://127.0.0.1:${portBase + 10}`,
      KDM_MAILPIT_URL: runtime.MAILPIT_URL ?? runtime.INBUCKET_URL ?? "",
      SUPABASE_URL: "",
      SUPABASE_PUBLISHABLE_KEY: "",
      SUPABASE_ANON_KEY: "",
      SUPABASE_SERVICE_ROLE_KEY: runtime.SERVICE_ROLE_KEY,
      SENTRY_DSN: "",
      SENTRY_AUTH_TOKEN: "",
      SENTRY_DISABLE_AUTO_UPLOAD: "true",
      NEXT_PUBLIC_SENTRY_DSN: "",
      NEXT_PUBLIC_KDM_DISABLE_SENTRY: "1",
      KDM_DISABLE_SENTRY: "1",
      NEXT_PUBLIC_KDM_SENTRY_LOCAL_ENABLED: "0",
      KDM_SENTRY_DIAGNOSTICS_ENABLED: "0",
      KDM_SENTRY_DIAGNOSTICS_OPERATOR_IDS: "",
      KDM_SENTRY_DIAGNOSTICS_EXPIRES_AT: "",
    };
    delete env.INGESTION_INTERNAL_TOKEN;
    delete env.SUPABASE_SECRET_KEY;
    code = isE2E ? runReviewE2E(testArgs, env) : runVitest(reviewFiles, env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Disposable review integration failed.");
    code = 1;
  } finally {
    if (!stopAndRemove(projectId, temporaryRoot, failures)) {
      console.error(`Disposable review project cleanup failed; retained workdir: ${temporaryRoot}`);
    }
  }
  if (failures.length) {
    for (const failure of failures) console.error(failure);
    code = 1;
  }
  if (code === 0) console.log("PASS: review isolation integration used and removed its own local Supabase project.");
  return code;
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}).catch((error) => {
  console.error(error instanceof Error ? error.message : "Disposable review integration failed.");
  process.exitCode = 1;
});
