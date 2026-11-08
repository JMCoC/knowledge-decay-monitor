import { beforeAll, describe, expect, it } from "vitest";

import { assertLocalSupabaseReady } from "../support/local-supabase";
import { openLocalSqlSession, type LocalSqlSession } from "../support/local-sql-session";
import { createNotificationFixture, withNotificationDispatchEnabled } from "../support/notification-fixtures";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sqlUuid(value: string) {
  if (!UUID_PATTERN.test(value)) throw new Error("Invalid notification fixture identifier.");
  return `'${value}'::uuid`;
}

async function closeSessions(sessions: LocalSqlSession[]) {
  for (const session of sessions) await session.close();
}

describe("S2-11 local notification concurrency", () => {
  beforeAll(assertLocalSupabaseReady);

  it("lets two independent PostgreSQL sessions claim only one lease", async () => {
    const fixture = await createNotificationFixture({ status: "completed" });
    const sessions: LocalSqlSession[] = [];
    try {
      await withNotificationDispatchEnabled(fixture.sql, async () => {
        sessions.push(await openLocalSqlSession("kdm_s211_claim_a"));
        sessions.push(await openLocalSqlSession("kdm_s211_claim_b"));
        const eventId = sqlUuid(fixture.eventId);
        const results = await Promise.all(sessions.map(session =>
          session.query(`select operation_id::text from public.claim_notification_event(${eventId});`),
        ));
        const operationIds = results.map(value => value.trim()).filter(Boolean);
        expect(operationIds).toHaveLength(1);
        expect(UUID_PATTERN.test(operationIds[0] ?? "")).toBe(true);

        const snapshot = await fixture.snapshot();
        expect(snapshot.event.status).toBe("pending");
        expect(snapshot.event.attempt_count).toBe(1);
        expect(snapshot.event.operation_id).toBe(operationIds[0]);
        expect(snapshot.event.lease_expires_at).toBeTruthy();
      });
    } finally {
      await closeSessions(sessions);
      await fixture.dispose();
    }
  }, 60_000);
});
