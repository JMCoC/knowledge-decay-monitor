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
  });
});
