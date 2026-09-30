import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

const PROJECT_ROOT = process.cwd();
const LOCAL_API_URL = "http://127.0.0.1:54321";
const LOCAL_APP_ORIGIN = "http://127.0.0.1:3000";

const node = process.execPath;
const nextCli = resolve(PROJECT_ROOT, "node_modules/next/dist/bin/next");

export default defineConfig({
  testDir: "./tests/e2e/auth",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  outputDir: ".artifacts/playwright",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: LOCAL_APP_ORIGIN,
    trace: "off",
    screenshot: "off",
    video: "off",
    browserName: "chromium",
  },
  webServer: {
    command: `"${node}" "${nextCli}" start --hostname 127.0.0.1 --port 3000`,
    cwd: PROJECT_ROOT,
    url: `${LOCAL_APP_ORIGIN}/login`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "ignore",
    env: {
      NEXT_PUBLIC_SUPABASE_URL: LOCAL_API_URL,
      KDM_LOCAL_SUPABASE_URL: LOCAL_API_URL,
      KDM_DISABLE_SENTRY: "1",
      NEXT_PUBLIC_KDM_DISABLE_SENTRY: "1",
    },
  },
});
