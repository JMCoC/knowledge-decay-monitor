import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/types/database";
import { createAnalysisFixture } from "../support/analysis-fixtures";
import { assertLocalSupabaseReady, cleanupLocalUser, newLocalUser } from "../support/local-supabase";

const LOCAL_API_URL = "http://127.0.0.1:54321";

function anonymousClient() {
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (process.env.KDM_LOCAL_SUPABASE_URL !== LOCAL_API_URL || !key) {
    throw new Error("The expected loopback Supabase client is unavailable.");
  }
  return createClient<Database>(LOCAL_API_URL, key, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
}

async function expectSnapshot(client: SupabaseClient<Database>) {
  const result = await client.rpc("get_credit_snapshot");
  expect(result.error).toBeNull();
  expect(result.data).toEqual({ available: 50, reserved: 0 });
}

async function readPromotion(client: SupabaseClient<Database>) {
  const result = await client.rpc("list_credit_ledger", { p_page: 1, p_page_size: 25 });
  expect(result.error).toBeNull();
  const page = result.data as unknown as {
    items: Array<{ id: string; type: string; amount: number; analysisId: string | null }>;
    total: number;
  };
  expect(page.total).toBe(1);
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).toMatchObject({ type: "Promotional", amount: 50, analysisId: null });
  return page.items[0].id;
}

type LooseRpcClient = {
  rpc(name: string, args?: Record<string, unknown>): PromiseLike<{
    data: unknown;
    error: { code: string } | null;
  }>;
};

beforeAll(assertLocalSupabaseReady);

describe("credit reads through real local Auth and REST", () => {
  it("uses persisted workspace and role, and keeps ledger reads tenant scoped", async () => {
    const tenantA = await createAnalysisFixture({ withLedger: false });
    let tenantB: Awaited<ReturnType<typeof createAnalysisFixture>> | undefined;
    let unbootstrapped: Awaited<ReturnType<typeof newLocalUser>> | undefined;
    try {
      tenantB = await createAnalysisFixture({ withLedger: false });
      unbootstrapped = await newLocalUser();

      await expectSnapshot(tenantA.admin);
      await expectSnapshot(tenantA.qa);
      await expectSnapshot(tenantA.member);

      const adminPromotionId = await readPromotion(tenantA.admin);
      const qaPromotionId = await readPromotion(tenantA.qa);
      const memberLedger = await tenantA.member.rpc("list_credit_ledger", { p_page: 1, p_page_size: 25 });
      expect(memberLedger.data).toBeNull();
      expect(memberLedger.error?.code).toBe("42501");

      const memberRows = await tenantA.member.from("credit_ledger").select("id");
      expect(memberRows.error).toBeNull();
      expect(memberRows.data).toEqual([]);

      const tenantBPromotionId = await readPromotion(tenantB.admin);
      expect(tenantBPromotionId).not.toBe(adminPromotionId);
      const filteredAcrossTenants = await tenantA.admin.from("credit_ledger").select("id")
        .eq("id", tenantBPromotionId);
      expect(filteredAcrossTenants.error).toBeNull();
      expect(filteredAcrossTenants.data).toEqual([]);

      const forgedArgs = {
        p_page: 1,
        p_page_size: 25,
        p_workspace_id: tenantB.workspaceId,
      };
      const expandedQuery = await tenantA.admin.rpc("list_credit_ledger", forgedArgs);
      expect(expandedQuery.data).toBeNull();
      expect(expandedQuery.error).not.toBeNull();

      const anonymous = anonymousClient();
      const anonymousSnapshot = await anonymous.rpc("get_credit_snapshot");
      expect(anonymousSnapshot.data).toBeNull();
      expect(anonymousSnapshot.error).not.toBeNull();
      const anonymousLedger = await anonymous.rpc("list_credit_ledger", { p_page: 1, p_page_size: 25 });
      expect(anonymousLedger.data).toBeNull();
      expect(anonymousLedger.error).not.toBeNull();

      const noProfileSnapshot = await unbootstrapped.client.rpc("get_credit_snapshot");
      expect(noProfileSnapshot.data).toBeNull();
      expect(noProfileSnapshot.error?.code).toBe("42501");
      const noProfileLedger = await unbootstrapped.client.rpc("list_credit_ledger", { p_page: 1, p_page_size: 25 });
      expect(noProfileLedger.data).toBeNull();
      expect(noProfileLedger.error?.code).toBe("42501");

      const directInsert = await tenantA.admin.from("credit_ledger").insert({
        workspace_id: tenantA.workspaceId,
        event_type: "Released",
        amount: 1,
        analysis_id: crypto.randomUUID(),
      });
      expect(directInsert.error?.code).toBe("42501");

      const publicRpc = tenantA.admin as unknown as LooseRpcClient;
      const publicWrite = await publicRpc.rpc("reserve_analysis_credits", {
        p_analysis_id: crypto.randomUUID(),
        p_expected_cost: 1,
      });
      expect(publicWrite.data).toBeNull();
      expect(publicWrite.error).not.toBeNull();

      const privateApi = (tenantA.admin as unknown as {
        schema(name: string): LooseRpcClient;
      }).schema("private");
      const privateWrite = await privateApi.rpc("grant_promotional_credits", {
        p_workspace_id: tenantA.workspaceId,
      });
      expect(privateWrite.data).toBeNull();
      expect(privateWrite.error).not.toBeNull();

      await tenantA.sql.query(`update public.profiles set role='Member' where id='${tenantA.qaId}'::uuid;`);
      await expectSnapshot(tenantA.qa);
      const downgradedLedger = await tenantA.qa.rpc("list_credit_ledger", { p_page: 1, p_page_size: 25 });
      expect(downgradedLedger.data).toBeNull();
      expect(downgradedLedger.error?.code).toBe("42501");
      const downgradedRows = await tenantA.qa.from("credit_ledger").select("id");
      expect(downgradedRows.error).toBeNull();
      expect(downgradedRows.data).toEqual([]);

      expect(qaPromotionId).toBe(adminPromotionId);
    } finally {
      try {
        if (unbootstrapped) await cleanupLocalUser(unbootstrapped.userId);
      } finally {
        await tenantA.dispose();
        await tenantB?.dispose();
      }
    }
  });
});
