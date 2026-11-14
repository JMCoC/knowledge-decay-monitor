import { migrationStage } from "./analysis-upgrade-policy.mjs";

const s3Names = new Set([
  "20261108150000_s3_01_review_enums.sql",
  "20261108150100_s3_01_review_model.sql",
  "20261108150200_s3_01_review_integrity.sql",
  "20261108150300_s3_01_review_security.sql",
  "20261108150400_s3_01_review_audit_outbox.sql",
  "20261108150500_s3_01_approval_contribution_check.sql",
]);

function migrationName(path) {
  const normalized = path.replaceAll("\\", "/");
  if (!/^supabase\/migrations\/[a-z0-9_]+\.sql$/.test(normalized)) {
    throw new Error("Unexpected migration path.");
  }
  return normalized.slice("supabase/migrations/".length);
}

/** @param {string} path @returns {"s2" | "s3_01"} */
export function reviewMigrationStage(path) {
  const name = migrationName(path);
  if (s3Names.has(name)) return "s3_01";
  const stage = migrationStage(`supabase/migrations/${name}`);
  return stage === "s3_01" ? "s3_01" : "s2";
}

/** @param {string} path @param {"s2" | "s3_01"} stage */
export function includeReviewMigration(path, stage) {
  if (stage !== "s2" && stage !== "s3_01") throw new Error("Unknown review upgrade stage.");
  const migration = reviewMigrationStage(path);
  return stage === "s3_01" || migration === "s2";
}
