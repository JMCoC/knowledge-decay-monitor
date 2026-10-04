import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  remove: vi.fn(),
  client: vi.fn(() => ({ storage: { from: () => ({ remove: mocks.remove }) } })),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mocks.client,
  getServiceSupabaseConfig: () => ({
    url: new URL("http://127.0.0.1:54321"),
    urlText: "http://127.0.0.1:54321",
    serviceRoleKey: "test-service-key",
  }),
}));

import {
  downloadStorageObject,
  removeStorageObject,
  storageObjectExists,
  StorageProviderError,
  uploadStorageObject,
} from "@/modules/ingestion/storage";

const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const documentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const versionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const attemptId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const attemptPath = `${workspaceId}/${documentId}/${versionId}/attempts/${attemptId}/original.md`;
const canonicalPath = `${workspaceId}/${documentId}/${versionId}/original.md`;

describe("trusted Storage adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mocks.fetch);
  });

  it("downloads one registered attempt from the authenticated private-object endpoint", async () => {
    mocks.fetch.mockResolvedValue(new Response("a"));
    const result = await downloadStorageObject(attemptPath, new AbortController().signal);

    expect(result).toBeInstanceOf(Response);
    const [url, options] = mocks.fetch.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(`http://127.0.0.1:54321/storage/v1/object/authenticated/documents/${attemptPath}`);
    expect(options).toMatchObject({
      method: "GET",
      redirect: "error",
      headers: { apikey: "test-service-key", authorization: "Bearer test-service-key" },
    });
  });

  it("treats 404 and the explicit Storage NoSuchKey response as absent", async () => {
    mocks.fetch.mockResolvedValue(new Response(null, { status: 404 }));
    await expect(downloadStorageObject(attemptPath, new AbortController().signal)).resolves.toBeNull();

    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ code: "NoSuchKey" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }));
    await expect(storageObjectExists(attemptPath)).resolves.toBe(false);

    for (const [status, body] of [[400, { code: "AccessDenied" }], [403, {}], [500, {}]] as const) {
      mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }));
      await expect(downloadStorageObject(attemptPath, new AbortController().signal))
        .rejects.toBeInstanceOf(StorageProviderError);
    }
    mocks.fetch.mockRejectedValueOnce(new Error("private network detail"));
    await expect(downloadStorageObject(attemptPath, new AbortController().signal))
      .rejects.toBeInstanceOf(StorageProviderError);
  });

  it("publishes verified bytes without overwrite and rejects redirects", async () => {
    mocks.fetch.mockResolvedValue(new Response(null, { status: 201 }));
    const bytes = new TextEncoder().encode("a");

    await expect(uploadStorageObject(canonicalPath, bytes, "text/markdown", new AbortController().signal))
      .resolves.toBe("created");
    const [url, options] = mocks.fetch.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(`http://127.0.0.1:54321/storage/v1/object/documents/${canonicalPath}`);
    expect(options).toMatchObject({
      method: "POST",
      body: expect.any(ArrayBuffer),
      redirect: "error",
      headers: { "x-upsert": "false", "content-type": "text/markdown" },
    });
    expect(new Uint8Array(options.body as ArrayBuffer)).toEqual(bytes);
  });

  it("deletes only a temporary attempt and confirms absence through a 404 read", async () => {
    mocks.remove.mockResolvedValue({ data: [], error: null });
    mocks.fetch.mockResolvedValue(new Response(null, { status: 404 }));

    await expect(removeStorageObject(attemptPath)).resolves.toBe(true);
    expect(mocks.remove).toHaveBeenCalledWith([attemptPath]);
    const [url, options] = mocks.fetch.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(`http://127.0.0.1:54321/storage/v1/object/authenticated/documents/${attemptPath}`);
    expect(options).toMatchObject({ method: "GET" });
    await expect(removeStorageObject(canonicalPath)).rejects.toBeInstanceOf(StorageProviderError);
    expect(mocks.remove).toHaveBeenCalledTimes(1);
  });

  it("keeps cleanup pending when the object still exists after removal", async () => {
    mocks.remove.mockResolvedValue({ data: [], error: null });
    mocks.fetch.mockResolvedValue(new Response("a", { status: 200 }));

    await expect(removeStorageObject(attemptPath)).resolves.toBe(false);
  });
});
