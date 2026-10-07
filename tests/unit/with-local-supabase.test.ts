import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  readLocalSupabaseRuntime: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawnSync: mocks.spawnSync }));
vi.mock("../../scripts/local-supabase.mjs", () => ({
  PROJECT_ROOT: "C:/KDM/knowledge-decay-monitor",
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

  it("never passes the service key to a build child", () => {
    expect(
      runWithLocalSupabase({ selected: "build", forwardedArgs: [], env: hostileParentEnv() }),
    ).toBe(0);

    const [, , options] = mocks.spawnSync.mock.calls[0] as [string, string[], { env: Record<string, string> }];
    expect(options.env).not.toHaveProperty("SUPABASE_SERVICE_ROLE_KEY");
    expect(options.env).not.toHaveProperty("SUPABASE_SECRET_KEY");
  });

  it("creates an ephemeral internal token for the local E2E web server", () => {
    const env = { ...hostileParentEnv(), INGESTION_INTERNAL_TOKEN: "REMOTE_INTERNAL_SENTINEL" };
    expect(
      runWithLocalSupabase({ selected: "e2e", forwardedArgs: [], env }),
    ).toBe(0);

    const [, , options] = mocks.spawnSync.mock.calls[0] as [string, string[], { env: Record<string, string> }];
    expect(options.env.INGESTION_INTERNAL_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(options.env.INGESTION_INTERNAL_TOKEN).not.toBe("REMOTE_INTERNAL_SENTINEL");
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
