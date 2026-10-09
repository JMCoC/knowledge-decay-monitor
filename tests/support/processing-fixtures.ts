import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database";
import { cleanupLocalUser, newLocalUser } from "./local-supabase";

const LOCAL_API_URL = "http://127.0.0.1:54321";
const FIXTURE_TEXT = "# Synthetic processing fixture\n\nA valid local test document.\n";
const FIXTURE_BYTES = Buffer.from(FIXTURE_TEXT, "utf8");
const FIXTURE_CHUNK = {
  chunk_index: 0,
  text_content: "Synthetic local processing fixture",
  page_number: 1,
  section_heading: "Fixture",
  embedding: `[1,${Array.from({ length: 383 }, () => "0").join(",")}]`,
};

function serviceClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key || process.env.KDM_LOCAL_SUPABASE_URL !== LOCAL_API_URL) {
    throw new Error("Local Supabase service test configuration is missing.");
  }
  return createClient<Database>(LOCAL_API_URL, key, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
}

function requireNoError(error: unknown, operation: string) {
  if (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      && typeof error.code === "string" ? error.code : "unknown";
    throw new Error(`Local processing fixture ${operation} failed (${code}).`);
  }
}

export async function createProcessingFixture(input: {
  status: "processing";
  startedAt?: string;
}) {
  const { client, userId } = await newLocalUser();
  const service = serviceClient();
  const suffix = randomUUID();
  let workspaceId: string | null = null;
  const documentId = randomUUID();
  const versionId = randomUUID();
  const operationId = randomUUID();
  const attemptId = randomUUID();
  const extension = "md";
  let disposed = false;

  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    let storageError: unknown = null;
    if (workspaceId) {
      const canonicalPath = `${workspaceId}/${documentId}/${versionId}/original.${extension}`;
      const canonicalAttemptPath = `${workspaceId}/${documentId}/${versionId}/attempts/${attemptId}/original.${extension}`;
      const { error } = await service.storage.from("documents").remove([canonicalPath, canonicalAttemptPath]);
      storageError = error;
    }
    try {
      await cleanupLocalUser(userId);
    } finally {
      requireNoError(storageError, "storage cleanup");
    }
  };

  try {
    const { data: workspace, error: bootstrapError } = await client.rpc("bootstrap_workspace", {
      workspace_name: `kdm-${suffix}`,
      full_name: "Processing Completion Test Admin",
    });
    requireNoError(bootstrapError, "workspace bootstrap");
    if (!workspace) throw new Error("Local processing fixture workspace was not created.");
    const resolvedWorkspaceId = workspace as string;
    workspaceId = resolvedWorkspaceId;

    const canonicalPath = `${resolvedWorkspaceId}/${documentId}/${versionId}/original.${extension}`;
    const canonicalAttemptPath = `${resolvedWorkspaceId}/${documentId}/${versionId}/attempts/${attemptId}/original.${extension}`;

    const { error: documentError } = await service.from("documents").insert({
      id: documentId,
      workspace_id: resolvedWorkspaceId,
      name: `Processing-${suffix}`,
      category: "SOP",
      owner_id: userId,
    });
    requireNoError(documentError, "document insert");

    const { error: versionError } = await service.from("document_versions").insert({
      id: versionId,
      workspace_id: resolvedWorkspaceId,
      document_id: documentId,
      version_number: 1,
      storage_path: canonicalPath,
      processing_status: input.status,
      processing_operation_id: operationId,
      processing_started_at: input.startedAt ?? new Date().toISOString(),
      size_bytes: FIXTURE_BYTES.byteLength,
    });
    requireNoError(versionError, "version insert");

    const { error: attemptError } = await service.from("document_upload_attempts").insert({
      id: attemptId,
      workspace_id: resolvedWorkspaceId,
      version_id: versionId,
      storage_path: canonicalAttemptPath,
      retired_at: new Date().toISOString(),
      cleanup_status: "absent",
    });
    requireNoError(attemptError, "upload attempt insert");

    const confirmedAt = new Date().toISOString();
    const { error: confirmationError } = await service.from("document_versions").update({
      upload_state: "confirmed",
      expected_sha256: createHash("sha256").update(FIXTURE_BYTES).digest("hex"),
      hash_source: "client_declared",
      upload_initiator_id: userId,
      idempotency_key: randomUUID(),
      request_fingerprint: createHash("sha256").update(`${suffix}:request`).digest("hex"),
      current_upload_attempt_id: attemptId,
      upload_confirmed_at: confirmedAt,
      reference_set_at: confirmedAt,
      reference_set_by: userId,
    }).eq("id", versionId);
    requireNoError(confirmationError, "upload confirmation");

    const { error: uploadError } = await service.storage.from("documents").upload(canonicalPath, FIXTURE_BYTES, {
      contentType: "text/markdown",
      upsert: false,
    });
    requireNoError(uploadError, "canonical original upload");

    return {
      workspaceId: resolvedWorkspaceId,
      documentId,
      versionId,
      operationId,
      storagePath: canonicalPath,
      chunks: [FIXTURE_CHUNK],
      service,
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
