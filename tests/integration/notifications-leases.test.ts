import { beforeAll, describe, expect, it } from "vitest";

import { createAnalysisFixture } from "../support/analysis-fixtures";
import { assertLocalSupabaseReady } from "../support/local-supabase";
import { openLocalSqlSession, type LocalSqlSession } from "../support/local-sql-session";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sqlUuid(value: string) {
  if (!UUID_PATTERN.test(value)) throw new Error("Invalid notification fixture identifier.");
  return `'${value}'::uuid`;
}

async function closeSessions(sessions: LocalSqlSession[]) {
  for (const session of sessions) await session.close();
}

describe("S2-11 notification delivery leases", () => {
  beforeAll(assertLocalSupabaseReady);

  it("allows one concurrent claim and fences expired attempts without a fourth send", async () => {
    const fixture = await createAnalysisFixture({ status: "completed" });
    const sessions: LocalSqlSession[] = [];
    const eventId = (await fixture.sql.query(
      `select id::text from public.notification_events where analysis_id = ${sqlUuid(fixture.analysisId)};`,
    )).trim();
    if (!UUID_PATTERN.test(eventId)) {
      await fixture.dispose();
      throw new Error("The completed local fixture did not create one notification event.");
    }

    let dispatchWasEnabled = false;
    let dispatchStateWasRead = false;
    try {
      dispatchWasEnabled = (await fixture.sql.query(
        "select enabled::text from private.notification_dispatch_settings where id;",
      )).trim() === "true";
      dispatchStateWasRead = true;
      await fixture.sql.query("update private.notification_dispatch_settings set enabled = true where id;");

      const first = await openLocalSqlSession("kdm_s211_claim_a");
      sessions.push(first);
      const second = await openLocalSqlSession("kdm_s211_claim_b");
      sessions.push(second);
      const event = sqlUuid(eventId);

      const claimResults = await Promise.all([
        first.query(`select operation_id::text from public.claim_notification_event(${event});`),
        second.query(`select operation_id::text from public.claim_notification_event(${event});`),
      ]);
      const operationIds = claimResults.map(value => value.trim()).filter(Boolean);
      expect(operationIds).toHaveLength(1);
      const firstOperationId = operationIds[0];
      if (!firstOperationId || !UUID_PATTERN.test(firstOperationId)) {
        throw new Error("The winning notification claim did not return one operation token.");
      }
      expect(await fixture.sql.query(
        `select attempt_count::text from public.notification_events where id = ${event};`,
      )).toBe("1");

      await fixture.sql.query(
        `update public.notification_events set lease_expires_at = now() - interval '1 second' where id = ${event};`,
      );
      expect(await first.query(`select public.recover_notification_event(${event});`)).toBe("pending");
      expect(await second.query(
        `select public.confirm_notification_sent(${event}, ${sqlUuid(firstOperationId)}, 'synthetic-message')::text;`,
      )).toBe("false");

      for (const expectedAttempt of [2, 3]) {
        await fixture.sql.query(
          `update public.notification_events set next_attempt_at = now() - interval '1 second' where id = ${event};`,
        );
        const claimed = await first.query(
          `select operation_id::text from public.claim_notification_event(${event});`,
        );
        expect(UUID_PATTERN.test(claimed.trim())).toBe(true);
        expect(await fixture.sql.query(
          `select attempt_count::text from public.notification_events where id = ${event};`,
        )).toBe(String(expectedAttempt));
        await fixture.sql.query(
          `update public.notification_events set lease_expires_at = now() - interval '1 second' where id = ${event};`,
        );
        const recovery = await second.query(`select public.recover_notification_event(${event});`);
        expect(recovery).toBe(expectedAttempt === 3 ? "failed" : "pending");
      }

      expect(await first.query(`select count(*)::text from public.claim_notification_event(${event});`)).toBe("0");
      expect(await fixture.sql.query(
        `select status::text || '|' || attempt_count::text || '|' || error_code from public.notification_events where id = ${event};`,
      )).toBe("failed|3|DELIVERY_FAILED");
      expect(await second.query(
        `select public.confirm_notification_sent(${event}, ${sqlUuid(firstOperationId)}, 'synthetic-message')::text;`,
      )).toBe("false");
    } finally {
      if (dispatchStateWasRead) {
        await fixture.sql.query(
          `update private.notification_dispatch_settings set enabled = ${dispatchWasEnabled} where id;`,
        ).catch(() => undefined);
      }
      await closeSessions(sessions);
      await fixture.dispose();
    }
  }, 60_000);
});
