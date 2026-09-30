import { afterEach, describe, expect, it, vi } from "vitest";
import { getAppOrigin } from "../../src/lib/app-origin";

describe("application origin", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses the loopback origin for local development when no override is set", () => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("APP_ORIGIN", "");
    delete process.env.APP_ORIGIN;

    expect(getAppOrigin()).toBe("http://127.0.0.1:3000");
  });

  it.each([
    "https://knowledge-decay-monitor-git-develop-kdm17.vercel.app",
    "https://knowledge-decay-monitor.vercel.app",
  ])("accepts the configured hosted origin %s", (origin) => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("APP_ORIGIN", origin);

    expect(getAppOrigin()).toBe(origin);
  });

  it("requires an explicit origin on Vercel", () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("APP_ORIGIN", "");
    delete process.env.APP_ORIGIN;

    expect(() => getAppOrigin()).toThrow("APP_ORIGIN is required on Vercel");
  });

  it.each([
    "http://example.com",
    "https://user:password@example.com",
    "https://example.com/path",
    "https://example.com/?next=https://attacker.example",
    "https://example.com/#fragment",
    "not a URL",
  ])("rejects invalid origin %s", (origin) => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("APP_ORIGIN", origin);

    expect(() => getAppOrigin()).toThrow("APP_ORIGIN is invalid");
  });
});
