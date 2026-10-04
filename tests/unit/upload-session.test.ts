import { describe, expect, it, vi } from "vitest";
import type {
  ActionResult,
  UploadItemResult,
  UploadSnapshot,
  UploadTarget,
} from "@/types/contracts";
import {
  clearOtherPendingUploadNamespaces,
  createUploadReference,
  createPendingUploadPersistence,
  pendingUploadStorageKey,
  prepareUpload,
  readPendingUploads,
  runUploadBatch,
  type PreparedUpload,
  type PendingUploadRecord,
  type UploadSessionDependencies,
} from "@/modules/ingestion/ui/upload-session";

const ownerId = "10000000-0000-4000-8000-000000000001";

function prepared(index: number, idempotencyKey = crypto.randomUUID()): PreparedUpload {
  const version = new File([`document ${index}`], `guide-${index}.md`, { type: "text/markdown" });
  return {
    file: version,
    metadata: { name: `Guide ${index}`, category: "SOP", ownerId },
    idempotencyKey,
    reference: { sizeBytes: version.size, sha256: "a".repeat(64), signature: "YQ==" },
  };
}

function target(index: number): UploadTarget {
  const versionId = `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  const attemptId = `40000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  return {
    versionId,
    attemptId,
    storagePath: `20000000-0000-4000-8000-000000000001/${versionId}/${versionId}/attempts/${attemptId}/original.md`,
    canonicalMimeType: "text/markdown",
  };
}

function confirmed(versionId: string, attemptId: string): UploadSnapshot {
  return {
    versionId,
    uploadState: "confirmed",
    attemptId,
    canOpen: true,
    canResume: false,
    canRecover: false,
  };
}

function snapshotResult(data: UploadSnapshot): ActionResult<UploadSnapshot> {
  return { ok: true, data };
}

function targetResult(data: UploadTarget | UploadSnapshot): ActionResult<UploadTarget | UploadSnapshot> {
  return { ok: true, data };
}

