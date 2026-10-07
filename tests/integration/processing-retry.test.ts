import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database";
import { claimProcessingRetry } from "../../src/modules/ingestion/processing-retry";
import { assertLocalSupabaseReady, cleanupLocalUser, newLocalUser } from "../support/local-supabase";

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

      const firstOperation = randomUUID();
      const secondOperation = randomUUID();
      const simultaneousClaims = await Promise.all([
        claimProcessingRetry({ workspaceId: resolvedWorkspaceId, versionId: resolvedVersionId, operationId: firstOperation }),
        claimProcessingRetry({ workspaceId: resolvedWorkspaceId, versionId: resolvedVersionId, operationId: secondOperation }),
      ]);
      expect(simultaneousClaims.filter((claim) => claim.kind === "claimed")).toHaveLength(1);
      expect(simultaneousClaims.filter((claim) => claim.kind === "conflict")).toHaveLength(1);

      const { data: claimedVersion, error: claimReadError } = await service
        .from("document_versions")
        .select("processing_status,processing_operation_id,upload_state,version_status")
        .eq("id", resolvedVersionId)
        .single();
      expect(claimReadError).toBeNull();
      expect(claimedVersion).toMatchObject({
        processing_status: "processing",
        upload_state: "confirmed",
        version_status: null,
      });
      expect([firstOperation, secondOperation]).toContain(claimedVersion?.processing_operation_id);

      const foreignWorkspaceClaim = await claimProcessingRetry({
        workspaceId: randomUUID(),
        versionId: resolvedVersionId,
        operationId: randomUUID(),
      });
      expect(foreignWorkspaceClaim).toEqual({ kind: "not_found" });

      const oldOperationId = claimedVersion?.processing_operation_id;
      if (!oldOperationId) throw new Error("The local retry claim did not persist its operation ID.");
      const staleStartedAt = new Date(Date.now() - 181_000).toISOString();
      const { error: expireError } = await service.from("document_versions").update({
        processing_started_at: staleStartedAt,
      }).eq("id", resolvedVersionId).eq("processing_operation_id", oldOperationId);
      expect(expireError).toBeNull();

      const staleOperationA = randomUUID();
      const staleOperationB = randomUUID();
      const staleClaims = await Promise.all([
        claimProcessingRetry({ workspaceId: resolvedWorkspaceId, versionId: resolvedVersionId, operationId: staleOperationA }),
        claimProcessingRetry({ workspaceId: resolvedWorkspaceId, versionId: resolvedVersionId, operationId: staleOperationB }),
      ]);
      expect(staleClaims.filter((claim) => claim.kind === "claimed")).toHaveLength(1);
      expect(staleClaims.filter((claim) => claim.kind === "conflict")).toHaveLength(1);

      const { count: documents, error: countError } = await service
        .from("documents")
        .select("id", { count: "exact", head: true })
        .eq("id", documentId);
      expect(countError).toBeNull();
      expect(documents).toBe(1);
    } finally {
      await cleanupLocalUser(userId);
    }
  });
});
