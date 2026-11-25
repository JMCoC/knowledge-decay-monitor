import { describe, expect, it } from "vitest";
import { runDeployment } from "../../scripts/deploy-vercel.mjs";

const repository = "JMCoC/knowledge-decay-monitor";
const sha = "a".repeat(40);
const projectId = "prj_project123";
const deploymentId = "dpl_deployment123";
const deploymentUrl = "https://kdm-candidate-123.vercel.app";
const previousId = "dpl_previous123";
const appOrigin = "https://www.example.com";
const loginHtml = "<p>Sign in to continue to your workspace.</p>";

function environment() {
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: repository,
    GITHUB_ACTOR: "maintainer",
    GITHUB_TRIGGERING_ACTOR: "maintainer",
    GITHUB_SHA: sha,
    QUALITY_RESULT: "success",
    TESTED_SHA: sha,
    GITHUB_RUN_ID: "12345",
    KDM_DEPLOY_ENVIRONMENT: "Production",
    GH_TOKEN: "GH_TOKEN_SENTINEL",
    VERCEL_TOKEN: "VERCEL_TOKEN_SENTINEL",
    VERCEL_ORG_ID: "team_abc123",
    VERCEL_PROJECT_ID: projectId,
    SENTRY_AUTH_TOKEN: "SENTRY_TOKEN_SENTINEL",
    APP_ORIGIN: appOrigin,
    VERCEL_AUTOMATION_BYPASS_SECRET: "BYPASS_SENTINEL",
  };
}

