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
import { openLocalSqlSession, waitForSqlLock, type LocalSqlSession } from "../support/local-sql-session";

interface RaceSessions {
  a: LocalSqlSession;
  b: LocalSqlSession;
  observer: LocalSqlSession;
}

async function openRaceSessions(): Promise<RaceSessions> {
  const a = await openLocalSqlSession("kdm_credit_reserve_a");
  try {
    const b = await openLocalSqlSession("kdm_credit_reserve_b");
    try {
      const observer = await openLocalSqlSession("kdm_credit_observer");
      return { a, b, observer };
    } catch (error) {
      await b.close();
      throw error;
    }
  } catch (error) {
    await a.close();
    throw error;
  }
}

async function closeRaceSessions(sessions: RaceSessions | undefined, pending: Array<Promise<string>>) {
  if (!sessions) return;
  await sessions.a.query("rollback;").catch(() => undefined);
  await Promise.allSettled(pending);
  await sessions.b.query("rollback;").catch(() => undefined);
  await Promise.allSettled([
    sessions.a.close(),
    sessions.b.close(),
    sessions.observer.close(),
  ]);
}

async function beginAndLock(session: LocalSqlSession, workspaceId: string) {
  await session.query("begin isolation level read committed;");
  await session.query(`select id from public.workspaces where id=${sqlUuid(workspaceId)} for update;`);
}

async function insertAndReserve(
  session: LocalSqlSession,
  fixture: Awaited<ReturnType<typeof createAnalysisFixture>>,
  analysisId: string,
  cost: number,
) {
  await session.query(insertCreditAnalysisSql(fixture, analysisId, cost));
  return lastCreditSqlValue(await session.query(
    `select private.reserve_analysis_credits(${sqlUuid(analysisId)}, ${cost});`,
  ));
}

async function eventCount(session: LocalSqlSession, analysisId: string, eventType: string) {
  return session.query(`select count(*)::text from public.credit_ledger where analysis_id=${sqlUuid(analysisId)} and event_type='${eventType}';`);
}

async function competeOppositeSettlement(
  sessions: RaceSessions,
  fixture: Awaited<ReturnType<typeof createAnalysisFixture>>,
  analysisId: string,
  first: "Consumed" | "Released",
  second: "Consumed" | "Released",
  pending: Array<Promise<string>>,
) {
  const cost = 7;
  await beginAndLock(sessions.a, fixture.workspaceId);
  await insertAndReserve(sessions.a, fixture, analysisId, cost);
  const firstStatus = first === "Consumed" ? "completed" : "failed";
  const firstError = first === "Released" ? ", error_code='PROVIDER_UNAVAILABLE'" : "";
  await sessions.a.query(
    `update public.analyses set status='${firstStatus}', finished_at=now()${firstError} where id=${sqlUuid(analysisId)};`,
  );
  await sessions.a.query(`select private.settle_analysis_credits(${sqlUuid(analysisId)}, ${cost}, '${first}');`);

  await sessions.b.query("begin isolation level read committed;");
  const secondStatus = second === "Consumed" ? "completed" : "failed";
  const secondError = second === "Released" ? ", error_code='PROVIDER_UNAVAILABLE'" : "";
  const competing = sessions.b.query(captureCreditSqlState(`
    perform id from public.workspaces where id=${sqlUuid(fixture.workspaceId)} for update;
    update public.analyses set status='${secondStatus}', finished_at=now()${secondError} where id=${sqlUuid(analysisId)};
    perform private.settle_analysis_credits(${sqlUuid(analysisId)}, ${cost}, '${second}');
  `));
  pending.push(competing);
  await waitForSqlLock(sessions.observer, sessions.b.pid, sessions.a.pid);
  await sessions.a.query("commit;");
  const sqlState = lastCreditSqlValue(await competing);
  await sessions.b.query("commit;");
  return sqlState;
}

beforeAll(assertLocalSupabaseReady);

