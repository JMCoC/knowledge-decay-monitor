import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { AnalysisExecutionManifest } from "../../src/types/analysis-internal";
import { createAnalysisFixture } from "../support/analysis-fixtures";
import { assertLocalSupabaseReady } from "../support/local-supabase";
import {
  LocalSqlError,
  openLocalSqlSession,
  waitForSqlLock,
  type LocalSqlSession,
} from "../support/local-sql-session";

// Uses two real LocalSqlSession sessions (openLocalSqlSession).
// No dblink. No direct pg_sleep: lock observation uses
// waitForSqlLock, which polls pg_stat_activity/pg_blocking_pids
// with a bounded helper. The §13.5 sequence is covered below as
// regression coverage for 8b-9's workspace advisory.

const MANIFEST: AnalysisExecutionManifest = {
  fingerprintVersion: "s2-05-v2",
  pricingVersion: "s2-04-v1",
  promptVersion: "prompt-lock-order-v1",
  outputSchemaVersion: "schema-lock-order-v1",
  providers: {
    primary: { provider: "synthetic-test", model: "fake" },
    fallback: { provider: "synthetic-test", model: "fake" },
  },
};

function sqlUuid(value: string) {
  if (!/^[0-9a-f-]{36}$/i.test(value)) throw new Error("Invalid synthetic fixture UUID.");
  return `'${value}'::uuid`;
}

