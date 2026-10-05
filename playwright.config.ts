import { defineConfig, devices, type Project } from "@playwright/test";
import { resolve } from "node:path";

const PROJECT_ROOT = process.cwd();
const LOCAL_API_URL = "http://127.0.0.1:54321";
const LOCAL_APP_ORIGIN = "http://127.0.0.1:3000";

const node = process.execPath;
const nextCli = resolve(PROJECT_ROOT, "node_modules/next/dist/bin/next");
const projects: Project[] = [
  {
    name: "chromium",
    use: { ...devices["Desktop Chrome"] },
  },
];

if (process.env.KDM_TEST_EDGE === "1") {
  projects.push({
    name: "msedge",
    use: { ...devices["Desktop Edge"], channel: "msedge" },
  });
}

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "list",
  outputDir: ".artifacts/playwright",
  timeout: 90_000,
  expect: {
    timeout: 10_000,
  },

  use: {
    baseURL: process.env.PLAYWRIGHT_TEST_BASE_URL || LOCAL_APP_ORIGIN,
    trace: "off",
    video: "off",
    screenshot: "off",
  },

  projects,

  webServer: {
    command: `"${node}" "${nextCli}" start --hostname 127.0.0.1 --port 3000`,
    cwd: PROJECT_ROOT,
    url: `${LOCAL_APP_ORIGIN}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "ignore",

    env: {
      NEXT_PUBLIC_SUPABASE_URL: LOCAL_API_URL,
      KDM_LOCAL_SUPABASE_URL: LOCAL_API_URL,
      KDM_DISABLE_SENTRY: "1",
      NEXT_PUBLIC_KDM_DISABLE_SENTRY: "1",
      KDM_SENTRY_DIAGNOSTICS_ENABLED: "0",
      KDM_SENTRY_DIAGNOSTICS_OPERATOR_IDS: "",
      KDM_SENTRY_DIAGNOSTICS_EXPIRES_AT: "",
      NEXT_PUBLIC_KDM_SENTRY_LOCAL_ENABLED: "0",
    },
  },
});
