import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database";
import { runLegacyReconciliation } from "../../scripts/upload-maintenance.mjs";
import { assertLocalSupabaseReady, cleanupLocalUser, newLocalUser, ownWorkspaceId, setLocalUploadMode } from "../support/local-supabase";

const LOCAL_API_URL = "http://127.0.0.1:54321";

function serviceClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key || process.env.KDM_LOCAL_SUPABASE_URL !== LOCAL_API_URL) {
    throw new Error("Local Supabase service test configuration is missing.");
  }
  return createClient<Database>(LOCAL_API_URL, key, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
}

describe("legacy upload reconciliation against local Postgres and Storage", () => {
  beforeAll(async () => {
    await assertLocalSupabaseReady();
    setLocalUploadMode("paused");
  });

  afterAll(() => setLocalUploadMode("paused"));
  afterEach(() => vi.unstubAllGlobals());

  it("confirms valid legacy bytes and preserves missing and already-processed rows idempotently", async () => {
    const { client, userId } = await newLocalUser();
    const suffix = randomUUID();
    const workspaceName = `kdm-${suffix}`;
    const service = serviceClient();
    let bootstrapped = false;
    const realFetch = globalThis.fetch.bind(globalThis);
    let validPath = "";

    try {
      const { data: workspace, error: bootstrapError } = await client.rpc("bootstrap_workspace", {
        workspace_name: workspaceName,
        full_name: "Legacy Reconciliation Test Admin",
      });
      expect(bootstrapError).toBeNull();
      expect(workspace).toBeTruthy();
      if (bootstrapError || !workspace) throw new Error("Local legacy reconciliation Admin bootstrap failed.");
      bootstrapped = true;
      const workspaceId = await ownWorkspaceId(client, userId);
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      const documents = ids.map((id, index) => ({
        id,
        workspace_id: workspaceId,
        name: `Legacy fixture ${index}`,
        category: "SOP" as const,
        owner_id: userId,
      }));
      const { error: documentsError } = await service.from("documents").insert(documents);
      expect(documentsError).toBeNull();

      const versions = ids.map((documentId, index) => {
        const versionId = randomUUID();
        const path = `${workspaceId}/${documentId}/${versionId}/original.md`;
        if (index === 2) validPath = path;
        return {
          id: versionId,
          workspace_id: workspaceId,
          document_id: documentId,
          version_number: 1,
          storage_path: path,
          processing_status: index === 1 ? "ready" as const : "uploaded" as const,
          version_status: index === 1 ? "historical" as const : null,
          size_bytes: index === 2 ? 1 : null,
        };
      });
      const { error: versionsError } = await service.from("document_versions").insert(versions);
      expect(versionsError).toBeNull();
      const processed = versions[1];
      const embedding = `[1,${"0,".repeat(382)}0]`;
      const { error: chunkError } = await service.from("document_chunks").insert({
        id: randomUUID(),
        workspace_id: workspaceId,
        version_id: processed.id,
        chunk_index: 0,
        text_content: "Preserve this synthetic legacy chunk.",
        embedding,
      });
      expect(chunkError).toBeNull();

      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname.endsWith(validPath)) return new Response("a", { status: 200 });
        return realFetch(input, init);
      });

      const runtime = { url: LOCAL_API_URL, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY! };
      const inspection = await runLegacyReconciliation(service, runtime, "inspect", userId);
      expect(inspection).toMatchObject({ scanned: 3, confirmed: 1, missing: 2, invalid: 0, failed: 0 });

      const firstApply = await runLegacyReconciliation(service, runtime, "apply", userId);
      expect(firstApply).toMatchObject({ scanned: 3, confirmed: 1, missing: 2, invalid: 0, failed: 0 });
      const repeatedApply = await runLegacyReconciliation(service, runtime, "apply", userId);
      expect(repeatedApply).toMatchObject({ scanned: 2, confirmed: 0, missing: 2, invalid: 0, failed: 0 });

      const confirmed = versions[2];
      const { data: confirmedRow, error: confirmedError } = await service.from("document_versions")
        .select("upload_state,hash_source,expected_sha256,size_bytes,processing_status,version_status,current_upload_attempt_id")
        .eq("id", confirmed.id).single();
      expect(confirmedError).toBeNull();
      expect(confirmedRow).toMatchObject({
        upload_state: "confirmed",
        hash_source: "legacy_reconciled",
        expected_sha256: createHash("sha256").update("a").digest("hex"),
        size_bytes: 1,
        processing_status: "uploaded",
        version_status: null,
      });
      expect(confirmedRow?.current_upload_attempt_id).toBeTruthy();
      const { count: attemptsCount, error: attemptsError } = await service.from("document_upload_attempts")
        .select("id", { count: "exact", head: true }).eq("version_id", confirmed.id);
      expect(attemptsError).toBeNull();
      expect(attemptsCount).toBe(1);

      const { data: processedDocument, error: processedError } = await service.from("documents")
        .select("active_version_id").eq("id", processed.document_id).single();
      expect(processedError).toBeNull();
      expect(processedDocument?.active_version_id).toBeNull();
      const { count: chunkCount, error: chunksError } = await service.from("document_chunks")
        .select("id", { count: "exact", head: true }).eq("version_id", processed.id);
      expect(chunksError).toBeNull();
      expect(chunkCount).toBe(1);

      const { data: absentRows, error: absentError } = await service.from("document_versions")
        .select("upload_state,expected_sha256,current_upload_attempt_id")
        .in("id", [versions[0].id, processed.id]);
      expect(absentError).toBeNull();
      expect(absentRows).toHaveLength(2);
      expect(absentRows?.every((row) => row.upload_state === null && row.expected_sha256 === null
        && row.current_upload_attempt_id === null)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      if (bootstrapped) await cleanupLocalUser(userId);
      else {
        const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (key) {
          await createClient<Database>(LOCAL_API_URL, key, {
            auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
          }).auth.admin.deleteUser(userId);
        }
      }
    }
  });
});
