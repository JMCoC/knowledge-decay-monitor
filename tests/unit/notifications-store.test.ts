import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database";
import { createNotificationStore } from "../../src/modules/notifications/store";
import type { NotificationBody, NotificationLease } from "../../src/modules/notifications/types";

type QueryResult = { data: unknown; error: unknown };

function rpcResult(data: unknown, error: unknown = null) {
  const calls: Array<[string, ...unknown[]]> = [];
  const builder: Record<string, unknown> = {};
  builder.abortSignal = vi.fn((...args: unknown[]) => {
    calls.push(["abortSignal", ...args]);
    return builder;
  });
  builder.then = (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve({ data, error }).then(resolve, reject);
  return { builder, calls };
}

function makeDb() {
  const rpc = vi.fn(() => rpcResult(null).builder);
  const from = vi.fn();
  const db = { rpc, from } as unknown as SupabaseClient<Database>;
  return { db, rpc, from };
}

const eventId = "11223344-5566-4788-99aa-bbccddeeff00";
const operationId = "22334455-6677-4899-aabb-ccddeeff0011";
const lease: NotificationLease = {
  eventId,
  operationId,
  attemptCount: 1,
  leaseExpiresAt: "2026-11-01T20:01:30.000Z",
};
const body: NotificationBody = {
  from: "Knowledge Decay Monitor <notifications@knowledge-decay-monitor.online>",
  to: ["operator@example.test"],
  subject: "Your analysis is complete",
  html: "<p>Your analysis is complete.</p>",
  text: "Your analysis is complete.",
};

describe("createNotificationStore", () => {
  let harness: ReturnType<typeof makeDb>;
  let store: ReturnType<typeof createNotificationStore>;

  beforeEach(() => {
    harness = makeDb();
    store = createNotificationStore(harness.db);
  });

  it("lists bounded, ordered notification metadata from the database clock", async () => {
    harness.rpc.mockReturnValueOnce(
      rpcResult([
        { event_id: eventId, recover_expired: false },
        { event_id: operationId, recover_expired: true },
      ]).builder,
    );

    expect(await store.listCandidates(99)).toEqual({
      ok: true,
      data: [
        { eventId, recoverExpired: false },
        { eventId: operationId, recoverExpired: true },
      ],
    });
    expect(harness.rpc).toHaveBeenCalledWith("list_notification_candidates", { p_limit: 5 });
    expect(harness.from).not.toHaveBeenCalled();
  });

  it("does not turn a candidate-query database error into an empty queue", async () => {
    harness.rpc.mockReturnValueOnce(
      rpcResult(null, { message: "private database detail" }).builder,
    );

    expect(await store.listCandidates(5)).toEqual({ ok: false, code: "INTERNAL_ERROR" });
  });

  it("lists only due alert IDs through an RPC that hides private delivery data", async () => {
    harness.rpc.mockReturnValueOnce(rpcResult([{ event_id: eventId }]).builder);

    expect(await store.listAlerts(10)).toEqual({ ok: true, data: [eventId] });
    expect(harness.rpc).toHaveBeenCalledWith("list_notification_alerts", { p_limit: 10 });
    expect(harness.from).not.toHaveBeenCalled();
  });

  it("claims atomically through the lease RPC and maps only its safe fields", async () => {
    harness.rpc.mockReturnValueOnce(
      rpcResult([
        {
          id: eventId,
          operation_id: operationId,
          attempt_count: 2,
          lease_expires_at: lease.leaseExpiresAt,
        },
      ]).builder,
    );

    expect(await store.claim(eventId)).toEqual({ ok: true, data: { ...lease, attemptCount: 2 } });
    expect(harness.rpc).toHaveBeenCalledWith("claim_notification_event", { p_event_id: eventId });
  });

  it("returns a no-claim result when the atomic RPC returns no row", async () => {
    harness.rpc.mockReturnValueOnce(rpcResult([]).builder);
    expect(await store.claim(eventId)).toEqual({ ok: true, data: null });
  });

  it("maps context authorization failures without exposing private details", async () => {
    harness.rpc.mockReturnValueOnce(
      rpcResult({ ok: false, code: "RECIPIENT_UNAVAILABLE", message: "auth email private detail" }).builder,
    );

    expect(await store.context(lease)).toEqual({ ok: false, code: "RECIPIENT_UNAVAILABLE" });
    expect(harness.rpc).toHaveBeenCalledWith("get_notification_context", {
      p_event_id: eventId,
      p_operation_id: operationId,
    });
  });

  it("persists the candidate body and returns the immutable request and idempotency key", async () => {
    harness.rpc.mockReturnValueOnce(
      rpcResult({
        ok: true,
        data: {
          body,
          requestJson: JSON.stringify(body),
          idempotencyKey: `kdm-terminal/${eventId}/v1`,
          firstSubmissionAt: "2026-11-01T20:00:00.000Z",
        },
      }).builder,
    );

    expect(await store.prepare(lease, body)).toEqual({
      ok: true,
      data: {
        body,
        requestJson: JSON.stringify(body),
        idempotencyKey: `kdm-terminal/${eventId}/v1`,
        firstSubmissionAt: "2026-11-01T20:00:00.000Z",
      },
    });
    expect(harness.rpc).toHaveBeenCalledWith("prepare_notification_delivery", {
      p_event_id: eventId,
      p_operation_id: operationId,
      p_request_json: JSON.stringify(body),
    });
  });

  it("maps malformed RPC responses and provider errors to controlled results", async () => {
    harness.rpc.mockReturnValueOnce(rpcResult({ ok: true, data: { body: [] } }).builder);
    expect(await store.context(lease)).toEqual({ ok: false, code: "INTERNAL_ERROR" });

    harness.rpc.mockReturnValueOnce(rpcResult(null, { message: "resend key must never escape" }).builder);
    expect(await store.sent(lease, "provider-id")).toEqual({ ok: false, code: "INTERNAL_ERROR" });
  });

  it("records and recovers attempts using lease tokens", async () => {
    harness.rpc
      .mockReturnValueOnce(rpcResult("pending").builder)
      .mockReturnValueOnce(rpcResult("failed").builder);

    expect(await store.failed(lease, "DELIVERY_FAILED", 3600)).toEqual({ ok: true, data: "pending" });
    expect(await store.recover(eventId)).toEqual({ ok: true, data: "failed" });
    expect(harness.rpc).toHaveBeenNthCalledWith(1, "record_notification_failure", {
      p_event_id: eventId,
      p_operation_id: operationId,
      p_error_code: "DELIVERY_FAILED",
      p_retry_after_seconds: 3600,
    });
    expect(harness.rpc).toHaveBeenNthCalledWith(2, "recover_notification_event", { p_event_id: eventId });
  });

  it("claims and retries telemetry with its own fencing operation", async () => {
    const alert = { eventId, operationId, code: "DELIVERY_FAILED" as const };
    harness.rpc
      .mockReturnValueOnce(rpcResult(alert).builder)
      .mockReturnValueOnce(rpcResult(true).builder)
      .mockReturnValueOnce(rpcResult(true).builder);

    expect(await store.claimAlert(eventId)).toEqual({ ok: true, data: alert });
    expect(await store.alertSent(alert)).toEqual({ ok: true, data: true });
    expect(await store.alertFailed(alert)).toEqual({ ok: true, data: true });
    expect(harness.rpc).toHaveBeenNthCalledWith(1, "claim_notification_alert", { p_event_id: eventId });
    expect(harness.rpc).toHaveBeenNthCalledWith(2, "confirm_notification_alert", {
      p_event_id: eventId,
      p_operation_id: operationId,
    });
    expect(harness.rpc).toHaveBeenNthCalledWith(3, "retry_notification_alert", {
      p_event_id: eventId,
      p_operation_id: operationId,
    });
  });

  it("bounds every database request at three seconds", async () => {
    vi.useFakeTimers();
    try {
      const never = { abortSignal: vi.fn(() => never), then: () => never };
      harness.rpc.mockReturnValueOnce(never);
      const pending = store.claim(eventId);
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(pending).resolves.toEqual({ ok: false, code: "INTERNAL_ERROR" });
    } finally {
      vi.useRealTimers();
    }
  });
});
