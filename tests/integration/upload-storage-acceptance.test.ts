import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database";
import {
  assertLocalSupabaseReady,
  cleanupLocalUser,
  expireLocalRecoveryLease,
  expireLocalVerificationLease,
  getLocalUploadMode,
  insertLocalProfile,
  newLocalUser,
  setLocalUploadMode,
} from "../support/local-supabase";

vi.mock("server-only", () => ({}));

import {
  finalizeUploadRecord,
  recoverUploadRecord,
  reserveUploadRecord,
  resumeUploadRecord,
  UploadStoreError,
} from "../../src/modules/ingestion/upload-store";
import { MAX_FILE_SIZE_BYTES } from "../../src/modules/ingestion/validation";
import { UploadVerificationError } from "../../src/modules/ingestion/verification";

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

function runLocalAttemptCleanup(mode: "inspect" | "apply") {
  const output = execFileSync(process.execPath, [
    resolve(process.cwd(), "scripts/cleanup-upload-attempts.mjs"),
    "--target", "local", "--mode", mode,
  ], { cwd: process.cwd(), encoding: "utf8", timeout: 30_000, windowsHide: true });
  return JSON.parse(output.trim()) as {
    retired: number;
    pending: number;
    absent: number;
    failed: number;
    processed: number;
  };
}

