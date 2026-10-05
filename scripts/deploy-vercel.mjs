import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { chooseDeployment } from "./deployment-policy.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const REPOSITORY = "JMCoC/knowledge-decay-monitor";
const VERCEL_SCOPE = "kdm17";
const VERCEL_CLI = "vercel@62.2.0";
const PREVIEW_DOMAIN = "kdm17.vercel.app";
const CHILD_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * @typedef {(command: string, args: string[], options: import("node:child_process").SpawnSyncOptionsWithStringEncoding) => {
 *   status: number | null;
 *   error?: Error;
 *   stdout: string | Buffer | null;
 * }} SpawnCommand
 */

const PLATFORM_ENV_KEYS = [
  "PATH",
  "HOME",
  "CI",
  "GITHUB_ACTIONS",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "USERPROFILE",
  "TMP",
  "TEMP",
  "TMPDIR",
  "RUNNER_TEMP",
  "NODE_OPTIONS",
  "NODE_ENV",
  "LANG",
  "TERM",
  "COREPACK_HOME",
  "PNPM_HOME",
];

function copyDefined(source, keys) {
  const result = {};
  for (const key of keys) {
    if (typeof source[key] === "string") result[key] = source[key];
  }
  return result;
}

function platformEnvironment(source) {
  return copyDefined(source, PLATFORM_ENV_KEYS);
}

function ghEnvironment(source) {
  return {
    ...platformEnvironment(source),
    GH_TOKEN: source.GH_TOKEN,
  };
}

function vercelEnvironment(source, { build = false, sha, sentryTarget, appOrigin } = {}) {
  const result = {
    ...platformEnvironment(source),
    VERCEL_TOKEN: source.VERCEL_TOKEN,
    VERCEL_ORG_ID: source.VERCEL_ORG_ID,
    VERCEL_PROJECT_ID: source.VERCEL_PROJECT_ID,
    VERCEL_TELEMETRY_DISABLED: "1",
  };

  if (build) {
    Object.assign(result, {
      APP_ORIGIN: appOrigin,
      NEXT_PUBLIC_KDM_DISABLE_SENTRY: "0",
      KDM_DISABLE_SENTRY: "0",
      NEXT_PUBLIC_KDM_SENTRY_LOCAL_ENABLED: "0",
      NEXT_PUBLIC_KDM_SENTRY_TARGET: sentryTarget,
      NEXT_PUBLIC_KDM_RELEASE: sha,
      SENTRY_RELEASE: sha,
      SENTRY_AUTH_TOKEN: source.SENTRY_AUTH_TOKEN,
    });
  }

  return result;
}

