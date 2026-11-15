import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";

const mocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  readLocalSupabaseRuntime: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawnSync: mocks.spawnSync }));
vi.mock("../../scripts/local-supabase.mjs", () => ({
  PROJECT_ROOT: process.cwd(),
  LOCAL_API_URL: "http://127.0.0.1:54321",
  readLocalSupabaseRuntime: mocks.readLocalSupabaseRuntime,
}));

import { runWithLocalSupabase } from "../../scripts/with-local-supabase.mjs";

const adminId = "10000000-0000-4000-8000-000000000001";

function localRuntime() {
  return {
    apiUrl: "http://127.0.0.1:54321",
    publishableKey: "LOCAL_PUBLISHABLE_SENTINEL",
    serviceRoleKey: "LOCAL_SERVICE_ROLE_SENTINEL",
    mailpitUrl: "http://127.0.0.1:54324",
  };
}

function hostileParentEnv() {
  return {
    NEXT_PUBLIC_SUPABASE_URL: "https://example.invalid",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "REMOTE_PUBLISHABLE_SENTINEL",
    SUPABASE_SERVICE_ROLE_KEY: "REMOTE_SERVICE_ROLE_SENTINEL",
    SUPABASE_SECRET_KEY: "REMOTE_SECRET_SENTINEL",
    SENTRY_DSN: "https://public@example.invalid/1",
    SENTRY_AUTH_TOKEN: "SENTRY_TOKEN_SENTINEL",
    NEXT_PUBLIC_KDM_SENTRY_LOCAL_ENABLED: "1",
    KDM_SENTRY_DIAGNOSTICS_ENABLED: "1",
    KDM_SENTRY_DIAGNOSTICS_OPERATOR_IDS: adminId,
    KDM_SENTRY_DIAGNOSTICS_EXPIRES_AT: "2026-10-04T18:00:00Z",
  };
}

