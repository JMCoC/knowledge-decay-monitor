import { describe, expect, it, vi } from "vitest";

describe("Playwright acceptance configuration", () => {
  it("uses only Chromium, does not persist browser content, and configures local/CI server behavior", async () => {
    const originalCI = process.env.CI;

    try {
      delete process.env.CI;
      vi.resetModules();

      const { default: localConfig } = await import("../../playwright.config");

      expect(localConfig.projects?.map((project) => project.name)).toEqual(["chromium"]);
      expect(localConfig.use?.trace).toBe("off");
      expect(localConfig.use?.video).toBe("off");
      expect(localConfig.use?.screenshot).toBe("off");

      const localWebServer = Array.isArray(localConfig.webServer)
        ? localConfig.webServer[0]
        : localConfig.webServer;

      expect(localWebServer?.reuseExistingServer).toBe(true);
      expect(localWebServer?.env).toMatchObject({
        NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
        KDM_LOCAL_SUPABASE_URL: "http://127.0.0.1:54321",
        KDM_DISABLE_SENTRY: "1",
        NEXT_PUBLIC_KDM_DISABLE_SENTRY: "1",
        KDM_SENTRY_DIAGNOSTICS_ENABLED: "0",
        NEXT_PUBLIC_KDM_SENTRY_LOCAL_ENABLED: "0",
      });

      process.env.CI = "1";
      vi.resetModules();

      const { default: ciConfig } = await import("../../playwright.config");

      const ciWebServer = Array.isArray(ciConfig.webServer)
        ? ciConfig.webServer[0]
        : ciConfig.webServer;

      expect(ciWebServer?.reuseExistingServer).toBe(false);
    } finally {
      if (originalCI === undefined) delete process.env.CI;
      else process.env.CI = originalCI;

      vi.resetModules();
    }
  });
});