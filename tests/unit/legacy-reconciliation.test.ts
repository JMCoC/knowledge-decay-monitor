import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { inspectLegacyOriginal } from "../../scripts/upload-maintenance.mjs";
import { parseReconciliationArgs } from "../../scripts/reconcile-legacy-uploads.mjs";

const actorId = "10000000-0000-4000-8000-000000000001";
const path = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/cccccccc-cccc-4ccc-8ccc-cccccccccccc/original.md";
const runtime = { url: "http://127.0.0.1:54321", serviceRoleKey: "test-service-key" };

afterEach(() => vi.unstubAllGlobals());

describe("legacy reconciliation CLI boundaries", () => {
  it("requires explicit target, mode, and a persisted operator id", () => {
    expect(parseReconciliationArgs([
      "--target", "local", "--mode", "inspect", "--actor-user-id", actorId,
    ])).toMatchObject({ target: "local", mode: "inspect", actorUserId: actorId });
    expect(() => parseReconciliationArgs(["--mode", "apply", "--actor-user-id", actorId]))
      .toThrow("A maintenance argument is missing its value.");
    expect(() => parseReconciliationArgs(["--target", "local", "--mode", "apply"]))
      .toThrow("An explicit operator identity is required.");
    expect(() => parseReconciliationArgs([
      "--target", "linked", "--mode", "apply", "--project-ref", "cdyjtoheovbvewewicaa",
      "--actor-user-id", actorId, "--project-ref", "other",
    ])).toThrow("Invalid reconciliation arguments.");
  });

  it("classifies only the structured NoSuchKey response as absence", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "NoSuchKey" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetch);
    await expect(inspectLegacyOriginal(runtime, path, null)).resolves.toEqual({ observation: "missing" });
    const [url, options] = fetch.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toContain("/storage/v1/object/authenticated/documents/");
    expect(options).toMatchObject({ method: "GET", redirect: "error" });

    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ code: "AccessDenied" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }));
    await expect(inspectLegacyOriginal(runtime, path, null)).rejects.toThrow("Storage inspection failed.");
  });

  it("hashes a valid one-byte Markdown object in memory and rejects size mismatch", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("a", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await expect(inspectLegacyOriginal(runtime, path, 1)).resolves.toEqual({
      observation: "valid",
      observedSizeBytes: 1,
      observedSha256: createHash("sha256").update("a").digest("hex"),
    });
    await expect(inspectLegacyOriginal(runtime, path, 2)).resolves.toEqual({ observation: "invalid" });
  });

  it("fails closed on an unregistered path before making an HTTP request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(inspectLegacyOriginal(runtime, "../outside.md", null))
      .rejects.toThrow("Legacy path is not a registered canonical object.");
    expect(fetch).not.toHaveBeenCalled();
  });
});