function runProcess(spawnCommand, command, args, options, stage) {
  let result;
  try {
    result = spawnCommand(command, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
      timeout: options.timeout ?? CHILD_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    throw new Error(`${stage} failed.`);
  }

  if (result?.error || result?.status !== 0) throw new Error(`${stage} failed.`);
  return typeof result.stdout === "string" ? result.stdout.trim() : "";
}

function parseJson(text, stage) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${stage} returned invalid structured output.`);
  }
}

function isValidLogin(value) {
  return typeof value === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value);
}

function validPermission(value) {
  return value === "write" || value === "maintain" || value === "admin";
}

function readAuthorizedActors(env, spawnCommand, cwd) {
  if (typeof env.GH_TOKEN !== "string" || !env.GH_TOKEN) {
    throw new Error("GitHub authorization is unavailable.");
  }

  const actors = [...new Set([env.GITHUB_ACTOR, env.GITHUB_TRIGGERING_ACTOR])];
  if (actors.some((actor) => !isValidLogin(actor))) {
    throw new Error("GitHub actor is invalid.");
  }

  for (const actor of actors) {
    const output = runProcess(
      spawnCommand,
      "gh",
      ["api", `repos/${REPOSITORY}/collaborators/${actor}/permission`, "--jq", ".permission"],
      { cwd, env: ghEnvironment(env), timeout: 30_000 },
      "GitHub permission check",
    );
    if (!validPermission(output)) throw new Error("GitHub actor is not authorized to deploy.");
  }
}

function readCurrentEvent(env, spawnCommand, cwd) {
  const eventName = env.GITHUB_EVENT_NAME;
  const ref = env.GITHUB_REF;
  const repository = env.GITHUB_REPOSITORY;
  if (repository !== REPOSITORY || !ref || !eventName) {
    throw new Error("GitHub deployment context is invalid.");
  }

  if (eventName === "pull_request") {
    const prNumber = Number(env.PR_NUMBER);
    if (!Number.isSafeInteger(prNumber) || prNumber <= 0 || String(prNumber) !== env.PR_NUMBER) {
      throw new Error("GitHub pull request number is invalid.");
    }
    const output = runProcess(
      spawnCommand,
      "gh",
      [
        "api",
        `repos/${REPOSITORY}/pulls/${prNumber}`,
        "--jq",
        "{state, draft, headSha: .head.sha, headRepository: .head.repo.full_name}",
      ],
      { cwd, env: ghEnvironment(env), timeout: 30_000 },
      "GitHub pull request check",
    );
    const pullRequest = parseJson(output, "GitHub pull request check");
    return {
      eventName,
      ref,
      repository,
      prNumber,
      prState: pullRequest?.state,
      draft: pullRequest?.draft,
      headSha: pullRequest?.headSha,
      headRepository: pullRequest?.headRepository,
    };
  }

  if (eventName === "push") {
    const output = runProcess(
      spawnCommand,
      "gh",
      ["api", `repos/${REPOSITORY}/branches/main`, "--jq", "{headSha: .commit.sha}"],
      { cwd, env: ghEnvironment(env), timeout: 30_000 },
      "GitHub main branch check",
    );
    const branch = parseJson(output, "GitHub main branch check");
    return {
      eventName,
      ref,
      repository,
      headSha: branch?.headSha,
    };
  }

  return { eventName, ref, repository };
}

function currentDeploymentDecision(target, env, spawnCommand, cwd) {
  readAuthorizedActors(env, spawnCommand, cwd);
  const current = readCurrentEvent(env, spawnCommand, cwd);
  const decision = chooseDeployment({
    ...current,
    qualityResult: env.QUALITY_RESULT,
    testedSha: env.TESTED_SHA,
    authorizedActor: true,
  });
  if (!decision || decision.target !== target) {
    throw new Error("Current GitHub revision is not eligible for this deployment.");
  }
  return decision;
}

function parseHttpsOrigin(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      !hostname.includes(".") ||
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "::1" ||
      /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) ||
      url.username ||
      url.password ||
      url.port ||
      (url.pathname !== "/" && url.pathname !== "") ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function deploymentOrigin(decision, env) {
  if (decision.target === "preview") {
    const alias = `kdm-pr-${decision.prNumber}-${PREVIEW_DOMAIN}`;
    return { appOrigin: `https://${alias}`, alias };
  }
  const appOrigin = parseHttpsOrigin(env.APP_ORIGIN);
  if (!appOrigin) throw new Error("Production APP_ORIGIN is invalid.");
  return { appOrigin };
}

function validVercelConfiguration(env) {
  return (
    typeof env.VERCEL_TOKEN === "string" &&
    env.VERCEL_TOKEN.length > 0 &&
    typeof env.VERCEL_ORG_ID === "string" &&
    /^team_[A-Za-z0-9]+$/.test(env.VERCEL_ORG_ID) &&
    typeof env.VERCEL_PROJECT_ID === "string" &&
    /^prj_[A-Za-z0-9]+$/.test(env.VERCEL_PROJECT_ID) &&
    typeof env.SENTRY_AUTH_TOKEN === "string" &&
    env.SENTRY_AUTH_TOKEN.length > 0
  );
}

