import "server-only";

import { createServiceClient, getServiceSupabaseConfig } from "@/lib/supabase/service";

const BUCKET = "documents";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CANONICAL_PATH = new RegExp(`^${UUID}/${UUID}/${UUID}/original\\.(pdf|docx|md)$`, "i");
const ATTEMPT_PATH = new RegExp(`^${UUID}/${UUID}/${UUID}/attempts/${UUID}/original\\.(pdf|docx|md)$`, "i");

export class StorageProviderError extends Error {
  constructor(readonly status?: number) {
    super("Storage provider request failed.");
    this.name = "StorageProviderError";
  }
}

function objectUrl(path: string, visibility: "authenticated" | "write"): { url: URL; serviceRoleKey: string } {
  if (!CANONICAL_PATH.test(path) && !ATTEMPT_PATH.test(path)) throw new StorageProviderError();
  const { url: projectUrl, serviceRoleKey } = getServiceSupabaseConfig();
  if (projectUrl.username || projectUrl.password || projectUrl.search || projectUrl.hash || projectUrl.pathname !== "/") {
    throw new StorageProviderError();
  }
  const route = visibility === "authenticated" ? "authenticated" : "";
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const url = new URL(projectUrl);
  url.pathname = `/storage/v1/object/${route ? `${route}/` : ""}${BUCKET}/${encodedPath}`;
  return { url, serviceRoleKey };
}

async function isMissingObjectResponse(response: Response): Promise<boolean> {
  if (response.status === 404) return true;
  if (response.status !== 400) return false;
  try {
    const payload: unknown = await response.json();
    return typeof payload === "object" && payload !== null
      && "code" in payload && payload.code === "NoSuchKey";
  } catch {
    return false;
  }
}

/** Returns null only for a confirmed missing-object response; other provider failures stay technical. */
export async function downloadStorageObject(path: string, signal: AbortSignal): Promise<Response | null> {
  const { url, serviceRoleKey } = objectUrl(path, "authenticated");
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
      },
      redirect: "error",
      signal,
    });
  } catch {
    throw new StorageProviderError();
  }
  if (await isMissingObjectResponse(response)) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new StorageProviderError(response.status);
  }
  return response;
}

/** Confirms presence only from a successful GET; only a confirmed 404 is absent. */
export async function storageObjectExists(path: string): Promise<boolean> {
  const response = await downloadStorageObject(path, AbortSignal.timeout(10_000));
  if (!response) return false;
  await response.body?.cancel().catch(() => undefined);
  return true;
}

/** Publishes exact verified bytes and never overwrites an existing object. */
export async function uploadStorageObject(
  path: string,
  bytes: Uint8Array,
  contentType: string,
  signal: AbortSignal,
): Promise<"created" | "exists"> {
  if (!CANONICAL_PATH.test(path) || !["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text/markdown"].includes(contentType)) {
    throw new StorageProviderError();
  }
  const { url, serviceRoleKey } = objectUrl(path, "write");
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
        "content-type": contentType,
        "cache-control": "max-age=3600",
        "x-upsert": "false",
      },
      body,
      redirect: "error",
      signal,
    });
  } catch {
    throw new StorageProviderError();
  }
  if (response.ok) return "created";
  await response.body?.cancel().catch(() => undefined);
  if (response.status === 400 || response.status === 409) return "exists";
  throw new StorageProviderError(response.status);
}

/** Removes one registered temporary path and confirms absence through Storage GET. */
export async function removeStorageObject(path: string): Promise<boolean> {
  if (!ATTEMPT_PATH.test(path)) throw new StorageProviderError();

  let deleteFailed = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const removal = createServiceClient().storage.from(BUCKET).remove([path]);
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new StorageProviderError()), 10_000);
    });
    const result = await Promise.race([removal, timeout]);
    deleteFailed = result.error !== null;
  } catch {
    deleteFailed = true;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  try {
    const response = await downloadStorageObject(path, AbortSignal.timeout(10_000));
    if (!response) return true;
    await response.body?.cancel().catch(() => undefined);
  } catch {
    throw new StorageProviderError();
  }

  if (deleteFailed) throw new StorageProviderError();
  return false;
}
