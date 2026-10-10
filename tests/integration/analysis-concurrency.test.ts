import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { AnalysisJobStatus } from "../../src/types/contracts";
import {
  createAnalysisFixture,
  type AnalysisFixture,
} from "../support/analysis-fixtures";
import { assertLocalSupabaseReady } from "../support/local-supabase";
import {
  LocalSqlError,
  openLocalSqlSession,
  waitForSqlLock,
  type LocalSqlSession,
} from "../support/local-sql-session";

function sqlLiteral(value: string) {
  if (value.includes("\0")) throw new Error("Invalid local analysis SQL value.");
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlUuid(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("Invalid local analysis SQL identifier.");
  }
  return `${sqlLiteral(value)}::uuid`;
}

function insertAnalysisSql(fixture: AnalysisFixture, analysisId: string, status: AnalysisJobStatus) {
  return `insert into public.analyses(
    id,workspace_id,initiator_id,status,fixed_cost,reserved_credits,idempotency_key,
    request_fingerprint,retrieval_config,pricing_version,prompt_version,output_schema_version,provider_config
  ) values (
    ${sqlUuid(analysisId)},${sqlUuid(fixture.workspaceId)},${sqlUuid(fixture.adminId)},
    ${sqlLiteral(status)}::public.analysis_job_status,3,3,
    ${sqlLiteral(`concurrency-${analysisId}`)},${sqlLiteral(`fingerprint-${analysisId}`)},
    '{"topK":5}'::jsonb,'concurrency-pricing-v1','concurrency-prompt-v1',
    'concurrency-output-v1','{"primary":{"provider":"synthetic"}}'::jsonb
  );`;
}

function insertScopeSql(fixture: AnalysisFixture, analysisId: string, versionIndex: number, role: "source" | "comparison") {
  const version = fixture.versions[versionIndex];
  if (!version) throw new Error("The local analysis fixture version was not created.");
  return `insert into public.analysis_documents(analysis_id,workspace_id,document_id,version_id,role)
    values (${sqlUuid(analysisId)},${sqlUuid(fixture.workspaceId)},${sqlUuid(version.documentId)},
      ${sqlUuid(version.versionId)},${sqlLiteral(role)}::public.analysis_scope_role);`;
}

function insertEvidenceSql(fixture: AnalysisFixture, versionIndex: number, evidenceId = randomUUID()) {
  const version = fixture.versions[versionIndex];
  if (!version) throw new Error("The local analysis fixture version was not created.");
  return `insert into public.finding_evidence(
      id,workspace_id,analysis_id,finding_id,document_id,version_id,chunk_id,page_number,section,section_heading,snapshot
    ) values (
      ${sqlUuid(evidenceId)},${sqlUuid(fixture.workspaceId)},${sqlUuid(fixture.analysisId)},
      ${sqlUuid(fixture.findingId)},${sqlUuid(version.documentId)},${sqlUuid(version.versionId)},
      ${sqlUuid(version.chunkId)},1,'Concurrency','Synthetic section','Synthetic concurrency evidence'
    );`;
}

function captureConstraintSqlStateSql(statement: string) {
  const setting = `kdm.analysis_sqlstate_${randomUUID().replaceAll("-", "")}`;
  return `do $kdm_capture$
declare
  v_state text := 'ok';
begin
  begin
    ${statement}
  exception
    when unique_violation then v_state := SQLSTATE;
    when check_violation then v_state := SQLSTATE;
  end;
  perform set_config('${setting}', v_state, true);
end
$kdm_capture$;
select current_setting('${setting}', true);`;
}

function lastSqlValue(output: string) {
  return output.split(/\r?\n/).at(-1)?.trim() ?? "";
}

type SqlCapture = { ok: true; value: string } | { ok: false; error: unknown };

async function captureSql(query: Promise<string>): Promise<SqlCapture> {
  try {
    return { ok: true, value: await query };
  } catch (error) {
    return { ok: false, error };
  }
}

async function runSqlStep<T>(label: string, operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    const sqlState = error instanceof LocalSqlError ? ` (SQLSTATE ${error.sqlState ?? "unavailable"})` : "";
    const safeDetail = error instanceof Error && /^(Local analysis|Refusing to remove analysis rows)/.test(error.message)
      ? `: ${error.message}`
      : "";
    throw new Error(`${label} failed${sqlState}${safeDetail}.`);
  }
}

