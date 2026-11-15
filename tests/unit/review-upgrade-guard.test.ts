import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  includeReviewDatabaseTestFile,
  isReviewUpgradeTemporaryRoot,
  reviewProjectResourcesOwned,
  reviewStorageObjectUrl,
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
      join(tempRoot, "kdm-s3-review-upgrade-0123456789abcdef"),
      tempRoot,
      "kdm-s3-review-upgrade-",
    )).toBe(true);
    expect(isReviewUpgradeTemporaryRoot(
      join(tempRoot, "unrelated-project"),
      tempRoot,
      "kdm-s3-review-upgrade-",
    )).toBe(false);
    expect(isReviewUpgradeTemporaryRoot(
      join(tempRoot, "kdm-s3-review-fresh-0123456789abcdef"),
      tempRoot,
      "kdm-s3-review-upgrade-",
    )).toBe(false);
  });

  it("copies review database tests only into compatible historical stages", () => {
    expect(includeReviewDatabaseTestFile("s3_01_review.test.sql", "s2")).toBe(false);
    expect(includeReviewDatabaseTestFile("s3_02_review.test.sql", "s2")).toBe(false);
    expect(includeReviewDatabaseTestFile("s3_02_review.test.sql", "s3_01")).toBe(false);
    expect(includeReviewDatabaseTestFile("s3_01_review.test.sql", "s3_01")).toBe(true);
    expect(includeReviewDatabaseTestFile("s3_01_review.test.sql", "s3_02")).toBe(true);
    expect(includeReviewDatabaseTestFile("s3_02_review.test.sql", "s3_02")).toBe(true);
  });

  it("opens a transaction before loading ON COMMIT DROP upgrade fixture helpers", () => {
    const fixture = readFileSync("supabase/tests/database/s3_02_review_upgrade_fixture.psql", "utf8");
    const transactionStart = fixture.indexOf("begin;");
    const helperInclude = fixture.indexOf("\\ir s3_02_upgrade_s3_01_fixtures.psql");

    expect(transactionStart).toBeGreaterThanOrEqual(0);
    expect(helperInclude).toBeGreaterThan(transactionStart);
  });

  it("restricts original-byte verification to canonical objects in local Storage", () => {
    const path = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-000000000001/30000000-0000-4000-8000-000000000001/original.md";
    expect(reviewStorageObjectUrl("http://127.0.0.1:56601", path, "upload")).toBe(
      `http://127.0.0.1:56601/storage/v1/object/documents/${path}`,
    );
    expect(reviewStorageObjectUrl("http://127.0.0.1:56601", path, "download")).toBe(
      `http://127.0.0.1:56601/storage/v1/object/authenticated/documents/${path}`,
    );
    expect(() => reviewStorageObjectUrl("https://example.supabase.co", path, "upload")).toThrow();
    expect(() => reviewStorageObjectUrl("http://127.0.0.1:56601", `../${path}`, "download")).toThrow();
  });
});
