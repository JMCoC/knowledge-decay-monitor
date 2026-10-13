const s1Names = new Set([
  "00001_initial_schema.sql",
  "20260930182112_reserve_document.sql",
  "20261003044516_s1_02_upload_expand.sql",
  "20261003045927_s1_02_upload_cutover.sql",
  "20261003051326_s1_02_upload_rpc_fix.sql",
  "20261003114725_s1_02_upload_conflict_fix.sql",
  "20261003124137_s1_02_upload_cleanup_marker.sql",
  "20261003130519_s1_02_upload_resume_target.sql",
  "20261003131708_s1_02_legacy_reference_provenance.sql",
  "20261003134628_s1_02_rpc_conflict_state.sql",
  "20261003143620_s1_02_legacy_reconciliation.sql",
  "20261003143823_s1_02_legacy_reconciliation_fix.sql",
  "20261003150154_s1_02_repository_projection.sql",
  "20261003214934_s1_02_upload_resume_reference_guard.sql",
  "20261006172303_finish_processing.sql",
  "20261009024630_first_vertical_processing_guard.sql",
  "20261009024913_first_vertical_repository_lease_read.sql",
  "20261009120000_durable_ingestion_jobs.sql",
  "20261009120100_durable_repository_projection.sql",
  "20261009124615_guard_legacy_processing_claims.sql",
  "20261009134833_enqueue_lock_budget.sql",
]);

const s201Names = new Set([
  "20261010192119_s2_01_analysis_tables.sql",
  "20261010193514_s2_01_analysis_integrity.sql",
  "20261010194238_s2_01_analysis_security.sql",
  "20261010195500_s2_01_finding_initial_state.sql",
]);

const s204Names = new Set([
  "20261012233545_s2_04_retrieval_estimation.sql",
]);

const stageOrder = Object.freeze({ s1: 0, s2_01: 1, s2_02: 2, s2_04: 3 });

/** @param {string} path */
export function migrationStage(path) {
  const normalized = path.replaceAll("\\", "/");
  if (!/^supabase\/migrations\/[a-z0-9_]+\.sql$/.test(normalized)) {
    throw new Error("Unexpected migration path.");
  }

  const name = normalized.slice("supabase/migrations/".length);
  if (s1Names.has(name)) return "s1";
  if (s201Names.has(name)) return "s2_01";
  if (/^\d{14}_s2_02_(credit_operations|credit_reads|workspace_promotion)\.sql$/.test(name)) {
    return "s2_02";
  }
  if (s204Names.has(name)) return "s2_04";
  throw new Error("Unreviewed migration in upgrade inventory.");
}

/**
 * @param {string} path
 * @param {"s1" | "s2_01" | "s2_02" | "s2_04"} stage
 */
export function includeMigration(path, stage) {
  if (!Object.hasOwn(stageOrder, stage)) throw new Error("Unknown upgrade stage.");
  return stageOrder[migrationStage(path)] <= stageOrder[stage];
}