async function closeSessions(sessions: LocalSqlSession[]) {
  for (const session of sessions) {
    await session.query("rollback;").catch(() => undefined);
    await session.close();
  }
}

async function deleteTransientAnalysis(fixture: AnalysisFixture, analysisId: string) {
  await fixture.sql.query("begin;");
  await fixture.sql.query(`delete from public.analysis_documents where analysis_id = ${sqlUuid(analysisId)};`);
  await fixture.sql.query(`delete from public.analyses where id = ${sqlUuid(analysisId)};`);
  await fixture.sql.query("commit;");
}

async function runScopeCapacityRace(fixture: AnalysisFixture, blockerOutcome: "commit" | "rollback") {
  const sessions: LocalSqlSession[] = [];
  let blockedInsert: Promise<SqlCapture> | undefined;
  try {
    const a = await openLocalSqlSession("kdm_analysis_scope_a");
    sessions.push(a);
    const b = await openLocalSqlSession("kdm_analysis_scope_b");
    sessions.push(b);
    const observer = await openLocalSqlSession("kdm_analysis_scope_observer");
    sessions.push(observer);

    await runSqlStep("begin active transaction A", a.query("begin;"));
    await runSqlStep("begin active transaction B", b.query("begin;"));
    await a.query(insertScopeSql(fixture, fixture.analysisId, 19, "comparison"));
    blockedInsert = captureSql(b.query(insertScopeSql(fixture, fixture.analysisId, 20, "comparison")));
    await waitForSqlLock(observer, b.pid, a.pid);

    await a.query(`${blockerOutcome};`);
    const inserted = await blockedInsert;
    if (!inserted.ok) throw inserted.error;

    const constraintState = lastSqlValue(await b.query(captureConstraintSqlStateSql(
      `perform private.validate_analysis_integrity(${sqlUuid(fixture.analysisId)});`,
    )));
    if (blockerOutcome === "commit") {
      expect(constraintState).toBe("23514");
      await b.query("rollback;");
    } else {
      expect(constraintState).toBe("ok");
      await b.query("commit;");
    }

    const distinctVersions = await fixture.sql.query(
      `select count(distinct version_id)::text from public.analysis_documents where analysis_id = ${sqlUuid(fixture.analysisId)};`,
    );
    expect(distinctVersions).toBe("20");
  } finally {
    await closeSessions(sessions);
    await blockedInsert;
  }
}

