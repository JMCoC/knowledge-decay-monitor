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
      JWT_SECRET: "JWT_SENTINEL",
      SECRET_KEY: "SECRET_SENTINEL",
      S3_PROTOCOL_ACCESS_KEY_SECRET: "STORAGE_SECRET_SENTINEL",
    }));
  });

  it("returns the service credential only in the private runtime value", () => {
    const runtime = readLocalSupabaseRuntime();
    expect(runtime).toMatchObject({
      apiUrl: "http://127.0.0.1:54321",
      serviceRoleKey: "local-service-fixture",
    });
    expect(runtime).not.toHaveProperty("jwtSecret");
    expect(runtime).not.toHaveProperty("secretKey");
    expect(JSON.stringify(runtime)).not.toMatch(/JWT_SENTINEL|SECRET_SENTINEL|STORAGE_SECRET_SENTINEL/);
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

  it("rejects a non-local Mailpit endpoint without including status credentials", () => {
    execFileSync.mockReturnValue(JSON.stringify({
      API_URL: "http://127.0.0.1:54321",
      PUBLISHABLE_KEY: "publishable-fixture",
      SERVICE_ROLE_KEY: "SERVICE_SENTINEL",
      MAILPIT_URL: "https://mailpit.example.invalid",
    }));

    let message = "";
    try {
      readLocalSupabaseRuntime();
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toBe("Refusing to use a non-local Mailpit endpoint.");
    expect(message).not.toContain("SERVICE_SENTINEL");
  });

  it("suppresses raw CLI errors from status output", () => {
    execFileSync.mockImplementation(() => {
      throw new Error("LOCAL_SERVICE_KEY_SENTINEL");
    });

    let message = "";
    try {
      readLocalSupabaseRuntime();
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toBe("Local Supabase is unavailable. Start the project stack first.");
    expect(message).not.toContain("SENTINEL");
  });
});
