import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../../src/types/database";
import { assertLocalSupabaseReady, cleanupLocalUser, getLocalUploadMode, newLocalUser, setLocalUploadMode } from "../support/local-supabase";

const storageMock = vi.hoisted(() => ({
  remove: vi.fn(),
  exists: vi.fn(),
  download: vi.fn(),
  upload: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("../../src/modules/ingestion/storage", () => ({
  removeStorageObject: storageMock.remove,
  storageObjectExists: storageMock.exists,
  downloadStorageObject: storageMock.download,
  uploadStorageObject: storageMock.upload,
}));

import { computeRequestFingerprint, recoverUploadRecord, reserveUploadRecord } from "../../src/modules/ingestion/upload-store";

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

function runCleanup(mode: "inspect" | "apply") {
  let output: string;
  try {
    output = execFileSync(process.execPath, [
      resolve(process.cwd(), "scripts/cleanup-upload-attempts.mjs"),
      "--target", "local", "--mode", mode,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 30_000, windowsHide: true });
  } catch (error) {
    const stdout = error && typeof error === "object" ? Reflect.get(error, "stdout") : undefined;
    output = typeof stdout === "string" ? stdout : Buffer.isBuffer(stdout) ? stdout.toString("utf8") : "";
    if (!output.trim()) throw new Error(`Local cleanup ${mode} command failed without a summary.`);
  }
  try {
    return JSON.parse(output.trim()) as { retired: number; pending: number; absent: number; failed: number; processed: number };
  } catch {
    throw new Error(`Local cleanup ${mode} command returned an invalid summary.`);
  }
}

describe("local upload recovery and maintenance cleanup", () => {
  let previousUploadMode: "paused" | "active";

  beforeAll(async () => {
    await assertLocalSupabaseReady();
    previousUploadMode = getLocalUploadMode();
    setLocalUploadMode("active");
  });

  afterAll(() => setLocalUploadMode(previousUploadMode));

  beforeEach(() => vi.resetAllMocks());

  it("serializes recovery and runs inspect/apply/inspect over exact retired attempts", async () => {
    const { client, userId } = await newLocalUser();
    const suffix = randomUUID();
    const workspaceName = `kdm-${suffix}`;
    const service = serviceClient();
    let releasePendingDelete: (() => void) | undefined;
    let bootstrapped = false;

    try {
      const { data: workspace, error: bootstrapError } = await client.rpc("bootstrap_workspace", {
        workspace_name: workspaceName,
        full_name: "Upload Recovery Test Admin",
      });
      expect(bootstrapError).toBeNull();
      expect(workspace).toBeTruthy();
      if (bootstrapError || !workspace) throw new Error("Local upload recovery Admin bootstrap failed.");
      bootstrapped = true;

      const bytes = new TextEncoder().encode("a");
      const item = {
        metadata: { name: `Upload-${suffix}`, category: "SOP" as const, ownerId: userId },
        fileName: "one-byte.md",
        declaredMimeType: "text/markdown",
        sizeBytes: bytes.byteLength,
        signature: Buffer.from(bytes).toString("base64"),
        idempotencyKey: randomUUID(),
        sha256: "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
      };
      const reservation = await reserveUploadRecord({
        userId,
        idempotencyKey: item.idempotencyKey,
        requestFingerprint: await computeRequestFingerprint(item, "md"),
        name: item.metadata.name,
        category: item.metadata.category,
        ownerId: userId,
        extension: "md",
        sizeBytes: item.sizeBytes,
        sha256: item.sha256,
      });

      let notifyDeleteStarted!: () => void;
      const deleteStarted = new Promise<void>((resolveDelete) => { notifyDeleteStarted = resolveDelete; });
      const deleteGate = new Promise<void>((resolveDelete) => { releasePendingDelete = resolveDelete; });
      storageMock.remove.mockImplementation(async (path: string) => {
        expect(path).toBe(reservation.storagePath);
        notifyDeleteStarted();
        await deleteGate;
        return true;
      });

      const firstRecovery = recoverUploadRecord(userId, reservation.versionId).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      const didStartDelete = await Promise.race([
        deleteStarted.then(() => true),
        new Promise<boolean>((resolveDelete) => setTimeout(() => resolveDelete(false), 5000)),
      ]);
      if (!didStartDelete) {
        releasePendingDelete?.();
        throw new Error("Recovery did not reach the temporary-object delete boundary.");
      }
      await expect(recoverUploadRecord(userId, reservation.versionId))
        .rejects.toMatchObject({ sqlstate: "55000" });
      releasePendingDelete?.();
      const firstOutcome = await firstRecovery;
      if ("error" in firstOutcome) throw new Error("First local recovery failed after Storage cleanup.");
      const recovered = firstOutcome.result;
      expect(recovered).toMatchObject({ uploadState: "pending", canResume: true });
      expect(recovered.attemptId).not.toBe(reservation.attemptId);

      const before = runCleanup("inspect");
      expect(before.retired).toBeGreaterThanOrEqual(1);
      expect(before.pending).toBe(0);
      const applied = runCleanup("apply");
      expect(applied, JSON.stringify(applied)).toMatchObject({ failed: 0 });
      expect(applied.processed).toBeGreaterThanOrEqual(1);
      const after = runCleanup("inspect");
      expect(after.retired).toBe(before.retired);
      expect(after.failed).toBe(0);
      expect(after.absent).toBe(after.retired);

      const { data: attempts, error: attemptError } = await service.from("document_upload_attempts")
        .select("id,retired_at,cleanup_status")
        .eq("version_id", reservation.versionId)
        .order("created_at", { ascending: true });
      expect(attemptError).toBeNull();
      expect(attempts).toHaveLength(2);
      expect(attempts?.[0]).toMatchObject({ id: reservation.attemptId, cleanup_status: "absent" });
      expect(attempts?.[0]?.retired_at).toBeTruthy();
      expect(attempts?.[1]).toMatchObject({ id: recovered.attemptId, retired_at: null });

      const { data: version, error: versionError } = await service.from("document_versions")
        .select("processing_status,version_status,current_upload_attempt_id,storage_path")
        .eq("id", reservation.versionId)
        .single();
      expect(versionError).toBeNull();
      expect(version).toMatchObject({
        processing_status: "uploaded",
        version_status: null,
        current_upload_attempt_id: recovered.attemptId,
      });
      expect(version?.storage_path).not.toContain("attempts");
    } finally {
      releasePendingDelete?.();
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
