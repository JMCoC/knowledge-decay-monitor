import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClient } = vi.hoisted(() => ({ createClient: vi.fn() }));

vi.mock("@supabase/supabase-js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@supabase/supabase-js")>();
  return { ...actual, createClient };
});
vi.mock("server-only", () => ({}));

import { createServiceClient } from "../../src/lib/supabase/service";

describe("server-only Supabase service client", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "server-secret-fixture");
  });

  it("fails closed without a server service key and does not echo it", () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");

    expect(() => createServiceClient()).toThrow("Privileged Supabase environment is missing");
    let message = "";
    try {
      createServiceClient();
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).not.toContain("server-secret-fixture");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("creates an isolated service client without session or cookie persistence", () => {
    createClient.mockReturnValue({ kind: "service-client" });

    expect(createServiceClient()).toEqual({ kind: "service-client" });
    expect(createClient).toHaveBeenCalledWith(
      "https://project.supabase.co",
      "server-secret-fixture",
      { auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false } },
    );
  });
});
