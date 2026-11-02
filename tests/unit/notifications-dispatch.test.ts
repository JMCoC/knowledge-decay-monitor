import { describe, expect, it, vi } from "vitest";
import { runNotificationDispatch } from "../../src/modules/notifications/dispatch";
import type {
  NotificationAlertLease,
  NotificationBody,
  NotificationContext,
  NotificationDispatchDeps,
  NotificationLease,
  NotificationStore,
} from "../../src/modules/notifications/types";

const eventId = "11223344-5566-4788-99aa-bbccddeeff00";
const operationId = "22334455-6677-4899-aabb-ccddeeff0011";
const secondEventId = "33445566-7788-499a-aabb-ccddeeff0022";
const appOrigin = "https://knowledge-decay-monitor.online";

const context: NotificationContext = {
  eventId,
  analysisId: secondEventId,
  workspaceId: "44556677-8899-4aaa-bbcc-ddeeff001122",
  recipientId: "55667788-99aa-4bbb-8cdd-eeff00112233",
  recipientEmail: "operator@example.test",
  type: "analysis_completed",
  finishedAt: "2026-11-01T19:57:00.000Z",
};
const lease: NotificationLease = {
  eventId,
  operationId,
  attemptCount: 1,
  leaseExpiresAt: "2026-11-01T20:01:30.000Z",
};
const body: NotificationBody = {
  from: "Knowledge Decay Monitor <notifications@knowledge-decay-monitor.online>",
  to: [context.recipientEmail],
  subject: "Your analysis is complete",
  html: "<p>Your analysis is complete.</p>",
  text: "Your analysis is complete.",
};
const prepared = {
  body,
  requestJson: "{\"persisted\":true}",
  idempotencyKey: `kdm-terminal/${eventId}/v1`,
  firstSubmissionAt: "2026-11-01T19:58:00.000Z",
};

function makeDeps(overrides: Partial<NotificationDispatchDeps> = {}) {
  let time = 0;
  const baseStore: NotificationStore = {
    listCandidates: vi.fn(async () => ({ ok: true as const, data: [{ eventId, recoverExpired: false }] })),
    claim: vi.fn(async () => ({ ok: true as const, data: lease })),
    context: vi.fn(async () => ({ ok: true as const, data: context })),
    prepare: vi.fn(async () => ({ ok: true as const, data: prepared })),
    sent: vi.fn(async () => ({ ok: true as const, data: true })),
    failed: vi.fn(async () => ({ ok: true as const, data: "pending" as const })),
    recover: vi.fn(async () => ({ ok: true as const, data: "pending" as const })),
    listAlerts: vi.fn(async () => ({ ok: true as const, data: [] as string[] })),
    claimAlert: vi.fn(async () => ({ ok: true as const, data: null })),
    alertSent: vi.fn(async () => ({ ok: true as const, data: true })),
    alertFailed: vi.fn(async () => ({ ok: true as const, data: true })),
  };
  const deps: NotificationDispatchDeps = {
    store: baseStore,
    send: vi.fn(async () => ({ ok: true as const, providerMessageId: "11111111-2222-4333-8444-555555555555" })),
    report: vi.fn(async () => true),
    config: { from: body.from, appOrigin },
    monotonicNow: () => time,
    utcNow: () => Date.parse("2026-11-01T20:00:00.000Z") + time,
    ...overrides,
  };
  return { deps, store: baseStore, setTime(value: number) { time = value; } };
}

