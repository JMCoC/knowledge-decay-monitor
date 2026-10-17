import { beforeAll, describe, expect, it } from "vitest";
import type { AnalysisExecutionManifest } from "../../src/types/analysis-internal";
import {
  buildChunksRevision,
  computeRequestFingerprint,
} from "../../src/modules/analysis/retrieval";
import { createAnalysisFixture } from "../support/analysis-fixtures";
import { assertLocalSupabaseReady } from "../support/local-supabase";
import {
  openLocalSqlSession,
  waitForSqlLock,
  type LocalSqlSession,
} from "../support/local-sql-session";

beforeAll(assertLocalSupabaseReady);

const MANIFEST: AnalysisExecutionManifest = {
  fingerprintVersion: "s2-05-v2",
  pricingVersion: "s2-04-v1",
  promptVersion: "prompt-test-v1",
  outputSchemaVersion: "schema-test-v1",
  providers: {
    primary: { provider: "provider-a", model: "model-a" },
    fallback: { provider: "provider-b", model: "model-b" },
  },
};

function uuidArray(ids: string[]): string {
  if (ids.length === 0) return "ARRAY[]::uuid[]";
  return `ARRAY[${ids.map((id) => `'${id}'::uuid`).join(",")}]::uuid[]`;
}

function sqlJson(value: unknown): string {
  return `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
}

function summaryQuery(
  workspaceId: string,
  sourceVersionIds: string[],
  comparisonVersionIds: string[],
): string {
  return `
    select chunk_count::text || '|' || candidate_pair_count::text || '|' ||
      chunks_revision || '|' || request_fingerprint || '|' || fixed_cost::text
    from private.analysis_retrieval_summary(
      '${workspaceId}'::uuid,
      ${uuidArray(sourceVersionIds)},
      ${uuidArray(comparisonVersionIds)},
      ${sqlJson(MANIFEST)}
    );
  `;
}

function parseSummary(value: string) {
  const row = value.split(/\r?\n/).find((line) => line.length > 0);
  if (!row) throw new Error("The local SQL summary returned no row.");
  const [chunkCount, candidatePairCount, chunksRevision, fingerprint, fixedCost] = row.split("|");
  return {
    chunkCount: Number(chunkCount),
    candidatePairCount: Number(candidatePairCount),
    chunksRevision,
    fingerprint,
    fixedCost: Number(fixedCost),
  };
}

describe("analysis retrieval snapshots through local Supabase", () => {
  it("matches the TypeScript v2 fingerprint and complete chunk revision", async () => {
    const fixture = await createAnalysisFixture({ versionCount: 2 });
    try {
      const source = fixture.versions[0];
      const comparison = fixture.versions[1];
      if (!source || !comparison) throw new Error("Fixture versions missing.");

      const sourceVersionIds = [source.versionId];
      const comparisonVersionIds = [comparison.versionId];
      const allVersionIds = [...sourceVersionIds, ...comparisonVersionIds];
      const chunks = await fixture.admin
        .from("document_chunks")
        .select("id")
        .in("version_id", allVersionIds);
      expect(chunks.error).toBeNull();
      const chunkIds = (chunks.data ?? []).map((row) => row.id).sort();

      const retrieval = await fixture.admin.rpc("retrieve_candidate_pairs", {
        p_workspace_id: fixture.workspaceId,
        p_source_version_ids: sourceVersionIds,
        p_comparison_version_ids: comparisonVersionIds,
        p_top_k: 5,
        p_threshold: 0.75,
      });
      expect(retrieval.error).toBeNull();
      const pairs = retrieval.data ?? [];
      const expectedFingerprint = computeRequestFingerprint(
        {
          chunkCount: chunkIds.length,
          candidatePairCount: pairs.length,
          sortedSourceVersionIds: sourceVersionIds,
          sortedComparisonVersionIds: comparisonVersionIds,
          pairs: pairs.map((pair) => ({
            sourceChunkId: pair.source_chunk_id,
            comparisonChunkId: pair.comparison_chunk_id,
          })),
          chunkIds,
        },
        { executionManifest: MANIFEST },
      );

      const summary = parseSummary(await fixture.sql.query(summaryQuery(
        fixture.workspaceId,
        sourceVersionIds,
        comparisonVersionIds,
      )));
      expect(summary).toEqual({
        chunkCount: chunkIds.length,
        candidatePairCount: pairs.length,
        chunksRevision: buildChunksRevision(chunkIds),
        fingerprint: expectedFingerprint,
        fixedCost: 2,
      });
    } finally {
      await fixture.dispose();
    }
  }, 60_000);

  it("keeps tied overlapping source orientation deterministic", async () => {
    const fixture = await createAnalysisFixture({ versionCount: 2 });
    try {
      const versionIds = fixture.versions.map((version) => version.versionId);
      const call = () => fixture.admin.rpc("retrieve_candidate_pairs", {
        p_workspace_id: fixture.workspaceId,
        p_source_version_ids: versionIds,
        p_comparison_version_ids: versionIds,
        p_top_k: 5,
        p_threshold: 0.75,
      });
      const first = await call();
      const second = await call();
      expect(first.error).toBeNull();
      expect(second.error).toBeNull();
      expect(first.data).toEqual(second.data);
      expect(first.data).toHaveLength(1);
      expect(first.data?.[0]?.source_version_id).toBe([...versionIds].sort()[0]);
    } finally {
      await fixture.dispose();
    }
  }, 60_000);

  it("serializes a chunk insertion behind the snapshot version lock", async () => {
    const fixture = await createAnalysisFixture({ versionCount: 1 });
    let contender: LocalSqlSession | undefined;
    let observer: LocalSqlSession | undefined;
    let blockerInTransaction = false;
    let contenderInTransaction = false;
    let blockedInsert: Promise<string> | undefined;
    try {
      const source = fixture.versions[0];
      if (!source) throw new Error("Fixture version missing.");
      const sourceIds = [source.versionId];
      const blocker = fixture.sql;
      const before = parseSummary(await blocker.query(summaryQuery(
        fixture.workspaceId,
        sourceIds,
        [],
      )));

      await blocker.query("begin;");
      blockerInTransaction = true;
      const lockedSummary = parseSummary(await blocker.query(summaryQuery(
        fixture.workspaceId,
        sourceIds,
        [],
      )));
      expect(lockedSummary).toEqual(before);

      contender = await openLocalSqlSession("kdm_s205_chunk_writer");
      observer = await openLocalSqlSession("kdm_s205_chunk_observer");
      await contender.query("begin;");
      contenderInTransaction = true;
      blockedInsert = contender.query(`
        insert into public.document_chunks(
          id, workspace_id, version_id, chunk_index, text_content, embedding
        ) values (
          extensions.gen_random_uuid(),
          '${fixture.workspaceId}'::uuid,
          '${source.versionId}'::uuid,
          1,
          'Concurrent synthetic chunk',
          ('[1,' || repeat('0,', 382) || '0]')::extensions.vector(384)
        );
      `);
      await waitForSqlLock(observer, contender.pid, blocker.pid);
      await blocker.query("commit;");
      blockerInTransaction = false;
      await blockedInsert;
      await contender.query("commit;");
      contenderInTransaction = false;

      const after = parseSummary(await fixture.sql.query(summaryQuery(
        fixture.workspaceId,
        sourceIds,
        [],
      )));
      expect(after.chunkCount).toBe(before.chunkCount + 1);
      expect(after.chunksRevision).not.toBe(before.chunksRevision);
      expect(after.fingerprint).not.toBe(before.fingerprint);
    } finally {
      if (blockerInTransaction) await fixture.sql.query("rollback;").catch(() => undefined);
      if (blockedInsert) await blockedInsert.catch(() => undefined);
      if (contenderInTransaction) await contender?.query("rollback;").catch(() => undefined);
      await observer?.close();
      await contender?.close();
      await fixture.dispose();
    }
  }, 30_000);
});
