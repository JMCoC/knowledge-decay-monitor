import { defineConfig, devices, type Project } from "@playwright/test";
import { resolve } from "node:path";

const PROJECT_ROOT = process.cwd();
const LOCAL_API_URL = process.env.KDM_LOCAL_SUPABASE_URL || "http://127.0.0.1:54321";
const LOCAL_APP_ORIGIN = "http://127.0.0.1:3000";

const node = process.execPath;
const nextCli = resolve(PROJECT_ROOT, "node_modules/next/dist/bin/next");
const appOrigin = process.env.PLAYWRIGHT_TEST_BASE_URL || LOCAL_APP_ORIGIN;
const appPort = new URL(appOrigin).port || "80";
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
  // The suite owns one consumer of a shared local queue, including crash tests.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "list",
  outputDir: ".artifacts/playwright",
  timeout: 90_000,
  expect: {
    timeout: 10_000,
  },

  use: {
    baseURL: appOrigin,
    trace: "off",
    video: "off",
    screenshot: "off",
  },

  projects,

  webServer: {
    command: `"${node}" "${nextCli}" start --hostname 127.0.0.1 --port ${appPort}`,
    cwd: PROJECT_ROOT,
    url: `${appOrigin}/login`,
    // Local suites must boot Next with the same disposable/local Supabase
    // credentials as the test process. Never reuse a developer's stale server.
    reuseExistingServer: process.env.KDM_LOCAL_SUPABASE_URL ? false : !process.env.CI,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "ignore",

    env: {
      NEXT_PUBLIC_SUPABASE_URL: LOCAL_API_URL,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || "",
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
      KDM_LOCAL_SUPABASE_URL: LOCAL_API_URL,
      KDM_LOCAL_SUPABASE_PROJECT_ID: process.env.KDM_LOCAL_SUPABASE_PROJECT_ID || "knowledge-decay-monitor-s1-02",
      KDM_LOCAL_SUPABASE_WORKDIR: process.env.KDM_LOCAL_SUPABASE_WORKDIR || PROJECT_ROOT,
      KDM_LOCAL_SUPABASE_DISPOSABLE: process.env.KDM_LOCAL_SUPABASE_DISPOSABLE || "",
      KDM_DISABLE_SENTRY: "1",
      NEXT_PUBLIC_KDM_DISABLE_SENTRY: "1",
      KDM_SENTRY_DIAGNOSTICS_ENABLED: "0",
      KDM_SENTRY_DIAGNOSTICS_OPERATOR_IDS: "",
      KDM_SENTRY_DIAGNOSTICS_EXPIRES_AT: "",
      NEXT_PUBLIC_KDM_SENTRY_LOCAL_ENABLED: "0",
    },
  },
});
