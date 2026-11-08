import { beforeAll, describe, expect, it } from "vitest";
import { createAnalysisFixture } from "../support/analysis-fixtures";
import { assertLocalSupabaseReady, cleanupLocalUser } from "../support/local-supabase";
import { openLocalSqlSession } from "../support/local-sql-session";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function workspaceStateSql(workspaceId: string) {
  if (!UUID_PATTERN.test(workspaceId)) throw new Error("Invalid synthetic workspace id.");
  return `
    select
      (select count(*) from public.workspaces where id = '${workspaceId}'::uuid)::text || '|' ||
      (select count(*) from public.documents where workspace_id = '${workspaceId}'::uuid)::text || '|' ||
      (select count(*) from public.credit_ledger where workspace_id = '${workspaceId}'::uuid)::text || '|' ||
      (select count(*) from public.analyses where workspace_id = '${workspaceId}'::uuid)::text;
  `;
}

beforeAll(assertLocalSupabaseReady);

describe("local synthetic workspace credit cleanup", () => {
  it("blocks owner cleanup while analysis history exists, then lets fixture disposal remove only its workspace", async () => {
    const fixture = await createAnalysisFixture({ withLedger: true });
    let witness: Awaited<ReturnType<typeof createAnalysisFixture>> | undefined;
    let observer: Awaited<ReturnType<typeof openLocalSqlSession>> | undefined;
    try {
      witness = await createAnalysisFixture({ withLedger: true });
      observer = await openLocalSqlSession("kdm_credit_cleanup_observer");

      let cleanupError: unknown;
      try {
        await cleanupLocalUser(fixture.adminId);
      } catch (error) {
        cleanupError = error;
      }
      expect(cleanupError).toBeInstanceOf(Error);
      expect(await observer.query(workspaceStateSql(fixture.workspaceId))).toBe("1|1|3|1");
      expect(await observer.query(workspaceStateSql(witness.workspaceId))).toBe("1|1|3|1");
      expect((cleanupError as Error).message).toMatch(/analysis or non-promotional credit history/i);

      await fixture.dispose();
      expect(await observer.query(workspaceStateSql(fixture.workspaceId))).toBe("0|0|0|0");
      expect(await observer.query(workspaceStateSql(witness.workspaceId))).toBe("1|1|3|1");
    } finally {
      await observer?.close();
      await fixture.dispose();
      await witness?.dispose();
    }
  });
});