describe("credit accounting under real PostgreSQL concurrency", () => {
  it("serializes competing reservations, keeps snapshots coherent, and locks only one workspace", async () => {
    const fixture = await createAnalysisFixture({ withLedger: false });
    let witness: Awaited<ReturnType<typeof createAnalysisFixture>> | undefined;
    let sessions: RaceSessions | undefined;
    const pending: Array<Promise<string>> = [];
    try {
      witness = await createAnalysisFixture({ withLedger: false });
      const spendId = crypto.randomUUID();
      await beginAndLock(fixture.sql, fixture.workspaceId);
      await insertAndReserve(fixture.sql, fixture, spendId, 45);
      await fixture.sql.query(`update public.analyses set status='completed', finished_at=now() where id=${sqlUuid(spendId)};`);
      await fixture.sql.query(`select private.settle_analysis_credits(${sqlUuid(spendId)}, 45, 'Consumed');`);
      await fixture.sql.query("commit;");
      expect(await fixture.sql.query(creditSnapshotSql(fixture.workspaceId))).toBe("5|0");

      sessions = await openRaceSessions();
      const analysisA = crypto.randomUUID();
      const analysisB = crypto.randomUUID();
      await beginAndLock(sessions.a, fixture.workspaceId);
      await insertAndReserve(sessions.a, fixture, analysisA, 4);

      await sessions.b.query("begin isolation level read committed;");
      const competing = sessions.b.query(captureCreditSqlState(`
        perform id from public.workspaces where id=${sqlUuid(fixture.workspaceId)} for update;
        ${insertCreditAnalysisSql(fixture, analysisB, 4)}
        perform private.reserve_analysis_credits(${sqlUuid(analysisB)}, 4);
      `));
      pending.push(competing);
      await waitForSqlLock(sessions.observer, sessions.b.pid, sessions.a.pid);

      expect(await sessions.observer.query(creditSnapshotSql(fixture.workspaceId))).toBe("5|0");

      const witnessAnalysis = crypto.randomUUID();
      await beginAndLock(witness!.sql, witness!.workspaceId);
      await insertAndReserve(witness!.sql, witness!, witnessAnalysis, 4);
      await witness!.sql.query(`update public.analyses set status='completed', finished_at=now() where id=${sqlUuid(witnessAnalysis)};`);
      await witness!.sql.query(`select private.settle_analysis_credits(${sqlUuid(witnessAnalysis)}, 4, 'Consumed');`);
      await witness!.sql.query("commit;");
      expect(await witness!.sql.query(creditSnapshotSql(witness!.workspaceId))).toBe("46|0");

      await sessions.a.query(`update public.analyses set status='completed', finished_at=now() where id=${sqlUuid(analysisA)};`);
      await sessions.a.query(`select private.settle_analysis_credits(${sqlUuid(analysisA)}, 4, 'Consumed');`);
      await sessions.a.query("commit;");
      expect(lastCreditSqlValue(await competing)).toBe("P2001");
      await sessions.b.query("commit;");

      expect(await sessions.observer.query(creditSnapshotSql(fixture.workspaceId))).toBe("1|0");
      expect(await eventCount(sessions.observer, analysisA, "Consumed")).toBe("1");
      expect(await sessions.observer.query(`select count(*)::text from public.analyses where id=${sqlUuid(analysisB)};`)).toBe("0");
    } finally {
      await closeRaceSessions(sessions, pending);
      await fixture.dispose();
      await witness?.dispose();
    }
  }, 45_000);

  it("replays one reservation and one matching terminal movement after concurrent delivery", async () => {
    const fixture = await createAnalysisFixture({ withLedger: false });
    let sessions: RaceSessions | undefined;
    const pending: Array<Promise<string>> = [];
    try {
      sessions = await openRaceSessions();
      const analysisId = crypto.randomUUID();
      await beginAndLock(sessions.a, fixture.workspaceId);
      const reservationId = await insertAndReserve(sessions.a, fixture, analysisId, 7);

      await sessions.b.query("begin isolation level read committed;");
      const reservationReplay = sessions.b.query(
        `select id from public.workspaces where id=${sqlUuid(fixture.workspaceId)} for update;
         select private.reserve_analysis_credits(${sqlUuid(analysisId)}, 7);`,
      );
      pending.push(reservationReplay);
      await waitForSqlLock(sessions.observer, sessions.b.pid, sessions.a.pid);
      await sessions.a.query("commit;");
      expect(lastCreditSqlValue(await reservationReplay)).toBe(reservationId);
      await sessions.b.query("commit;");
      expect(await eventCount(sessions.observer, analysisId, "Reserved")).toBe("1");

      await beginAndLock(sessions.a, fixture.workspaceId);
      await sessions.a.query(`update public.analyses set status='completed', finished_at=now() where id=${sqlUuid(analysisId)};`);
      const settlementId = lastCreditSqlValue(await sessions.a.query(
        `select private.settle_analysis_credits(${sqlUuid(analysisId)}, 7, 'Consumed');`,
      ));

      await sessions.b.query("begin isolation level read committed;");
      const settlementReplay = sessions.b.query(
        `select id from public.workspaces where id=${sqlUuid(fixture.workspaceId)} for update;
         select private.settle_analysis_credits(${sqlUuid(analysisId)}, 7, 'Consumed');`,
      );
      pending.push(settlementReplay);
      await waitForSqlLock(sessions.observer, sessions.b.pid, sessions.a.pid);
      await sessions.a.query("commit;");
      expect(lastCreditSqlValue(await settlementReplay)).toBe(settlementId);
      await sessions.b.query("commit;");

      expect(await eventCount(sessions.observer, analysisId, "Consumed")).toBe("1");
      expect(await sessions.observer.query(creditSnapshotSql(fixture.workspaceId))).toBe("43|0");
    } finally {
      await closeRaceSessions(sessions, pending);
      await fixture.dispose();
    }
  });

  it("rejects opposite terminal deliveries in both orders and preserves the winner", async () => {
    const fixture = await createAnalysisFixture({ withLedger: false });
    let sessions: RaceSessions | undefined;
    const pending: Array<Promise<string>> = [];
    try {
      sessions = await openRaceSessions();

      const consumedFirst = crypto.randomUUID();
      expect(await competeOppositeSettlement(
        sessions, fixture, consumedFirst, "Consumed", "Released", pending,
      )).toBe("P2002");
      expect(await sessions.observer.query(`select status::text from public.analyses where id=${sqlUuid(consumedFirst)};`)).toBe("completed");
      expect(await eventCount(sessions.observer, consumedFirst, "Consumed")).toBe("1");
      expect(await eventCount(sessions.observer, consumedFirst, "Released")).toBe("0");

      const releasedFirst = crypto.randomUUID();
      expect(await competeOppositeSettlement(
        sessions, fixture, releasedFirst, "Released", "Consumed", pending,
      )).toBe("P2002");
      expect(await sessions.observer.query(`select status::text from public.analyses where id=${sqlUuid(releasedFirst)};`)).toBe("failed");
      expect(await eventCount(sessions.observer, releasedFirst, "Released")).toBe("1");
      expect(await eventCount(sessions.observer, releasedFirst, "Consumed")).toBe("0");
      expect(await sessions.observer.query(creditSnapshotSql(fixture.workspaceId))).toBe("43|0");
    } finally {
      await closeRaceSessions(sessions, pending);
      await fixture.dispose();
    }
  });

  it("serializes first promotion and replays a full-cost reservation after the balance is spent", async () => {
    const fixture = await createAnalysisFixture({ withLedger: false });
    let sessions: RaceSessions | undefined;
    const pending: Array<Promise<string>> = [];
    try {
      await fixture.sql.query(`delete from public.credit_ledger where workspace_id=${sqlUuid(fixture.workspaceId)} and event_type='Promotional';`);
      sessions = await openRaceSessions();

      await beginAndLock(sessions.a, fixture.workspaceId);
      const promotionId = lastCreditSqlValue(await sessions.a.query(
        `select private.grant_promotional_credits(${sqlUuid(fixture.workspaceId)});`,
      ));
      await sessions.b.query("begin isolation level read committed;");
      const promotionReplay = sessions.b.query(
        `select private.grant_promotional_credits(${sqlUuid(fixture.workspaceId)});`,
      );
      pending.push(promotionReplay);
      await waitForSqlLock(sessions.observer, sessions.b.pid, sessions.a.pid);
      await sessions.a.query("commit;");
      expect(lastCreditSqlValue(await promotionReplay)).toBe(promotionId);
      await sessions.b.query("commit;");
      expect(await sessions.observer.query(`select count(*)::text from public.credit_ledger where workspace_id=${sqlUuid(fixture.workspaceId)} and event_type='Promotional';`)).toBe("1");

      const analysisId = crypto.randomUUID();
      await beginAndLock(sessions.a, fixture.workspaceId);
      const reservationId = await insertAndReserve(sessions.a, fixture, analysisId, 50);
      await sessions.a.query(`update public.analyses set status='completed', finished_at=now() where id=${sqlUuid(analysisId)};`);
      await sessions.a.query(`select private.settle_analysis_credits(${sqlUuid(analysisId)}, 50, 'Consumed');`);

      await sessions.b.query("begin isolation level read committed;");
      const reservationReplay = sessions.b.query(
        `select id from public.workspaces where id=${sqlUuid(fixture.workspaceId)} for update;
         select private.reserve_analysis_credits(${sqlUuid(analysisId)}, 50);`,
      );
      pending.push(reservationReplay);
      await waitForSqlLock(sessions.observer, sessions.b.pid, sessions.a.pid);
      await sessions.a.query("commit;");
      expect(lastCreditSqlValue(await reservationReplay)).toBe(reservationId);
      await sessions.b.query("commit;");

      expect(await eventCount(sessions.observer, analysisId, "Reserved")).toBe("1");
      expect(await eventCount(sessions.observer, analysisId, "Consumed")).toBe("1");
      expect(await sessions.observer.query(creditSnapshotSql(fixture.workspaceId))).toBe("0|0");
    } finally {
      await closeRaceSessions(sessions, pending);
      await fixture.dispose();
    }
  });

  it("lets a waiting reservation continue from the original balance after the first transaction rolls back", async () => {
    const fixture = await createAnalysisFixture({ withLedger: false });
    let sessions: RaceSessions | undefined;
    const pending: Array<Promise<string>> = [];
    try {
      sessions = await openRaceSessions();
      const analysisA = crypto.randomUUID();
      const analysisB = crypto.randomUUID();
      await beginAndLock(sessions.a, fixture.workspaceId);
      await insertAndReserve(sessions.a, fixture, analysisA, 4);

      await sessions.b.query("begin isolation level read committed;");
      const waitingReservation = sessions.b.query(captureCreditSqlState(`
        perform id from public.workspaces where id=${sqlUuid(fixture.workspaceId)} for update;
        ${insertCreditAnalysisSql(fixture, analysisB, 4)}
        perform private.reserve_analysis_credits(${sqlUuid(analysisB)}, 4);
      `));
      pending.push(waitingReservation);
      await waitForSqlLock(sessions.observer, sessions.b.pid, sessions.a.pid);
      await sessions.a.query("rollback;");
      expect(lastCreditSqlValue(await waitingReservation)).toBe("ok");
      await sessions.b.query("commit;");

      expect(await sessions.observer.query(creditSnapshotSql(fixture.workspaceId))).toBe("46|4");
      expect(await sessions.observer.query(`select count(*)::text from public.analyses where id=${sqlUuid(analysisA)};`)).toBe("0");
      expect(await sessions.observer.query(`select count(*)::text from public.analyses where id=${sqlUuid(analysisB)};`)).toBe("1");
      expect(await eventCount(sessions.observer, analysisB, "Reserved")).toBe("1");
    } finally {
      await closeRaceSessions(sessions, pending);
      await fixture.dispose();
    }
  });
});
