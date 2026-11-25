import { migrationStage } from "./analysis-upgrade-policy.mjs";

const s3Names = new Set([
  "20261108150000_s3_01_review_enums.sql",
  "20261108150100_s3_01_review_model.sql",
  "20261108150200_s3_01_review_integrity.sql",
  "20261108150300_s3_01_review_security.sql",
  "20261108150400_s3_01_review_audit_outbox.sql",
  "20261108150500_s3_01_approval_contribution_check.sql",
]);

const s302Names = new Set([
  "20261114150000_s3_02_review_audit_enum.sql",
  "20261114150100_s3_02_review_model.sql",
  "20261114150200_s3_02_review_coverage_guards.sql",
  "20261114150300_s3_02_review_command_support.sql",
  "20261114150400_s3_02_finding_commands.sql",
  "20261114150500_s3_02_round_commands.sql",
  "20261114150600_s3_02_findings_projection.sql",
]);

const s305Names = new Set([
  "20261116120000_s3_05_correction_processing.sql",
  "20261117120000_s3_05_candidate_lifecycle.sql",
  "20261117130000_s3_05_member_processing_read.sql",
  "20261121120000_s3_05_enqueue_lock_budget_fix.sql",
  "20261121130000_s3_05_correction_worker_reads.sql",
]);

function migrationName(path) {
  const normalized = path.replaceAll("\\", "/");
  if (!/^supabase\/migrations\/[a-z0-9_]+\.sql$/.test(normalized)) {
    throw new Error("Unexpected migration path.");
  }
  return normalized.slice("supabase/migrations/".length);
}

/** @param {string} path @returns {"s2" | "s3_01" | "s3_02" | "s3_05"} */
export function reviewMigrationStage(path) {
  const name = migrationName(path);
  if (s302Names.has(name)) return "s3_02";
  if (s3Names.has(name)) return "s3_01";
  if (s305Names.has(name)) return "s3_05";
  const stage = migrationStage(`supabase/migrations/${name}`);
  if (stage === "s3_01" || stage === "s3_02" || stage === "s3_05") return stage;
  return "s2";
}

/** @param {string} path @param {"s2" | "s3_01" | "s3_02" | "s3_05"} stage */
export function includeReviewMigration(path, stage) {
  if (stage !== "s2" && stage !== "s3_01" && stage !== "s3_02" && stage !== "s3_05") {
    throw new Error("Unknown review upgrade stage.");
  }
  const migration = reviewMigrationStage(path);
  const stageOrder = { s2: 0, s3_01: 1, s3_02: 2, s3_05: 3 };
  return stageOrder[migration] <= stageOrder[stage];
}
