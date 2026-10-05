import { describe, expect, it } from "vitest";
import { localSupabaseTestConfig } from "../../tests/e2e/auth.helper";

describe("local E2E Supabase configuration", () => {
  it("rejects missing credentials instead of using a public-key fallback", () => {
    expect(() => localSupabaseTestConfig({})).toThrow(
      "Local Supabase test environment is missing or has the wrong API URL.",
    );
  });

  it("accepts only the expected loopback project", () => {
    expect(() =>
      localSupabaseTestConfig({
        KDM_LOCAL_SUPABASE_URL: "https://supabase.example",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "fixture",
      }),
    ).toThrow("Local Supabase test environment is missing or has the wrong API URL.");
  });

  it("accepts the local public URL and publishable key", () => {
    expect(
      localSupabaseTestConfig({
        KDM_LOCAL_SUPABASE_URL: "http://127.0.0.1:54321",
        NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "local-publishable-fixture",
      }),
    ).toEqual({ url: "http://127.0.0.1:54321", publishableKey: "local-publishable-fixture" });
  });

  it("rejects a remote public URL even when the local marker is present", () => {
    expect(() =>
      localSupabaseTestConfig({
        KDM_LOCAL_SUPABASE_URL: "http://127.0.0.1:54321",
        NEXT_PUBLIC_SUPABASE_URL: "https://example.invalid",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "synthetic-fixture",
      }),
    ).toThrow("Local Supabase test environment is missing or has the wrong API URL.");
  });
});
