import { readNotificationsConfig } from "../../../src/modules/notifications/config.ts";
import type {
  NotificationConfig,
  NotificationHandlerDeps,
  NotificationHandlerEnv,
} from "../../../src/modules/notifications/types.ts";

function json(status: number, body: Record<string, boolean | string>, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function sameSecret(candidate: string, expected: string): boolean {
  if (candidate.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < candidate.length; index += 1) {
    difference |= candidate.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

function hasValidBearer(request: Request, expectedToken: string): boolean {
  const authorization = request.headers.get("authorization");
  if (!authorization) return false;
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  return match !== null && sameSecret(match[1] as string, expectedToken);
}

async function readEmptyJsonObject(request: Request): Promise<boolean> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return false;

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength) || Number(contentLength) > 1024) return false;
  }

  if (!request.body) return false;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (totalBytes > 1024) {
        await reader.cancel();
        return false;
      }
      chunks.push(result.value);
    }
  } catch {
    return false;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      && Object.keys(value).length === 0;
  } catch {
    return false;
  }
}

/** Authenticates the private scheduler request before creating any database dependency. */
export async function handleNotificationRequest(
  request: Request,
  env: NotificationHandlerEnv,
  deps: NotificationHandlerDeps,
): Promise<Response> {
  if (request.method !== "POST") {
    return json(405, { error: "method_not_allowed" }, { allow: "POST" });
  }

  let config: NotificationConfig;
  try {
    config = readNotificationsConfig((name) => env[name]);
  } catch {
    return json(503, { error: "not_ready" });
  }
  if (!config.enabled) return json(503, { error: "not_ready" });

  if (!hasValidBearer(request, config.internalToken)) {
    return json(401, { error: "unauthorized" });
  }
  if (!(await readEmptyJsonObject(request))) {
    return json(400, { error: "invalid_request" });
  }

  let store: ReturnType<NotificationHandlerDeps["createStore"]>;
  let send: ReturnType<NotificationHandlerDeps["createSender"]>;
  let report: ReturnType<NotificationHandlerDeps["createReporter"]>;
  try {
    store = deps.createStore(config);
    send = deps.createSender(config);
    report = deps.createReporter(config);
    if (!(await deps.isDispatchEnabled(config))) return json(503, { error: "not_ready" });
  } catch {
    return json(503, { error: "not_ready" });
  }

  let registered = false;
  const work = Promise.resolve()
    .then(() => registered
      ? deps.runDispatch({
          store,
          send,
          report,
          config: { from: config.from, appOrigin: config.appOrigin },
          monotonicNow: () => performance.now(),
          utcNow: () => Date.now(),
        })
      : undefined)
    .then(() => undefined)
    .catch(() => undefined);

  try {
    deps.waitUntil(work);
    registered = true;
  } catch {
    return json(503, { error: "not_ready" });
  }

  return json(202, { accepted: true });
}