async function runActiveAnalysisRace(
  fixture: AnalysisFixture,
  blockerOutcome: "commit" | "rollback",
  otherWorkspace?: AnalysisFixture,
) {
  const sessions: LocalSqlSession[] = [];
  let blockedInsert: Promise<string> | undefined;
  try {
    const a = await openLocalSqlSession("kdm_analysis_active_a");
    sessions.push(a);
    const b = await openLocalSqlSession("kdm_analysis_active_b");
    sessions.push(b);
    const observer = await openLocalSqlSession("kdm_analysis_active_observer");
    sessions.push(observer);

    await runSqlStep("begin active transaction A", a.query("begin;"));
    await runSqlStep("begin active transaction B", b.query("begin;"));
    const analysisA = randomUUID();
    const analysisB = randomUUID();
    await runSqlStep("insert active analysis A", a.query(insertAnalysisSql(fixture, analysisA, "queued")));
    await runSqlStep("scope active analysis A", a.query(insertScopeSql(fixture, analysisA, 0, "source")));
    blockedInsert = b.query(captureConstraintSqlStateSql(insertAnalysisSql(fixture, analysisB, "processing")));
    await waitForSqlLock(observer, b.pid, a.pid);

    let otherAnalysis: string | undefined;
    if (otherWorkspace) {
      const other = await openLocalSqlSession("kdm_analysis_other_tenant");
      sessions.push(other);
      otherAnalysis = randomUUID();
      await runSqlStep("begin independent workspace transaction", other.query("begin;"));
      await runSqlStep("insert independent active analysis", other.query(insertAnalysisSql(otherWorkspace, otherAnalysis, "processing")));
      await runSqlStep("scope independent active analysis", other.query(insertScopeSql(otherWorkspace, otherAnalysis, 0, "source")));
      await runSqlStep("commit independent workspace transaction", other.query("commit;"));
    }

    await runSqlStep(`finish active transaction A with ${blockerOutcome}`, a.query(`${blockerOutcome};`));
    const insertState = lastSqlValue(await blockedInsert);
    if (blockerOutcome === "commit") {
      if (insertState === "ok") {
        const activeStates = await b.query(`select count(*)::text || ':' || string_agg(status::text, ',')
          from public.analyses where workspace_id = ${sqlUuid(fixture.workspaceId)}
            and status in ('queued','processing');`);
        throw new Error(`The active-index race admitted two candidates (${activeStates}).`);
      }
      expect(insertState).toBe("23505");
      await runSqlStep("rollback blocked active transaction B", b.query("rollback;"));
    } else {
      expect(insertState).toBe("ok");
      await runSqlStep("scope active analysis B", b.query(insertScopeSql(fixture, analysisB, 0, "source")));
      await runSqlStep("commit active transaction B", b.query("commit;"));
    }

    if (blockerOutcome === "commit") {
      const completedId = randomUUID();
      await runSqlStep("begin completed-analysis transaction", a.query("begin;"));
      await runSqlStep("insert completed analysis beside active run", a.query(insertAnalysisSql(fixture, completedId, "completed")));
      await runSqlStep("scope completed analysis beside active run", a.query(insertScopeSql(fixture, completedId, 0, "source")));
      await runSqlStep("commit completed analysis beside active run", a.query("commit;"));
    }

    const activeCount = await runSqlStep("count active analyses", fixture.sql.query(
      `select count(*)::text from public.analyses where workspace_id = ${sqlUuid(fixture.workspaceId)} and status in ('queued','processing');`,
    ));
    expect(activeCount).toBe("1");
    if (otherWorkspace && otherAnalysis) {
      const otherCount = await runSqlStep("count independent active analysis", otherWorkspace.sql.query(
        `select count(*)::text from public.analyses where id = ${sqlUuid(otherAnalysis)} and status = 'processing';`,
      ));
      expect(otherCount).toBe("1");
    }

    await deleteTransientAnalysis(fixture, blockerOutcome === "commit" ? analysisA : analysisB);
  } finally {
    await closeSessions(sessions);
    await blockedInsert;
  }
}

beforeAll(assertLocalSupabaseReady);

