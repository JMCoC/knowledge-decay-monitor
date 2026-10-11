import { describe, expect, it } from "vitest";
import {
  includeMigration,
  migrationStage,
  type MigrationStage,
} from "../../scripts/analysis-upgrade-policy.mjs";

const s1Names = [
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
];

const s201Names = [
  "20261010192119_s2_01_analysis_tables.sql",
  "20261010193514_s2_01_analysis_integrity.sql",
  "20261010194238_s2_01_analysis_security.sql",
  "20261010195500_s2_01_finding_initial_state.sql",
];

describe("analysis migration upgrade stages", () => {
  it("classifies every reviewed S1 and S2-01 migration by its exact name", () => {
    for (const name of s1Names) {
      expect(migrationStage(`supabase/migrations/${name}`)).toBe("s1");
    }
    for (const name of s201Names) {
      expect(migrationStage(`supabase/migrations/${name}`)).toBe("s2_01");
    }
    for (const name of [
      "20261011013954_s2_02_credit_operations.sql",
      "20261011014828_s2_02_credit_reads.sql",
      "20261011020726_s2_02_workspace_promotion.sql",
      "20990101000000_s2_02_credit_operations.sql",
    ]) {
      expect(migrationStage(`supabase/migrations/${name}`)).toBe("s2_02");
    }
  });

  it("includes only migrations at or before the requested stage", () => {
    const s1 = "supabase/migrations/00001_initial_schema.sql";
    const s201 = "supabase/migrations/20261010192119_s2_01_analysis_tables.sql";
    const s202 = "supabase/migrations/20990101000000_s2_02_credit_operations.sql";
    expect(includeMigration(s1, "s1")).toBe(true);
    expect(includeMigration(s201, "s1")).toBe(false);
    expect(includeMigration(s1, "s2_01")).toBe(true);
    expect(includeMigration(s201, "s2_01")).toBe(true);
    expect(includeMigration(s202, "s2_01")).toBe(false);
    expect(includeMigration(s202, "s2_02")).toBe(true);
  });

  it("normalizes Windows separators and rejects paths or names outside the inventory", () => {
    expect(migrationStage("supabase\\migrations\\00001_initial_schema.sql")).toBe("s1");
    expect(() => migrationStage("../untrusted.sql")).toThrow();
    expect(() => migrationStage("C:\\work\\supabase\\migrations\\00001_initial_schema.sql")).toThrow();
    expect(() => migrationStage("supabase/migrations/20990101000001_unreviewed.sql")).toThrow();
    expect(() => includeMigration("supabase/migrations/00001_initial_schema.sql", "s3" as MigrationStage)).toThrow();
  });
});
