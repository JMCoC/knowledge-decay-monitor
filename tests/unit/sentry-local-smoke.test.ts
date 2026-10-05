import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
  readLocalSupabaseRuntime: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: mocks.execFileSync,
  spawn: mocks.spawn,
}));
vi.mock("../../scripts/local-supabase.mjs", () => ({
  PROJECT_ROOT: "C:/KDM/knowledge-decay-monitor",
  LOCAL_API_URL: "http://127.0.0.1:54321",
  readLocalSupabaseRuntime: mocks.readLocalSupabaseRuntime,
}));

import { runSentryLocalSmoke } from "../../scripts/sentry-local-smoke.mjs";

const operatorId = "10000000-0000-4000-8000-000000000001";
const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();

function validEnv() {
  return {
    KDM_SENTRY_DIAGNOSTICS_ENABLED: "1",
    KDM_SENTRY_DIAGNOSTICS_OPERATOR_IDS: operatorId,
    KDM_SENTRY_DIAGNOSTICS_EXPIRES_AT: expiresAt,
  };
}

describe("local Sentry smoke launcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readLocalSupabaseRuntime.mockReturnValue({
      apiUrl: "http://127.0.0.1:54321",
      publishableKey: "LOCAL_PUBLISHABLE_SENTINEL",
      serviceRoleKey: "LOCAL_SERVICE_ROLE_SENTINEL",
    });
    mocks.execFileSync.mockImplementation((_command: string, args: string[]) =>
      args[0] === "rev-parse" ? `${"a".repeat(40)}\n` : "",
    );
    mocks.spawn.mockReturnValue({ on: vi.fn() });
  });

  it("starts Next with local Supabase and a dirty development release", () => {
    mocks.execFileSync.mockImplementation((_command: string, args: string[]) =>
      args[0] === "rev-parse" ? `${"a".repeat(40)}\n` : " M src/example.ts\n",
    );

    runSentryLocalSmoke({
      env: {
        ...validEnv(),
        SUPABASE_SERVICE_ROLE_KEY: "REMOTE_SERVICE_ROLE_SENTINEL",
        SUPABASE_SECRET_KEY: "REMOTE_SECRET_SENTINEL",
      },
      nowMs: Date.now(),
    });

    const [command, args, options] = mocks.spawn.mock.calls[0] as [string, string[], { env: Record<string, string> }];
    expect(args.slice(1)).toEqual(["dev", "--hostname", "127.0.0.1", "--port", "3000"]);
    expect(options.env).toMatchObject({
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "LOCAL_PUBLISHABLE_SENTINEL",
      KDM_LOCAL_SUPABASE_URL: "http://127.0.0.1:54321",
      NEXT_PUBLIC_KDM_SENTRY_TARGET: "development",
      NEXT_PUBLIC_KDM_RELEASE: `${"a".repeat(40)}-dirty`,
      NEXT_PUBLIC_KDM_SENTRY_LOCAL_ENABLED: "1",
      SUPABASE_SERVICE_ROLE_KEY: "LOCAL_SERVICE_ROLE_SENTINEL",
    });
    expect(command).toBe(process.execPath);
    expect(options.env).not.toHaveProperty("SUPABASE_SECRET_KEY");
    expect(JSON.stringify(options)).not.toMatch(/REMOTE_SERVICE_ROLE_SENTINEL|REMOTE_SECRET_SENTINEL/);
  });

  it("refuses a non-local Supabase runtime before starting the app", () => {
    mocks.readLocalSupabaseRuntime.mockReturnValue({
      apiUrl: "https://remote.example.invalid",
      publishableKey: "REMOTE_KEY_SENTINEL",
    });

    expect(() => runSentryLocalSmoke({ env: validEnv(), nowMs: Date.now() })).toThrow(
      "Refusing to run diagnostics against a non-local Supabase project.",
    );
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it.each([
    ["disabled opt-in", { ...validEnv(), KDM_SENTRY_DIAGNOSTICS_ENABLED: "0" }],
    ["missing operator", { ...validEnv(), KDM_SENTRY_DIAGNOSTICS_OPERATOR_IDS: "" }],
    ["malformed operator", { ...validEnv(), KDM_SENTRY_DIAGNOSTICS_OPERATOR_IDS: "not-a-uuid" }],
    ["missing expiry", { ...validEnv(), KDM_SENTRY_DIAGNOSTICS_EXPIRES_AT: "" }],
    ["expired policy", { ...validEnv(), KDM_SENTRY_DIAGNOSTICS_EXPIRES_AT: "2020-01-01T00:00:00Z" }],
    ["unbounded policy", { ...validEnv(), KDM_SENTRY_DIAGNOSTICS_EXPIRES_AT: "2030-01-01T00:00:00Z" }],
    ["expiry without UTC zone", { ...validEnv(), KDM_SENTRY_DIAGNOSTICS_EXPIRES_AT: "2026-10-04T18:00:00" }],
  ])("rejects %s configuration without launching", (_name, env) => {
    expect(() => runSentryLocalSmoke({ env, nowMs: Date.now() })).toThrow();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("preserves inherited kill switches and test mode", () => {
    const env = {
      ...validEnv(),
      NODE_ENV: "test",
      KDM_DISABLE_SENTRY: "1",
      NEXT_PUBLIC_KDM_DISABLE_SENTRY: "1",
    };

    runSentryLocalSmoke({ env, nowMs: Date.now() });

    expect((mocks.spawn.mock.calls[0][2] as { env: Record<string, string> }).env).toMatchObject({
      NODE_ENV: "test",
      KDM_DISABLE_SENTRY: "1",
      NEXT_PUBLIC_KDM_DISABLE_SENTRY: "1",
      NEXT_PUBLIC_KDM_SENTRY_LOCAL_ENABLED: "1",
    });
  });
});
