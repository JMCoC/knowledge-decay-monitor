import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

import { createBatchPersistence } from "../../src/modules/analysis/worker/batch-persistence";
import { createFinalization } from "../../src/modules/analysis/worker/finalization";
import { runAnalysisJob } from "../../src/modules/analysis/worker/process-analysis";
import { runNotificationDispatch } from "../../src/modules/notifications/dispatch";
import type { NotificationStore } from "../../src/modules/notifications/types";
import type { AnalysisExecutionManifest } from "../../src/types/analysis-internal";
import type { Database, Json } from "../../src/types/database";
import type { AnalysisWorkerDb } from "../../src/modules/analysis/worker/types";
import { FakeAnalysisProvider } from "../../supabase/functions/analyze/_test_doubles/analysis-provider.fake";
import { createAnalysisFixture } from "../support/analysis-fixtures";
import { assertLocalSupabaseReady } from "../support/local-supabase";
import {
  createFakeResend,
  createNotificationDispatchDeps,
  createNotificationFixture,
  createScopedNotificationStore,
  prioritizeNotificationEvent,
  withNotificationDispatchEnabled,
} from "../support/notification-fixtures";

const LOCAL_API_URL = "http://127.0.0.1:54321";
const MANIFEST: AnalysisExecutionManifest = {
  fingerprintVersion: "s2-05-v2",
  pricingVersion: "s2-04-v1",
  promptVersion: "s2-11-notifications-producer-v1",
  outputSchemaVersion: "s2-11-notifications-producer-findings-v1",
  providers: {
    primary: { provider: "synthetic-test", model: "fake" },
    fallback: { provider: "synthetic-test", model: "fake" },
  },
};
const MANIFEST_JSON = MANIFEST as unknown as Json;

function serviceClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key || process.env.KDM_LOCAL_SUPABASE_URL !== LOCAL_API_URL) {
    throw new Error("Local notification test configuration is missing.");
  }
  return createClient<Database>(LOCAL_API_URL, key, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
}

async function createRealTerminalRun(
  status: "completed" | "failed",
) {
  const fixture = await createAnalysisFixture({ status: "failed", versionCount: 2 });
  const service = serviceClient();
  let analysisId: string | undefined;
  try {
    const source = fixture.versions[0]?.versionId;
    const comparison = fixture.versions[1]?.versionId;
    if (!source || !comparison) throw new Error("The producer fixture has no analysis pair.");

    const estimate = await service.rpc("create_analysis_estimate", {
      p_actor_id: fixture.adminId,
      p_source_version_ids: [source],
      p_comparison_version_ids: [comparison],
      p_manifest: MANIFEST_JSON,
    });
    if (estimate.error || !estimate.data?.[0]?.estimate_ref) {
      throw new Error("The real analysis estimate could not be created.");
    }
    const created = await service.rpc("run_analysis", {
      p_actor_id: fixture.adminId,
      p_estimate_ref: estimate.data[0].estimate_ref,
      p_idempotency_key: `s2-11-notification-producer-${randomUUID()}`,
      p_current_manifest: MANIFEST_JSON,
    });
    if (created.error || !created.data?.[0]?.analysis_id) {
      throw new Error("The real analysis run could not be created.");
    }
    analysisId = created.data[0].analysis_id;

    const workerClient = service as unknown as AnalysisWorkerDb;
    const provider = status === "completed"
      ? new FakeAnalysisProvider()
      : new FakeAnalysisProvider({ failAtCallIndex: 0, failCode: "ESTIMATE_STALE" });
    const result = await runAnalysisJob({
      client: workerClient,
      provider,
      persistence: createBatchPersistence(workerClient),
      finalization: createFinalization(workerClient),
      analysisId,
    });
    expect(result.kind).toBe(status);

    const { data: events, error: eventsError } = await service
      .from("notification_events")
      .select("id,recipient_id,type")
      .eq("analysis_id", analysisId);
    expect(eventsError).toBeNull();
    expect(events).toHaveLength(1);
    const event = events?.[0];
    if (!event) throw new Error("Real finalization did not create its terminal notification event.");
    expect(event.recipient_id).toBe(fixture.adminId);
    expect(event.type).toBe(status === "completed" ? "analysis_completed" : "analysis_failed");

    const { count: findingsCount, error: findingsError } = await service
      .from("findings")
      .select("id", { count: "exact", head: true })
      .eq("analysis_id", analysisId);
    expect(findingsError).toBeNull();
    expect(findingsCount).toBe(0);

    return { fixture, service, analysisId, eventId: event.id, status };
  } catch (error) {
    if (analysisId) {
      await fixture.sql.query(`delete from private.analysis_finding_evidence_staging where analysis_id = '${analysisId}'::uuid;`);
      await fixture.sql.query(`delete from private.analysis_finding_staging where analysis_id = '${analysisId}'::uuid;`);
    }
    await fixture.dispose();
    throw error;
  }
}

