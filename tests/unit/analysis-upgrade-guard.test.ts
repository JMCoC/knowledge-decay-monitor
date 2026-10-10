import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("refuses the disposable upgrade harness outside CI before touching Docker", () => {
  const result = spawnSync(process.execPath, ["scripts/check-analysis-upgrade.mjs"], {
    env: { ...process.env, CI: "", GITHUB_ACTIONS: "" },
    encoding: "utf8",
    windowsHide: true,
  });

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Disposable CI is required.");
});