function reserved(items: PreparedUpload[]): ActionResult<UploadItemResult[]> {
  return {
    ok: true,
    data: items.map((_, index) => ({
      index,
      outcome: { ok: true, documentId: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`, target: target(index) },
    })),
  };
}

function dependencies(
  items: PreparedUpload[],
  overrides: Partial<UploadSessionDependencies> = {},
) {
  const pending = new Map<string, unknown>();
  const savePending = vi.fn((record: { idempotencyKey: string }) => pending.set(record.idempotencyKey, record));
  const clearPending = vi.fn((idempotencyKey: string) => pending.delete(idempotencyKey));
  const base: UploadSessionDependencies = {
    reserveUpload: vi.fn(async () => reserved(items)),
    uploadToStorage: vi.fn(async () => undefined),
    finalizeUpload: vi.fn(async ({ versionId, attemptId }) => snapshotResult(confirmed(versionId, attemptId))),
    getUploadState: vi.fn(async (versionId: string) => snapshotResult({
      versionId,
      uploadState: "pending",
      attemptId: target(0).attemptId,
      canOpen: false,
      canResume: true,
      canRecover: false,
    })),
    resumeUpload: vi.fn(async () => targetResult(target(0))),
    recoverUpload: vi.fn(async (versionId: string) => snapshotResult({
      versionId,
      uploadState: "pending",
      attemptId: target(0).attemptId,
      canOpen: false,
      canResume: true,
      canRecover: false,
    })),
    savePending,
    clearPending,
    setStatus: vi.fn(),
  };
  return { dependencies: { ...base, ...overrides }, pending, savePending, clearPending };
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); },
  };
}

describe("browser upload session", () => {
  it("hashes actual file bytes and accepts a one-byte Markdown reference", async () => {
    const file = new File(["a"], "one-byte.md", { type: "text/plain" });

    const result = await prepareUpload(file, { name: "One byte", category: "SOP", ownerId }, crypto.randomUUID());

    expect(result.reference).toEqual({
      sizeBytes: 1,
      sha256: "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
      signature: "YQ==",
    });
  });

  it("creates a reusable reference without upload metadata for a version recovery", async () => {
    const file = new File(["original bytes"], "guide.md", { type: "text/markdown" });

    await expect(createUploadReference(file)).resolves.toEqual({
      sizeBytes: 14,
      sha256: "52c3935626c104b2cbc9031291a1c4d56614c38f52072a361d658a58a9c48698",
      signature: "b3JpZ2luYWw=",
    });
  });

  it("accepts the 10 MiB Storage boundary and rejects one byte above it", async () => {
    const exactLimit = new File([new Uint8Array(10_485_760)], "maximum.md", { type: "text/markdown" });
    const oversized = new File([new Uint8Array(10_485_761)], "oversized.md", { type: "text/markdown" });

    const preparedLimit = await prepareUpload(
      exactLimit,
      { name: "Maximum", category: "SOP", ownerId },
      crypto.randomUUID(),
    );

    expect(preparedLimit.reference.sizeBytes).toBe(10_485_760);
    await expect(prepareUpload(
      oversized,
      { name: "Oversized", category: "SOP", ownerId },
      crypto.randomUUID(),
    )).rejects.toThrow("The selected file cannot be uploaded.");
  });

  it("persists only pending IDs and keys under a project and user namespace", () => {
    const storage = memoryStorage();
    const userId = "10000000-0000-4000-8000-000000000001";
    const key = pendingUploadStorageKey("http://127.0.0.1:54321", userId);
    const persistence = createPendingUploadPersistence(storage, key);
    const record = {
      idempotencyKey: crypto.randomUUID(),
      documentId: crypto.randomUUID(),
      versionId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      fileName: "private-runbook.md",
      sha256: "b".repeat(64),
      storagePath: "private/path",
    } as unknown as PendingUploadRecord;

    persistence.save(record);

    const stored = storage.getItem(key)!;
    expect(stored).not.toContain("private-runbook.md");
    expect(stored).not.toContain("sha256");
    expect(stored).not.toContain("private/path");
    expect(readPendingUploads(storage, key)).toEqual([{
      idempotencyKey: record.idempotencyKey,
      documentId: record.documentId,
      versionId: record.versionId,
      attemptId: record.attemptId,
    }]);
  });

  it("clears pending namespaces belonging to another identity in the same project", () => {
    const storage = memoryStorage();
    const first = pendingUploadStorageKey("https://project-a.supabase.co", "10000000-0000-4000-8000-000000000001");
    const second = pendingUploadStorageKey("https://project-a.supabase.co", "10000000-0000-4000-8000-000000000002");
    const unrelated = pendingUploadStorageKey("https://project-b.supabase.co", "10000000-0000-4000-8000-000000000002");
    storage.setItem(first, "[]");
    storage.setItem(second, "[]");
    storage.setItem(unrelated, "[]");

    clearOtherPendingUploadNamespaces(storage, "https://project-a.supabase.co", second);

    expect(storage.getItem(first)).toBeNull();
    expect(storage.getItem(second)).toBe("[]");
    expect(storage.getItem(unrelated)).toBe("[]");
  });

  it("limits transfers to two and serializes finalization", async () => {
    const items = [0, 1, 2, 3].map((index) => prepared(index));
    let activeUploads = 0;
    let peakUploads = 0;
    let activeFinalizers = 0;
    let peakFinalizers = 0;
    const mocks = dependencies(items, {
      uploadToStorage: vi.fn(async () => {
        activeUploads += 1;
        peakUploads = Math.max(peakUploads, activeUploads);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeUploads -= 1;
      }),
      finalizeUpload: vi.fn(async ({ versionId, attemptId }) => {
        activeFinalizers += 1;
        peakFinalizers = Math.max(peakFinalizers, activeFinalizers);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeFinalizers -= 1;
        return snapshotResult(confirmed(versionId, attemptId));
      }),
    });

    const result = await runUploadBatch(items, mocks.dependencies);

    expect(peakUploads).toBeLessThanOrEqual(2);
    expect(peakUploads).toBe(2);
    expect(peakFinalizers).toBe(1);
    expect(result).toHaveLength(4);
    expect(result.every((entry) => entry.status === "uploaded_processing_pending")).toBe(true);
    expect(mocks.clearPending).toHaveBeenCalledTimes(4);
  });

  it("reconciles an ambiguous transfer before retrying and reuses its idempotency key", async () => {
    const key = "550e8400-e29b-41d4-a716-446655440000";
    const item = prepared(0, key);
    const retryTarget = { ...target(4), versionId: target(0).versionId };
    const events: string[] = [];
    let transferCount = 0;
    const mocks = dependencies([item], {
      savePending: vi.fn(() => { events.push("save"); }),
      reserveUpload: vi.fn(async (input) => {
        events.push("reserve");
        expect(input[0]?.idempotencyKey).toBe(key);
        return reserved([item]);
      }),
      uploadToStorage: vi.fn(async () => {
        transferCount += 1;
        if (transferCount === 1) throw new Error("response lost");
      }),
      getUploadState: vi.fn(async (versionId: string) => snapshotResult({
        versionId,
        uploadState: "pending",
        attemptId: target(0).attemptId,
        canOpen: false,
        canResume: true,
        canRecover: false,
      })),
      resumeUpload: vi.fn(async () => targetResult(retryTarget)),
    });

    const result = await runUploadBatch([item], mocks.dependencies);

    expect(events.slice(0, 2)).toEqual(["save", "reserve"]);
    expect(mocks.dependencies.reserveUpload).toHaveBeenCalledTimes(1);
    expect(mocks.dependencies.getUploadState).toHaveBeenCalledTimes(1);
    expect(mocks.dependencies.resumeUpload).toHaveBeenCalledWith(target(0).versionId, item.reference);
    expect(mocks.dependencies.uploadToStorage).toHaveBeenNthCalledWith(2, retryTarget, item.file);
    expect(result[0]).toMatchObject({ status: "uploaded_processing_pending" });
    expect(mocks.clearPending).toHaveBeenCalledWith(key);
  });

  it("keeps the pending key when the reservation response is lost", async () => {
    const key = "550e8400-e29b-41d4-a716-446655440000";
    const item = prepared(0, key);
    const mocks = dependencies([item], {
      reserveUpload: vi.fn()
        .mockRejectedValueOnce(new Error("response lost"))
        .mockResolvedValueOnce(reserved([item])),
    });

    const first = await runUploadBatch([item], mocks.dependencies);

    expect(first[0]?.status).toBe("upload_incomplete");
    expect(mocks.pending.has(key)).toBe(true);
    expect(mocks.dependencies.uploadToStorage).not.toHaveBeenCalled();

    const retry = await runUploadBatch([item], mocks.dependencies);

    expect(mocks.dependencies.reserveUpload).toHaveBeenCalledTimes(2);
    expect(mocks.dependencies.reserveUpload).toHaveBeenNthCalledWith(
      2,
      expect.arrayContaining([expect.objectContaining({ idempotencyKey: key })]),
    );
    expect(retry[0]?.status).toBe("uploaded_processing_pending");
    expect(mocks.clearPending).toHaveBeenCalledWith(key);
  });
});
