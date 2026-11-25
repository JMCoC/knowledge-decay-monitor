import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import {
  includeReviewMigration,
  reviewMigrationStage,
} from "../../scripts/review-upgrade-policy.mjs";

const s3Migrations = [
  "20261108150000_s3_01_review_enums.sql",
  "20261108150100_s3_01_review_model.sql",
  "20261108150200_s3_01_review_integrity.sql",
  "20261108150300_s3_01_review_security.sql",
  "20261108150400_s3_01_review_audit_outbox.sql",
  "20261108150500_s3_01_approval_contribution_check.sql",
];
const s302Migrations = [
  "20261114150000_s3_02_review_audit_enum.sql",
  "20261114150100_s3_02_review_model.sql",
  "20261114150200_s3_02_review_coverage_guards.sql",
  "20261114150300_s3_02_review_command_support.sql",
  "20261114150400_s3_02_finding_commands.sql",
  "20261114150500_s3_02_round_commands.sql",
  "20261114150600_s3_02_findings_projection.sql",
];
const s305Migrations = [
  "20261116120000_s3_05_correction_processing.sql",
  "20261117120000_s3_05_candidate_lifecycle.sql",
  "20261117130000_s3_05_member_processing_read.sql",
  "20261121120000_s3_05_enqueue_lock_budget_fix.sql",
  "20261121130000_s3_05_correction_worker_reads.sql",
];

describe("review migration stages", () => {
  it("pins the S3-02 allowlist to the migration files in the repository", () => {
    const files = readdirSync("supabase/migrations")
      .filter((name) => name.includes("_s3_02_"))
      .sort();
    expect(files).toEqual([...s302Migrations].sort());
  });

  it("pins the S3-05 allowlist to the migration files in the repository", () => {
    const files = readdirSync("supabase/migrations")
      .filter((name) => name.includes("_s3_05_"))
      .sort();
    expect(files).toEqual([...s305Migrations].sort());
  });

  it("recognizes the S2 baseline and the exact S3-01 migration allowlist", () => {
    expect(reviewMigrationStage("supabase/migrations/20261101190100_s2_11_notification_scheduler.sql"))
      .toBe("s2");
    for (const name of s3Migrations) {
      expect(reviewMigrationStage(`supabase/migrations/${name}`)).toBe("s3_01");
    }
    for (const name of s302Migrations) {
      expect(reviewMigrationStage(`supabase/migrations/${name}`)).toBe("s3_02");
    }
    expect(() => reviewMigrationStage("supabase/migrations/20261108150600_s3_01_unreviewed.sql"))
      .toThrow("Unreviewed migration in upgrade inventory.");
  });

  it("classifies S3-05 as a later stage without weakening the unknown-migration guard", () => {
    for (const name of s305Migrations) {
      expect(reviewMigrationStage(`supabase/migrations/${name}`)).toBe("s3_05");
    }
    expect(() => reviewMigrationStage("supabase/migrations/20990101000000_s9_99_unknown.sql"))
      .toThrow("Unreviewed migration in upgrade inventory.");
  });

  it("keeps S3-02 out of the S3-01 baseline and includes it only in the S3-02 stage", () => {
    const s2 = "supabase/migrations/20261101190100_s2_11_notification_scheduler.sql";
    expect(includeReviewMigration(s2, "s2")).toBe(true);
    expect(includeReviewMigration(s2, "s3_01")).toBe(true);
    for (const name of s3Migrations) {
      const migration = `supabase/migrations/${name}`;
      expect(includeReviewMigration(migration, "s2")).toBe(false);
      expect(includeReviewMigration(migration, "s3_01")).toBe(true);
      expect(includeReviewMigration(migration, "s3_02")).toBe(true);
    }
    for (const name of s302Migrations) {
      const migration = `supabase/migrations/${name}`;
      expect(includeReviewMigration(migration, "s2")).toBe(false);
      expect(includeReviewMigration(migration, "s3_01")).toBe(false);
      expect(includeReviewMigration(migration, "s3_02")).toBe(true);
    }
    for (const name of s305Migrations) {
      const migration = `supabase/migrations/${name}`;
      expect(includeReviewMigration(migration, "s2")).toBe(false);
      expect(includeReviewMigration(migration, "s3_01")).toBe(false);
      expect(includeReviewMigration(migration, "s3_02")).toBe(false);
      expect(includeReviewMigration(migration, "s3_05")).toBe(true);
    }
    expect(() => includeReviewMigration(s2, "remote" as "s2")).toThrow("Unknown review upgrade stage.");
  });

  it("rejects traversal, absolute paths, and URL-like inputs", () => {
    for (const path of [
      "../supabase/migrations/20261108150000_s3_01_review_enums.sql",
      "C:\\work\\supabase\\migrations\\20261108150000_s3_01_review_enums.sql",
      "https://project.supabase.co/supabase/migrations/20261108150000_s3_01_review_enums.sql",
    ]) {
      expect(() => reviewMigrationStage(path)).toThrow();
    }
  });
});
