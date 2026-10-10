import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database";
import { assertLocalSupabaseReady, cleanupLocalUser, getLocalUploadMode, newLocalUser, setLocalUploadMode } from "../support/local-supabase";

vi.mock("server-only", () => ({}));

import {
  computeRequestFingerprint,
  getUploadSnapshot,
  reserveUploadRecord,
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

describe("local upload reservation and Storage boundary", () => {
  let previousUploadMode: "paused" | "active";

  beforeAll(async () => {
    await assertLocalSupabaseReady();
    previousUploadMode = getLocalUploadMode();
    setLocalUploadMode("active");
  });

  afterAll(() => {
    setLocalUploadMode(previousUploadMode);
  });

  it("recovers duplicate/lost-response reservations and allows only the registered direct upload", async () => {
    const service = serviceClient();
    const { client, userId } = await newLocalUser();
    const suffix = randomUUID();
    const workspaceName = `kdm-${suffix}`;
    let workspaceId: string | null = null;
    let attemptPath: string | null = null;
    let uploaded = false;

    try {
      const { data: bootstrappedWorkspace, error: bootstrapError } = await client.rpc("bootstrap_workspace", {
        workspace_name: workspaceName,
        full_name: "Upload Test Admin",
      });
      expect(bootstrapError).toBeNull();
      if (bootstrapError || !bootstrappedWorkspace) throw new Error("Local upload Admin bootstrap failed.");
      workspaceId = bootstrappedWorkspace as string;

      const file = new TextEncoder().encode("a");
      const item = {
        metadata: { name: `Upload-${suffix}`, category: "SOP" as const, ownerId: userId },
        fileName: "one-byte.md",
        declaredMimeType: "text/markdown",
        sizeBytes: file.byteLength,
        signature: Buffer.from(file.subarray(0, Math.min(8, file.byteLength))).toString("base64"),
        idempotencyKey: randomUUID(),
        sha256: createHash("sha256").update(file).digest("hex"),
      };
      const extension = "md" as const;
      const requestFingerprint = await computeRequestFingerprint(item, extension);
      const input = {
        userId,
        idempotencyKey: item.idempotencyKey,
        requestFingerprint,
        name: item.metadata.name,
        category: item.metadata.category,
        ownerId: item.metadata.ownerId,
        extension,
        sizeBytes: item.sizeBytes,
        sha256: item.sha256,
      };

      const [first, retry] = await Promise.all([
        reserveUploadRecord(input),
        reserveUploadRecord(input),
      ]);
      expect(first).toEqual(retry);
      attemptPath = first.storagePath;
      expect(first.uploadState).toBe("pending");
      expect(first.storagePath).toContain(`/attempts/${first.attemptId}/original.md`);

      const lostItem = {
        ...item,
        metadata: { ...item.metadata, name: `Lost-response-${suffix}` },
        idempotencyKey: randomUUID(),
      };
      const lostInput = {
        ...input,
        idempotencyKey: lostItem.idempotencyKey,
        requestFingerprint: await computeRequestFingerprint(lostItem, extension),
        name: lostItem.metadata.name,
      };
      const realFetch = globalThis.fetch;
      let responseWasDropped = false;
      vi.stubGlobal("fetch", async (request: RequestInfo | URL, init?: RequestInit) => {
        const response = await realFetch(request, init);
        const url = request instanceof Request ? new URL(request.url) : new URL(request.toString());
        if (!responseWasDropped && url.pathname.endsWith("/rpc/reserve_document_upload")) {
          responseWasDropped = true;
          throw new TypeError("Synthetic local reservation response loss.");
        }
        return response;
      });
      try {
        await expect(reserveUploadRecord(lostInput)).rejects.toThrow("Upload persistence failed.");
      } finally {
        vi.unstubAllGlobals();
      }
      expect(responseWasDropped).toBe(true);

      const recoveredReservation = await reserveUploadRecord(lostInput);
      expect(recoveredReservation).toMatchObject({ uploadState: "pending" });
      const [lostDocuments, lostVersions, lostAttempts] = await Promise.all([
        service.from("documents").select("id", { count: "exact", head: true }).eq("id", recoveredReservation.documentId),
        service.from("document_versions").select("id", { count: "exact", head: true }).eq("id", recoveredReservation.versionId),
        service.from("document_upload_attempts").select("id", { count: "exact", head: true }).eq("id", recoveredReservation.attemptId),
      ]);
      expect([lostDocuments.count, lostVersions.count, lostAttempts.count]).toEqual([1, 1, 1]);

      const [documents, versions, attempts] = await Promise.all([
        service.from("documents").select("id", { count: "exact", head: true }).eq("id", first.documentId),
        service.from("document_versions").select("id", { count: "exact", head: true }).eq("id", first.versionId),
        service.from("document_upload_attempts").select("id", { count: "exact", head: true }).eq("id", first.attemptId),
      ]);
      expect([documents.count, versions.count, attempts.count]).toEqual([1, 1, 1]);

      await expect(reserveUploadRecord({
        ...input,
        requestFingerprint: "c".repeat(64),
        sha256: "c".repeat(64),
      })).rejects.toMatchObject({ sqlstate: "23505" });

      const upload = await client.storage.from("documents").upload(
        first.storagePath,
        new Blob([file], { type: first.canonicalMimeType }),
        { contentType: first.canonicalMimeType, upsert: false },
      );
      expect(upload.error).toBeNull();
      expect(upload.data?.path).toBe(first.storagePath);
      uploaded = true;

      const snapshot = await getUploadSnapshot(userId, first.versionId);
      expect(snapshot).toMatchObject({
        versionId: first.versionId,
        attemptId: first.attemptId,
        uploadState: "pending",
        canOpen: false,
      });

      const temporaryDownload = await client.storage.from("documents").download(first.storagePath);
      expect(temporaryDownload.error).toBeTruthy();
      const temporaryList = await client.storage.from("documents").list(
        `${workspaceId}/${first.documentId}/${first.versionId}/attempts/${first.attemptId}`,
      );
      expect(temporaryList.error || (temporaryList.data?.length ?? 0) === 0).toBeTruthy();
      const temporaryDelete = await client.storage.from("documents").remove([first.storagePath]);
      expect(temporaryDelete.error).toBeNull();
      expect(temporaryDelete.data).toEqual([]);
      const attemptAfterDeniedDelete = await service.storage.from("documents").download(first.storagePath);
      expect(attemptAfterDeniedDelete.error).toBeNull();
      if (!attemptAfterDeniedDelete.data) throw new Error("Unauthorized local deletion removed the upload attempt.");
      expect(new Uint8Array(await attemptAfterDeniedDelete.data.arrayBuffer())).toEqual(file);

      const canonicalPath = `${workspaceId}/${first.documentId}/${first.versionId}/original.md`;
      const canonicalUpload = await client.storage.from("documents").upload(
        canonicalPath,
        new Blob([file], { type: first.canonicalMimeType }),
        { contentType: first.canonicalMimeType, upsert: false },
      );
      expect(canonicalUpload.error).toBeTruthy();
    } finally {
      if (attemptPath && uploaded) {
        const { error } = await service.storage.from("documents").remove([attemptPath]);
        if (error) throw new Error("Local upload object cleanup failed.");
      }
      await cleanupLocalUser(userId);
    }
  });
});
