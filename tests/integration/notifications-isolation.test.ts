import { beforeAll, describe, expect, it } from "vitest";

import { runNotificationDispatch } from "../../src/modules/notifications/dispatch";
import { assertLocalSupabaseReady } from "../support/local-supabase";
import { openLocalSqlSession } from "../support/local-sql-session";
import {
  createFakeResend,
  createNotificationDispatchDeps,
  createNotificationFixture,
  withNotificationDispatchEnabled,
} from "../support/notification-fixtures";

function sqlUuid(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("Invalid notification fixture identifier.");
  }
  return `'${value}'::uuid`;
}

async function unrelatedEventsSnapshot(sql: { query(statement: string): Promise<string> }, ids: string[]) {
  const excluded = ids.map(sqlUuid).join(",");
  return sql.query(`
    select coalesce(jsonb_agg(to_jsonb(e) order by e.id), '[]'::jsonb)::text
    from public.notification_events e where e.id not in (${excluded});
  `);
}

describe("S2-11 notification isolation and accounting", () => {
  beforeAll(assertLocalSupabaseReady);

  it("keeps a transactional dispatch gate toggle inside its rollback", async () => {
    const fixture = await createNotificationFixture({ status: "completed" });
    try {
      expect(await fixture.sql.query("select enabled::text from private.notification_dispatch_settings where id;")).toBe("false");
      expect(await fixture.sql.query("select count(*)::text from cron.job where jobname='kdm-notifications-dispatch';")).toBe("0");
      const result = await fixture.sql.query(`
        begin;
        update private.notification_dispatch_settings set enabled=true where id;
        select enabled::text from private.notification_dispatch_settings where id;
        rollback;
        select enabled::text from private.notification_dispatch_settings where id;
      `);
      expect(result.split(/\r?\n/)).toContain("true");
      expect(result.split(/\r?\n/).at(-1)).toBe("false");
    } finally {
      await fixture.dispose();
    }
  }, 60_000);

  it("unrelated_pending_event_is_untouched", async () => {
    const target = await createNotificationFixture({ status: "completed" });
    const sentinel = await createNotificationFixture({ status: "failed" });
    const resend = createFakeResend();
    try {
      const sentinelBefore = await sentinel.snapshot();
      const unrelatedBefore = await unrelatedEventsSnapshot(target.sql, [target.eventId, sentinel.eventId]);
      await withNotificationDispatchEnabled(target.sql, async () => {
        await runNotificationDispatch(createNotificationDispatchDeps(target.store, resend.send));
        expect(resend.calls).toHaveLength(1);
        expect((await target.snapshot()).event.status).toBe("sent");
        expect(await sentinel.snapshot()).toEqual(sentinelBefore);
        expect(await unrelatedEventsSnapshot(target.sql, [target.eventId, sentinel.eventId]))
          .toBe(unrelatedBefore);
      });
    } finally {
      await sentinel.dispose();
      await target.dispose();
    }
  }, 60_000);

  it("email_failure_preserves_analysis_findings_ledger", async () => {
    const fixture = await createNotificationFixture({ status: "completed", withLedger: true });
    const resend = createFakeResend();
    resend.rejectNextResponse();
    try {
      const before = await fixture.snapshot();
      await withNotificationDispatchEnabled(fixture.sql, async () => {
        await runNotificationDispatch(createNotificationDispatchDeps(fixture.store, resend.send));
        const after = await fixture.snapshot();
        expect(after.event.status).toBe("pending");
        expect(after.event.error_code).toBe("DELIVERY_FAILED");
        expect(after.analysis).toEqual(before.analysis);
        expect(after.findings).toEqual(before.findings);
        expect(after.evidence).toEqual(before.evidence);
        expect(after.ledger).toEqual(before.ledger);
        expect(resend.calls).toHaveLength(1);
        expect(resend.logicalDeliveryCount).toBe(0);
      });
    } finally {
      await fixture.dispose();
    }
  }, 60_000);

  it("fixture cleanup cascades its private delivery row and preserves existing event rows", async () => {
    const fixture = await createNotificationFixture({ status: "completed" });
    const before = await unrelatedEventsSnapshot(fixture.sql, [fixture.eventId]);
    let disposed = false;
    try {
      await withNotificationDispatchEnabled(fixture.sql, async () => {
        const claimed = await fixture.store.claim(fixture.eventId);
        expect(claimed.ok && claimed.data).toBeTruthy();
        const state = await fixture.snapshot();
        expect(state.delivery).not.toBeNull();
      });

      await fixture.dispose();
      disposed = true;
      const observer = await openLocalSqlSession("kdm_s211_cleanup_verify");
      try {
        expect(await observer.query(`select count(*)::text from private.notification_deliveries where event_id=${sqlUuid(fixture.eventId)};`)).toBe("0");
        expect(await observer.query(`select count(*)::text from public.notification_events where id=${sqlUuid(fixture.eventId)};`)).toBe("0");
        expect(await unrelatedEventsSnapshot(observer, [fixture.eventId])).toBe(before);
      } finally {
        await observer.close();
      }
    } finally {
      if (!disposed) await fixture.dispose();
    }
  }, 60_000);
});
