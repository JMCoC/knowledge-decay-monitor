import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database";
import {
  assertLocalSupabaseReady,
  cleanupLocalUser,
  insertLocalProfile,
  newLocalUser,
  setLocalUploadMode,
} from "../support/local-supabase";

vi.mock("server-only", () => ({}));

import {
  finalizeUploadRecord,
  reserveUploadRecord,
  resumeUploadRecord,
} from "../../src/modules/ingestion/upload-store";

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

function reference(bytes: Uint8Array) {
  return {
    sizeBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    signature: Buffer.from(bytes.subarray(0, Math.min(8, bytes.byteLength))).toString("base64"),
  };
}

describe("same-workspace cross-user upload recovery", () => {
  beforeAll(async () => {
    await assertLocalSupabaseReady();
    setLocalUploadMode("active");
  });

  afterAll(() => setLocalUploadMode("paused"));

  it("allows same-workspace QA, hides foreign versions, and rejects mismatched bytes before Storage", async () => {
    const admin = await newLocalUser();
    const qa = await newLocalUser();
    const member = await newLocalUser();
    const otherAdmin = await newLocalUser();
    const service = serviceClient();
    const suffix = randomUUID();
    const workspaceName = `kdm-${suffix}`;
    const otherWorkspaceName = `kdm-${randomUUID()}`;

    try {
      const { data: workspaceId, error: bootstrapError } = await admin.client.rpc("bootstrap_workspace", {
        workspace_name: workspaceName,
        full_name: "Cross-user resume Admin",
      });
      expect(bootstrapError).toBeNull();
      if (bootstrapError || !workspaceId) throw new Error("Cross-user resume Admin bootstrap failed.");
      insertLocalProfile({
        userId: qa.userId,
        workspaceId,
        role: "QA Lead",
        fullName: "Cross-user resume QA",
        email: qa.email,
      });
      insertLocalProfile({
        userId: member.userId,
        workspaceId,
        role: "Member",
        fullName: "Cross-user resume Member",
        email: member.email,
      });

      const { data: otherWorkspaceId, error: otherBootstrapError } = await otherAdmin.client.rpc("bootstrap_workspace", {
        workspace_name: otherWorkspaceName,
        full_name: "Cross-workspace resume Admin",
      });
      expect(otherBootstrapError).toBeNull();
      if (otherBootstrapError || !otherWorkspaceId) throw new Error("Cross-workspace resume Admin bootstrap failed.");

      const bytes = new TextEncoder().encode("same tenant can resume this exact Markdown");
      const idempotencyKey = randomUUID();
      const reservation = await reserveUploadRecord({
        userId: admin.userId,
        idempotencyKey,
        requestFingerprint: createHash("sha256").update(idempotencyKey).digest("hex"),
        name: `Cross-user-${suffix}`,
        category: "SOP",
        ownerId: admin.userId,
        extension: "md",
        sizeBytes: bytes.byteLength,
        sha256: reference(bytes).sha256,
      });

      await expect(resumeUploadRecord(member.userId, reservation.versionId))
        .rejects.toMatchObject({ sqlstate: "42501" });
      await expect(resumeUploadRecord(otherAdmin.userId, reservation.versionId))
        .rejects.toMatchObject({ sqlstate: "P0002" });

      const foreignTarget = await resumeUploadRecord(qa.userId, reservation.versionId);
      expect(foreignTarget).toMatchObject({
        versionId: reservation.versionId,
        attemptId: reservation.attemptId,
        storagePath: reservation.storagePath,
      });

      const differentBytes = new TextEncoder().encode("a different Markdown file");
      await expect(resumeUploadRecord(qa.userId, reservation.versionId, reference(differentBytes)))
        .rejects.toMatchObject({ sqlstate: "22023" });

      const target = await resumeUploadRecord(qa.userId, reservation.versionId, reference(bytes));
      expect(target).toMatchObject({
        versionId: reservation.versionId,
        attemptId: reservation.attemptId,
        storagePath: reservation.storagePath,
        canonicalMimeType: "text/markdown",
      });
      if (!target || !("storagePath" in target)) throw new Error("The QA could not resume the pending upload.");

      const uploaded = await qa.client.storage.from("documents").upload(
        target.storagePath,
        new Blob([bytes], { type: target.canonicalMimeType }),
        { contentType: target.canonicalMimeType, upsert: false },
      );
      expect(uploaded.error).toBeNull();

      const finalized = await finalizeUploadRecord(qa.userId, target.versionId, target.attemptId);
      expect(finalized).toMatchObject({ uploadState: "confirmed", canOpen: true });

      const { data: version, error: versionError } = await service.from("document_versions")
        .select("upload_state,storage_path,processing_status,version_status")
        .eq("id", reservation.versionId)
        .single();
      expect(versionError).toBeNull();
      expect(version).toMatchObject({ upload_state: "confirmed", processing_status: "uploaded", version_status: null });
      const canonical = await service.storage.from("documents").download(reservation.storagePath
        .split("/attempts/")[0] + "/original.md");
      expect(canonical.error).toBeNull();
      if (!canonical.data) throw new Error("Cross-user recovery did not publish the canonical original.");
      expect(new Uint8Array(await canonical.data.arrayBuffer())).toEqual(bytes);
    } finally {
      const { data: workspace } = await service.from("workspaces").select("id").eq("name", workspaceName).maybeSingle();
      if (workspace) {
        const { data: documents } = await service.from("documents").select("id").eq("workspace_id", workspace.id);
        const documentIds = documents?.map((document) => document.id) ?? [];
        if (documentIds.length > 0) {
          const { data: versions } = await service.from("document_versions")
            .select("id,storage_path")
            .in("document_id", documentIds);
          const versionIds = versions?.map((version) => version.id) ?? [];
          const { data: attempts } = versionIds.length > 0
            ? await service.from("document_upload_attempts").select("storage_path").in("version_id", versionIds)
            : { data: [] as Array<{ storage_path: string }> };
          const paths = [
            ...(versions ?? []).map((version) => version.storage_path),
            ...(attempts ?? []).map((attempt) => attempt.storage_path),
          ];
          if (paths.length > 0) await service.storage.from("documents").remove(paths);
        }
      }
      await cleanupLocalUser(admin.userId);
      await cleanupLocalUser(qa.userId);
      await cleanupLocalUser(member.userId);
      await cleanupLocalUser(otherAdmin.userId);
    }
  });
});
