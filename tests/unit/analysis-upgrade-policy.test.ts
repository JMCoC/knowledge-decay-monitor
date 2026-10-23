import { describe, expect, it } from "vitest";
import {
  filterFunctionConfigForStage,
  includeFunction,
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

const s204Names = [
  "20261012233545_s2_04_retrieval_estimation.sql",
];

const s206Names = [
  "20261015221607_s2_06_analysis_leases.sql",
  "20261017190000_s2_05_retrieval_snapshot.sql",
  "20261017190100_s2_05_estimate_commands.sql",
  "20261017190110_s2_05_estimate_json_validation_fix.sql",
  "20261017190120_s2_05_empty_comparison_normalization.sql",
  "20261017190130_s2_05_empty_comparison_array_fix.sql",
  "20261017190200_s2_05_run_commands.sql",
  "20261017190210_s2_05_analysis_estimate_timeouts.sql",
  "20261017205245_s2_05_worker_handoff.sql",
  "20261017230309_s2_05_analysis_recovery.sql",
  "20261018021500_s2_05_materialized_candidate_snapshots.sql",
  "20261018022500_s2_05_empty_comparison_candidate_snapshot.sql",
];

const s203Names = [
  "20261011030000_s2_03_eligible_documents_projection.sql",
];

const s208aNames = [
  "20261021164507_s2_08a_analysis_finalization.sql",
  "20261021181000_s2_08a_fix_persist_initial_checkpoint.sql",
];

describe("analysis migration upgrade stages", () => {
  it("classifies every reviewed S1 and S2 migration by its exact name", () => {
    for (const name of s1Names) {
      expect(migrationStage(`supabase/migrations/${name}`)).toBe("s1");
    }
    for (const name of s201Names) {
      expect(migrationStage(`supabase/migrations/${name}`)).toBe("s2_01");
    }
    for (const name of s204Names) {
      expect(migrationStage(`supabase/migrations/${name}`)).toBe("s2_04");
    }
    for (const name of s206Names) {
      expect(migrationStage(`supabase/migrations/${name}`)).toBe("s2_06");
    }
    for (const name of s203Names) {
      expect(migrationStage(`supabase/migrations/${name}`)).toBe("s2_03");
    }
    for (const name of s208aNames) {
      expect(migrationStage(`supabase/migrations/${name}`)).toBe("s2_08a");
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
    const s203 = "supabase/migrations/20261011030000_s2_03_eligible_documents_projection.sql";
    const s204 = "supabase/migrations/20261012233545_s2_04_retrieval_estimation.sql";
    const s206 = "supabase/migrations/20261015221607_s2_06_analysis_leases.sql";
    const s205Worker = "supabase/migrations/20261017205245_s2_05_worker_handoff.sql";
    const s205Recovery = "supabase/migrations/20261017230309_s2_05_analysis_recovery.sql";
    const s205CandidateSnapshots = "supabase/migrations/20261018021500_s2_05_materialized_candidate_snapshots.sql";
    const s205EmptySnapshot = "supabase/migrations/20261018022500_s2_05_empty_comparison_candidate_snapshot.sql";
    const s208a = "supabase/migrations/20261021164507_s2_08a_analysis_finalization.sql";
    expect(includeMigration(s1, "s1")).toBe(true);
    expect(includeMigration(s201, "s1")).toBe(false);
    expect(includeMigration(s1, "s2_01")).toBe(true);
    expect(includeMigration(s201, "s2_01")).toBe(true);
    expect(includeMigration(s202, "s2_01")).toBe(false);
    expect(includeMigration(s202, "s2_02")).toBe(true);
    expect(includeMigration(s203, "s2_02")).toBe(false);
    expect(includeMigration(s203, "s2_03")).toBe(true);
    expect(includeMigration(s204, "s2_03")).toBe(false);
    expect(includeMigration(s204, "s2_02")).toBe(false);
    expect(includeMigration(s204, "s2_04")).toBe(true);
    expect(includeMigration(s206, "s2_04")).toBe(false);
    expect(includeMigration(s206, "s2_06")).toBe(true);
    expect(includeMigration(s205Recovery, "s2_04")).toBe(false);
    expect(includeMigration(s205Recovery, "s2_06")).toBe(true);
    expect(includeMigration(s205Worker, "s2_04")).toBe(false);
    expect(includeMigration(s205Worker, "s2_06")).toBe(true);
    expect(includeMigration(s205CandidateSnapshots, "s2_04")).toBe(false);
    expect(includeMigration(s205CandidateSnapshots, "s2_06")).toBe(true);
    expect(includeMigration(s205EmptySnapshot, "s2_04")).toBe(false);
    expect(includeMigration(s205EmptySnapshot, "s2_06")).toBe(true);
    expect(includeMigration(s208a, "s2_06")).toBe(false);
    expect(includeMigration(s208a, "s2_08a")).toBe(true);
  });

  it("normalizes Windows separators and rejects paths or names outside the inventory", () => {
    expect(migrationStage("supabase\\migrations\\00001_initial_schema.sql")).toBe("s1");
    expect(() => migrationStage("../untrusted.sql")).toThrow();
    expect(() => migrationStage("C:\\work\\supabase\\migrations\\00001_initial_schema.sql")).toThrow();
    expect(() => migrationStage("supabase/migrations/20990101000001_unreviewed.sql")).toThrow();
    expect(() => includeMigration("supabase/migrations/00001_initial_schema.sql", "s3" as MigrationStage)).toThrow();
  });
});

describe("analysis function upgrade stages", () => {
  it("includes only functions at or before the requested stage", () => {
    const embed = "supabase/functions/embed/index.ts";
    const analyze = "supabase/functions/analyze/index.ts";
    const cases: ReadonlyArray<readonly [string, MigrationStage, boolean]> = [
      [embed, "s1", true],
      [analyze, "s1", false],
      [analyze, "s2_01", false],
      [analyze, "s2_04", false],
      [analyze, "s2_06", true],
      [embed, "s2_06", true],
    ];
    for (const [path, stage, expected] of cases) {
      expect(includeFunction(path, stage)).toBe(expected);
    }
  });

  it("rejects functions outside the reviewed inventory", () => {
    expect(() => includeFunction("supabase/functions/unknown/index.ts", "s1"))
      .toThrow("Unreviewed function in upgrade inventory.");
    expect(() => includeFunction("supabase/functions/embed/index.ts", "s3" as MigrationStage)).toThrow();
  });
});

describe("analysis function config upgrade stages", () => {
  it("omits function config for functions not included at the requested stage", () => {
    const config = [
      'project_id = "test"',
      "",
      "[functions.embed]",
      "verify_jwt = false",
      "",
      "[functions.analyze]",
      "verify_jwt = false",
      "",
      "[db]",
      "port = 54322",
    ].join("\r\n");
    const expectedS1Config = [
      'project_id = "test"',
      "",
      "[functions.embed]",
      "verify_jwt = false",
      "",
      "[db]",
      "port = 54322",
    ].join("\r\n");
    expect(filterFunctionConfigForStage(config, "s1")).toBe(expectedS1Config);
    expect(filterFunctionConfigForStage(config, "s2_06")).toBe(config);
  });
});
