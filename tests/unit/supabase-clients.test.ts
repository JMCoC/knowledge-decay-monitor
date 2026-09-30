import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSupabaseEnv } from "../../src/lib/supabase/env";
import {
  createReadOnlyClient,
  createWritableClient,
} from "../../src/lib/supabase/server";

const mocks = vi.hoisted(() => ({
  createBrowserClient: vi.fn(),
  createServerClient: vi.fn(),
  cookieStore: {
    getAll: vi.fn(() => [] as { name: string; value: string }[]),
    set: vi.fn(),
  },
}));

vi.mock("@supabase/ssr", () => ({
  createBrowserClient: mocks.createBrowserClient,
  createServerClient: mocks.createServerClient,
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => mocks.cookieStore),
}));

vi.mock("server-only", () => ({}));

describe("Supabase SSR cookie factories", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "local-test-key");
    mocks.createServerClient.mockReturnValue({ kind: "server-client" });
  });

  it("requires both public configuration values without echoing them", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");

    expect(() => getSupabaseEnv()).toThrow("Supabase public environment variables are missing");
    try {
      getSupabaseEnv();
    } catch (error) {
      expect(String(error)).not.toContain("127.0.0.1");
    }
  });

  it("uses a read-only cookie adapter in Server Components", async () => {
    const client = await createReadOnlyClient();
    const options = mocks.createServerClient.mock.calls[0]?.[2];

    expect(client).toEqual({ kind: "server-client" });
    expect(options.cookies.getAll()).toEqual([]);
    options.cookies.setAll([
      { name: "sb-session", value: "refreshed-token", options: { path: "/" } },
    ]);
    expect(mocks.cookieStore.set).not.toHaveBeenCalled();
  });

  it("writes every cookie chunk from a Server Action or Route Handler", async () => {
    await createWritableClient();
    const options = mocks.createServerClient.mock.calls[0]?.[2];
    const chunks = [
      { name: "sb-auth-token.0", value: "first", options: { path: "/", httpOnly: true } },
      { name: "sb-auth-token.1", value: "second", options: { path: "/", httpOnly: true } },
    ];

    options.cookies.setAll(chunks);

    expect(mocks.cookieStore.set.mock.calls).toEqual(
      chunks.map(({ name, value, options }) => [name, value, options]),
    );
  });

  it("propagates cookie-write errors instead of reporting a successful mutation", async () => {
    mocks.cookieStore.set.mockImplementation(() => {
      throw new Error("write failed");
    });
    await createWritableClient();
    const options = mocks.createServerClient.mock.calls[0]?.[2];

    expect(() =>
      options.cookies.setAll([
        { name: "sb-auth-token", value: "value", options: { path: "/" } },
      ]),
    ).toThrow("write failed");
  });

  it("lets a Route Handler defer cookie writes until its final response is chosen", async () => {
    const onCookieWrite = vi.fn();
    await createWritableClient(onCookieWrite);
    const options = mocks.createServerClient.mock.calls[0]?.[2];
    const chunks = [
      { name: "sb-auth-token.0", value: "first", options: { path: "/" } },
      { name: "sb-auth-token.1", value: "second", options: { path: "/" } },
    ];

    options.cookies.setAll(chunks, { "Cache-Control": "private, no-store" });

    expect(mocks.cookieStore.set).not.toHaveBeenCalled();
    expect(onCookieWrite).toHaveBeenCalledWith(chunks, { "Cache-Control": "private, no-store" });
  });
});
