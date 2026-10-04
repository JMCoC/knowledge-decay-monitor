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
});