describe("local Supabase test runner isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readLocalSupabaseRuntime.mockReturnValue(localRuntime());
    mocks.spawnSync.mockReturnValue({ status: 0, error: undefined });
  });

  it("forces local Supabase credentials and disables Sentry diagnostics in the child", () => {
    expect(
      runWithLocalSupabase({ selected: "integration", forwardedArgs: [], env: hostileParentEnv() }),
    ).toBe(0);

    const [, , options] = mocks.spawnSync.mock.calls[0] as [string, string[], { env: Record<string, string> }];
    expect(options.env).toMatchObject({
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "LOCAL_PUBLISHABLE_SENTINEL",
      KDM_LOCAL_SUPABASE_URL: "http://127.0.0.1:54321",
      KDM_DISABLE_SENTRY: "1",
      NEXT_PUBLIC_KDM_DISABLE_SENTRY: "1",
      KDM_SENTRY_DIAGNOSTICS_ENABLED: "0",
      KDM_SENTRY_DIAGNOSTICS_OPERATOR_IDS: "",
      KDM_SENTRY_DIAGNOSTICS_EXPIRES_AT: "",
      NEXT_PUBLIC_KDM_SENTRY_LOCAL_ENABLED: "0",
      SENTRY_DSN: "",
      SENTRY_AUTH_TOKEN: "",
      SUPABASE_SERVICE_ROLE_KEY: "LOCAL_SERVICE_ROLE_SENTINEL",
    });
    expect(options.env).not.toHaveProperty("SUPABASE_SECRET_KEY");
    expect(JSON.stringify(options.env)).not.toMatch(/REMOTE_|SENTRY_TOKEN_SENTINEL|example\.invalid/);
  });

  it("runs review isolation in its disposable runner after the shared integration suite", () => {
    expect(
      runWithLocalSupabase({ selected: "integration", forwardedArgs: [], env: hostileParentEnv() }),
    ).toBe(0);

    expect(mocks.spawnSync).toHaveBeenCalledTimes(2);
    const [, suiteArgs] = mocks.spawnSync.mock.calls[0] as [string, string[]];
    expect(suiteArgs.slice(-6)).toEqual([
      "--exclude", "tests/integration/review-foundation-isolation.test.ts",
      "--exclude", "tests/integration/review-commands-isolation.test.ts",
      "--exclude", "tests/integration/review-command-concurrency.test.ts",
    ]);

    const [reviewCommand, reviewArgs, reviewOptions] = mocks.spawnSync.mock.calls[1] as [
      string,
      string[],
      { cwd: string; env: Record<string, string> },
    ];
    expect(reviewCommand).toBe(process.execPath);
    expect(reviewArgs[0]?.replaceAll("\\", "/")).toBe(
      resolve(process.cwd(), "scripts/run-review-isolated-integration.mjs").replaceAll("\\", "/"),
    );
    expect(reviewArgs.slice(1)).toEqual([
      "tests/integration/review-foundation-isolation.test.ts",
      "tests/integration/review-commands-isolation.test.ts",
      "tests/integration/review-command-concurrency.test.ts",
    ]);
    expect(reviewOptions.cwd).toBe(process.cwd());
    expect(reviewOptions.env).toMatchObject({
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
      SUPABASE_SERVICE_ROLE_KEY: "LOCAL_SERVICE_ROLE_SENTINEL",
    });
    expect(JSON.stringify(reviewOptions.env)).not.toMatch(/REMOTE_|SENTRY_TOKEN_SENTINEL|example\.invalid/);
  });

  it("keeps review suites isolated when full-suite Vitest options are forwarded", () => {
    expect(runWithLocalSupabase({
      selected: "integration",
      forwardedArgs: ["--reporter=dot"],
      env: hostileParentEnv(),
    })).toBe(0);

    expect(mocks.spawnSync).toHaveBeenCalledTimes(2);
    const [, suiteArgs] = mocks.spawnSync.mock.calls[0] as [string, string[]];
    expect(suiteArgs).toContain("--reporter=dot");
    expect(suiteArgs.slice(-6)).toEqual([
      "--exclude", "tests/integration/review-foundation-isolation.test.ts",
      "--exclude", "tests/integration/review-commands-isolation.test.ts",
      "--exclude", "tests/integration/review-command-concurrency.test.ts",
    ]);
  });

  it("runs an explicitly requested review batch only through the disposable project", () => {
    const requested = [
      "tests/integration/review-command-concurrency.test.ts",
      "tests/integration/review-commands-isolation.test.ts",
    ];

    expect(runWithLocalSupabase({ selected: "integration", forwardedArgs: requested, env: hostileParentEnv() })).toBe(0);

    expect(mocks.readLocalSupabaseRuntime).not.toHaveBeenCalled();
    expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
    const [reviewCommand, reviewArgs] = mocks.spawnSync.mock.calls[0] as [string, string[]];
    expect(reviewCommand).toBe(process.execPath);
    expect(reviewArgs.slice(1)).toEqual(requested);
  });

  it("does not launch the isolated review runner when the shared integration suite fails", () => {
    mocks.spawnSync.mockReturnValueOnce({ status: 1, error: undefined });

    expect(
      runWithLocalSupabase({ selected: "integration", forwardedArgs: [], env: hostileParentEnv() }),
    ).toBe(1);
    expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
  });

  it("never passes the service key to a build child", () => {
    expect(
      runWithLocalSupabase({ selected: "build", forwardedArgs: [], env: hostileParentEnv() }),
    ).toBe(0);

    const [, , options] = mocks.spawnSync.mock.calls[0] as [string, string[], { env: Record<string, string> }];
    expect(options.env).not.toHaveProperty("SUPABASE_SERVICE_ROLE_KEY");
    expect(options.env).not.toHaveProperty("SUPABASE_SECRET_KEY");
  });

  it("strips the retired internal ingestion token from the local E2E server", () => {
    const env = { ...hostileParentEnv(), INGESTION_INTERNAL_TOKEN: "REMOTE_INTERNAL_SENTINEL" };
    expect(
      runWithLocalSupabase({ selected: "e2e", forwardedArgs: [], env }),
    ).toBe(0);

    const [, , options] = mocks.spawnSync.mock.calls[0] as [string, string[], { env: Record<string, string> }];
    expect(options.env.INGESTION_INTERNAL_TOKEN).toBeUndefined();
  });

  it("gives the standalone worker an explicit local API URL and server key", () => {
    expect(runWithLocalSupabase({ selected:"worker", forwardedArgs:[], env:hostileParentEnv() })).toBe(0);
    const [, , options] = mocks.spawnSync.mock.calls[0] as [string, string[], { env: Record<string, string> }];
    expect(options.env.SUPABASE_URL).toBe("http://127.0.0.1:54321");
    expect(options.env.SUPABASE_SERVICE_ROLE_KEY).toBe("LOCAL_SERVICE_ROLE_SENTINEL");
    expect(options.env.INGESTION_INTERNAL_TOKEN).toBeUndefined();
  });

  it("does not start integration or E2E without the local service key", () => {
    mocks.readLocalSupabaseRuntime.mockReturnValue({
      ...localRuntime(),
      serviceRoleKey: undefined,
    });

    expect(
      runWithLocalSupabase({ selected: "e2e", forwardedArgs: [], env: hostileParentEnv() }),
    ).toBe(1);
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });
});
