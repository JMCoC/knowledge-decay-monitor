import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database";
import { assertLocalSupabaseReady, cleanupLocalUser, getLocalUploadMode, newLocalUser, setLocalUploadMode } from "../support/local-supabase";

vi.mock("server-only", () => ({}));

import { finalizeUploadRecord, reserveUploadRecord } from "../../src/modules/ingestion/upload-store";

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

function bodyResponse(bytes: Uint8Array) {
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  return new Response(body, { status: 200 });
}

describe("local PostgreSQL upload finalization", () => {
  let previousUploadMode: "paused" | "active";

  beforeAll(async () => {
    await assertLocalSupabaseReady();
    previousUploadMode = getLocalUploadMode();
    setLocalUploadMode("active");
  });

  afterAll(() => {
    try {
      setLocalUploadMode(previousUploadMode);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses persisted CAS, publishes verified bytes, reconciles a lost response, and retires only temporaries", async () => {
    const { client, userId } = await newLocalUser();
    const suffix = randomUUID();
    const workspaceName = `kdm-${suffix}`;
    const service = serviceClient();
    const storedObjects = new Map<string, Uint8Array>();
    const lostResponsePaths = new Set<string>();
    const realFetch = globalThis.fetch.bind(globalThis);
    let bootstrapped = false;

    try {
      const { data: workspace, error: bootstrapError } = await client.rpc("bootstrap_workspace", {
        workspace_name: workspaceName,
        full_name: "Upload Finalization Test Admin",
      });
      expect(bootstrapError).toBeNull();
      expect(workspace).toBeTruthy();
      if (bootstrapError || !workspace) throw new Error("Local upload finalization Admin bootstrap failed.");
      bootstrapped = true;

      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.origin !== LOCAL_API_URL || !url.pathname.startsWith("/storage/v1/object/")) {
          return realFetch(input, init);
        }

        const method = init?.method ?? "GET";
        const tail = url.pathname.slice("/storage/v1/object/".length);
        if (method === "GET" && tail.startsWith("authenticated/documents/")) {
          const path = decodeURIComponent(tail.slice("authenticated/documents/".length));
          const existing = storedObjects.get(path);
          return existing ? bodyResponse(existing) : new Response(null, { status: 404 });
        }
        if (method === "POST" && tail.startsWith("documents/")) {
          const path = decodeURIComponent(tail.slice("documents/".length));
          if (storedObjects.has(path)) return new Response(null, { status: 409 });
          const bytes = new Uint8Array(init?.body as ArrayBuffer);
          storedObjects.set(path, bytes);
          if (lostResponsePaths.has(path)) throw new Error("Local transport dropped the write response.");
          return new Response("{}", { status: 201, headers: { "content-type": "application/json" } });
        }
        if (method === "DELETE" && tail === "documents") {
          const payload = JSON.parse(String(init?.body ?? "{}")) as { prefixes?: string[] };
          for (const path of payload.prefixes ?? []) storedObjects.delete(path);
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(null, { status: 404 });
      });

      const bytes = new TextEncoder().encode("a");
      for (const loseResponse of [false, true]) {
        const idempotencyKey = randomUUID();
        const item = {
          metadata: { name: `Upload-${suffix}-${loseResponse ? "lost" : "normal"}`, category: "SOP" as const, ownerId: userId },
          fileName: "one-byte.md",
          declaredMimeType: "text/markdown",
          sizeBytes: bytes.byteLength,
          signature: Buffer.from(bytes).toString("base64"),
          idempotencyKey,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
        const reservation = await reserveUploadRecord({
          userId,
          idempotencyKey,
          requestFingerprint: createHash("sha256").update(JSON.stringify([idempotencyKey])).digest("hex"),
          name: item.metadata.name,
          category: item.metadata.category,
          ownerId: userId,
          extension: "md",
          sizeBytes: bytes.byteLength,
          sha256: item.sha256,
        });
        storedObjects.set(reservation.storagePath, bytes);
        const canonicalPath = `${reservation.storagePath.split("/attempts/")[0]}/original.md`;
        if (loseResponse) lostResponsePaths.add(canonicalPath);

        const snapshot = await finalizeUploadRecord(userId, reservation.versionId, reservation.attemptId);
        expect(snapshot).toMatchObject({
          versionId: reservation.versionId,
          uploadState: "confirmed",
          attemptId: reservation.attemptId,
          canOpen: true,
          canResume: false,
          canRecover: false,
        });
        expect(storedObjects.get(canonicalPath)).toEqual(bytes);
        expect(storedObjects.has(reservation.storagePath)).toBe(false);

        const { data: version, error: versionError } = await service.from("document_versions")
          .select("processing_status,version_status,upload_state,storage_path")
          .eq("id", reservation.versionId)
          .single();
        expect(versionError).toBeNull();
        expect(version).toMatchObject({
          processing_status: "uploaded",
          version_status: null,
          upload_state: "confirmed",
          storage_path: canonicalPath,
        });
        const { data: document, error: documentError } = await service.from("documents")
          .select("active_version_id")
          .eq("id", reservation.documentId)
          .single();
        expect(documentError).toBeNull();
        expect(document?.active_version_id).toBeNull();
        const { data: attempt, error: attemptError } = await service.from("document_upload_attempts")
          .select("retired_at,cleanup_status")
          .eq("id", reservation.attemptId)
          .single();
        expect(attemptError).toBeNull();
        expect(attempt).toMatchObject({ cleanup_status: "absent" });
        expect(attempt?.retired_at).toBeTruthy();
      }
    } finally {
      vi.unstubAllGlobals();
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