async function disposeRealTerminalRun(fixture: Awaited<ReturnType<typeof createRealTerminalRun>>) {
  await fixture.fixture.sql.query(
    `delete from private.analysis_finding_evidence_staging where analysis_id = '${fixture.analysisId}'::uuid;`,
  );
  await fixture.fixture.sql.query(
    `delete from private.analysis_finding_staging where analysis_id = '${fixture.analysisId}'::uuid;`,
  );
  await fixture.fixture.dispose();
}

describe("S2-11 local notification delivery", () => {
  beforeAll(assertLocalSupabaseReady);

  it("replays_same_request_after_lost_response", async () => {
    const fixture = await createNotificationFixture({ status: "completed", withLedger: true });
    const resend = createFakeResend();
    resend.loseNextResponse();
    try {
      await withNotificationDispatchEnabled(fixture.sql, async () => {
        const deps = createNotificationDispatchDeps(fixture.store, resend.send);
        expect(await fixture.store.listCandidates(5)).toEqual({
          ok: true,
          data: expect.arrayContaining([{ eventId: fixture.eventId, recoverExpired: false }]),
        });
        expect(await runNotificationDispatch(deps)).toMatchObject({ claimed: 1, sent: 0, failed: 1 });
        const first = await fixture.snapshot();
        expect(first.event.error_code).toBe("DELIVERY_FAILED");
        expect(first.delivery?.request_json).toBeTruthy();
        expect(resend.calls).toHaveLength(1);
        expect(first.event.status).toBe("pending");
        expect(first.event.attempt_count).toBe(1);
        await fixture.setNextAttemptDue();

        expect(await runNotificationDispatch(deps)).toMatchObject({ claimed: 1, sent: 1, failed: 0 });
        expect(resend.calls).toHaveLength(2);
        expect(resend.calls[1]).toEqual(resend.calls[0]);
        expect(resend.logicalDeliveryCount).toBe(1);
        const final = await fixture.snapshot();
        expect(final.event.status).toBe("sent");
        expect(final.event.attempt_count).toBe(2);
        expect(final.delivery?.provider_message_id).toMatch(/^synthetic-resend-/);
      });
    } finally {
      await fixture.dispose();
    }
  }, 60_000);

  it("stale_lease_cannot_ack", async () => {
    const fixture = await createNotificationFixture({ status: "completed" });
    try {
      await withNotificationDispatchEnabled(fixture.sql, async () => {
        const old = await fixture.store.claim(fixture.eventId);
        expect(old.ok && old.data).toBeTruthy();
        if (!old.ok || !old.data) throw new Error("The first notification claim was not created.");
        await fixture.expireLease();
        expect(await fixture.store.recover(fixture.eventId)).toEqual({ ok: true, data: "pending" });
        await fixture.setNextAttemptDue();
        const current = await fixture.store.claim(fixture.eventId);
        expect(current.ok && current.data).toBeTruthy();
        if (!current.ok || !current.data) throw new Error("The recovered notification could not be claimed.");
        expect(current.data.operationId).not.toBe(old.data.operationId);
        expect(await fixture.store.sent(old.data, "synthetic-resend-stale"))
          .toEqual({ ok: false, code: "LEASE_LOST" });
        const state = await fixture.snapshot();
        expect(state.event.status).toBe("pending");
        expect(state.event.attempt_count).toBe(2);
        expect(state.event.operation_id).toBe(current.data.operationId);
        expect(state.delivery?.provider_message_id).toBeNull();
      });
    } finally {
      await fixture.dispose();
    }
  }, 60_000);

  it("third_attempt_crash_never_sends_fourth", async () => {
    const fixture = await createNotificationFixture({ status: "completed" });
    const resend = createFakeResend();
    resend.rejectNextResponse();
    resend.rejectNextResponse();
    try {
      await withNotificationDispatchEnabled(fixture.sql, async () => {
        const firstDeps = createNotificationDispatchDeps(fixture.store, resend.send);
        await runNotificationDispatch(firstDeps);
        await fixture.setNextAttemptDue();
        await runNotificationDispatch(firstDeps);
        await fixture.setNextAttemptDue();

        const crashStore: NotificationStore = {
          ...fixture.store,
          async sent() { throw new Error("synthetic process crash after provider acceptance"); },
        };
        await runNotificationDispatch(createNotificationDispatchDeps(crashStore, resend.send));
        expect(resend.calls).toHaveLength(3);
        expect(resend.logicalDeliveryCount).toBe(1);
        expect((await fixture.snapshot()).event.attempt_count).toBe(3);

        await fixture.expireLease();
        expect(await fixture.store.recover(fixture.eventId)).toEqual({ ok: true, data: "failed" });
        const afterCrash = await runNotificationDispatch(firstDeps);
        expect(afterCrash.sent).toBe(0);
        expect(resend.calls).toHaveLength(3);
        const terminal = await fixture.snapshot();
        expect(terminal.event.status).toBe("failed");
        expect(terminal.event.attempt_count).toBe(3);
      });
    } finally {
      await fixture.dispose();
    }
  }, 60_000);

  it("retries_use_persisted_sender_origin_template", async () => {
    const fixture = await createNotificationFixture({ status: "failed" });
    const resend = createFakeResend();
    resend.rejectNextResponse();
    try {
      await withNotificationDispatchEnabled(fixture.sql, async () => {
        const firstDeps = createNotificationDispatchDeps(fixture.store, resend.send, {
          appOrigin: "https://initial.example.test",
        });
        await runNotificationDispatch(firstDeps);
        const persisted = (await fixture.snapshot()).delivery?.request_json;
        expect(typeof persisted).toBe("string");

        await fixture.setNextAttemptDue();
        const retryDeps = createNotificationDispatchDeps(fixture.store, resend.send, {
          appOrigin: "https://changed.example.test",
        });
        await runNotificationDispatch(retryDeps);

        expect(resend.calls).toHaveLength(2);
        expect(resend.calls[1]?.requestJson).toBe(persisted);
        expect(resend.calls[1]?.requestJson).toContain("https://initial.example.test/login");
        expect(resend.calls[1]?.requestJson).not.toContain("https://changed.example.test");
        expect(JSON.parse(resend.calls[1]!.requestJson)).toMatchObject({
          from: "Knowledge Decay Monitor <notifications@knowledge-decay-monitor.online>",
          to: [fixture.adminCredentials.email],
          subject: "Your analysis could not be completed",
        });
      });
    } finally {
      await fixture.dispose();
    }
  }, 60_000);

  it("email_role_or_tenant_change_prevents_send", async () => {
    const roleFixture = await createNotificationFixture({ status: "completed" });
    const tenantFixture = await createNotificationFixture({ status: "completed" });
    try {
      await withNotificationDispatchEnabled(roleFixture.sql, async () => {
        const runAfterMutation = async (
          fixture: typeof roleFixture,
          mutate: () => Promise<void>,
          restore: () => Promise<void>,
        ) => {
          let contextCalls = 0;
          let mutationError: unknown;
          const store: NotificationStore = {
            ...fixture.store,
            async context(lease) {
              contextCalls += 1;
              if (contextCalls === 2) {
                try { await mutate(); }
                catch (error) { mutationError = error; throw error; }
              }
              return fixture.store.context(lease);
            },
          };
          const resend = createFakeResend();
          try {
            await runNotificationDispatch(createNotificationDispatchDeps(store, resend.send));
            expect(contextCalls).toBe(2);
            expect(mutationError).toBeUndefined();
            expect(resend.calls).toHaveLength(0);
            expect((await fixture.snapshot()).event.status).toBe("failed");
          } finally {
            await restore();
          }
        };

        await runAfterMutation(
          roleFixture,
          async () => {
            await roleFixture.sql.query(`update public.profiles set role='Admin' where id='${roleFixture.qaId}'::uuid;`);
            await roleFixture.sql.query(`update public.profiles set role='Member' where id='${roleFixture.adminId}'::uuid;`);
          },
          async () => {
            await roleFixture.sql.query(`update public.profiles set role='Admin' where id='${roleFixture.adminId}'::uuid;`);
            await roleFixture.sql.query(`update public.profiles set role='QA Lead' where id='${roleFixture.qaId}'::uuid;`);
          },
        );
        await runAfterMutation(
          tenantFixture,
          async () => {
            await tenantFixture.sql.query(`update auth.users set email='kdm-${randomUUID()}@example.test' where id='${tenantFixture.adminId}'::uuid;`);
          },
          async () => {
            await tenantFixture.sql.query(`update auth.users set email='${tenantFixture.adminCredentials.email}' where id='${tenantFixture.adminId}'::uuid;`);
          },
        );
      });
    } finally {
      await tenantFixture.dispose();
      await roleFixture.dispose();
    }
  }, 60_000);

  it("late_recovery_after_23h_does_not_resend", async () => {
    const fixture = await createNotificationFixture({ status: "completed" });
    const resend = createFakeResend();
    resend.loseNextResponse();
    try {
      await withNotificationDispatchEnabled(fixture.sql, async () => {
        const deps = createNotificationDispatchDeps(fixture.store, resend.send);
        await runNotificationDispatch(deps);
        await fixture.ageFirstSubmission(24);
        await fixture.setNextAttemptDue();
        await runNotificationDispatch(deps);

        expect(resend.calls).toHaveLength(1);
        expect(resend.logicalDeliveryCount).toBe(1);
        const state = await fixture.snapshot();
        expect(state.event.status).toBe("failed");
        expect(state.event.attempt_count).toBe(2);
        expect(state.event.error_code).toBe("DELIVERY_FAILED");
      });
    } finally {
      await fixture.dispose();
    }
  }, 60_000);

  it("sentry_failure_is_recovered_without_email_retry", async () => {
    const fixture = await createNotificationFixture({ status: "failed" });
    const resend = createFakeResend();
    resend.rejectNextResponse();
    resend.rejectNextResponse();
    resend.rejectNextResponse();
    let reportAttempts = 0;
    try {
      await withNotificationDispatchEnabled(fixture.sql, async () => {
        const deps = createNotificationDispatchDeps(fixture.store, resend.send, {
          report: async () => ++reportAttempts > 1,
        });
        await runNotificationDispatch(deps);
        await fixture.setNextAttemptDue();
        await runNotificationDispatch(deps);
        await fixture.setNextAttemptDue();
        await runNotificationDispatch(deps);
        expect((await fixture.snapshot()).event.status).toBe("failed");
        expect(resend.calls).toHaveLength(3);

        await runNotificationDispatch(deps);
        expect(reportAttempts).toBe(1);
        await fixture.setAlertNextAttemptDue();
        await runNotificationDispatch(deps);

        expect(reportAttempts).toBe(2);
        expect(resend.calls).toHaveLength(3);
        expect((await fixture.snapshot()).event.status).toBe("failed");
      });
    } finally {
      await fixture.dispose();
    }
  }, 60_000);
});

