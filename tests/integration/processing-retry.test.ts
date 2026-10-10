import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database";
import { claimProcessingRetry } from "../../src/modules/ingestion/processing-retry";
import { assertLocalSupabaseReady, cleanupLocalUser, newLocalUser, seedLocalProcessingClaim } from "../support/local-supabase";

vi.mock("server-only", () => ({}));

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

describe("local processing retry claim", () => {
  beforeAll(assertLocalSupabaseReady);
  afterEach(() => vi.unstubAllGlobals());

  it("serializes duplicate retries, hides foreign workspace versions, and rescues an expired lease", async () => {
    const { client, userId } = await newLocalUser();
    const suffix = randomUUID();
    const service = serviceClient();

    try {
      const { data: workspace, error: bootstrapError } = await client.rpc("bootstrap_workspace", {
        workspace_name: `kdm-${suffix}`,
        full_name: "Processing Retry Test Admin",
      });
      expect(bootstrapError).toBeNull();
      expect(workspace).toBeTruthy();
      if (bootstrapError || !workspace) throw new Error("Local retry workspace bootstrap failed.");
      const resolvedWorkspaceId = workspace as string;

      const documentId = randomUUID();
      const resolvedVersionId = randomUUID();
      const attemptId = randomUUID();
      const now = new Date().toISOString();
      const sha256 = "a".repeat(64);
      const canonicalPath = `${resolvedWorkspaceId}/${documentId}/${resolvedVersionId}/original.md`;

      const { error: documentError } = await service.from("documents").insert({
        id: documentId,
        workspace_id: resolvedWorkspaceId,
        name: `Retry-${suffix}`,
        category: "SOP",
        owner_id: userId,
      });
      expect(documentError).toBeNull();

      const { error: versionError } = await service.from("document_versions").insert({
        id: resolvedVersionId,
        workspace_id: resolvedWorkspaceId,
        document_id: documentId,
        version_number: 1,
        storage_path: canonicalPath,
        processing_status: "processing_failed",
        size_bytes: 1,
      });
      expect(versionError).toBeNull();

      const { error: attemptError } = await service.from("document_upload_attempts").insert({
        id: attemptId,
        workspace_id: resolvedWorkspaceId,
        version_id: resolvedVersionId,
        storage_path: `${resolvedWorkspaceId}/${documentId}/${resolvedVersionId}/attempts/${attemptId}/original.md`,
        retired_at: now,
        cleanup_status: "absent",
      });
      expect(attemptError).toBeNull();

      const { error: confirmError } = await service.from("document_versions").update({
        upload_state: "confirmed",
        expected_sha256: sha256,
        hash_source: "client_declared",
        upload_initiator_id: userId,
        idempotency_key: randomUUID(),
        request_fingerprint: "b".repeat(64),
        current_upload_attempt_id: attemptId,
        upload_confirmed_at: now,
        reference_set_at: now,
        reference_set_by: userId,
      }).eq("id", resolvedVersionId);
      expect(confirmError).toBeNull();

      const simultaneous = await Promise.all([
        claimProcessingRetry({workspaceId:resolvedWorkspaceId,versionId:resolvedVersionId}),
        claimProcessingRetry({workspaceId:resolvedWorkspaceId,versionId:resolvedVersionId}),
      ]);
      expect(simultaneous.filter(r=>r.kind==='queued')).toHaveLength(1);
      expect(simultaneous.filter(r=>r.kind==='conflict')).toHaveLength(1);
      expect(await claimProcessingRetry({workspaceId:randomUUID(),versionId:resolvedVersionId})).toEqual({kind:'not_found'});
      const oldOperation=randomUUID();
      seedLocalProcessingClaim(resolvedVersionId,oldOperation,new Date().toISOString());
      expect(await claimProcessingRetry({workspaceId:resolvedWorkspaceId,versionId:resolvedVersionId})).toEqual({kind:'conflict'});
      seedLocalProcessingClaim(resolvedVersionId,oldOperation,new Date(Date.now()-181_000).toISOString());
      const retries=await Promise.all([
        claimProcessingRetry({workspaceId:resolvedWorkspaceId,versionId:resolvedVersionId}),
        claimProcessingRetry({workspaceId:resolvedWorkspaceId,versionId:resolvedVersionId}),
      ]);
      expect(retries.filter(r=>r.kind==='queued')).toHaveLength(1);
      expect(retries.filter(r=>r.kind==='conflict')).toHaveLength(1);
      const current=await service.from('document_versions').select('processing_status,processing_queued,processing_operation_id').eq('id',resolvedVersionId).single();
      expect(current.data).toMatchObject({processing_status:'uploaded',processing_queued:true,processing_operation_id:null});
    } finally {
      await cleanupLocalUser(userId);
    }
  });
});
