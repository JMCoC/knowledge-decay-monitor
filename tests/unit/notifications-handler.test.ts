import { describe, expect, it, vi } from "vitest";
import { handleNotificationRequest } from "../../supabase/functions/dispatch-notifications/handler";
import type {
  NotificationDispatchDeps,
  NotificationHandlerDeps,
  NotificationHandlerEnv,
  NotificationStore,
} from "../../src/modules/notifications/types";

const TOKEN = "local-notification-token-with-32-chars";
const ENV: NotificationHandlerEnv = {
  NOTIFICATIONS_ENABLED: "true",
  NOTIFICATIONS_INTERNAL_TOKEN: TOKEN,
  RESEND_API_KEY: "re_test_key_with_sufficient_fake_length",
  NOTIFICATIONS_FROM: "Knowledge Decay Monitor <notifications@knowledge-decay-monitor.online>",
  APP_ORIGIN: "http://localhost:3000",
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_SERVICE_ROLE_KEY: "local-test-service-role-key",
  SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
  NOTIFICATIONS_ENVIRONMENT: "development",
  NOTIFICATIONS_RELEASE_SHA: "d".repeat(40),
};
const SUMMARY = { claimed: 0, sent: 0, failed: 0, reported: 0 };

function request(options: {
  method?: string;
  body?: string;
  authorization?: string;
  contentType?: string;
} = {}): Request {
  const headers = new Headers();
  if (options.authorization !== undefined) headers.set("authorization", options.authorization);
  if (options.contentType !== undefined) headers.set("content-type", options.contentType);
  return new Request("https://example.test/functions/v1/dispatch-notifications", {
    method: options.method ?? "POST",
    headers,
    ...(options.method === "GET" || options.method === "HEAD"
      ? {}
      : { body: options.body ?? "{}" }),
  });
}

function makeDeps(overrides: Partial<NotificationHandlerDeps> = {}) {
  const pending: Promise<unknown>[] = [];
  const store = {} as NotificationStore;
  const deps: NotificationHandlerDeps = {
    createStore: vi.fn(() => store),
    createSender: vi.fn((): NotificationDispatchDeps["send"] => vi.fn(async () => ({
      ok: true,
      providerMessageId: "11111111-2222-4333-8444-555555555555",
    } as const))),
    createReporter: vi.fn((): NotificationDispatchDeps["report"] => vi.fn(async () => true)),
    isDispatchEnabled: vi.fn(async () => true),
    runDispatch: vi.fn(async () => SUMMARY),
    waitUntil: vi.fn((work: Promise<unknown>) => pending.push(work)),
    ...overrides,
  };
  return { deps, pending };
}

async function responseBody(response: Response): Promise<unknown> {
  return response.json();
}