function htmlResponse(body = loginHtml, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function createHarness({
  aliasAfterPromotion = deploymentId,
  candidateResponse = () => htmlResponse(),
  publicResponse = () => htmlResponse(),
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
  aliasAfterPromotion?: string;
  candidateResponse?: () => Response;
  publicResponse?: () => Response;
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
  const env = environment();
  const summaries: Record<string, string>[] = [];
  const sequence: string[] = [];
  const requests: { url: string; options?: RequestInit }[] = [];
  let promoted = false;
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
      if (endpoint.includes("/branches/main")) {
        const headSha = currentHeads[Math.min(headIndex++, currentHeads.length - 1)];
        sequence.push("main");
        return { status: 0, stdout: JSON.stringify({ headSha }), stderr: "" };
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
        // CLI 62.2.0 deliberately omits projectId and meta from inspect JSON.
        return {
          status: 0,
          stdout: JSON.stringify({ id: deploymentId, name: "knowledge-decay-monitor", url: deploymentUrl, target: "production", readyState, createdAt: 1 }),
          stderr: "",
        };
      }
      if (operation === "promote") {
        sequence.push("promote");
        promoted = true;
      }
      if (operation === "api" && args[3].startsWith("/v4/aliases/")) {
        sequence.push("alias");
        return {
          status: 0,
          stdout: JSON.stringify({ alias: "www.example.com", projectId, deploymentId: promoted ? aliasAfterPromotion : previousId }),
          stderr: "",
        };
      }
      if (operation === "api") {
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
              kdmTarget: "production",
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
    requests,
    sequence,
    summaries,
    environment: env,
    run(options: { preflightOnly?: boolean } = {}) {
      return runDeployment("production", {
        env,
        spawnCommand,
        fetchPage: async (input, options) => {
          const url = String(input);
          requests.push({ url, options });
          if (url === `${deploymentUrl}/login`) {
            sequence.push("candidate login");
            return candidateResponse();
          }
          if (url === `${appOrigin}/login`) {
            sequence.push("public login");
            return publicResponse();
          }
          throw new Error("Unexpected smoke URL");
        },
        delay: async () => {},
        summarize: (report) => summaries.push(report),
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

describe("Vercel deploy runner", async () => {
  it("preflights GitHub authorization without invoking Vercel or receiving Vercel credentials", async () => {
    const harness = createHarness({ preflight: true });

    expect(await harness.run()).toBe(0);
    expect(vercelCalls(harness.calls)).toHaveLength(0);
    expect(harness.calls.some((call) => call.command === "gh")).toBe(true);
    expect(harness.calls.filter((call) => call.command === "gh").every((call) =>
      !call.options.env?.VERCEL_TOKEN && !call.options.env?.SENTRY_AUTH_TOKEN,
    )).toBe(true);
  });

  it("does not use Vercel credentials for an actor without write access", async () => {
    const harness = createHarness({ permission: "read" });

    expect(await harness.run()).toBe(1);
    expect(vercelCalls(harness.calls)).toHaveLength(0);
    expect(harness.logs.join("\n")).not.toMatch(/VERCEL_TOKEN_SENTINEL|SENTRY_TOKEN_SENTINEL/);
  });

  it("checks the triggering actor again on workflow reruns", async () => {
    const harness = createHarness();
    harness.environment.GITHUB_TRIGGERING_ACTOR = "readonly";

    expect(await harness.run()).toBe(1);
    expect(vercelCalls(harness.calls)).toHaveLength(0);
  });

  it("promotes only a ready Production deployment built from the current main SHA", async () => {
    const harness = createHarness();

    expect(await harness.run()).toBe(0);
    const calls = vercelCalls(harness.calls);
    expect(calls.map(operation)).toEqual(["pull", "build", "deploy", "inspect", "api", "api", "promote", "api"]);
    expect(calls[0].args).toContain("--environment=production");
    expect(calls[1].args).toContain("--prod");
    expect(calls[1].options.env?.NEXT_PUBLIC_KDM_SENTRY_TARGET).toBe("production");
    expect(calls[2].args).toContain("--prebuilt");
    expect(calls[2].args).toContain("--prod");
    expect(calls[2].args).toContain("--skip-domain");
    expect(calls[2].options.env?.SENTRY_AUTH_TOKEN).toBeUndefined();
    expect(calls[4].args).toContain(`/v13/deployments/${deploymentId}`);
    expect(calls[5].args).toContain("/v4/aliases/www.example.com");
    expect(calls[6].args).toContain(deploymentId);
    expect(harness.sequence).toEqual([
      "main", "main", "candidate login", "alias", "main", "promote", "alias", "public login",
    ]);
    expect(harness.requests).toEqual([
      { url: `${deploymentUrl}/login`, options: expect.objectContaining({
        redirect: "manual", headers: { "Cache-Control": "no-cache", "x-vercel-protection-bypass": "BYPASS_SENTINEL" },
      }) },
      { url: `${appOrigin}/login`, options: expect.objectContaining({
        redirect: "manual", headers: { "Cache-Control": "no-cache" },
      }) },
    ]);
    expect(harness.calls.every((call) => call.options.shell === false)).toBe(true);
    expect(harness.calls.every((call) => !call.options.env?.VERCEL_AUTOMATION_BYPASS_SECRET)).toBe(true);
    expect(harness.summaries).toEqual([{
      "GitHub run": "12345",
      "Tested SHA": sha,
      "Candidate deployment": deploymentId,
      "Candidate login": "Passed",
      "Previous deployment": previousId,
      "Promotion": "Command succeeded",
      "Public alias": "Passed",
      "Public login": "Passed",
    }]);
  });

  it("does not create a deployment if the production APP_ORIGIN is local or invalid", async () => {
    const harness = createHarness();
    harness.environment.APP_ORIGIN = "http://127.0.0.1:3000";

    expect(await harness.run()).toBe(1);
    expect(vercelCalls(harness.calls)).toHaveLength(0);
  });

  it("stops before promotion when main advances during candidate verification", async () => {
    const harness = createHarness({ currentHeads: [sha, sha, "b".repeat(40)] });

    expect(await harness.run()).toBe(1);
    const calls = vercelCalls(harness.calls);
    expect(calls.map(operation)).toEqual(["pull", "build", "deploy", "inspect", "api", "api"]);
    expect(harness.logs.join("\n")).not.toMatch(/VERCEL_TOKEN_SENTINEL|SENTRY_TOKEN_SENTINEL/);
  });

  it.each([
    ["wrong project", { inspectedProjectId: "prj_other123" }],
    ["wrong source SHA", { inspectedSha: "b".repeat(40) }],
    ["non-ready state", { readyState: "ERROR" }],
  ])("stops before publication for an inspection with %s", async (_label, override) => {
    const harness = createHarness(override);

    expect(await harness.run()).toBe(1);
    expect(vercelCalls(harness.calls).map(operation)).toEqual(["pull", "build", "deploy", "inspect", "api"]);
  });

  it.each([
    [1, ""],
    [0, JSON.stringify({ id: deploymentId, url: deploymentUrl, projectId, readyState: "READY" })],
  ])("does not publish when deployment metadata is unavailable", async (failureStatus, failureStdout) => {
    const harness = createHarness({ failOperation: "api", failureStatus, failureStdout });
    expect(await harness.run()).toBe(1);
    expect(vercelCalls(harness.calls).map(operation)).toEqual(["pull", "build", "deploy", "inspect", "api"]);
    expect(harness.logs.join("\n")).not.toContain("SENTINEL");
  });

  it.each([
    [() => htmlResponse("BYPASS_SENTINEL", 302), "unexpected_login_response"],
    [() => htmlResponse("BYPASS_SENTINEL"), "login_marker_missing"],
    [() => new Response(loginHtml, { headers: { "Content-Type": "text/plain" } }), "unexpected_login_response"],
    [() => { throw new Error("BYPASS_SENTINEL"); }, "login_request_failed"],
  ])("blocks promotion on a failed candidate login smoke", async (candidateResponse, reason) => {
    const harness = createHarness({ candidateResponse });

    expect(await harness.run()).toBe(1);
    expect(harness.requests).toHaveLength(3);
    expect(harness.sequence).not.toContain("promote");
    expect(harness.logs.join("\n")).toContain(reason);
    expect(harness.logs.join("\n")).not.toContain("SENTINEL");
    expect(harness.summaries[0]).toMatchObject({
      "Candidate deployment": deploymentId,
      "Candidate login": "Failed",
      "Promotion": "Not attempted",
    });
  });

  it("does not probe the public endpoint when the alias still points to the previous deployment", async () => {
    const harness = createHarness({ aliasAfterPromotion: previousId });

    expect(await harness.run()).toBe(1);
    expect(harness.sequence).toContain("promote");
    expect(harness.sequence).not.toContain("public login");
    expect(harness.logs.join("\n")).toContain(`reason=production_alias_mismatch; active=${previousId}`);
    expect(harness.summaries[0]).toMatchObject({ "Public alias": "Failed" });
  });

  it.each([
    [{ failOperation: "promote" }, "Attempted, outcome uncertain", "Not run"],
    [{ publicResponse: () => htmlResponse("private response", 503) }, "Command succeeded", "Failed"],
  ])("records both IDs when promotion or the public smoke fails", async (options, promotion, publicLogin) => {
    const harness = createHarness(options);

    expect(await harness.run()).toBe(1);
    expect(harness.logs.join("\n")).toContain("Check the live Production alias before retry or rollback");
    expect(harness.logs.join("\n")).not.toMatch(/SENTINEL|private response/);
    expect(harness.summaries[0]).toMatchObject({
      "Candidate deployment": deploymentId,
      "Previous deployment": previousId,
      "Promotion": promotion,
      "Public login": publicLogin,
    });
  });

  it("suppresses CLI output that may contain credentials", async () => {
    const harness = createHarness({ failOperation: "pull" });

    expect(await harness.run()).toBe(1);
    expect(harness.logs.join("\n")).not.toMatch(/VERCEL_TOKEN_SENTINEL|SENTRY_TOKEN_SENTINEL|GH_TOKEN_SENTINEL/);
  });

  it.each([
    ["private non-JSON output", "invalid_json_output"],
    ['{"unexpected":"private"}', "invalid_deployment_reference"],
  ])("distinguishes successful CLI execution from invalid deployment output: %s", async (failureStdout, category) => {
    const harness = createHarness({ failOperation: "deploy", failureStatus: 0, failureStdout });
    expect(await harness.run()).toBe(1);
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
  ])("reports a safe deploy failure category for %s", async (failureOutput, category) => {
    const harness = createHarness({
      failOperation: "deploy",
      failureOutput: `${failureOutput}\nVERCEL_TOKEN_SENTINEL SENTRY_TOKEN_SENTINEL`,
    });

    expect(await harness.run()).toBe(1);
    expect(harness.logs.join("\n")).toContain(`reason=${category}; exit=1`);
    expect(harness.logs.join("\n")).not.toMatch(/SENTINEL|private|provider response/);
    expect(vercelCalls(harness.calls).map(operation)).toEqual(["pull", "build", "deploy"]);
  });
});