describe("analysis integrity under concurrent local SQL sessions", () => {
  it("serializes the last scope slot for both commit and rollback", async () => {
    const committedFixture = await createAnalysisFixture({ versionCount: 19, unscopedVersionCount: 2 });
    let rolledBackFixture: AnalysisFixture | undefined;
    try {
      await runScopeCapacityRace(committedFixture, "commit");
      rolledBackFixture = await createAnalysisFixture({ versionCount: 19, unscopedVersionCount: 2 });
      await runScopeCapacityRace(rolledBackFixture, "rollback");
    } finally {
      await committedFixture.dispose();
      if (rolledBackFixture) await rolledBackFixture.dispose();
    }
  });

  it("serializes evidence against scope deletion and preserves shared-version roles", async () => {
    const fixture = await createAnalysisFixture({ versionCount: 2 });
    const sessions: LocalSqlSession[] = [];
    let blockedInsert: Promise<SqlCapture> | undefined;
    try {
      const a = await openLocalSqlSession("kdm_analysis_evidence_a");
      sessions.push(a);
      const b = await openLocalSqlSession("kdm_analysis_evidence_b");
      sessions.push(b);
      const observer = await openLocalSqlSession("kdm_analysis_evidence_observer");
      sessions.push(observer);

      await a.query("begin;");
      await b.query("begin;");
      await a.query(`delete from public.analysis_documents where analysis_id = ${sqlUuid(fixture.analysisId)} and version_id = ${sqlUuid(fixture.versions[1].versionId)} and role = 'comparison';`);
      blockedInsert = captureSql(b.query(insertEvidenceSql(fixture, 1)));
      await waitForSqlLock(observer, b.pid, a.pid);
      await a.query("commit;");

      const inserted = await blockedInsert;
      if (!inserted.ok) throw inserted.error;
      const evidenceState = lastSqlValue(await b.query(captureConstraintSqlStateSql(
        `perform private.validate_analysis_integrity(${sqlUuid(fixture.analysisId)});`,
      )));
      expect(evidenceState).toBe("23514");
      await b.query("rollback;");

      await fixture.sql.query(insertScopeSql(fixture, fixture.analysisId, 1, "comparison"));
      const evidenceId = randomUUID();
      await fixture.sql.query(insertEvidenceSql(fixture, 1, evidenceId));
      await fixture.sql.query("begin;");
      await fixture.sql.query(`delete from public.analysis_documents
        where analysis_id = ${sqlUuid(fixture.analysisId)}
          and version_id = ${sqlUuid(fixture.versions[1].versionId)} and role = 'comparison';`);
      const deleteState = lastSqlValue(await fixture.sql.query(captureConstraintSqlStateSql(
        `perform private.validate_analysis_integrity(${sqlUuid(fixture.analysisId)});`,
      )));
      expect(deleteState).toBe("23514");
      await fixture.sql.query("rollback;");

      const duplicateRole = insertScopeSql(fixture, fixture.analysisId, 0, "comparison");
      await fixture.sql.query(duplicateRole);
      await fixture.sql.query(`delete from public.analysis_documents
        where analysis_id = ${sqlUuid(fixture.analysisId)}
          and version_id = ${sqlUuid(fixture.versions[0].versionId)} and role = 'comparison';`);
      const sourceRoleRemains = await fixture.sql.query(`select count(*)::text from public.analysis_documents
        where analysis_id = ${sqlUuid(fixture.analysisId)}
          and version_id = ${sqlUuid(fixture.versions[0].versionId)} and role = 'source';`);
      expect(sourceRoleRemains).toBe("1");
    } finally {
      await closeSessions(sessions);
      await blockedInsert;
      await fixture.dispose();
    }
  });

  it("enforces one active analysis per workspace without coupling tenants", async () => {
    let committedFixture: AnalysisFixture | undefined;
    let otherWorkspace: AnalysisFixture | undefined;
    try {
      committedFixture = await createAnalysisFixture();
      const existingActiveId = randomUUID();
      await runSqlStep("begin existing active fixture", committedFixture.sql.query("begin;"));
      await runSqlStep("insert existing queued analysis", committedFixture.sql.query(
        insertAnalysisSql(committedFixture, existingActiveId, "queued"),
      ));
      await runSqlStep("scope existing queued analysis", committedFixture.sql.query(
        insertScopeSql(committedFixture, existingActiveId, 0, "source"),
      ));
      await runSqlStep("commit existing active fixture", committedFixture.sql.query("commit;"));
      await runSqlStep("begin queued duplicate test", committedFixture.sql.query("begin;"));
      const duplicate = lastSqlValue(await committedFixture.sql.query(
        captureConstraintSqlStateSql(insertAnalysisSql(committedFixture, randomUUID(), "processing")),
      ));
      expect(duplicate).toBe("23505");
      await runSqlStep("rollback queued duplicate test", committedFixture.sql.query("rollback;"));
      await deleteTransientAnalysis(committedFixture, existingActiveId);

      otherWorkspace = await createAnalysisFixture();
      await runActiveAnalysisRace(committedFixture, "commit", otherWorkspace);
      await runActiveAnalysisRace(committedFixture, "rollback");
    } finally {
      if (committedFixture) await runSqlStep("dispose committed fixture", committedFixture.dispose());
      if (otherWorkspace) await runSqlStep("dispose independent workspace fixture", otherWorkspace.dispose());
    }
  }, 60000);

  it("validates both old and new parents when a scope reference moves", async () => {
    const fixture = await createAnalysisFixture({ versionCount: 2, unscopedVersionCount: 2 });
    try {
      const newParent = randomUUID();
      await runSqlStep("begin new parent", fixture.sql.query("begin;"));
      await runSqlStep("insert new parent", fixture.sql.query(insertAnalysisSql(fixture, newParent, "completed")));
      await runSqlStep("scope new parent", fixture.sql.query(insertScopeSql(fixture, newParent, 1, "source")));
      await runSqlStep("commit new parent", fixture.sql.query("commit;"));

      await runSqlStep("add replacement source", fixture.sql.query(insertScopeSql(fixture, fixture.analysisId, 2, "source")));
      await runSqlStep("begin valid scope move", fixture.sql.query("begin;"));
      await runSqlStep("move valid scope association", fixture.sql.query(`update public.analysis_documents set analysis_id = ${sqlUuid(newParent)}
        where analysis_id = ${sqlUuid(fixture.analysisId)}
          and version_id = ${sqlUuid(fixture.versions[2].versionId)} and role = 'source';`));
      await runSqlStep("commit valid scope move", fixture.sql.query("commit;"));

      const originalSourceCount = await runSqlStep("count original parent sources", fixture.sql.query(`select count(*)::text from public.analysis_documents
        where analysis_id = ${sqlUuid(fixture.analysisId)} and role = 'source';`));
      const newParentSourceCount = await runSqlStep("count new parent sources", fixture.sql.query(`select count(*)::text from public.analysis_documents
        where analysis_id = ${sqlUuid(newParent)} and role = 'source';`));
      expect(originalSourceCount).toBe("1");
      expect(newParentSourceCount).toBe("2");

      const invalidParent = randomUUID();
      const invalidFinding = randomUUID();
      const invalidEvidence = randomUUID();
      const version = fixture.versions[3];
      await runSqlStep("begin invalid-parent fixture", fixture.sql.query("begin;"));
      await runSqlStep("insert invalid-parent analysis", fixture.sql.query(insertAnalysisSql(fixture, invalidParent, "completed")));
      await runSqlStep("insert invalid-parent scope", fixture.sql.query(insertScopeSql(fixture, invalidParent, 3, "source")));
      await runSqlStep("insert invalid-parent finding", fixture.sql.query(`insert into public.findings(
          id,workspace_id,analysis_id,type,severity_original,severity_current,confidence,explanation,fingerprint
        ) values (${sqlUuid(invalidFinding)},${sqlUuid(fixture.workspaceId)},${sqlUuid(invalidParent)},
          'contradiction','High','High',0.2,'Synthetic parent-move finding',${sqlLiteral(`move-${invalidFinding}`)});`));
      await runSqlStep("insert invalid-parent evidence", fixture.sql.query(`insert into public.finding_evidence(
          id,workspace_id,analysis_id,finding_id,document_id,version_id,chunk_id,snapshot
        ) values (${sqlUuid(invalidEvidence)},${sqlUuid(fixture.workspaceId)},${sqlUuid(invalidParent)},
          ${sqlUuid(invalidFinding)},${sqlUuid(version.documentId)},${sqlUuid(version.versionId)},
          ${sqlUuid(version.chunkId)},'Synthetic parent-move evidence');`));
      await runSqlStep("commit invalid-parent fixture", fixture.sql.query("commit;"));
      await fixture.sql.query("begin;");
      await fixture.sql.query(`update public.analysis_documents set analysis_id = ${sqlUuid(fixture.analysisId)}
        where analysis_id = ${sqlUuid(invalidParent)}
          and version_id = ${sqlUuid(version.versionId)} and role = 'source';`);
      const invalidMoveState = lastSqlValue(await fixture.sql.query(captureConstraintSqlStateSql(
        `perform private.validate_analysis_integrity(${sqlUuid(invalidParent)});
         perform private.validate_analysis_integrity(${sqlUuid(fixture.analysisId)});`,
      )));
      expect(invalidMoveState).toBe("23514");
      await runSqlStep("rollback invalid scope move", fixture.sql.query("rollback;"));

      const oldParentStillOwnsSource = await runSqlStep("verify invalid move retained source", fixture.sql.query(`select count(*)::text from public.analysis_documents
        where analysis_id = ${sqlUuid(invalidParent)}
          and version_id = ${sqlUuid(version.versionId)} and role = 'source';`));
      expect(oldParentStillOwnsSource).toBe("1");
    } finally {
      await runSqlStep("dispose parent-move fixture", fixture.dispose());
    }
  });
});
