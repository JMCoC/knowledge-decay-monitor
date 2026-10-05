import { describe, expect, it } from "vitest";
import { runDeployment } from "../../scripts/deploy-vercel.mjs";

const repository = "JMCoC/knowledge-decay-monitor";
const sha = "a".repeat(40);
const projectId = "prj_project123";
const deploymentId = "dpl_deployment123";
const deploymentUrl = "https://kdm-preview-123.vercel.app";

function environment(target: "preview" | "production" = "preview") {
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: target === "preview" ? "pull_request" : "push",
    GITHUB_REF: target === "preview" ? "refs/pull/8/merge" : "refs/heads/main",
    GITHUB_REPOSITORY: repository,
    GITHUB_ACTOR: "maintainer",
    GITHUB_TRIGGERING_ACTOR: "maintainer",
    GITHUB_SHA: target === "preview" ? "b".repeat(40) : sha,
    QUALITY_RESULT: "success",
    TESTED_SHA: sha,
    PR_NUMBER: target === "preview" ? "8" : "",
    KDM_DEPLOY_ENVIRONMENT: target === "preview" ? "Preview" : "Production",
    GH_TOKEN: "GH_TOKEN_SENTINEL",
    VERCEL_TOKEN: "VERCEL_TOKEN_SENTINEL",
    VERCEL_ORG_ID: "team_abc123",
    VERCEL_PROJECT_ID: projectId,
    SENTRY_AUTH_TOKEN: "SENTRY_TOKEN_SENTINEL",
    APP_ORIGIN: target === "preview" ? "" : "https://www.example.com",
  };
}

