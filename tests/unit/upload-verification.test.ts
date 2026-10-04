import { createHash, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  download: vi.fn(),
  upload: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("../../src/modules/ingestion/storage", () => ({
  downloadStorageObject: storage.download,
  uploadStorageObject: storage.upload,
}));

import {
  readBoundedBody,
  verifyAndPromote,
  type VerificationClaim,
} from "../../src/modules/ingestion/verification";

const markdown = new TextEncoder().encode("a");
const hash = createHash("sha256").update(markdown).digest("hex");

function claim(overrides: Partial<VerificationClaim> = {}): VerificationClaim {
  const workspaceId = randomUUID();
  const documentId = randomUUID();
  const versionId = randomUUID();
  const attemptId = randomUUID();
  return {
    versionId,
    attemptId,
    operationId: randomUUID(),
    workspaceId,
    temporaryPath: `${workspaceId}/${documentId}/${versionId}/attempts/${attemptId}/original.md`,
    canonicalPath: `${workspaceId}/${documentId}/${versionId}/original.md`,
    expectedSha256: hash,
    expectedSizeBytes: markdown.byteLength,
    canonicalMimeType: "text/markdown",
    uploadState: "verifying",
    ...overrides,
  };
}

function response(bytes: Uint8Array, headers: Record<string, string> = {}) {
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  return new Response(body, { headers });
}

describe("bounded upload verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("counts streamed bytes and rejects an oversized body even when Content-Length lies", async () => {
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(10_485_761));
          controller.enqueue(new Uint8Array([1]));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );

    await expect(readBoundedBody(
      new Response(stream, { headers: { "content-length": "1" } }),
      new AbortController().signal,
    )).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(pulls).toBe(1);
    expect(cancelled).toBe(true);
  });

  it("cancels a stalled reader when the request signal aborts", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      pull() {
        return new Promise<void>(() => undefined);
      },
      cancel() {
        cancelled = true;
      },
    }, { highWaterMark: 0 });
    const controller = new AbortController();
    const read = readBoundedBody(new Response(stream), controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();

    await expect(read).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(cancelled).toBe(true);
  });

  it("treats the verification budget timeout as a pending technical failure", async () => {
    vi.useFakeTimers();
    try {
      storage.download.mockImplementation((_path: string, signal: AbortSignal) => new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
      }));
      const result = verifyAndPromote(claim());
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(result).resolves.toMatchObject({ state: "pending", error: "INTERNAL_ERROR" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts a one-byte Markdown file and promotes only verified bytes", async () => {
    storage.download.mockResolvedValue(response(markdown, { "content-length": "0" }));
    storage.upload.mockResolvedValue("created");
    const currentClaim = claim();

    await expect(verifyAndPromote(currentClaim)).resolves.toMatchObject({ state: "confirmed" });
    expect(storage.upload).toHaveBeenCalledWith(
      currentClaim.canonicalPath,
      expect.any(Uint8Array),
      "text/markdown",
      expect.any(AbortSignal),
    );
    expect(new Uint8Array((storage.upload.mock.calls[0]?.[1] as ArrayBuffer))).toEqual(markdown);
  });

  it.each([
    ["wrong size", { expectedSizeBytes: markdown.byteLength + 1 }],
    ["wrong digest", { expectedSha256: "0".repeat(64) }],
  ])("rejects a temporary object with %s", async (_label, override) => {
    storage.download.mockResolvedValue(response(markdown));

    await expect(verifyAndPromote(claim(override))).resolves.toMatchObject({ state: "rejected" });
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it("leaves a truly missing temporary object pending", async () => {
    storage.download.mockResolvedValue(null);

    await expect(verifyAndPromote(claim())).resolves.toMatchObject({ state: "pending" });
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it("maps provider read failures to pending with a controlled internal error", async () => {
    storage.download.mockRejectedValue(new Error("sensitive provider payload"));

    await expect(verifyAndPromote(claim())).resolves.toMatchObject({
      state: "pending",
      error: "INTERNAL_ERROR",
    });
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it("confirms a collided canonical path only when its exact bytes match", async () => {
    storage.download
      .mockResolvedValueOnce(response(markdown))
      .mockResolvedValueOnce(response(markdown));
    storage.upload.mockResolvedValue("exists");
    const currentClaim = claim();

    await expect(verifyAndPromote(currentClaim)).resolves.toMatchObject({ state: "confirmed" });
    expect(storage.download).toHaveBeenCalledTimes(2);
  });

  it("reconciles an upload whose response was lost after the canonical write", async () => {
    storage.download
      .mockResolvedValueOnce(response(markdown))
      .mockResolvedValueOnce(response(markdown));
    storage.upload.mockRejectedValue(new Error("connection closed after write"));

    await expect(verifyAndPromote(claim())).resolves.toMatchObject({ state: "confirmed" });
    expect(storage.download).toHaveBeenCalledTimes(2);
  });

  it("keeps a mismatching canonical object pending without deleting it", async () => {
    storage.download
      .mockResolvedValueOnce(response(markdown))
      .mockResolvedValueOnce(response(new TextEncoder().encode("other")));
    storage.upload.mockResolvedValue("exists");
    const currentClaim = claim();

    await expect(verifyAndPromote(currentClaim)).resolves.toMatchObject({
      state: "pending",
      error: "INTERNAL_ERROR",
    });
    expect(storage.upload).toHaveBeenCalledTimes(1);
  });

  it("does no Storage I/O for an already confirmed claim", async () => {
    await expect(verifyAndPromote(claim({ uploadState: "confirmed", operationId: null })))
      .resolves.toMatchObject({ state: "confirmed" });
    expect(storage.download).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
  });
});
