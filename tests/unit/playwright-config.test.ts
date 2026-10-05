import { describe, expect, it } from "vitest";
import config from "../../playwright.config";

describe("Playwright acceptance configuration", () => {
  it("uses only Chromium and does not persist browser content", () => {
    expect(config.projects?.map((project) => project.name)).toEqual(["chromium"]);
    expect(config.use?.trace).toBe("off");
    expect(config.use?.video).toBe("off");
    expect(config.use?.screenshot).toBe("off");
    const webServer = Array.isArray(config.webServer) ? config.webServer[0] : config.webServer;
    expect(webServer?.reuseExistingServer).toBe(false);
    expect(webServer?.env).toMatchObject({
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
      KDM_LOCAL_SUPABASE_URL: "http://127.0.0.1:54321",
      KDM_DISABLE_SENTRY: "1",
      NEXT_PUBLIC_KDM_DISABLE_SENTRY: "1",
      KDM_SENTRY_DIAGNOSTICS_ENABLED: "0",
      NEXT_PUBLIC_KDM_SENTRY_LOCAL_ENABLED: "0",
    });
  });
});