function createHarness({
  target = "preview",
  currentHeads = [sha, sha, sha],
  inspectedProjectId = projectId,
  inspectedSha = sha,
  readyState = "READY",
  permission = "write",
  failOperation,
  failureOutput = "VERCEL_TOKEN_SENTINEL SENTRY_TOKEN_SENTINEL",
  failureStatus = 1,
  failureStdout = "",
  preflight = false,
}: {
  target?: "preview" | "production";
  currentHeads?: string[];
  inspectedProjectId?: string;
  inspectedSha?: string;
  readyState?: string;
  permission?: string;
  failOperation?: string;
  failureOutput?: string;
  failureStatus?: number;
  failureStdout?: string;
  preflight?: boolean;
} = {}) {
  const calls: Array<{ command: string; args: string[]; options: { env?: Record<string, string | undefined>; shell?: boolean | string } }> = [];
  const logs: string[] = [];
  const env = environment(target);
  let headIndex = 0;

  const spawnCommand = (
    command: string,
    args: string[],
    options: { env?: Record<string, string | undefined>; shell?: boolean | string },
  ) => {
    calls.push({ command, args, options });
    const operation = command === "pnpm" ? args[2] : undefined;
    if (command === "git") return { status: 0, stdout: `${sha}\n`, stderr: "" };
    if (command === "gh") {
      const endpoint = args[1] ?? "";
      if (endpoint.includes("/pulls/")) {
        const headSha = currentHeads[Math.min(headIndex++, currentHeads.length - 1)];
        return {
          status: 0,
          stdout: JSON.stringify({
            state: "open",
            draft: false,
            headSha,
            headRepository: repository,
          }),
          stderr: "",
        };
      }
      if (endpoint.includes("/branches/main")) {
        return { status: 0, stdout: JSON.stringify({ headSha: sha }), stderr: "" };
      }
      if (endpoint.includes("/collaborators/")) {
        const actorPermission = endpoint.includes("/readonly/") ? "read" : permission;
        return { status: 0, stdout: `${actorPermission}\n`, stderr: "" };
      }
    }

    if (command === "pnpm") {
      if (operation === failOperation) {
        return { status: failureStatus, stdout: failureStdout, stderr: failureOutput };
      }
      if (operation === "deploy") {
        return {
          status: 0,
          stdout: JSON.stringify({ id: deploymentId, url: deploymentUrl }),
          stderr: "",
        };
      }
      if (operation === "inspect") {
        return {
          status: 0,
          stdout: JSON.stringify({
            id: deploymentId,
            url: deploymentUrl,
            projectId: inspectedProjectId,
            readyState,
            meta: {
              githubCommitSha: inspectedSha,
              kdmTestedSha: inspectedSha,
              kdmRepository: repository,
              kdmTarget: target,
            },
          }),
          stderr: "",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "unexpected process" };
  };

  return {
    calls,
    logs,
    environment: env,
    run(options: { preflightOnly?: boolean } = {}) {
      return runDeployment(target, {
        env,
        spawnCommand,
        log: (message: string) => logs.push(message),
        preflightOnly: options.preflightOnly ?? preflight,
      });
    },
  };
}

function vercelCalls(calls: ReturnType<typeof createHarness>["calls"]) {
  return calls.filter((call) => call.command === "pnpm");
}

function operation(call: ReturnType<typeof createHarness>["calls"][number]) {
  return call.args[2];
}

describe("Vercel deploy runner", () => {
  it("preflights GitHub authorization without invoking Vercel or receiving Vercel credentials", () => {
    const harness = createHarness({ preflight: true });

    expect(harness.run()).toBe(0);
    expect(vercelCalls(harness.calls)).toHaveLength(0);
    expect(harness.calls.some((call) => call.command === "gh")).toBe(true);
    expect(harness.calls.filter((call) => call.command === "gh").every((call) =>
      !call.options.env?.VERCEL_TOKEN && !call.options.env?.SENTRY_AUTH_TOKEN,
    )).toBe(true);
  });

  it("does not use Vercel credentials for an actor without write access", () => {
    const harness = createHarness({ permission: "read" });

    expect(harness.run()).toBe(1);
    expect(vercelCalls(harness.calls)).toHaveLength(0);
    expect(harness.logs.join("\n")).not.toMatch(/VERCEL_TOKEN_SENTINEL|SENTRY_TOKEN_SENTINEL/);
  });

  it("checks the triggering actor again on workflow reruns", () => {
    const harness = createHarness();
    harness.environment.GITHUB_TRIGGERING_ACTOR = "readonly";

    expect(harness.run()).toBe(1);
    expect(vercelCalls(harness.calls)).toHaveLength(0);
  });

  it("builds and aliases only a ready Preview deployment for the exact tested SHA", () => {
    const harness = createHarness();

    expect(harness.run()).toBe(0);
    const calls = vercelCalls(harness.calls);
    expect(calls.map(operation)).toEqual(["pull", "build", "deploy", "inspect", "alias"]);

    const pull = calls[0];
    expect(pull.args).toContain("--environment=preview");
    expect(pull.args).toContain("--project");
    const build = calls[1];
    expect(build.args).toContain("--target=preview");
    expect(build.options.env).toMatchObject({
      NEXT_PUBLIC_KDM_SENTRY_TARGET: "preview",
      NEXT_PUBLIC_KDM_RELEASE: sha,
      SENTRY_RELEASE: sha,
      APP_ORIGIN: "https://kdm-pr-8-kdm17.vercel.app",
      SENTRY_AUTH_TOKEN: "SENTRY_TOKEN_SENTINEL",
    });
    const deploy = calls[2];
    expect(deploy.args).toContain("--prebuilt");
    // Vercel CLI 62.2.0 rejects --skip-domain for non-production targets.
    expect(deploy.args).not.toContain("--skip-domain");
    expect(deploy.args).not.toContain("--prod");
    expect(deploy.options.env?.SENTRY_AUTH_TOKEN).toBeUndefined();
    expect(deploy.options.env?.GH_TOKEN).toBeUndefined();
    expect(calls.every((call) => call.options.shell === false)).toBe(true);
    expect(harness.logs.join("\n")).not.toMatch(/VERCEL_TOKEN_SENTINEL|SENTRY_TOKEN_SENTINEL|GH_TOKEN_SENTINEL/);
  });

  it("promotes only a ready Production deployment built from the current main SHA", () => {
    const harness = createHarness({ target: "production" });

    expect(harness.run()).toBe(0);
    const calls = vercelCalls(harness.calls);
    expect(calls.map(operation)).toEqual(["pull", "build", "deploy", "inspect", "promote"]);
    expect(calls[0].args).toContain("--environment=production");
    expect(calls[1].args).toContain("--prod");
    expect(calls[1].options.env?.NEXT_PUBLIC_KDM_SENTRY_TARGET).toBe("production");
    expect(calls[2].args).toContain("--prebuilt");
    expect(calls[2].args).toContain("--prod");
    expect(calls[2].args).toContain("--skip-domain");
    expect(calls[2].options.env?.SENTRY_AUTH_TOKEN).toBeUndefined();
    expect(calls[4].args).toContain(deploymentUrl);
  });

  it("does not create a deployment if the production APP_ORIGIN is local or invalid", () => {
    const harness = createHarness({ target: "production" });
    harness.environment.APP_ORIGIN = "http://127.0.0.1:3000";

    expect(harness.run()).toBe(1);
    expect(vercelCalls(harness.calls)).toHaveLength(0);
  });

  it("stops before aliasing when the PR head changes during the build", () => {
    const harness = createHarness({ currentHeads: [sha, sha, "b".repeat(40)] });

    expect(harness.run()).toBe(1);
    const calls = vercelCalls(harness.calls);
    expect(calls.map(operation)).toEqual(["pull", "build", "deploy", "inspect"]);
    expect(harness.logs.join("\n")).not.toMatch(/VERCEL_TOKEN_SENTINEL|SENTRY_TOKEN_SENTINEL/);
  });

  it.each([
    ["wrong project", { inspectedProjectId: "prj_other123" }],
    ["wrong source SHA", { inspectedSha: "b".repeat(40) }],
    ["non-ready state", { readyState: "ERROR" }],
  ])("stops before publication for an inspection with %s", (_label, override) => {
    const harness = createHarness(override);

    expect(harness.run()).toBe(1);
    expect(vercelCalls(harness.calls).map(operation)).toEqual(["pull", "build", "deploy", "inspect"]);
  });

  it("suppresses CLI output that may contain credentials", () => {
    const harness = createHarness({ failOperation: "pull" });

    expect(harness.run()).toBe(1);
    expect(harness.logs.join("\n")).not.toMatch(/VERCEL_TOKEN_SENTINEL|SENTRY_TOKEN_SENTINEL|GH_TOKEN_SENTINEL/);
  });

  it.each([
    ["private non-JSON output", "invalid_json_output"],
    ['{"unexpected":"private"}', "invalid_deployment_reference"],
  ])("distinguishes successful CLI execution from invalid deployment output: %s", (failureStdout, category) => {
    const harness = createHarness({ failOperation: "deploy", failureStatus: 0, failureStdout });
    expect(harness.run()).toBe(1);
    expect(harness.logs.join("\n")).toContain(`reason=${category}`);
    expect(harness.logs.join("\n")).not.toMatch(/private|SENTINEL/);
    expect(vercelCalls(harness.calls).map(operation)).toEqual(["pull", "build", "deploy"]);
  });

  it.each([
    ['The `--skip-domain` option can only be used with production deployments.', "invalid_cli_arguments"],
    ['Error: No prebuilt output found in ".vercel/output"', "prebuilt_output_missing"],
    ['Prebuilt deployment cannot be created because vercel build failed with error', "prebuilt_build_failed"],
    ['https://vercel.link/prebuilt-environment-mismatch', "prebuilt_target_mismatch"],
    ['Error: Git author private@example.com must have access to the team', "git_author_access_denied"],
    ['Error: The specified token is not valid', "authentication_failed"],
    ['Error: Forbidden', "access_denied"],
    ['Error: Rate limit exceeded', "rate_limited"],
    ['Error: unknown or unexpected option: --private-value', "invalid_cli_arguments"],
    ['Error: getaddrinfo ENOTFOUND private.example.com', "network_failure"],
    ['unrecognized private provider response', "unclassified_cli_failure"],
  ])("reports a safe deploy failure category for %s", (failureOutput, category) => {
    const harness = createHarness({
      failOperation: "deploy",
      failureOutput: `${failureOutput}\nVERCEL_TOKEN_SENTINEL SENTRY_TOKEN_SENTINEL`,
    });

    expect(harness.run()).toBe(1);
    expect(harness.logs.join("\n")).toContain(`reason=${category}; exit=1`);
    expect(harness.logs.join("\n")).not.toMatch(/SENTINEL|private|provider response/);
    expect(vercelCalls(harness.calls).map(operation)).toEqual(["pull", "build", "deploy"]);
  });
});
