import { beforeEach, describe, expect, it, vi } from "vitest";

const { execFileSync } = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync }));

import { readLocalSupabaseRuntime } from "../../scripts/local-supabase.mjs";

describe("local Supabase runtime", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    execFileSync.mockReturnValue(JSON.stringify({
      API_URL: "http://127.0.0.1:54321",
      PUBLISHABLE_KEY: "local-publishable-fixture",
      SERVICE_ROLE_KEY: "local-service-fixture",
      MAILPIT_URL: "http://127.0.0.1:54324",
    }));
  });

  it("returns the service credential only in the private runtime value", () => {
    expect(readLocalSupabaseRuntime()).toMatchObject({
      apiUrl: "http://127.0.0.1:54321",
      serviceRoleKey: "local-service-fixture",
    });
  });

  it("rejects a service credential tied to a non-local API", () => {
    execFileSync.mockReturnValue(JSON.stringify({
      API_URL: "https://remote.supabase.co",
      PUBLISHABLE_KEY: "publishable-fixture",
      SERVICE_ROLE_KEY: "service-fixture",
      MAILPIT_URL: "http://127.0.0.1:54324",
    }));

    expect(() => readLocalSupabaseRuntime()).toThrow(
      "Refusing to run Auth tests: Supabase API is not the expected local URL.",
    );
  });
});
