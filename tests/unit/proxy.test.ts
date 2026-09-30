import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "../../src/proxy";

const mocks = vi.hoisted(() => ({ createServerClient: vi.fn() }));

vi.mock("@supabase/ssr", () => ({ createServerClient: mocks.createServerClient }));

describe("Supabase session Proxy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("refreshes every cookie chunk on the request and final response", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "local-test-key");
    mocks.createServerClient.mockImplementation((_url, _key, options) => ({
      auth: {
        getClaims: async () => {
          options.cookies.setAll([
            {
              name: "sb-auth-token.0",
              value: "first",
              options: { path: "/", httpOnly: true },
            },
            {
              name: "sb-auth-token.1",
              value: "second",
              options: { path: "/", httpOnly: true },
            },
          ], { "Cache-Control": "private, no-cache, no-store" });
          options.cookies.setAll([
            {
              name: "sb-auth-token.0",
              value: "replacement",
              options: { path: "/", httpOnly: true },
            },
          ], { Pragma: "no-cache" });
          return { data: { claims: { sub: "user-1" } }, error: null };
        },
      },
    }));
    const request = new NextRequest("http://127.0.0.1:3000/app");

    const response = await proxy(request);

    expect(request.cookies.get("sb-auth-token.0")?.value).toBe("replacement");
    expect(request.cookies.get("sb-auth-token.1")?.value).toBe("second");
    expect(response.cookies.get("sb-auth-token.0")?.value).toBe("replacement");
    expect(response.cookies.get("sb-auth-token.1")?.value).toBe("second");
    expect(response.headers.get("cache-control")).toContain("private");
    expect(response.headers.get("pragma")).toBe("no-cache");
  });

  it("keeps refreshed cookies if Proxy chooses a redirect response", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "local-test-key");
    mocks.createServerClient.mockImplementation((_url, _key, options) => ({
      auth: {
        getClaims: async () => {
          options.cookies.setAll([
            { name: "sb-refresh", value: "new", options: { path: "/" } },
          ], { "Cache-Control": "private, no-cache, no-store" });
          return { data: { claims: null }, error: null };
        },
      },
    }));
    const request = new NextRequest("http://127.0.0.1:3000/app");
    const response = await proxy(request);

    expect(response.status).toBe(307);
    const destination = new URL(response.headers.get("location")!);
    expect(destination.origin).toBe(request.nextUrl.origin);
    expect(destination.pathname).toBe("/login");
    expect(response.cookies.get("sb-refresh")?.value).toBe("new");
  });

  it("does not treat an Auth transport error as an anonymous session", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "local-test-key");
    mocks.createServerClient.mockReturnValue({
      auth: { getClaims: async () => ({ data: null, error: new Error("Auth unavailable") }) },
    });
    const request = new NextRequest("http://127.0.0.1:3000/app");

    const response = await proxy(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });
});
