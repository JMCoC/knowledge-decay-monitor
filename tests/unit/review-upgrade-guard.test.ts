import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  isReviewUpgradeTemporaryRoot,
  reviewProjectResourcesOwned,
} from "../../scripts/check-review-upgrade.mjs";

function invoke(args: string[]) {
  return spawnSync(process.execPath, ["scripts/check-review-upgrade.mjs", ...args], {
    env: { ...process.env, CI: "", GITHUB_ACTIONS: "" },
    encoding: "utf8",
    windowsHide: true,
  });
}

describe("review upgrade runner guard", () => {
  it("rejects missing, remote, and extra arguments before starting external processes", () => {
    for (const args of [
      [],
      ["https://example.supabase.co"],
      ["--linked"],
      ["--ci", "--linked"],
      ["--disposable-local", "--project-ref", "abcdefghijklmnopqrst"],
      ["--disposable-local", "https://example.supabase.co"],
    ]) {
      const result = invoke(args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Use exactly one of --disposable-local or --ci.");
      expect(result.stderr).not.toContain("Docker container inventory");
    }
  });

  it("rejects CI mode outside GitHub Actions before process discovery", () => {
    const result = invoke(["--ci"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--ci is available only inside GitHub Actions.");
    expect(result.stderr).not.toContain("Docker container inventory");
  });

  it("stops only a project whose complete container set is owned by this run", () => {
    expect(reviewProjectResourcesOwned(["supabase_db_owned", "supabase_api_owned"], [
      "supabase_db_owned", "supabase_api_owned",
    ])).toBe(true);
    expect(reviewProjectResourcesOwned(["supabase_db_owned", "supabase_api_foreign"], [
      "supabase_db_owned",
    ])).toBe(false);
    expect(reviewProjectResourcesOwned(["supabase_db_owned"], [])).toBe(false);
  });

  it("removes temporary workspaces only below the generated runner prefix", () => {
    const tempRoot = join(tmpdir(), "kdm-review-temp-root");
    expect(isReviewUpgradeTemporaryRoot(
      join(tempRoot, "kdm-s3-01-upgrade-0123456789abcdef"),
      tempRoot,
      "kdm-s3-01-upgrade-",
    )).toBe(true);
    expect(isReviewUpgradeTemporaryRoot(
      join(tempRoot, "unrelated-project"),
      tempRoot,
      "kdm-s3-01-upgrade-",
    )).toBe(false);
    expect(isReviewUpgradeTemporaryRoot(
      join(tempRoot, "kdm-s3-01-fresh-0123456789abcdef"),
      tempRoot,
      "kdm-s3-01-upgrade-",
    )).toBe(false);
  });
});
