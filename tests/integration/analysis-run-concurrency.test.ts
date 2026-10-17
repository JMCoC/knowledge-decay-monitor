import { beforeAll, describe, expect, it } from "vitest";
import type { AnalysisExecutionManifest } from "../../src/types/analysis-internal";
import { createAnalysisFixture } from "../support/analysis-fixtures";
import { assertLocalSupabaseReady } from "../support/local-supabase";
import {
  openLocalSqlSession,
  waitForSqlLock,
  type LocalSqlSession,
} from "../support/local-sql-session";

const MANIFEST: AnalysisExecutionManifest = {
  fingerprintVersion: "s2-05-v2",
  pricingVersion: "s2-04-v1",
  promptVersion: "prompt-run-race-v1",
  outputSchemaVersion: "schema-run-race-v1",
  providers: {
    primary: { provider: "provider-a", model: "model-a" },
    fallback: { provider: "provider-b", model: "model-b" },
  },
};

function uuid(value: string) {
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
      ${uuid(actorId)}, array[${uuid(sourceVersionId)}], '{}'::uuid[], ${json(MANIFEST)}
    );
  `);
  const estimateRef = output.split(/\r?\n/).find(Boolean);
  if (!estimateRef || !/^[0-9a-f-]{36}$/i.test(estimateRef)) {
    throw new Error("The synthetic Run estimate was not created.");
  }
  return estimateRef;
}

function runSql(actorId: string, estimateRef: string, key: string) {
  if (!/^[a-z0-9-]{1,128}$/.test(key)) throw new Error("Invalid synthetic idempotency key.");
  return `
    select analysis_id::text || '|' || status::text
    from public.run_analysis(${uuid(actorId)}, ${uuid(estimateRef)}, '${key}', ${json(MANIFEST)});
  `;
}

function capturedRunSql(actorId: string, estimateRef: string, key: string) {
  if (!/^[a-z0-9-]{1,128}$/.test(key)) throw new Error("Invalid synthetic idempotency key.");
  return `
    create function pg_temp.capture_analysis_run(
      p_actor uuid, p_estimate uuid, p_key text, p_manifest jsonb
    ) returns text
    language plpgsql
    set search_path = pg_temp, public
    as $capture$
    declare v_id uuid; v_status public.analysis_job_status;
    begin
      begin
        select r.analysis_id, r.status into v_id, v_status
        from public.run_analysis(p_actor, p_estimate, p_key, p_manifest) r;
      exception when others then
        return 'ERR:' || sqlstate;
      end;
      return coalesce(v_id::text, '') || '|' || coalesce(v_status::text, '');
    end;
    $capture$;
    select pg_temp.capture_analysis_run(
      ${uuid(actorId)}, ${uuid(estimateRef)}, '${key}', ${json(MANIFEST)}
    );
  `;
}

function parseRun(output: string) {
  const [analysisId, status] = output.split(/\r?\n/).find(Boolean)?.split("|") ?? [];
  if (!analysisId || !status) throw new Error("The local Run RPC returned no analysis row.");
  return { analysisId, status };
}

function retrySql(actorId: string, failedId: string, estimateRef: string, key: string) {
  if (!/^[a-z0-9-]{1,128}$/.test(key)) throw new Error("Invalid synthetic idempotency key.");
  return `
    select analysis_id::text || '|' || status::text || '|' || retry_of_analysis_id::text
    from public.retry_analysis(
      ${uuid(actorId)}, ${uuid(failedId)}, ${uuid(estimateRef)}, '${key}', ${json(MANIFEST)}
    );
  `;
}

function parseRetry(output: string) {
  const [analysisId, status, retryOfAnalysisId] = output.split(/\r?\n/).find(Boolean)?.split("|") ?? [];
  if (!analysisId || !status || !retryOfAnalysisId) {
    throw new Error("The local Retry RPC returned no analysis row.");
  }
  return { analysisId, status, retryOfAnalysisId };
}

beforeAll(assertLocalSupabaseReady);

describe("analysis Run concurrency through local PostgreSQL", () => {
  it("replays the same command after a real workspace lock while another workspace progresses", async () => {
    const firstFixture = await createAnalysisFixture({ versionCount: 1 });
    const secondFixture = await createAnalysisFixture({ versionCount: 1 });
    let contender: LocalSqlSession | undefined;
    let observer: LocalSqlSession | undefined;
    let firstTransactionOpen = false;
    let replayPending: Promise<string> | undefined;
    try {
      const firstVersion = firstFixture.versions[0];
      const secondVersion = secondFixture.versions[0];
      if (!firstVersion || !secondVersion) throw new Error("Run race fixture versions are missing.");
      const firstEstimate = await createEstimate(firstFixture.sql, firstFixture.adminId, firstVersion.versionId);
      const secondEstimate = await createEstimate(secondFixture.sql, secondFixture.adminId, secondVersion.versionId);

      await firstFixture.sql.query("begin;");
      firstTransactionOpen = true;
      const first = parseRun(await firstFixture.sql.query(
        runSql(firstFixture.adminId, firstEstimate, "same-key-race"),
      ));

      contender = await openLocalSqlSession("kdm_s205_run_replay");
      observer = await openLocalSqlSession("kdm_s205_run_observer");
      replayPending = contender.query(runSql(firstFixture.adminId, firstEstimate, "same-key-race"));
      await waitForSqlLock(observer, contender.pid, firstFixture.sql.pid);

      const independent = parseRun(await secondFixture.sql.query(
        runSql(secondFixture.adminId, secondEstimate, "independent-workspace"),
      ));
      expect(independent.status).toBe("queued");

      await firstFixture.sql.query("commit;");
      firstTransactionOpen = false;
      const replay = parseRun(await replayPending);
      expect(replay).toEqual(first);

      const persisted = await firstFixture.sql.query(`
        select count(*)::text || '|' ||
          (select count(*)::text from public.credit_ledger
           where analysis_id = ${uuid(first.analysisId)} and event_type = 'Reserved')
        from public.analyses where estimate_id = ${uuid(firstEstimate)};
      `);
      expect(persisted.split(/\r?\n/).find(Boolean)).toBe("1|1");
    } finally {
      if (firstTransactionOpen) await firstFixture.sql.query("rollback;").catch(() => undefined);
      await replayPending?.catch(() => undefined);
      await observer?.close();
      await contender?.close();
      await firstFixture.dispose();
      await secondFixture.dispose();
    }
  }, 30_000);

  it("serializes two simultaneous Retries into one new reservation", async () => {
    const fixture = await createAnalysisFixture({ versionCount: 1 });
    let contender: LocalSqlSession | undefined;
    let observer: LocalSqlSession | undefined;
    let retryTransactionOpen = false;
    let retryPending: Promise<string> | undefined;
    try {
      const version = fixture.versions[0];
      if (!version) throw new Error("Retry race fixture version is missing.");
      const estimateRef = await createEstimate(fixture.sql, fixture.adminId, version.versionId);
      await fixture.sql.query(`
        begin;
        update public.analyses set status = 'queued', attempt_count = 0,
          started_at = null, finished_at = null, error_code = null
        where id = ${uuid(fixture.analysisId)};
        select private.reserve_analysis_credits(${uuid(fixture.analysisId)}, 3);
        update public.analyses set status = 'failed', attempt_count = 1,
          started_at = clock_timestamp(), finished_at = clock_timestamp(), error_code = 'INTERNAL_ERROR'
        where id = ${uuid(fixture.analysisId)};
        select private.settle_analysis_credits(${uuid(fixture.analysisId)}, 3, 'Released');
        commit;
      `);

      await fixture.sql.query("begin;");
      retryTransactionOpen = true;
      const first = parseRetry(await fixture.sql.query(
        retrySql(fixture.adminId, fixture.analysisId, estimateRef, "same-retry-race"),
      ));
      contender = await openLocalSqlSession("kdm_s205_retry_replay");
      observer = await openLocalSqlSession("kdm_s205_retry_observer");
      retryPending = contender.query(
        retrySql(fixture.adminId, fixture.analysisId, estimateRef, "same-retry-race"),
      );
      await waitForSqlLock(observer, contender.pid, fixture.sql.pid);

      await fixture.sql.query("commit;");
      retryTransactionOpen = false;
      const replay = parseRetry(await retryPending);
      expect(replay).toEqual(first);

      const persisted = await fixture.sql.query(`
        select count(*)::text || '|' ||
          (select count(*)::text from public.credit_ledger
           where analysis_id = ${uuid(first.analysisId)} and event_type = 'Reserved')
        from public.analyses
        where retry_of_analysis_id = ${uuid(fixture.analysisId)}
          and estimate_id = ${uuid(estimateRef)};
      `);
      expect(persisted.split(/\r?\n/).find(Boolean)).toBe("1|1");
    } finally {
      if (retryTransactionOpen) await fixture.sql.query("rollback;").catch(() => undefined);
      await retryPending?.catch(() => undefined);
      await observer?.close();
      await contender?.close();
      await fixture.dispose();
    }
  }, 30_000);

  it.each(["chunk", "pointer"] as const)(
    "waits for a concurrent %s mutation and rejects the now-stale estimate",
    async (mutation) => {
      const fixture = await createAnalysisFixture({ versionCount: 1 });
      let contender: LocalSqlSession | undefined;
      let observer: LocalSqlSession | undefined;
      let writerTransactionOpen = false;
      let runPending: Promise<string> | undefined;
      try {
        const version = fixture.versions[0];
        if (!version) throw new Error("Snapshot race fixture version is missing.");
        const estimateRef = await createEstimate(fixture.sql, fixture.adminId, version.versionId);

        await fixture.sql.query("begin;");
        writerTransactionOpen = true;
        if (mutation === "chunk") {
          await fixture.sql.query(`
            insert into public.document_chunks(
              workspace_id, version_id, chunk_index, text_content, embedding
            ) values (
              ${uuid(fixture.workspaceId)}, ${uuid(version.versionId)}, 1,
              'Concurrent synthetic analysis chunk',
              ('[1,' || repeat('0,', 382) || '0]')::extensions.vector(384)
            );
          `);
        } else {
          await fixture.sql.query(`
            update public.document_versions set version_status = 'historical'
            where id = ${uuid(version.versionId)};
            update public.documents set active_version_id = null
            where id = ${uuid(version.documentId)};
          `);
        }

        contender = await openLocalSqlSession("kdm_s205_run_snapshot");
        observer = await openLocalSqlSession("kdm_s205_run_observer");
        runPending = contender.query(capturedRunSql(
          fixture.adminId, estimateRef, `stale-${mutation}`,
        ));
        await waitForSqlLock(observer, contender.pid, fixture.sql.pid);
        await fixture.sql.query("commit;");
        writerTransactionOpen = false;

        const outcome = await runPending;
        expect(outcome.split(/\r?\n/).filter(Boolean).at(-1)).toBe("ERR:P2102");
        const noPartialRun = await fixture.sql.query(`
          select count(*)::text || '|' ||
            (select count(*)::text from public.credit_ledger l
             join public.analyses a on a.id = l.analysis_id
             where a.estimate_id = ${uuid(estimateRef)})
          from public.analyses where estimate_id = ${uuid(estimateRef)};
        `);
        expect(noPartialRun.split(/\r?\n/).find(Boolean)).toBe("0|0");
      } finally {
        if (writerTransactionOpen) await fixture.sql.query("rollback;").catch(() => undefined);
        await runPending?.catch(() => undefined);
        await observer?.close();
        await contender?.close();
        await fixture.dispose();
      }
    },
  );
});