describe("S2-11 real analysis producer", () => {
  beforeAll(assertLocalSupabaseReady);

  it.each(["completed", "failed"] as const)("delivers the real S2-08 %s event, including zero findings", async (status) => {
    const run = await createRealTerminalRun(status);
    const resend = createFakeResend();
    try {
      await prioritizeNotificationEvent(run.fixture.sql, run.eventId, 101);
      const store = createScopedNotificationStore(run.service, [run.eventId]);
      await withNotificationDispatchEnabled(run.fixture.sql, async () => {
        const candidates = await store.listCandidates(5);
        expect(candidates).toEqual({
          ok: true,
          data: expect.arrayContaining([{ eventId: run.eventId, recoverExpired: false }]),
        });
        const summary = await runNotificationDispatch(createNotificationDispatchDeps(store, resend.send));
        expect(summary).toMatchObject({ claimed: 1, sent: 1, failed: 0 });
        expect(resend.calls).toHaveLength(1);
        const message = JSON.parse(resend.calls[0]!.requestJson) as { to: string[]; subject: string; text: string };
        expect(message.to).toEqual([run.fixture.adminCredentials.email]);
        expect(message.subject).toBe(status === "completed"
          ? "Your analysis is complete"
          : "Your analysis could not be completed");
        expect(message.text).toContain(run.analysisId);

        const state = await run.fixture.sql.query(`
          select e.status::text || '|' || e.recipient_id::text || '|' || a.status::text || '|' ||
                 (select count(*) from public.findings f where f.analysis_id=a.id)::text || '|' ||
                 (select string_agg(l.event_type::text, ',' order by l.event_type) from public.credit_ledger l where l.analysis_id=a.id)
          from public.notification_events e join public.analyses a on a.id=e.analysis_id
          where e.id='${run.eventId}'::uuid;
        `);
        const [eventStatus, recipientId, analysisStatus, findingCount, ledger] = state.trim().split("|");
        expect(eventStatus).toBe("sent");
        expect(recipientId).toBe(run.fixture.adminId);
        expect(analysisStatus).toBe(status);
        expect(findingCount).toBe("0");
        expect(ledger?.split(",").sort()).toEqual(status === "completed" ? ["Consumed", "Reserved"] : ["Released", "Reserved"]);
      });
    } finally {
      await disposeRealTerminalRun(run);
    }
  }, 90_000);
});
