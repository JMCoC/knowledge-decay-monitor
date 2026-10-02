import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../../src/app/auth/callback/route";

const mocks = vi.hoisted(() => ({
  createWritableClient: vi.fn(),
  verifyOtp: vi.fn(),
  verifyOtpError: null as Error | null,
  reportAuthFailure: vi.fn(),
}));

vi.mock("../../src/lib/supabase/server", () => ({
  createWritableClient: mocks.createWritableClient,
}));
vi.mock("../../src/lib/observability/auth-events", () => ({
  reportAuthFailure: mocks.reportAuthFailure,
}));

function validTokenRequest(extra = "") {
  return new NextRequest(
    `http://127.0.0.1:3000/auth/callback?token_hash=synthetic-token&type=recovery${extra}`,
  );
}

describe("recovery callback", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    mocks.verifyOtpError = null;
    mocks.createWritableClient.mockImplementation(async (writeCookies) => ({
      auth: {
        verifyOtp: vi.fn(async (input) => {
          mocks.verifyOtp(input);
          if (!mocks.verifyOtpError) {
            writeCookies(
              [
                { name: "sb-auth-token.0", value: "first", options: { path: "/", httpOnly: true } },
                { name: "sb-auth-token.1", value: "second", options: { path: "/", httpOnly: true } },
              ],
              { "Cache-Control": "private, no-store" },
            );
          }
          return { error: mocks.verifyOtpError };
        }),
      },
    }));
  });

  it.each([
    ["missing token", "http://127.0.0.1:3000/auth/callback?type=recovery", null],
    ["unsupported type", "http://127.0.0.1:3000/auth/callback?token_hash=synthetic-token&type=signup", null],
  ])("rejects %s without calling verifyOtp", async (_label, url) => {
    const response = await GET(new NextRequest(url as string));

    expect(mocks.createWritableClient).not.toHaveBeenCalled();
    expect(new URL(response.headers.get("location")!).pathname).toBe("/forgot-password");
    expect(new URL(response.headers.get("location")!).search).toBe("?error=invalid-link");
  });

  it("verifies only recovery tokens, fixes the destination, and preserves every cookie chunk", async () => {
    const response = await GET(validTokenRequest("&next=https%3A%2F%2Fexample.org"));

    expect(mocks.verifyOtp).toHaveBeenCalledWith({
      token_hash: "synthetic-token",
      type: "recovery",
    });
    const destination = new URL(response.headers.get("location")!);
    expect(destination.origin).toBe("http://127.0.0.1:3000");
    expect(destination.pathname).toBe("/reset-password");
    expect(destination.search).toBe("");
    expect(response.cookies.get("sb-auth-token.0")?.value).toBe("first");
    expect(response.cookies.get("sb-auth-token.1")?.value).toBe("second");
    expect(response.headers.get("cache-control")).toContain("private");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("returns to the configured hosted origin after recovery", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("APP_ORIGIN", "https://knowledge-decay-monitor-git-develop-kdm17.vercel.app");

    const response = await GET(validTokenRequest());

    expect(new URL(response.headers.get("location")!).origin).toBe(
      "https://knowledge-decay-monitor-git-develop-kdm17.vercel.app",
    );
    expect(new URL(response.headers.get("location")!).pathname).toBe("/reset-password");
    expect(response.cookies.get("sb-auth-token.0")?.value).toBe("first");
    expect(response.cookies.get("sb-auth-token.1")?.value).toBe("second");
  });

  it("discards cookie changes if token verification fails", async () => {
    mocks.verifyOtpError = new Error("provider details include synthetic token");

    const response = await GET(validTokenRequest("&next=https%3A%2F%2Fexample.org"));

    expect(new URL(response.headers.get("location")!).pathname).toBe("/forgot-password");
    expect(response.headers.get("location")).not.toContain("synthetic-token");
    expect(response.cookies.getAll()).toHaveLength(0);
    expect(mocks.reportAuthFailure).toHaveBeenCalledWith({
      operation: "recovery",
      code: "PROVIDER_ERROR",
      correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    });
    expect(JSON.stringify(mocks.reportAuthFailure.mock.calls)).not.toContain("synthetic-token");
  });
});
