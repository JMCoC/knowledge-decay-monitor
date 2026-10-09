import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { assertLocalSupabaseReady } from "../support/local-supabase";
import { createProcessingFixture } from "../support/processing-fixtures";
import { openLocalSqlSession, waitForSqlLock } from "../support/local-sql-session";

describe("local processing completion fencing", () => {
  beforeAll(assertLocalSupabaseReady);

  it("rejects completion after the persisted 50-second deadline without partial activation", async () => {
    const fixture = await createProcessingFixture({
      status: "processing",
      startedAt: new Date(Date.now() - 51_000).toISOString(),
    });
    try {
      const { data, error } = await fixture.service.rpc("finish_processing", {
        p_version_id: fixture.versionId,
        p_operation_id: fixture.operationId,
        p_chunks: fixture.chunks,
      });
      expect(data).toBeNull();
      expect(error?.code).toBe("22023");

      const { data: version, error: readError } = await fixture.service.from("document_versions")
        .select("processing_status,version_status,processing_operation_id")
        .eq("id", fixture.versionId).single();
      expect(readError).toBeNull();
      expect(version).toMatchObject({
        processing_status: "processing",
        version_status: null,
        processing_operation_id: fixture.operationId,
      });
      const { count, error: chunksError } = await fixture.service.from("document_chunks")
        .select("id", { count: "exact", head: true }).eq("version_id", fixture.versionId);
      expect(chunksError).toBeNull();
      expect(count).toBe(0);
    } finally {
      await fixture.dispose();
    }
  });

  it("rejects A after B commits a replacement claim", async () => {
    const fixture = await createProcessingFixture({ status: "processing" });
    const a = await openLocalSqlSession("kdm_finish_a");
    const b = await openLocalSqlSession("kdm_claim_b");
    try {
      const replacement = randomUUID();
      await b.query("begin;");
      await b.query(`update public.document_versions
        set processing_operation_id='${replacement}', processing_started_at=clock_timestamp()
        where id='${fixture.versionId}';`);
      const finishing = a.query(`select public.finish_processing(
        '${fixture.versionId}', '${fixture.operationId}',
        '${JSON.stringify(fixture.chunks)}'::jsonb);`);
      const outcome = finishing.then(
        () => ({ kind: "resolved" as const }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      );
      await waitForSqlLock(b, a.pid);
      await b.query("commit;");
      expect(await outcome).toMatchObject({ kind: "rejected", error: { sqlState: "22023" } });

      const { data: version, error: readError } = await fixture.service.from("document_versions")
        .select("processing_status,processing_operation_id,version_status")
        .eq("id", fixture.versionId).single();
      expect(readError).toBeNull();
      expect(version).toMatchObject({
        processing_status: "processing",
        processing_operation_id: replacement,
        version_status: null,
      });
      const { count, error: chunksError } = await fixture.service.from("document_chunks")
        .select("id", { count: "exact", head: true }).eq("version_id", fixture.versionId);
      expect(chunksError).toBeNull();
      expect(count).toBe(0);
    } finally {
      await a.close();
      await b.close();
      await fixture.dispose();
    }
  });

  it("bounds a real HTTP RPC blocked on a version row and leaves no chunks", async () => {
    const fixture = await createProcessingFixture({ status: "processing" });
    const blocker = await openLocalSqlSession("kdm_http_lock");
    try {
      await blocker.query("begin;");
      await blocker.query(`select id from public.document_versions where id='${fixture.versionId}' for update;`);
      const startedAt = Date.now();
      const { data, error } = await fixture.service.rpc("finish_processing", {
        p_version_id: fixture.versionId,
        p_operation_id: fixture.operationId,
        p_chunks: fixture.chunks,
      });
      const elapsedMs = Date.now() - startedAt;
      expect(data).toBeNull();
      expect(["55P03", "57014"]).toContain(error?.code);
      expect(elapsedMs).toBeLessThan(2500);
      await blocker.query("commit;");

      const { count, error: chunksError } = await fixture.service.from("document_chunks")
        .select("id", { count: "exact", head: true }).eq("version_id", fixture.versionId);
      expect(chunksError).toBeNull();
      expect(count).toBe(0);
      const { data: version, error: readError } = await fixture.service.from("document_versions")
        .select("processing_status,version_status,processing_operation_id")
        .eq("id", fixture.versionId).single();
      expect(readError).toBeNull();
      expect(version).toMatchObject({
        processing_status: "processing",
        version_status: null,
        processing_operation_id: fixture.operationId,
      });
    } finally {
      await blocker.close();
      await fixture.dispose();
    }
  });
});