describe("real local Storage upload acceptance", () => {
  let previousUploadMode: "paused" | "active";

  beforeAll(async () => {
    await assertLocalSupabaseReady();
    previousUploadMode = getLocalUploadMode();
    setLocalUploadMode("active");
  });

  afterAll(() => setLocalUploadMode(previousUploadMode));

  it("verifies, publishes, and authorizes a real 10 MiB original", async () => {
    const service = serviceClient();
    const users: Array<Awaited<ReturnType<typeof newLocalUser>>> = [];
    const temporaryPaths: string[] = [];
    const canonicalPaths: string[] = [];

    try {
      const adminA = await newLocalUser();
      users.push(adminA);
      const workspaceAResult = await adminA.client.rpc("bootstrap_workspace", {
        workspace_name: `kdm-${randomUUID()}`,
        full_name: "Storage acceptance Admin A",
      });
      expect(workspaceAResult.error).toBeNull();
      if (!workspaceAResult.data) throw new Error("Storage acceptance Admin A bootstrap failed.");
      const workspaceA = workspaceAResult.data;

      const qaA = await newLocalUser();
      users.push(qaA);
      insertLocalProfile({
        userId: qaA.userId,
        workspaceId: workspaceA,
        role: "QA Lead",
        fullName: "Storage acceptance QA A",
        email: qaA.email,
      });
      const memberA = await newLocalUser();
      users.push(memberA);
      insertLocalProfile({
        userId: memberA.userId,
        workspaceId: workspaceA,
        role: "Member",
        fullName: "Storage acceptance Member A",
        email: memberA.email,
      });

      const adminB = await newLocalUser();
      users.push(adminB);
      const workspaceBResult = await adminB.client.rpc("bootstrap_workspace", {
        workspace_name: `kdm-${randomUUID()}`,
        full_name: "Storage acceptance Admin B",
      });
      expect(workspaceBResult.error).toBeNull();
      if (!workspaceBResult.data) throw new Error("Storage acceptance Admin B bootstrap failed.");

      const bytes = new Uint8Array(Buffer.alloc(MAX_FILE_SIZE_BYTES, 0x61));
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const reservation = await reserveUploadRecord({
        userId: adminA.userId,
        idempotencyKey: randomUUID(),
        requestFingerprint: createHash("sha256").update(randomUUID()).digest("hex"),
        name: `S1-02 real Storage ${randomUUID()}`,
        category: "SOP",
        ownerId: adminA.userId,
        extension: "md",
        sizeBytes: bytes.byteLength,
        sha256,
      });
      temporaryPaths.push(reservation.storagePath);
      const canonicalPath = `${workspaceA}/${reservation.documentId}/${reservation.versionId}/original.md`;
      canonicalPaths.push(canonicalPath);

      const unauthorizedBytes = new TextEncoder().encode("unauthorized fixture write");
      for (const actor of [memberA, adminB]) {
        const unauthorizedWrite = await actor.client.storage.from("documents").upload(
          reservation.storagePath,
          new Blob([unauthorizedBytes], { type: reservation.canonicalMimeType }),
          { contentType: reservation.canonicalMimeType, upsert: false },
        );
        expect(unauthorizedWrite.error).toBeTruthy();
        const absentAttempt = await service.storage.from("documents").download(reservation.storagePath);
        expect(absentAttempt.error).toBeTruthy();
      }

      const uploaded = await adminA.client.storage.from("documents").upload(
        reservation.storagePath,
        new Blob([bytes], { type: reservation.canonicalMimeType }),
        { contentType: reservation.canonicalMimeType, upsert: false },
      );
      expect(uploaded.error).toBeNull();
      expect(uploaded.data?.path).toBe(reservation.storagePath);

      const attemptFolder = `${workspaceA}/${reservation.documentId}/${reservation.versionId}/attempts/${reservation.attemptId}`;
      for (const actor of [adminA, qaA, memberA, adminB]) {
        const denied = await actor.client.storage.from("documents").download(reservation.storagePath);
        expect(denied.error).toBeTruthy();
        const hiddenListing = await actor.client.storage.from("documents").list(attemptFolder);
        expect(hiddenListing.error || (hiddenListing.data?.length ?? 0) === 0).toBeTruthy();
        const deniedTemporaryUrl = await actor.client.storage.from("documents")
          .createSignedUrl(reservation.storagePath, 300);
        expect(deniedTemporaryUrl.error).toBeTruthy();
        const deniedCanonicalUrl = await actor.client.storage.from("documents").createSignedUrl(canonicalPath, 300);
        expect(deniedCanonicalUrl.error).toBeTruthy();
        const deniedDelete = await actor.client.storage.from("documents").remove([reservation.storagePath]);
        expect(deniedDelete.error || (deniedDelete.data?.length ?? 0) === 0).toBeTruthy();
      }
      const temporaryStillExists = await service.storage.from("documents").download(reservation.storagePath);
      expect(temporaryStillExists.error).toBeNull();
      if (!temporaryStillExists.data) throw new Error("A denied temporary delete removed the uploaded bytes.");
      const temporaryHash = createHash("sha256")
        .update(new Uint8Array(await temporaryStillExists.data.arrayBuffer())).digest("hex");
      expect(temporaryHash === sha256).toBe(true);
      const canonicalBeforeConfirmation = await adminA.client.storage.from("documents").download(canonicalPath);
      expect(canonicalBeforeConfirmation.error).toBeTruthy();

      const realFetch = globalThis.fetch.bind(globalThis);
      let releaseVerification!: () => void;
      let signalVerificationStarted!: () => void;
      let heldVerificationRead = false;
      const verificationStarted = new Promise<void>((resolve) => { signalVerificationStarted = resolve; });
      const verificationGate = new Promise<void>((resolve) => { releaseVerification = resolve; });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await realFetch(input, init);
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (
          !heldVerificationRead
          && init?.method === "GET"
          && url.origin === LOCAL_API_URL
          && url.pathname === `/storage/v1/object/authenticated/documents/${reservation.storagePath}`
        ) {
          heldVerificationRead = true;
          signalVerificationStarted();
          await verificationGate;
        }
        return response;
      });
      let confirmed: Awaited<ReturnType<typeof finalizeUploadRecord>>;
      let finishing: Promise<Awaited<ReturnType<typeof finalizeUploadRecord>>> | undefined;
      try {
        finishing = finalizeUploadRecord(adminA.userId, reservation.versionId, reservation.attemptId);
        const reachedStorageRead = await Promise.race([
          verificationStarted.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
        ]);
        if (!reachedStorageRead) throw new Error("Finalization did not reach the real Storage verification request.");
        await expect(recoverUploadRecord(adminA.userId, reservation.versionId))
          .rejects.toMatchObject({ sqlstate: "55000" });
        await expect(finalizeUploadRecord(adminA.userId, reservation.versionId, reservation.attemptId))
          .rejects.toMatchObject({ sqlstate: "55000" });
        const inProgress = await service.from("document_versions").select("upload_state")
          .eq("id", reservation.versionId).single();
        expect(inProgress.data?.upload_state).toBe("verifying");
        releaseVerification();
        confirmed = await finishing;
        finishing = undefined;
      } finally {
        releaseVerification();
        if (finishing) await finishing.catch(() => undefined);
        vi.unstubAllGlobals();
      }
      expect(confirmed).toMatchObject({
        versionId: reservation.versionId,
        uploadState: "confirmed",
        canOpen: true,
        canResume: false,
        canRecover: false,
      });

      const [version, document, attempt] = await Promise.all([
        service.from("document_versions").select("processing_status,version_status,upload_state,storage_path")
          .eq("id", reservation.versionId).single(),
        service.from("documents").select("active_version_id").eq("id", reservation.documentId).single(),
        service.from("document_upload_attempts").select("retired_at,cleanup_status")
          .eq("id", reservation.attemptId).single(),
      ]);
      expect(version.error).toBeNull();
      expect(version.data).toMatchObject({
        processing_status: "uploaded",
        version_status: null,
        upload_state: "confirmed",
        storage_path: canonicalPath,
      });
      expect(document.data?.active_version_id).toBeNull();
      expect(attempt.data?.retired_at).toBeTruthy();
      expect(attempt.data?.cleanup_status).toBe("absent");

      for (const actor of [adminA, qaA]) {
        const signed = await actor.client.storage.from("documents").createSignedUrl(canonicalPath, 300);
        expect(signed.error).toBeNull();
        expect(Boolean(signed.data?.signedUrl)).toBe(true);
        const opened = await actor.client.storage.from("documents").download(canonicalPath);
        expect(opened.error).toBeNull();
        if (!opened.data) throw new Error("An authorized local role received no original bytes.");
        const openedHash = createHash("sha256").update(new Uint8Array(await opened.data.arrayBuffer())).digest("hex");
        expect(openedHash === sha256).toBe(true);
      }
      for (const actor of [memberA, adminB]) {
        const denied = await actor.client.storage.from("documents").download(canonicalPath);
        expect(denied.error).toBeTruthy();
        const deniedSignedUrl = await actor.client.storage.from("documents").createSignedUrl(canonicalPath, 300);
        expect(deniedSignedUrl.error).toBeTruthy();
      }
      const retiredTemporary = await adminA.client.storage.from("documents").download(reservation.storagePath);
      expect(retiredTemporary.error).toBeTruthy();
    } finally {
      const paths = [...temporaryPaths, ...canonicalPaths];
      if (paths.length > 0) {
        const { error } = await service.storage.from("documents").remove(paths);
        if (error) throw new Error("Synthetic local Storage object cleanup failed.");
      }
      for (const user of users) await cleanupLocalUser(user.userId);
    }
  }, 120_000);

  it("reconciles an actual canonical write when the persisted finish response is lost", async () => {
    const service = serviceClient();
    const temporaryPaths: string[] = [];
    const canonicalPaths: string[] = [];
    let userId: string | undefined;

    try {
      const admin = await newLocalUser();
      userId = admin.userId;
      const workspaceResult = await admin.client.rpc("bootstrap_workspace", {
        workspace_name: `kdm-${randomUUID()}`,
        full_name: "Storage lost-response Admin",
      });
      expect(workspaceResult.error).toBeNull();
      if (!workspaceResult.data) throw new Error("Lost-response Admin bootstrap failed.");

      const bytes = new TextEncoder().encode("verified original");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const reservation = await reserveUploadRecord({
        userId: admin.userId,
        idempotencyKey: randomUUID(),
        requestFingerprint: createHash("sha256").update(randomUUID()).digest("hex"),
        name: `Lost finish response ${randomUUID()}`,
        category: "SOP",
        ownerId: admin.userId,
        extension: "md",
        sizeBytes: bytes.byteLength,
        sha256,
      });
      temporaryPaths.push(reservation.storagePath);
      const canonicalPath = `${workspaceResult.data}/${reservation.documentId}/${reservation.versionId}/original.md`;
      canonicalPaths.push(canonicalPath);
      const upload = await admin.client.storage.from("documents").upload(
        reservation.storagePath,
        new Blob([bytes], { type: reservation.canonicalMimeType }),
        { contentType: reservation.canonicalMimeType, upsert: false },
      );
      expect(upload.error).toBeNull();

      const realFetch = globalThis.fetch.bind(globalThis);
      let lostFinishResponse = false;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (
          !lostFinishResponse
          && url.origin === LOCAL_API_URL
          && url.pathname === "/rest/v1/rpc/finish_upload_verification"
          && init?.method === "POST"
        ) {
          lostFinishResponse = true;
          return new Response(JSON.stringify({
            code: "XX000",
            details: null,
            hint: null,
            message: "Synthetic lost finish response",
          }), { status: 500, headers: { "content-type": "application/json" } });
        }
        return realFetch(input, init);
      });
      try {
        await expect(finalizeUploadRecord(admin.userId, reservation.versionId, reservation.attemptId))
          .rejects.toBeInstanceOf(UploadStoreError);
      } finally {
        vi.unstubAllGlobals();
      }
      expect(lostFinishResponse).toBe(true);

      const canonicalAfterLostResponse = await service.storage.from("documents").download(canonicalPath);
      expect(canonicalAfterLostResponse.error).toBeNull();
      if (!canonicalAfterLostResponse.data) throw new Error("The interrupted finish lost the canonical bytes.");
      const canonicalHash = createHash("sha256")
        .update(new Uint8Array(await canonicalAfterLostResponse.data.arrayBuffer())).digest("hex");
      expect(canonicalHash === sha256).toBe(true);
      const verifying = await service.from("document_versions").select("upload_state,storage_path")
        .eq("id", reservation.versionId).single();
      expect(verifying.data).toMatchObject({ upload_state: "verifying", storage_path: canonicalPath });
      const hiddenCanonical = await admin.client.storage.from("documents").download(canonicalPath);
      expect(hiddenCanonical.error).toBeTruthy();
      const hiddenCanonicalUrl = await admin.client.storage.from("documents").createSignedUrl(canonicalPath, 300);
      expect(hiddenCanonicalUrl.error).toBeTruthy();

      expireLocalVerificationLease(reservation.versionId);
      const retried = await finalizeUploadRecord(admin.userId, reservation.versionId, reservation.attemptId);
      expect(retried).toMatchObject({ uploadState: "confirmed", canOpen: true, canResume: false });
      const [version, document, attempt] = await Promise.all([
        service.from("document_versions").select("processing_status,version_status,upload_state,storage_path")
          .eq("id", reservation.versionId).single(),
        service.from("documents").select("active_version_id").eq("id", reservation.documentId).single(),
        service.from("document_upload_attempts").select("retired_at,cleanup_status")
          .eq("id", reservation.attemptId).single(),
      ]);
      expect(version.data).toMatchObject({
        processing_status: "uploaded", version_status: null,
        upload_state: "confirmed", storage_path: canonicalPath,
      });
      expect(document.data?.active_version_id).toBeNull();
      expect(attempt.data).toMatchObject({ cleanup_status: "absent" });
      expect(attempt.data?.retired_at).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
      const paths = [...temporaryPaths, ...canonicalPaths];
      if (paths.length > 0) {
        const { error } = await service.storage.from("documents").remove(paths);
        if (error) throw new Error("Synthetic local lost-response objects could not be cleaned.");
      }
      if (userId) await cleanupLocalUser(userId);
    }
  }, 120_000);

  it("keeps rejected bytes private and retries only their retired Storage path", async () => {
    const service = serviceClient();
    const users: Array<Awaited<ReturnType<typeof newLocalUser>>> = [];
    const temporaryPaths: string[] = [];
    const canonicalPaths: string[] = [];
    let releaseOldUploadResponse: (() => void) | undefined;
    let settleOldUpload: (() => Promise<void>) | undefined;

    try {
      const adminA = await newLocalUser();
      users.push(adminA);
      const workspaceAResult = await adminA.client.rpc("bootstrap_workspace", {
        workspace_name: `kdm-${randomUUID()}`,
        full_name: "Storage rejected Admin A",
      });
      expect(workspaceAResult.error).toBeNull();
      if (!workspaceAResult.data) throw new Error("Rejected-upload Admin A bootstrap failed.");
      const workspaceA = workspaceAResult.data;

      const qaA = await newLocalUser();
      users.push(qaA);
      insertLocalProfile({
        userId: qaA.userId, workspaceId: workspaceA, role: "QA Lead",
        fullName: "Storage rejected QA A", email: qaA.email,
      });
      const memberA = await newLocalUser();
      users.push(memberA);
      insertLocalProfile({
        userId: memberA.userId, workspaceId: workspaceA, role: "Member",
        fullName: "Storage rejected Member A", email: memberA.email,
      });

      const adminB = await newLocalUser();
      users.push(adminB);
      const workspaceBResult = await adminB.client.rpc("bootstrap_workspace", {
        workspace_name: `kdm-${randomUUID()}`,
        full_name: "Storage rejected Admin B",
      });
      expect(workspaceBResult.error).toBeNull();

      const expectedBytes = new TextEncoder().encode("expected");
      const rejectedBytes = new TextEncoder().encode("tampered");
      expect(rejectedBytes.byteLength).toBe(expectedBytes.byteLength);
      const expectedSha256 = createHash("sha256").update(expectedBytes).digest("hex");
      const reservation = await reserveUploadRecord({
        userId: adminA.userId,
        idempotencyKey: randomUUID(),
        requestFingerprint: createHash("sha256").update(randomUUID()).digest("hex"),
        name: `Rejected Storage ${randomUUID()}`,
        category: "SOP",
        ownerId: adminA.userId,
        extension: "md",
        sizeBytes: expectedBytes.byteLength,
        sha256: expectedSha256,
      });
      temporaryPaths.push(reservation.storagePath);
      const canonicalPath = `${workspaceA}/${reservation.documentId}/${reservation.versionId}/original.md`;
      canonicalPaths.push(canonicalPath);
      let signalOldUploadStored: (() => void) | undefined;
      let failNextDelete = false;
      let heldOldUploadResponse = false;
      const oldUploadResponseGate = new Promise<void>((resolve) => { releaseOldUploadResponse = resolve; });
      const oldUploadStored = new Promise<void>((resolve) => { signalOldUploadStored = resolve; });
      const realFetch = globalThis.fetch.bind(globalThis);
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const method = init?.method ?? (input instanceof Request ? input.method : "GET");
        const prefix = "/storage/v1/object/documents/";
        const path = url.pathname.startsWith(prefix)
          ? decodeURIComponent(url.pathname.slice(prefix.length))
          : "";
        if (method === "POST" && path === reservation.storagePath && !heldOldUploadResponse) {
          const response = await realFetch(input, init);
          heldOldUploadResponse = true;
          signalOldUploadStored?.();
          await oldUploadResponseGate;
          return response;
        }
        if (
          failNextDelete
          && url.pathname === "/storage/v1/object/documents"
          && method === "DELETE"
        ) {
          failNextDelete = false;
          return new Response("synthetic local Storage failure", { status: 503 });
        }
        return realFetch(input, init);
      });
      const oldUploadInFlight = adminA.client.storage.from("documents").upload(
        reservation.storagePath,
        new Blob([rejectedBytes], { type: reservation.canonicalMimeType }),
        { contentType: reservation.canonicalMimeType, upsert: false },
      );
      settleOldUpload = () => oldUploadInFlight.then(() => undefined, () => undefined);
      const oldUploadReachedStorage = await Promise.race([
        oldUploadStored.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
      ]);
      expect(oldUploadReachedStorage).toBe(true);

      const rejected = await finalizeUploadRecord(adminA.userId, reservation.versionId, reservation.attemptId);
      expect(rejected).toMatchObject({ uploadState: "rejected", canOpen: false });
      const persisted = await service.from("document_versions")
        .select("processing_status,version_status,upload_state,storage_path")
        .eq("id", reservation.versionId).single();
      expect(persisted.data).toMatchObject({
        processing_status: "uploaded", version_status: null,
        upload_state: "rejected", storage_path: canonicalPath,
      });
      const rejectedObject = await service.storage.from("documents").download(reservation.storagePath);
      expect(rejectedObject.error).toBeNull();
      if (!rejectedObject.data) throw new Error("Rejected bytes disappeared before recovery.");
      const rejectedHash = createHash("sha256")
        .update(new Uint8Array(await rejectedObject.data.arrayBuffer())).digest("hex");
      expect(rejectedHash === createHash("sha256").update(rejectedBytes).digest("hex")).toBe(true);

      const attemptFolder = `${workspaceA}/${reservation.documentId}/${reservation.versionId}/attempts/${reservation.attemptId}`;
      for (const actor of [adminA, qaA, memberA, adminB]) {
        const deniedDownload = await actor.client.storage.from("documents").download(reservation.storagePath);
        expect(deniedDownload.error).toBeTruthy();
        const hiddenListing = await actor.client.storage.from("documents").list(attemptFolder);
        expect(hiddenListing.error || (hiddenListing.data?.length ?? 0) === 0).toBeTruthy();
        const deniedSignedUrl = await actor.client.storage.from("documents")
          .createSignedUrl(reservation.storagePath, 300);
        expect(deniedSignedUrl.error).toBeTruthy();
        const deniedDelete = await actor.client.storage.from("documents").remove([reservation.storagePath]);
        expect(deniedDelete.error || (deniedDelete.data?.length ?? 0) === 0).toBeTruthy();
      }
      const rejectedBytesRetained = await service.storage.from("documents").download(reservation.storagePath);
      expect(rejectedBytesRetained.error).toBeNull();
      const absentCanonical = await service.storage.from("documents").download(canonicalPath);
      expect(absentCanonical.error).toBeTruthy();

      const validBytes = new TextEncoder().encode("stable canonical");
      const validSha256 = createHash("sha256").update(validBytes).digest("hex");
      const stable = await reserveUploadRecord({
        userId: adminA.userId,
        idempotencyKey: randomUUID(),
        requestFingerprint: createHash("sha256").update(randomUUID()).digest("hex"),
        name: `Stable canonical ${randomUUID()}`,
        category: "SOP",
        ownerId: adminA.userId,
        extension: "md",
        sizeBytes: validBytes.byteLength,
        sha256: validSha256,
      });
      temporaryPaths.push(stable.storagePath);
      const stableCanonicalPath = `${workspaceA}/${stable.documentId}/${stable.versionId}/original.md`;
      canonicalPaths.push(stableCanonicalPath);
      const stableUpload = await adminA.client.storage.from("documents").upload(
        stable.storagePath,
        new Blob([validBytes], { type: stable.canonicalMimeType }),
        { contentType: stable.canonicalMimeType, upsert: false },
      );
      expect(stableUpload.error).toBeNull();
      await expect(finalizeUploadRecord(adminA.userId, stable.versionId, stable.attemptId))
        .resolves.toMatchObject({ uploadState: "confirmed", canOpen: true });

      failNextDelete = true;
      await expect(recoverUploadRecord(adminA.userId, reservation.versionId))
        .rejects.toMatchObject({ code: "INTERNAL_ERROR" } satisfies Partial<UploadVerificationError>);
      expect(failNextDelete).toBe(false);
      const recovering = await service.from("document_versions")
        .select("upload_state,current_upload_attempt_id")
        .eq("id", reservation.versionId).single();
      expect(recovering.data).toMatchObject({
        upload_state: "recovering", current_upload_attempt_id: reservation.attemptId,
      });
      expireLocalRecoveryLease(reservation.versionId);

      const inspected = runLocalAttemptCleanup("inspect");
      expect(inspected.pending).toBeGreaterThan(0);
      const cleanup = runLocalAttemptCleanup("apply");
      expect(cleanup.failed).toBe(0);
      expect(cleanup.processed).toBeGreaterThan(0);
      const attemptAfterCleanup = await service.from("document_upload_attempts")
        .select("retired_at,cleanup_status").eq("id", reservation.attemptId).single();
      expect(attemptAfterCleanup.data).toMatchObject({ cleanup_status: "absent" });
      expect(attemptAfterCleanup.data?.retired_at).toBeTruthy();
      const removedRejectedObject = await service.storage.from("documents").download(reservation.storagePath);
      expect(removedRejectedObject.error).toBeTruthy();

      const recovered = await recoverUploadRecord(adminA.userId, reservation.versionId);
      expect(recovered).toMatchObject({ uploadState: "pending", canResume: true });
      expect(recovered.attemptId).not.toBe(reservation.attemptId);
      releaseOldUploadResponse?.();
      const lateClientResponse = await oldUploadInFlight;
      expect(lateClientResponse.error).toBeNull();
      await expect(finalizeUploadRecord(adminA.userId, reservation.versionId, reservation.attemptId))
        .rejects.toMatchObject({ sqlstate: "55000" } satisfies Partial<UploadStoreError>);

      // Model a Storage write that was authorized before retirement but commits after recovery.
      const lateOldWrite = await service.storage.from("documents").upload(
        reservation.storagePath,
        new Blob([rejectedBytes], { type: reservation.canonicalMimeType }),
        { contentType: reservation.canonicalMimeType, upsert: false },
      );
      expect(lateOldWrite.error).toBeNull();
      const newWriteAgainstRetiredAttempt = await adminA.client.storage.from("documents").upload(
        reservation.storagePath,
        new Blob([rejectedBytes], { type: reservation.canonicalMimeType }),
        { contentType: reservation.canonicalMimeType, upsert: false },
      );
      expect(newWriteAgainstRetiredAttempt.error).toBeTruthy();
      setLocalUploadMode("active");
      await expect(finalizeUploadRecord(adminA.userId, reservation.versionId, reservation.attemptId))
        .rejects.toMatchObject({ sqlstate: "55000" } satisfies Partial<UploadStoreError>);

      const lateWriteCleanup = runLocalAttemptCleanup("apply");
      expect(lateWriteCleanup.failed).toBe(0);
      const removedLateOldWrite = await service.storage.from("documents").download(reservation.storagePath);
      expect(removedLateOldWrite.error).toBeTruthy();
      const attemptAfterLateCleanup = await service.from("document_upload_attempts")
        .select("cleanup_status,retired_at").eq("id", reservation.attemptId).single();
      expect(attemptAfterLateCleanup.data).toMatchObject({ cleanup_status: "absent" });

      const replacement = await resumeUploadRecord(adminA.userId, reservation.versionId, {
        sizeBytes: expectedBytes.byteLength,
        sha256: expectedSha256,
        signature: Buffer.from(expectedBytes).toString("base64"),
      });
      expect(replacement).toMatchObject({
        versionId: reservation.versionId,
        canonicalMimeType: reservation.canonicalMimeType,
      });
      if (!replacement || !("storagePath" in replacement)) {
        throw new Error("The recovered current attempt has no Storage target.");
      }
      temporaryPaths.push(replacement.storagePath);
      const replacementUpload = await adminA.client.storage.from("documents").upload(
        replacement.storagePath,
        new Blob([expectedBytes], { type: replacement.canonicalMimeType }),
        { contentType: replacement.canonicalMimeType, upsert: false },
      );
      expect(replacementUpload.error).toBeNull();
      await expect(finalizeUploadRecord(adminA.userId, reservation.versionId, replacement.attemptId))
        .resolves.toMatchObject({ uploadState: "confirmed", canOpen: true });
      const replacementCanonical = await service.storage.from("documents").download(canonicalPath);
      expect(replacementCanonical.error).toBeNull();
      if (!replacementCanonical.data) throw new Error("The replacement attempt did not publish its canonical original.");
      expect(new Uint8Array(await replacementCanonical.data.arrayBuffer())).toEqual(expectedBytes);

      const stableCanonicalBefore = await service.storage.from("documents").download(stableCanonicalPath);
      expect(stableCanonicalBefore.error).toBeNull();
      if (!stableCanonicalBefore.data) throw new Error("The confirmed canonical original disappeared.");
      const stableHashBefore = createHash("sha256")
        .update(new Uint8Array(await stableCanonicalBefore.data.arrayBuffer())).digest("hex");
      expect(stableHashBefore === validSha256).toBe(true);

      const beforeRepeatCleanup = await service.from("documents")
        .select("id,active_version_id").eq("id", stable.documentId).single();
      const beforeRejectedVersion = await service.from("document_versions")
        .select("upload_state,version_status").eq("id", reservation.versionId).single();
      const repeatedCleanup = runLocalAttemptCleanup("apply");
      const thirdCleanup = runLocalAttemptCleanup("apply");
      expect(repeatedCleanup.failed).toBe(0);
      expect(thirdCleanup.failed).toBe(0);
      const afterRepeatCleanup = await service.from("documents")
        .select("id,active_version_id").eq("id", stable.documentId).single();
      const afterRejectedVersion = await service.from("document_versions")
        .select("upload_state,version_status").eq("id", reservation.versionId).single();
      expect(afterRepeatCleanup.data).toEqual(beforeRepeatCleanup.data);
      expect(afterRejectedVersion.data).toEqual(beforeRejectedVersion.data);
      const stableCanonicalAfter = await service.storage.from("documents").download(stableCanonicalPath);
      expect(stableCanonicalAfter.error).toBeNull();
      if (!stableCanonicalAfter.data) throw new Error("Repeated cleanup removed the confirmed canonical original.");
      const stableHashAfter = createHash("sha256")
        .update(new Uint8Array(await stableCanonicalAfter.data.arrayBuffer())).digest("hex");
      expect(stableHashAfter === validSha256).toBe(true);
    } finally {
      releaseOldUploadResponse?.();
      if (settleOldUpload) await settleOldUpload();
      vi.unstubAllGlobals();
      const paths = [...temporaryPaths, ...canonicalPaths];
      if (paths.length > 0) {
        const { error } = await service.storage.from("documents").remove(paths);
        if (error) throw new Error("Synthetic local rejected-upload Storage cleanup failed.");
      }
      for (const user of users) await cleanupLocalUser(user.userId);
    }
  }, 120_000);
});