function normalizedVercelUrl(value) {
  if (typeof value !== "string" || !value || /[\s?#]/.test(value)) return null;
  try {
    const url = new URL(value.startsWith("https://") ? value : `https://${value}`);
    if (
      url.protocol !== "https:" ||
      !url.hostname.toLowerCase().endsWith(".vercel.app") ||
      url.username ||
      url.password ||
      url.port ||
      (url.pathname !== "/" && url.pathname !== "") ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function parseCreatedDeployment(output) {
  const result = parseJson(output, "Vercel deploy");
  const deployment = result?.deployment ?? result;
  const id = deployment?.id ?? deployment?.deploymentId;
  const url = normalizedVercelUrl(deployment?.url);
  if (typeof id !== "string" || !/^dpl_[A-Za-z0-9]+$/.test(id) || !url) {
    throw new Error("Vercel deploy returned an invalid deployment reference.");
  }
  return { id, url };
}

function inspectReadyDeployment(output, created, decision, env) {
  const result = parseJson(output, "Vercel inspect");
  const deployment = result?.deployment ?? result;
  const inspectionUrl = normalizedVercelUrl(deployment?.url);
  const metadata = deployment?.meta;

  if (
    deployment?.id !== created.id ||
    deployment?.projectId !== env.VERCEL_PROJECT_ID ||
    inspectionUrl !== created.url ||
    deployment?.readyState !== "READY" ||
    metadata?.githubCommitSha !== decision.sha ||
    metadata?.kdmTestedSha !== decision.sha ||
    metadata?.kdmRepository !== REPOSITORY ||
    metadata?.kdmTarget !== decision.target
  ) {
    throw new Error("Vercel deployment did not match the tested project, SHA, target, and READY state.");
  }
}

function vercelCommand(spawnCommand, operation, args, env, stage, buildOptions) {
  const executable = "pnpm";
  const childEnv = vercelEnvironment(env, buildOptions);
  return runProcess(
    spawnCommand,
    executable,
    ["dlx", VERCEL_CLI, operation, ...args],
    { cwd: PROJECT_ROOT, env: childEnv },
    stage,
  );
}

/**
 * @param {"preview" | "production"} target
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {SpawnCommand} [options.spawnCommand]
 * @param {(message: string) => void} [options.log]
 * @param {boolean} [options.preflightOnly]
 * @param {string} [options.projectRoot]
 * @returns {number}
 */
export function runDeployment(
  target,
  {
    env = process.env,
    spawnCommand = spawnSync,
    log = console.log,
    preflightOnly = false,
    projectRoot = PROJECT_ROOT,
  } = {},
) {
  let stage = "GitHub preflight";
  try {
    if (
      (target !== "preview" && target !== "production") ||
      env.GITHUB_ACTIONS !== "true" ||
      env.KDM_DEPLOY_ENVIRONMENT !== (target === "preview" ? "Preview" : "Production") ||
      env.QUALITY_RESULT !== "success" ||
      typeof env.TESTED_SHA !== "string" ||
      !/^[0-9a-f]{40}$/i.test(env.TESTED_SHA)
    ) {
      throw new Error("Deployment inputs are invalid.");
    }

    const gitSha = runProcess(
      spawnCommand,
      "git",
      ["rev-parse", "HEAD"],
      { cwd: projectRoot, env: platformEnvironment(env), timeout: 30_000 },
      "Checked-out SHA verification",
    );
    if (gitSha.toLowerCase() !== env.TESTED_SHA.toLowerCase()) {
      throw new Error("The checkout does not match the tested SHA.");
    }

    const decision = currentDeploymentDecision(target, env, spawnCommand, projectRoot);
    const { appOrigin, alias } = deploymentOrigin(decision, env);
    if (preflightOnly) {
      log(`Deployment preflight passed for ${target} at ${decision.sha}.`);
      return 0;
    }

    if (!validVercelConfiguration(env)) throw new Error("Deployment credentials or project settings are incomplete.");

    stage = "Vercel pull";
    vercelCommand(
      spawnCommand,
      "pull",
      [
        "--yes",
        `--environment=${target}`,
        "--scope",
        VERCEL_SCOPE,
        "--project",
        env.VERCEL_PROJECT_ID,
      ],
      env,
      stage,
    );

    stage = "Vercel build";
    const buildOptions = {
      build: true,
      sha: decision.sha,
      sentryTarget: target,
      appOrigin,
    };
    vercelCommand(
      spawnCommand,
      "build",
      [
        "--yes",
        "--scope",
        VERCEL_SCOPE,
        "--project",
        env.VERCEL_PROJECT_ID,
        ...(target === "production" ? ["--prod"] : ["--target=preview"]),
      ],
      env,
      stage,
      buildOptions,
    );

    stage = "GitHub pre-deployment revision check";
    const beforeDeploy = currentDeploymentDecision(target, env, spawnCommand, projectRoot);
    if (beforeDeploy.sha !== decision.sha || beforeDeploy.prNumber !== decision.prNumber) {
      throw new Error("The source revision changed during the build.");
    }

    stage = "Vercel deploy";
    const deployArgs = [
      "--prebuilt",
      "--no-wait",
      "--skip-domain",
      "--yes",
      "--json",
      "--scope",
      VERCEL_SCOPE,
      "--project",
      env.VERCEL_PROJECT_ID,
      "--env",
      `APP_ORIGIN=${appOrigin}`,
      "--env",
      "KDM_DISABLE_SENTRY=0",
      ...(target === "production" ? ["--prod"] : ["--target=preview"]),
      "--meta",
      `githubCommitSha=${decision.sha}`,
      "--meta",
      `kdmTestedSha=${decision.sha}`,
      "--meta",
      `kdmRepository=${REPOSITORY}`,
      "--meta",
      `kdmTarget=${target}`,
    ];
    const created = parseCreatedDeployment(
      vercelCommand(spawnCommand, "deploy", deployArgs, env, stage),
    );

    stage = "Vercel READY and source verification";
    const inspection = vercelCommand(
      spawnCommand,
      "inspect",
      [created.url, "--json", "--wait", "--timeout", "15m", "--scope", VERCEL_SCOPE],
      env,
      stage,
    );
    inspectReadyDeployment(inspection, created, decision, env);

    stage = "GitHub pre-publication revision check";
    const beforePublish = currentDeploymentDecision(target, env, spawnCommand, projectRoot);
    if (beforePublish.sha !== decision.sha || beforePublish.prNumber !== decision.prNumber) {
      throw new Error("The source revision changed before publication.");
    }

    if (target === "preview") {
      stage = "Vercel Preview alias";
      vercelCommand(
        spawnCommand,
        "alias",
        ["set", created.url, alias, "--scope", VERCEL_SCOPE],
        env,
        stage,
      );
      log(`Preview ready: ${created.id} ${created.url} ${decision.sha}`);
    } else {
      stage = "Vercel Production promotion";
      vercelCommand(
        spawnCommand,
        "promote",
        [created.url, "--yes", "--scope", VERCEL_SCOPE],
        env,
        stage,
      );
      log(`Production promoted: ${created.id} ${created.url} ${decision.sha}`);
    }

    return 0;
  } catch {
    log(preflightOnly ? "Deployment preflight denied." : `Deployment stopped safely during ${stage}.`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [target, mode, ...extra] = process.argv.slice(2);
  const preflightOnly = mode === "--preflight" && extra.length === 0;
  if (
    (target !== "preview" && target !== "production") ||
    extra.length > 0 ||
    (mode && !preflightOnly)
  ) {
    console.error("Usage: node scripts/deploy-vercel.mjs <preview|production> [--preflight]");
    process.exitCode = 2;
  } else {
    process.exitCode = runDeployment(target, { preflightOnly });
  }
}