describe("runNotificationDispatch", () => {
  it("prepares immutable content before send and confirms only after the DB ack", async () => {
    const harness = makeDeps();
    const order: string[] = [];
    vi.mocked(harness.store.prepare).mockImplementation(async () => {
      order.push("prepare");
      return { ok: true, data: prepared };
    });
    vi.mocked(harness.deps.send).mockImplementation(async (request) => {
      order.push("send");
      expect(request).toEqual(prepared);
      return { ok: true, providerMessageId: "11111111-2222-4333-8444-555555555555" };
    });
    vi.mocked(harness.store.sent).mockImplementation(async () => {
      order.push("ack");
      return { ok: true, data: true };
    });

    expect(await runNotificationDispatch(harness.deps)).toEqual({ claimed: 1, sent: 1, failed: 0, reported: 0 });
    expect(order).toEqual(["prepare", "send", "ack"]);
    expect(harness.store.context).toHaveBeenCalledTimes(2);
    expect(harness.store.sent).toHaveBeenCalledWith(lease, "11111111-2222-4333-8444-555555555555");
  });

  it("sends the persisted envelope when runtime configuration changes after preparation", async () => {
    const harness = makeDeps();
    vi.mocked(harness.store.prepare).mockImplementation(async () => {
      harness.deps.config = { from: "changed sender", appOrigin: "https://changed.example.test" };
      return { ok: true, data: prepared };
    });

    await runNotificationDispatch(harness.deps);

    expect(harness.deps.send).toHaveBeenCalledWith(prepared);
    expect(harness.deps.send).not.toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({ from: "changed sender" }),
    }));
  });

  it("does not send on a candidate-list database error", async () => {
    const harness = makeDeps();
    vi.mocked(harness.store.listCandidates).mockResolvedValue({ ok: false, code: "INTERNAL_ERROR" });

    const summary = await runNotificationDispatch(harness.deps);

    expect(summary.failed).toBeGreaterThan(0);
    expect(harness.deps.send).not.toHaveBeenCalled();
  });

  it("permanently closes an invalid recipient without calling the provider", async () => {
    const harness = makeDeps();
    vi.mocked(harness.store.context).mockResolvedValue({ ok: true, data: { ...context, recipientEmail: "not-an-email" } });

    await runNotificationDispatch(harness.deps);

    expect(harness.deps.send).not.toHaveBeenCalled();
    expect(harness.store.failed).toHaveBeenCalledWith(lease, "RECIPIENT_UNAVAILABLE");
  });

  it("revalidates recipient authorization immediately before HTTP", async () => {
    const harness = makeDeps();
    vi.mocked(harness.store.context)
      .mockResolvedValueOnce({ ok: true, data: context })
      .mockResolvedValueOnce({ ok: true, data: { ...context, recipientEmail: "changed@example.test" } });

    await runNotificationDispatch(harness.deps);

    expect(harness.deps.send).not.toHaveBeenCalled();
    expect(harness.store.failed).toHaveBeenCalledWith(lease, "RECIPIENT_UNAVAILABLE");
  });

  it("does not send if workspace or recipient identity changes after preparation", async () => {
    const harness = makeDeps();
    vi.mocked(harness.store.context)
      .mockResolvedValueOnce({ ok: true, data: context })
      .mockResolvedValueOnce({ ok: true, data: { ...context, workspaceId: "66778899-aabb-4ccc-8dde-eff001122334" } });

    await runNotificationDispatch(harness.deps);

    expect(harness.deps.send).not.toHaveBeenCalled();
    expect(harness.store.failed).toHaveBeenCalledWith(lease, "RECIPIENT_UNAVAILABLE");
  });

  it("does not claim when fewer than 28 seconds remain in the execution budget", async () => {
    let clockCall = 0;
    const harness = makeDeps({ monotonicNow: () => (clockCall++ === 0 ? 0 : 18_001) });

    await runNotificationDispatch(harness.deps);

    expect(harness.store.claim).not.toHaveBeenCalled();
    expect(harness.deps.send).not.toHaveBeenCalled();
  });

  it("recovers expired leases before claims and does not send in the same pass", async () => {
    const harness = makeDeps();
    vi.mocked(harness.store.listCandidates).mockResolvedValue({ ok: true, data: [{ eventId, recoverExpired: true }] });

    await runNotificationDispatch(harness.deps);

    expect(harness.store.recover).toHaveBeenCalledWith(eventId);
    expect(harness.store.claim).not.toHaveBeenCalled();
    expect(harness.deps.send).not.toHaveBeenCalled();
  });

  it("does not mark sent when the provider accepted but the database acknowledgement was lost", async () => {
    const harness = makeDeps();
    vi.mocked(harness.store.sent).mockResolvedValue({ ok: false, code: "INTERNAL_ERROR" });

    const summary = await runNotificationDispatch(harness.deps);

    expect(harness.deps.send).toHaveBeenCalledTimes(1);
    expect(harness.store.sent).toHaveBeenCalledTimes(1);
    expect(summary.sent).toBe(0);
    expect(harness.store.failed).not.toHaveBeenCalled();
  });

  it("passes the bounded provider retry hint to persisted failure policy", async () => {
    const harness = makeDeps();
    vi.mocked(harness.deps.send).mockResolvedValue({ ok: false, code: "DELIVERY_FAILED", retryAfterSeconds: 3600 });

    await runNotificationDispatch(harness.deps);

    expect(harness.store.failed).toHaveBeenCalledWith(lease, "DELIVERY_FAILED", 3600);
  });

  it("never starts delivery after the first-submission window or lease cannot cover the HTTP timeout", async () => {
    const harness = makeDeps({
      utcNow: () => Date.parse("2026-11-02T19:00:00.000Z"),
    });

    await runNotificationDispatch(harness.deps);

    expect(harness.store.failed).toHaveBeenCalledWith(lease, "INTERNAL_ERROR");
    expect(harness.deps.send).not.toHaveBeenCalled();
  });

  it("uses no document or accounting dependencies and bounds alerts ahead of mail", async () => {
    const harness = makeDeps();
    vi.mocked(harness.store.listAlerts).mockResolvedValue({
      ok: true,
      data: [eventId, secondEventId, "66778899-aabb-4ccc-ddee-ff0011223344", "778899aa-bbcc-4dde-eff0-011223344556", "8899aabb-ccdd-4eef-8011-223344556677"],
    });
    vi.mocked(harness.store.claimAlert).mockImplementation(async (id) => ({
      ok: true,
      data: { eventId: id, operationId, code: "DELIVERY_FAILED" },
    }));
    vi.mocked(harness.deps.report).mockResolvedValue(false);

    const summary = await runNotificationDispatch(harness.deps);

    expect(harness.store.claimAlert).toHaveBeenCalledTimes(2);
    expect(harness.store.alertFailed).toHaveBeenCalledTimes(2);
    expect(harness.deps.send).toHaveBeenCalledTimes(1);
    expect(summary.claimed).toBeLessThanOrEqual(5);
  });

  it("limits event claims to five and never runs more than two sends concurrently", async () => {
    const harness = makeDeps();
    const ids = [eventId, secondEventId, "66778899-aabb-4ccc-ddee-ff0011223344", "778899aa-bbcc-4dde-eff0-011223344556", "8899aabb-ccdd-4eef-8011-223344556677", "99aabbcc-ddee-4ff0-8112-233445566778"];
    vi.mocked(harness.store.listCandidates).mockResolvedValue({
      ok: true,
      data: ids.map((id) => ({ eventId: id, recoverExpired: false })),
    });
    vi.mocked(harness.store.claim).mockImplementation(async (id) => ({
      ok: true,
      data: { ...lease, eventId: id, operationId: `op-${id}` },
    }));
    vi.mocked(harness.store.context).mockImplementation(async (currentLease) => ({
      ok: true,
      data: { ...context, eventId: currentLease.eventId },
    }));
    let active = 0;
    let peak = 0;
    vi.mocked(harness.deps.send).mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return { ok: true, providerMessageId: "11111111-2222-4333-8444-555555555555" };
    });

    const summary = await runNotificationDispatch(harness.deps);

    expect(summary.claimed).toBeLessThanOrEqual(5);
    expect(harness.store.claim).toHaveBeenCalledTimes(5);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("does not duplicate delivery when two invocations race for the same event", async () => {
    const harness = makeDeps();
    let claimCount = 0;
    vi.mocked(harness.store.claim).mockImplementation(async () => {
      claimCount += 1;
      return claimCount === 1 ? { ok: true as const, data: lease } : { ok: true as const, data: null };
    });

    await Promise.all([
      runNotificationDispatch(harness.deps),
      runNotificationDispatch(harness.deps),
    ]);

    expect(harness.deps.send).toHaveBeenCalledTimes(1);
  });

  it("treats a reporting exception as retryable and does not stop new email work", async () => {
    const harness = makeDeps();
    const alert: NotificationAlertLease = { eventId, operationId, code: "DELIVERY_FAILED" };
    vi.mocked(harness.store.listAlerts).mockResolvedValue({ ok: true, data: [eventId] });
    vi.mocked(harness.store.claimAlert).mockResolvedValue({ ok: true, data: alert });
    vi.mocked(harness.deps.report).mockRejectedValue(new Error("sensitive sentry response"));

    await runNotificationDispatch(harness.deps);

    expect(harness.store.alertFailed).toHaveBeenCalledWith(alert);
    expect(harness.deps.send).toHaveBeenCalledTimes(1);
  });
});
