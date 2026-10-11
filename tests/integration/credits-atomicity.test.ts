import { beforeAll, describe, expect, it } from "vitest";
import { createAnalysisFixture } from "../support/analysis-fixtures";
import { assertLocalSupabaseReady } from "../support/local-supabase";
import {
  captureCreditSqlState,
  creditSnapshotSql,
  insertCreditAnalysisSql,
  lastCreditSqlValue,
  sqlUuid,
} from "../support/credit-sql";

beforeAll(assertLocalSupabaseReady);

describe("credit reservation and analysis transaction boundaries", () => {
  it("rolls back reservations, terminal settlements, and finding publication as one unit", async () => {
    const completedFixture = await createAnalysisFixture({ withLedger: false });
    let failedFixture: Awaited<ReturnType<typeof createAnalysisFixture>> | undefined;
    try {
      failedFixture = await createAnalysisFixture({ withLedger: false });
      const analysisId = crypto.randomUUID();

      const reservationRollback = lastCreditSqlValue(await completedFixture.sql.query(captureCreditSqlState(`
        perform id from public.workspaces where id=${sqlUuid(completedFixture.workspaceId)} for update;
        ${insertCreditAnalysisSql(completedFixture, analysisId, 7)}
        perform private.reserve_analysis_credits(${sqlUuid(analysisId)}, 7);
        raise exception using errcode='P0001', message='Synthetic post-reservation failure';
      `)));
      expect(reservationRollback).toBe("P0001");
      expect(await completedFixture.sql.query(creditSnapshotSql(completedFixture.workspaceId))).toBe("50|0");
      expect(await completedFixture.sql.query(`select count(*)::text from public.analyses where id=${sqlUuid(analysisId)};`)).toBe("0");

      const insufficientId = crypto.randomUUID();
      const insufficient = lastCreditSqlValue(await completedFixture.sql.query(captureCreditSqlState(`
        perform id from public.workspaces where id=${sqlUuid(completedFixture.workspaceId)} for update;
        ${insertCreditAnalysisSql(completedFixture, insufficientId, 51)}
        perform private.reserve_analysis_credits(${sqlUuid(insufficientId)}, 51);
      `)));
      expect(insufficient).toBe("P2001");
      expect(await completedFixture.sql.query(creditSnapshotSql(completedFixture.workspaceId))).toBe("50|0");
      expect(await completedFixture.sql.query(`select count(*)::text from public.analyses where id=${sqlUuid(insufficientId)};`)).toBe("0");

      const invalidScopeId = crypto.randomUUID();
      const invalidScope = lastCreditSqlValue(await completedFixture.sql.query(captureCreditSqlState(`
        perform id from public.workspaces where id=${sqlUuid(completedFixture.workspaceId)} for update;
        ${insertCreditAnalysisSql(completedFixture, invalidScopeId, 7)}
        delete from public.analysis_documents where analysis_id=${sqlUuid(invalidScopeId)};
        set constraints all immediate;
      `)));
      expect(invalidScope).toBe("23514");
      expect(await completedFixture.sql.query(creditSnapshotSql(completedFixture.workspaceId))).toBe("50|0");
      expect(await completedFixture.sql.query(`select count(*)::text from public.analyses where id=${sqlUuid(invalidScopeId)};`)).toBe("0");

      const consumeId = crypto.randomUUID();
      await completedFixture.sql.query("begin;");
      await completedFixture.sql.query(`select id from public.workspaces where id=${sqlUuid(completedFixture.workspaceId)} for update;`);
      await completedFixture.sql.query(insertCreditAnalysisSql(completedFixture, consumeId, 7));
      await completedFixture.sql.query(`select private.reserve_analysis_credits(${sqlUuid(consumeId)}, 7);`);
      await completedFixture.sql.query("commit;");
      expect(await completedFixture.sql.query(creditSnapshotSql(completedFixture.workspaceId))).toBe("43|7");

      await completedFixture.sql.query("begin;");
      await completedFixture.sql.query(`select id from public.workspaces where id=${sqlUuid(completedFixture.workspaceId)} for update;`);
      const consumedFault = lastCreditSqlValue(await completedFixture.sql.query(captureCreditSqlState(`
        update public.analyses set status='completed', finished_at=now() where id=${sqlUuid(consumeId)};
        perform private.settle_analysis_credits(${sqlUuid(consumeId)}, 7, 'Consumed');
        raise exception using errcode='P0001', message='Synthetic completion failure';
      `)));
      expect(consumedFault).toBe("P0001");
      await completedFixture.sql.query("rollback;");
      expect(await completedFixture.sql.query(`select status::text from public.analyses where id=${sqlUuid(consumeId)};`)).toBe("queued");
      expect(await completedFixture.sql.query(`select count(*)::text from public.credit_ledger where analysis_id=${sqlUuid(consumeId)} and event_type='Consumed';`)).toBe("0");
      expect(await completedFixture.sql.query(creditSnapshotSql(completedFixture.workspaceId))).toBe("43|7");

      const findingId = crypto.randomUUID();
      const evidenceId = crypto.randomUUID();
      const invalidChunkId = crypto.randomUUID();
      await completedFixture.sql.query("begin;");
      await completedFixture.sql.query(`select id from public.workspaces where id=${sqlUuid(completedFixture.workspaceId)} for update;`);
      const invalidEvidence = lastCreditSqlValue(await completedFixture.sql.query(captureCreditSqlState(`
        update public.analyses set status='completed', finished_at=now() where id=${sqlUuid(consumeId)};
        perform private.settle_analysis_credits(${sqlUuid(consumeId)}, 7, 'Consumed');
        insert into public.findings(id,workspace_id,analysis_id,type,severity_original,severity_current,confidence,explanation,fingerprint)
          values (${sqlUuid(findingId)},${sqlUuid(completedFixture.workspaceId)},${sqlUuid(consumeId)},'contradiction','High','High',0.8,'Synthetic credit finding','${crypto.randomUUID()}');
        insert into public.finding_evidence(id,workspace_id,analysis_id,finding_id,document_id,version_id,chunk_id,page_number,section,section_heading,snapshot)
          values (${sqlUuid(evidenceId)},${sqlUuid(completedFixture.workspaceId)},${sqlUuid(consumeId)},${sqlUuid(findingId)},${sqlUuid(completedFixture.versions[0].documentId)},${sqlUuid(completedFixture.versions[0].versionId)},${sqlUuid(invalidChunkId)},1,'Fixture','Invalid chunk','Synthetic evidence');
      `)));
      expect(invalidEvidence).toBe("23503");
      await completedFixture.sql.query("rollback;");
      expect(await completedFixture.sql.query(`select status::text from public.analyses where id=${sqlUuid(consumeId)};`)).toBe("queued");
      expect(await completedFixture.sql.query(`select count(*)::text from public.findings where analysis_id=${sqlUuid(consumeId)};`)).toBe("0");
      expect(await completedFixture.sql.query(`select count(*)::text from public.finding_evidence where analysis_id=${sqlUuid(consumeId)};`)).toBe("0");
      expect(await completedFixture.sql.query(`select count(*)::text from public.credit_ledger where analysis_id=${sqlUuid(consumeId)} and event_type='Consumed';`)).toBe("0");
      expect(await completedFixture.sql.query(creditSnapshotSql(completedFixture.workspaceId))).toBe("43|7");

      await completedFixture.sql.query("begin;");
      await completedFixture.sql.query(`select id from public.workspaces where id=${sqlUuid(completedFixture.workspaceId)} for update;`);
      await completedFixture.sql.query(`
        update public.analyses set status='completed', finished_at=now() where id=${sqlUuid(consumeId)};
        select private.settle_analysis_credits(${sqlUuid(consumeId)}, 7, 'Consumed');
        insert into public.findings(id,workspace_id,analysis_id,type,severity_original,severity_current,confidence,explanation,fingerprint)
          values (${sqlUuid(findingId)},${sqlUuid(completedFixture.workspaceId)},${sqlUuid(consumeId)},'contradiction','High','High',0.8,'Synthetic credit finding','${crypto.randomUUID()}');
        insert into public.finding_evidence(id,workspace_id,analysis_id,finding_id,document_id,version_id,chunk_id,page_number,section,section_heading,snapshot)
          values (${sqlUuid(evidenceId)},${sqlUuid(completedFixture.workspaceId)},${sqlUuid(consumeId)},${sqlUuid(findingId)},${sqlUuid(completedFixture.versions[0].documentId)},${sqlUuid(completedFixture.versions[0].versionId)},${sqlUuid(completedFixture.versions[0].chunkId)},1,'Fixture','Valid chunk','Synthetic evidence');
      `);
      await completedFixture.sql.query("commit;");
      expect(await completedFixture.sql.query(creditSnapshotSql(completedFixture.workspaceId))).toBe("43|0");
      expect(await completedFixture.sql.query(`select count(*)::text from public.findings where analysis_id=${sqlUuid(consumeId)};`)).toBe("1");
      expect(await completedFixture.sql.query(`select count(*)::text from public.finding_evidence where analysis_id=${sqlUuid(consumeId)};`)).toBe("1");

      const releaseId = crypto.randomUUID();
      await failedFixture.sql.query("begin;");
      await failedFixture.sql.query(`select id from public.workspaces where id=${sqlUuid(failedFixture.workspaceId)} for update;`);
      await failedFixture.sql.query(insertCreditAnalysisSql(failedFixture, releaseId, 7));
      await failedFixture.sql.query(`select private.reserve_analysis_credits(${sqlUuid(releaseId)}, 7);`);
      await failedFixture.sql.query("commit;");
      expect(await failedFixture.sql.query(creditSnapshotSql(failedFixture.workspaceId))).toBe("43|7");

      await failedFixture.sql.query("begin;");
      await failedFixture.sql.query(`select id from public.workspaces where id=${sqlUuid(failedFixture.workspaceId)} for update;`);
      const releaseFault = lastCreditSqlValue(await failedFixture.sql.query(captureCreditSqlState(`
        update public.analyses set status='failed', finished_at=now(), error_code='PROVIDER_UNAVAILABLE' where id=${sqlUuid(releaseId)};
        perform private.settle_analysis_credits(${sqlUuid(releaseId)}, 7, 'Released');
        raise exception using errcode='P0001', message='Synthetic failure finalization';
      `)));
      expect(releaseFault).toBe("P0001");
      await failedFixture.sql.query("rollback;");
      expect(await failedFixture.sql.query(`select status::text from public.analyses where id=${sqlUuid(releaseId)};`)).toBe("queued");
      expect(await failedFixture.sql.query(`select count(*)::text from public.credit_ledger where analysis_id=${sqlUuid(releaseId)} and event_type='Released';`)).toBe("0");
      expect(await failedFixture.sql.query(creditSnapshotSql(failedFixture.workspaceId))).toBe("43|7");

      await failedFixture.sql.query("begin;");
      await failedFixture.sql.query(`select id from public.workspaces where id=${sqlUuid(failedFixture.workspaceId)} for update;`);
      await failedFixture.sql.query(`
        update public.analyses set status='failed', finished_at=now(), error_code='PROVIDER_UNAVAILABLE' where id=${sqlUuid(releaseId)};
        select private.settle_analysis_credits(${sqlUuid(releaseId)}, 7, 'Released');
      `);
      await failedFixture.sql.query("commit;");
      expect(await failedFixture.sql.query(creditSnapshotSql(failedFixture.workspaceId))).toBe("50|0");
      expect(await failedFixture.sql.query(`select count(*)::text from public.credit_ledger where analysis_id=${sqlUuid(releaseId)} and event_type='Released';`)).toBe("1");
    } finally {
      await completedFixture.dispose();
      await failedFixture?.dispose();
    }
  });
});