function json(value: unknown) {
  return `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
}

async function createEstimate(
  session: LocalSqlSession,
  actorId: string,
  sourceVersionId: string,
) {
  const output = await session.query(`
    select estimate_ref::text
    from public.create_analysis_estimate(
      ${sqlUuid(actorId)}, array[${sqlUuid(sourceVersionId)}], '{}'::uuid[], ${json(MANIFEST)}
    );
  `);
  const estimateRef = output.split(/\r?\n/).find(Boolean);
  if (!estimateRef || !/^[0-9a-f-]{36}$/i.test(estimateRef)) {
    throw new Error("The lock-order estimate was not created.");
  }
  return estimateRef;
}

function runSql(actorId: string, estimateRef: string, key: string) {
  if (!/^[a-z0-9-]{1,128}$/.test(key)) throw new Error("Invalid synthetic idempotency key.");
  return `
    select analysis_id::text || '|' || status::text
    from private.create_analysis_run(
      ${sqlUuid(actorId)}, ${sqlUuid(estimateRef)}, '${key}', null, ${json(MANIFEST)}
    );
  `;
}

function parseRun(output: string) {
  const [analysisId, status] = output.split(/\r?\n/).find(Boolean)?.split("|") ?? [];
  if (!analysisId || !status) throw new Error("The local create_analysis_run returned no analysis row.");
  return { analysisId, status };
}

function lockWorkspaceSql(workspaceId: string) {
  return `
    select pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(${sqlUuid(workspaceId)}::text, 0)
    );
    select id from public.workspaces where id = ${sqlUuid(workspaceId)} for update;
  `;
}

async function waitEvent(session: LocalSqlSession, pid: number) {
  const output = await session.query(`
    select coalesce(wait_event_type, '') || '|' || coalesce(wait_event, '')
    from pg_catalog.pg_stat_activity
    where pid = ${pid};
  `);
  return output.split(/\r?\n/).find(Boolean) ?? "";
}

async function runCounts(session: LocalSqlSession, estimateRef: string) {
  const output = await session.query(`
    select
      (select count(*)::text from public.analyses where estimate_id = ${sqlUuid(estimateRef)})
      || '|' ||
      (select count(*)::text
       from public.credit_ledger l
       join public.analyses a on a.id = l.analysis_id
       where a.estimate_id = ${sqlUuid(estimateRef)}
         and l.event_type = 'Reserved');
  `);
  return output.split(/\r?\n/).find(Boolean) ?? "";
}

beforeAll(assertLocalSupabaseReady);

describe("create_analysis_run canonical lock order", () => {
  it("takes the workspace advisory before the workspace row lock", async () => {
    const fixture = await createAnalysisFixture({ versionCount: 1 });
    let contender: LocalSqlSession | undefined;
    let observer: LocalSqlSession | undefined;
    let holderTransactionOpen = false;
    let contenderTransactionOpen = false;
    let pending: Promise<string> | undefined;
    try {
      const version = fixture.versions[0];
      if (!version) throw new Error("Lock-order fixture version is missing.");
      const estimateRef = await createEstimate(fixture.sql, fixture.adminId, version.versionId);
      const key = `lock-order-${randomUUID()}`;

      await fixture.sql.query("begin;");
      holderTransactionOpen = true;
      await fixture.sql.query(lockWorkspaceSql(fixture.workspaceId));

      contender = await openLocalSqlSession("kdm_lock_order_contender");
      observer = await openLocalSqlSession("kdm_lock_order_observer");
      await contender.query("begin;");
      contenderTransactionOpen = true;
      pending = contender.query(runSql(fixture.adminId, estimateRef, key));
      await waitForSqlLock(observer, contender.pid, fixture.sql.pid);
      expect(await waitEvent(observer, contender.pid)).toBe("Lock|advisory");

      await fixture.sql.query("commit;");
      holderTransactionOpen = false;
      const created = parseRun(await pending);
      expect(created.status).toBe("queued");
      await contender.query("commit;");
      contenderTransactionOpen = false;
      expect(await runCounts(observer, estimateRef)).toBe("1|1");

      await contender.query("begin;");
      contenderTransactionOpen = true;
      const replay = parseRun(await contender.query(runSql(fixture.adminId, estimateRef, key)));
      expect(replay).toEqual(created);
      await contender.query("commit;");
      contenderTransactionOpen = false;
      expect(await runCounts(observer, estimateRef)).toBe("1|1");
    } finally {
      if (holderTransactionOpen) await fixture.sql.query("rollback;").catch(() => undefined);
      await pending?.catch(() => undefined);
      if (contenderTransactionOpen) await contender?.query("rollback;").catch(() => undefined);
      await observer?.close();
      await contender?.close();
      await fixture.dispose();
    }
  }, 30_000);

  it("does not block a different workspace", async () => {
    const first = await createAnalysisFixture({ versionCount: 1 });
    const second = await createAnalysisFixture({ versionCount: 1 });
    let contender: LocalSqlSession | undefined;
    let holderTransactionOpen = false;
    let contenderTransactionOpen = false;
    try {
      const secondVersion = second.versions[0];
      if (!secondVersion) throw new Error("Lock-order fixture version is missing.");
      const secondEstimate = await createEstimate(second.sql, second.adminId, secondVersion.versionId);

      await first.sql.query("begin;");
      holderTransactionOpen = true;
      await first.sql.query(lockWorkspaceSql(first.workspaceId));

      contender = await openLocalSqlSession("kdm_lock_order_other", { queryTimeoutMs: 5000 });
      await contender.query("begin;");
      contenderTransactionOpen = true;
      const created = parseRun(await contender.query(
        runSql(second.adminId, secondEstimate, `lock-order-other-${randomUUID()}`),
      ));
      expect(created.status).toBe("queued");
      await contender.query("commit;");
      contenderTransactionOpen = false;

      await first.sql.query("commit;");
      holderTransactionOpen = false;
    } finally {
      if (holderTransactionOpen) await first.sql.query("rollback;").catch(() => undefined);
      if (contenderTransactionOpen) await contender?.query("rollback;").catch(() => undefined);
      await contender?.close();
      await first.dispose();
      await second.dispose();
    }
  }, 30_000);

  // Regression coverage, not TDD: 8b-9 added the workspace advisory
  // to private.create_analysis_run before its workspace/analysis row
  // locks, so this canonical sequence already passes on HEAD. There is
  // no RED baseline without reverting 8b-9.
  //
  // Spec §13.5 literal sequence:
  // 1. fixture has two analyses in one workspace;
  // 2. session 1: BEGIN; advisory(ws); FOR UPDATE workspaces;
  // 3. session 2: BEGIN; create_analysis_run (advisory(ws) first) waits;
  // 4. session 1: FOR UPDATE analyses; COMMIT;
  // 5. session 2 proceeds and COMMITs.
  // If create_analysis_run loses the advisory, session 2 waits on the
  // workspace row instead and the wait-event assertion fails.
  it("avoids the §13.5 deadlock between advisory/workspace and analyses locks", async () => {
    const fixture = await createAnalysisFixture({ versionCount: 1 });
    let contender: LocalSqlSession | undefined;
    let observer: LocalSqlSession | undefined;
    let holderTransactionOpen = false;
    let contenderTransactionOpen = false;
    let pending: Promise<string> | undefined;
    try {
      const version = fixture.versions[0];
      if (!version) throw new Error("Lock-order fixture version is missing.");
      const estimateRef = await createEstimate(fixture.sql, fixture.adminId, version.versionId);
      const key = `lock-order-deadlock-${randomUUID()}`;

      await fixture.sql.query("begin;");
      holderTransactionOpen = true;
      const second = parseRun(await fixture.sql.query(runSql(fixture.adminId, estimateRef, key)));
      await fixture.sql.query("commit;");
      holderTransactionOpen = false;
      expect(second.status).toBe("queued");

      await fixture.sql.query("begin;");
      holderTransactionOpen = true;
      await fixture.sql.query(lockWorkspaceSql(fixture.workspaceId));

      contender = await openLocalSqlSession("kdm_lock_order_deadlock_contender");
      observer = await openLocalSqlSession("kdm_lock_order_deadlock_observer");
      await contender.query("begin;");
      contenderTransactionOpen = true;
      pending = contender.query(runSql(fixture.adminId, estimateRef, key));
      try {
        await waitForSqlLock(observer, contender.pid, fixture.sql.pid);
      } catch (error) {
        const pendingError = await pending.catch((cause: unknown) => cause);
        if (pendingError instanceof LocalSqlError && pendingError.sqlState === "40P01") {
          throw new Error("The §13.5 sequence deadlocked before the holder committed.");
        }
        throw error;
      }
      expect(await waitEvent(observer, contender.pid)).toBe("Lock|advisory");

      const blocking = await observer.query(`
        select
          (${fixture.sql.pid} = any(pg_catalog.pg_blocking_pids(${contender.pid})))::text
          || '|' ||
          (${contender.pid} = any(pg_catalog.pg_blocking_pids(${fixture.sql.pid})))::text;
      `);
      expect(blocking.split(/\r?\n/).find(Boolean)).toBe("true|false");

      try {
        await fixture.sql.query(`
          select id
          from public.analyses
          where workspace_id = ${sqlUuid(fixture.workspaceId)}
          order by id
          for update;
        `);
        await fixture.sql.query("commit;");
        holderTransactionOpen = false;
        const replayed = parseRun(await pending);
        expect(replayed).toEqual(second);
        await contender.query("commit;");
        contenderTransactionOpen = false;
      } catch (error) {
        if (error instanceof LocalSqlError && error.sqlState === "40P01") {
          throw new Error("The §13.5 sequence deadlocked after the holder committed.");
        }
        throw error;
      }
    } finally {
      if (holderTransactionOpen) await fixture.sql.query("rollback;").catch(() => undefined);
      await pending?.catch(() => undefined);
      if (contenderTransactionOpen) await contender?.query("rollback;").catch(() => undefined);
      await observer?.close();
      await contender?.close();
      await fixture.dispose();
    }
  }, 30_000);

  it("preserves successful run and replay behavior", async () => {
    const fixture = await createAnalysisFixture({ versionCount: 1 });
    let transactionOpen = false;
    try {
      const version = fixture.versions[0];
      if (!version) throw new Error("Lock-order fixture version is missing.");
      const estimateRef = await createEstimate(fixture.sql, fixture.adminId, version.versionId);
      const key = `lock-order-replay-${randomUUID()}`;

      await fixture.sql.query("begin;");
      transactionOpen = true;
      const first = parseRun(await fixture.sql.query(runSql(fixture.adminId, estimateRef, key)));
      await fixture.sql.query("commit;");
      transactionOpen = false;

      await fixture.sql.query("begin;");
      transactionOpen = true;
      const replay = parseRun(await fixture.sql.query(runSql(fixture.adminId, estimateRef, key)));
      await fixture.sql.query("commit;");
      transactionOpen = false;

      expect(replay).toEqual(first);
      expect(await runCounts(fixture.sql, estimateRef)).toBe("1|1");
    } finally {
      if (transactionOpen) await fixture.sql.query("rollback;").catch(() => undefined);
      await fixture.dispose();
    }
  }, 30_000);
});