describe("notification dispatch HTTP handler", () => {
  it("rejects unsupported methods without reading configuration or creating dependencies", async () => {
    const { deps } = makeDeps();
    const response = await handleNotificationRequest(request({ method: "GET" }), ENV, deps);

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(deps.createStore).not.toHaveBeenCalled();
    expect(deps.isDispatchEnabled).not.toHaveBeenCalled();
  });

  it("rejects an incorrect Bearer token before any dependency or database access", async () => {
    const { deps } = makeDeps();
    const response = await handleNotificationRequest(request({
      authorization: "Bearer wrong-token",
    }), ENV, deps);

    expect(response.status).toBe(401);
    expect(await responseBody(response)).toEqual({ error: "unauthorized" });
    expect(deps.createStore).not.toHaveBeenCalled();
    expect(deps.createSender).not.toHaveBeenCalled();
    expect(deps.createReporter).not.toHaveBeenCalled();
    expect(deps.isDispatchEnabled).not.toHaveBeenCalled();
    expect(deps.runDispatch).not.toHaveBeenCalled();
    expect(deps.waitUntil).not.toHaveBeenCalled();
  });

  it("rejects a missing Bearer token before any dependency or database access", async () => {
    const { deps } = makeDeps();
    const response = await handleNotificationRequest(request(), ENV, deps);

    expect(response.status).toBe(401);
    expect(await responseBody(response)).toEqual({ error: "unauthorized" });
    expect(deps.createStore).not.toHaveBeenCalled();
    expect(deps.createSender).not.toHaveBeenCalled();
    expect(deps.createReporter).not.toHaveBeenCalled();
    expect(deps.isDispatchEnabled).not.toHaveBeenCalled();
    expect(deps.runDispatch).not.toHaveBeenCalled();
    expect(deps.waitUntil).not.toHaveBeenCalled();
  });

  it("returns 503 while the runtime kill switch is disabled", async () => {
    const { deps } = makeDeps();
    const response = await handleNotificationRequest(request(), {
      ...ENV,
      NOTIFICATIONS_ENABLED: "false",
    }, deps);

    expect(response.status).toBe(503);
    expect(deps.createStore).not.toHaveBeenCalled();
    expect(deps.isDispatchEnabled).not.toHaveBeenCalled();
    expect(deps.runDispatch).not.toHaveBeenCalled();
  });

  it("fails closed when the runtime flag uses the planned zero value", async () => {
    const { deps } = makeDeps();
    const response = await handleNotificationRequest(request(), {
      ...ENV,
      NOTIFICATIONS_ENABLED: "0",
    }, deps);

    expect(response.status).toBe(503);
    expect(deps.createStore).not.toHaveBeenCalled();
    expect(deps.isDispatchEnabled).not.toHaveBeenCalled();
    expect(deps.runDispatch).not.toHaveBeenCalled();
  });

  it("returns 503 for an invalid private configuration without querying the database", async () => {
    const { deps } = makeDeps();
    const response = await handleNotificationRequest(request(), {
      ...ENV,
      APP_ORIGIN: "http://public.example.test",
    }, deps);

    expect(response.status).toBe(503);
    expect(deps.createStore).not.toHaveBeenCalled();
    expect(deps.isDispatchEnabled).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed JSON", "{"],
    ["an array", "[]"],
    ["a recipient field", '{"recipient":"operator@example.test"}'],
  ])("rejects %s without querying readiness", async (_name, body) => {
    const { deps } = makeDeps();
    const response = await handleNotificationRequest(request({
      body,
      authorization: `Bearer ${TOKEN}`,
      contentType: "application/json",
    }), ENV, deps);

    expect(response.status).toBe(400);
    expect(deps.createStore).not.toHaveBeenCalled();
    expect(deps.isDispatchEnabled).not.toHaveBeenCalled();
  });

  it("rejects bodies over 1024 bytes even when no length header is supplied", async () => {
    const { deps } = makeDeps();
    const response = await handleNotificationRequest(request({
      body: `{"padding":"${"x".repeat(1100)}"}`,
      authorization: `Bearer ${TOKEN}`,
      contentType: "application/json",
    }), ENV, deps);

    expect(response.status).toBe(400);
    expect(deps.createStore).not.toHaveBeenCalled();
    expect(deps.isDispatchEnabled).not.toHaveBeenCalled();
  });

  it("requires a JSON content type and the exact empty object body", async () => {
    const noContentType = makeDeps();
    const noContentTypeResponse = await handleNotificationRequest(request({
      authorization: `Bearer ${TOKEN}`,
    }), ENV, noContentType.deps);
    expect(noContentTypeResponse.status).toBe(400);
    expect(noContentType.deps.isDispatchEnabled).not.toHaveBeenCalled();

    const withField = makeDeps();
    const withFieldResponse = await handleNotificationRequest(request({
      authorization: `Bearer ${TOKEN}`,
      contentType: "application/json",
      body: '{"analysisId":"11223344-5566-4788-99aa-bbccddeeff00"}',
    }), ENV, withField.deps);
    expect(withFieldResponse.status).toBe(400);
    expect(withField.deps.isDispatchEnabled).not.toHaveBeenCalled();
  });

  it("returns 503 and claims nothing while the database scheduler toggle is disabled", async () => {
    const { deps } = makeDeps({ isDispatchEnabled: vi.fn(async () => false) });
    const response = await handleNotificationRequest(request({
      authorization: `Bearer ${TOKEN}`,
      contentType: "application/json",
    }), ENV, deps);

    expect(response.status).toBe(503);
    expect(deps.isDispatchEnabled).toHaveBeenCalledTimes(1);
    expect(deps.runDispatch).not.toHaveBeenCalled();
    expect(deps.waitUntil).not.toHaveBeenCalled();
  });

  it("returns 503 if the Sentry reporter is not prepared before checking the database toggle", async () => {
    const { deps } = makeDeps({
      createReporter: vi.fn(() => { throw new Error("Sentry is unavailable"); }),
    });
    const response = await handleNotificationRequest(request({
      authorization: `Bearer ${TOKEN}`,
      contentType: "application/json",
    }), ENV, deps);

    expect(response.status).toBe(503);
    expect(deps.createReporter).toHaveBeenCalledTimes(1);
    expect(deps.isDispatchEnabled).not.toHaveBeenCalled();
    expect(deps.runDispatch).not.toHaveBeenCalled();
  });

  it("returns 503 when the database readiness check throws", async () => {
    const { deps } = makeDeps({ isDispatchEnabled: vi.fn(async () => { throw new Error("db private failure"); }) });
    const response = await handleNotificationRequest(request({
      authorization: `Bearer ${TOKEN}`,
      contentType: "application/json",
    }), ENV, deps);

    expect(response.status).toBe(503);
    expect(await responseBody(response)).toEqual({ error: "not_ready" });
    expect(deps.runDispatch).not.toHaveBeenCalled();
    expect(deps.waitUntil).not.toHaveBeenCalled();
  });

  it("acknowledges the authenticated trigger without exposing the dispatch result", async () => {
    const { deps, pending } = makeDeps({
      runDispatch: vi.fn(async () => ({ claimed: 1, sent: 1, failed: 0, reported: 0 })),
    });
    const response = await handleNotificationRequest(request({
      authorization: `Bearer ${TOKEN}`,
      contentType: "application/json",
    }), ENV, deps);

    expect(response.status).toBe(202);
    expect(await responseBody(response)).toEqual({ accepted: true });
    expect(deps.waitUntil).toHaveBeenCalledTimes(1);
    await pending[0];
    expect(deps.runDispatch).toHaveBeenCalledTimes(1);
  });

  it("keeps the accepted ACK when the bounded dispatch work rejects", async () => {
    const { deps, pending } = makeDeps({
      runDispatch: vi.fn(async () => { throw new Error("private dispatch error"); }),
    });
    const response = await handleNotificationRequest(request({
      authorization: `Bearer ${TOKEN}`,
      contentType: "application/json",
    }), ENV, deps);

    expect(response.status).toBe(202);
    expect(await responseBody(response)).toEqual({ accepted: true });
    await expect(pending[0]).resolves.toBeUndefined();
  });

  it("returns 503 if the runtime cannot register background work", async () => {
    const { deps, pending } = makeDeps({
      waitUntil: vi.fn(() => { throw new Error("no EdgeRuntime waitUntil"); }),
    });
    const response = await handleNotificationRequest(request({
      authorization: `Bearer ${TOKEN}`,
      contentType: "application/json",
    }), ENV, deps);

    expect(response.status).toBe(503);
    await Promise.resolve();
    expect(deps.runDispatch).not.toHaveBeenCalled();
    expect(pending).toHaveLength(0);
  });
});
