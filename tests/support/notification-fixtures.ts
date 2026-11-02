import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

import { NOTIFICATIONS_FROM } from "../../src/modules/notifications/config";
import { createNotificationStore } from "../../src/modules/notifications/store";
import type {
  NotificationDispatchDeps,
  NotificationStore,
  PreparedNotification,
  SendNotificationResult,
} from "../../src/modules/notifications/types";
import type { Database } from "../../src/types/database";
import { createAnalysisFixture, type AnalysisFixture } from "./analysis-fixtures";
import { assertLocalSupabaseReady } from "./local-supabase";
import type { LocalSqlSession } from "./local-sql-session";

const LOCAL_API_URL = "http://127.0.0.1:54321";
const LOCAL_APP_ORIGIN = "http://127.0.0.1:3000";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface NotificationFixtureSnapshot {
  event: Record<string, unknown>;
  delivery: Record<string, unknown> | null;
  analysis: Record<string, unknown>;
  findings: unknown[];
  evidence: unknown[];
  ledger: unknown[];
}

export interface NotificationFixture extends AnalysisFixture {
  eventId: string;
  store: NotificationStore;
  snapshot(): Promise<NotificationFixtureSnapshot>;
  setNextAttemptDue(): Promise<void>;
  expireLease(): Promise<void>;
  ageFirstSubmission(hours: number): Promise<void>;
  setAlertNextAttemptDue(): Promise<void>;
}

function sqlUuid(value: string) {
  if (!UUID_PATTERN.test(value)) throw new Error("Invalid notification fixture identifier.");
  return `'${value}'::uuid`;
}

function serviceClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key || process.env.KDM_LOCAL_SUPABASE_URL !== LOCAL_API_URL) {
    throw new Error("Local notification fixture service access is unavailable.");
  }
  return createClient<Database>(LOCAL_API_URL, key, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
}

/** Limit only the production listing RPC results. Every claim/context/write remains a real RPC. */
export function createScopedNotificationStore(
  db: SupabaseClient<Database>,
  eventIds: readonly string[],
): NotificationStore {
  if (eventIds.length === 0 || eventIds.some((id) => !UUID_PATTERN.test(id))) {
    throw new Error("Notification store requires only synthetic fixture event IDs.");
  }
  const allowlist = new Set(eventIds);
  const store = createNotificationStore(db);
  return {
    ...store,
    async listCandidates(limit) {
      const result = await store.listCandidates(limit);
      return result.ok
        ? { ok: true, data: result.data.filter((candidate) => allowlist.has(candidate.eventId)) }
        : result;
    },
    async listAlerts(limit) {
      const result = await store.listAlerts(limit);
      return result.ok
        ? { ok: true, data: result.data.filter((eventId) => allowlist.has(eventId)) }
        : result;
    },
  };
}

async function setEnabled(sql: LocalSqlSession, enabled: boolean) {
  await sql.query(`update private.notification_dispatch_settings set enabled=${enabled} where id;`);
  const actual = await sql.query("select enabled::text from private.notification_dispatch_settings where id;");
  if (actual.trim() !== String(enabled)) throw new Error("The local notification dispatch gate did not reach its expected state.");
}

/** Temporarily opens only the local gate, after proving no scheduler or lease can consume other work. */
export async function withNotificationDispatchEnabled<T>(sql: LocalSqlSession, action: () => Promise<T>): Promise<T> {
  if (process.env.KDM_LOCAL_SUPABASE_URL !== LOCAL_API_URL) {
    throw new Error("Refusing to enable notifications outside the expected local Supabase project.");
  }

  let advisoryLockHeld = false;
  let enabledByTest = false;
  try {
    const locked = await sql.query("select pg_try_advisory_lock(211011011)::text;");
    if (locked.trim() !== "true") throw new Error("Another notification integration test owns the local gate.");
    advisoryLockHeld = true;

    const enabled = (await sql.query("select enabled::text from private.notification_dispatch_settings where id;")).trim();
    const schedulerJobs = (await sql.query("select count(*)::text from cron.job where jobname='kdm-notifications-dispatch';")).trim();
    const activeEmailLeases = (await sql.query(`
      select count(*)::text from public.notification_events
      where status='pending' and operation_id is not null and lease_expires_at > clock_timestamp();
    `)).trim();
    const activeAlertLeases = (await sql.query(`
      select count(*)::text from private.notification_deliveries
      where alert_operation_id is not null and alert_lease_expires_at > clock_timestamp();
    `)).trim();

    if (enabled !== "false" || schedulerJobs !== "0" || activeEmailLeases !== "0" || activeAlertLeases !== "0") {
      throw new Error("Refusing to enable the local notification gate while a scheduler or delivery lease is active.");
    }

    enabledByTest = true;
    await setEnabled(sql, true);
    return await action();
  } finally {
    if (enabledByTest) await setEnabled(sql, false);
    if (advisoryLockHeld) await sql.query("select pg_advisory_unlock(211011011)::text;");
  }
}

export async function prioritizeNotificationEvent(sql: LocalSqlSession, eventId: string, years = 100) {
  if (!Number.isInteger(years) || years < 1 || years > 500) throw new Error("Invalid local notification fixture priority.");
  await sql.query(`
    update public.notification_events set created_at=clock_timestamp()-(${years} * interval '1 year')
    where id=${sqlUuid(eventId)};
  `);
}

export async function createNotificationFixture(options: {
  status: "completed" | "failed";
  withLedger?: boolean;
}): Promise<NotificationFixture> {
  await assertLocalSupabaseReady();
  const fixture = await createAnalysisFixture({
    status: options.status,
    withLedger: options.withLedger,
  });
  let eventId: string;
  try {
    const rows = (await fixture.sql.query(`
      select id::text from public.notification_events
      where analysis_id=${sqlUuid(fixture.analysisId)} order by id;
    `)).split(/\r?\n/).filter(Boolean);
    if (rows.length !== 1 || !UUID_PATTERN.test(rows[0] ?? "")) {
      throw new Error("The local terminal analysis fixture did not create exactly one notification event.");
    }
    eventId = rows[0]!;
    await prioritizeNotificationEvent(fixture.sql, eventId);
  } catch (error) {
    await fixture.dispose();
    throw error;
  }

  const store = createScopedNotificationStore(serviceClient(), [eventId]);
  const snapshot = async (): Promise<NotificationFixtureSnapshot> => {
    const raw = await fixture.sql.query(`
      select pg_catalog.jsonb_build_object(
        'event', (select pg_catalog.to_jsonb(e) from public.notification_events e where e.id=${sqlUuid(eventId)}),
        'delivery', (select pg_catalog.to_jsonb(d) from private.notification_deliveries d where d.event_id=${sqlUuid(eventId)}),
        'analysis', (select pg_catalog.to_jsonb(a) from public.analyses a where a.id=${sqlUuid(fixture.analysisId)}),
        'findings', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(f) order by f.id), '[]'::jsonb) from public.findings f where f.analysis_id=${sqlUuid(fixture.analysisId)}),
        'evidence', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(e) order by e.id), '[]'::jsonb) from public.finding_evidence e where e.analysis_id=${sqlUuid(fixture.analysisId)}),
        'ledger', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(l) order by l.id), '[]'::jsonb) from public.credit_ledger l where l.analysis_id=${sqlUuid(fixture.analysisId)})
      )::text;
    `);
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error("The local notification fixture snapshot was not valid JSON.");
    }
    if (typeof value !== "object" || value === null || !("event" in value) || !value.event) {
      throw new Error("The local notification fixture snapshot did not contain its event.");
    }
    return value as NotificationFixtureSnapshot;
  };

  return {
    ...fixture,
    eventId,
    store,
    snapshot,
    async setNextAttemptDue() {
      await fixture.sql.query(`
        update public.notification_events set next_attempt_at=clock_timestamp()-interval '1 second'
        where id=${sqlUuid(eventId)} and status='pending' and operation_id is null;
      `);
    },
    async expireLease() {
      const updated = await fixture.sql.query(`
        update public.notification_events set lease_expires_at=clock_timestamp()-interval '1 second'
        where id=${sqlUuid(eventId)} and status='pending' and operation_id is not null
        returning id::text;
      `);
      const returnedIds = updated.split(/\r?\n/).map((value) => value.trim()).filter((value) => UUID_PATTERN.test(value));
      if (returnedIds.length !== 1 || returnedIds[0] !== eventId) {
        throw new Error("Expected to expire exactly the notification fixture lease.");
      }
    },
    async ageFirstSubmission(hours: number) {
      if (!Number.isInteger(hours) || hours < 1 || hours > 168) throw new Error("Invalid fixture notification age.");
      await fixture.sql.query(`
        update private.notification_deliveries
        set first_submission_at=clock_timestamp()-(${hours} * interval '1 hour')
        where event_id=${sqlUuid(eventId)} and request_json is not null;
      `);
    },
    async setAlertNextAttemptDue() {
      await fixture.sql.query(`
        update private.notification_deliveries
        set alert_next_attempt_at=clock_timestamp()-interval '1 second'
        where event_id=${sqlUuid(eventId)} and failure_reported_at is null;
      `);
    },
  };
}

export interface FakeResendCall {
  idempotencyKey: string;
  requestJson: string;
}

export interface FakeResend {
  readonly calls: FakeResendCall[];
  readonly logicalDeliveryCount: number;
  send(prepared: PreparedNotification): Promise<SendNotificationResult>;
  rejectNextResponse(): void;
  loseNextResponse(): void;
}

/** Deterministic Resend fake: one logical acceptance per key and immutable payload per key. */
export function createFakeResend(): FakeResend {
  const calls: FakeResendCall[] = [];
  const accepted = new Map<string, { requestJson: string; providerMessageId: string }>();
  const outcomes: Array<"reject" | "lose-after-acceptance"> = [];
  return {
    calls,
    get logicalDeliveryCount() { return accepted.size; },
    rejectNextResponse() { outcomes.push("reject"); },
    loseNextResponse() { outcomes.push("lose-after-acceptance"); },
    async send(prepared) {
      calls.push({ idempotencyKey: prepared.idempotencyKey, requestJson: prepared.requestJson });
      const existing = accepted.get(prepared.idempotencyKey);
      if (existing && existing.requestJson !== prepared.requestJson) {
        throw new Error("The fake Resend received a changed payload for an existing idempotency key.");
      }
      const outcome = outcomes.shift();
      if (outcome === "reject") return { ok: false, code: "DELIVERY_FAILED" };
      const acceptedMessage = existing ?? {
        requestJson: prepared.requestJson,
        providerMessageId: `synthetic-resend-${randomUUID()}`,
      };
      accepted.set(prepared.idempotencyKey, acceptedMessage);
      if (outcome === "lose-after-acceptance") return { ok: false, code: "DELIVERY_FAILED" };
      return { ok: true, providerMessageId: acceptedMessage.providerMessageId };
    },
  };
}

export function createNotificationDispatchDeps(
  store: NotificationStore,
  send: NotificationDispatchDeps["send"],
  options: {
    appOrigin?: string;
    report?: NotificationDispatchDeps["report"];
  } = {},
): NotificationDispatchDeps {
  const startedAt = performance.now();
  return {
    store,
    send,
    report: options.report ?? (async () => true),
    config: { from: NOTIFICATIONS_FROM, appOrigin: options.appOrigin ?? LOCAL_APP_ORIGIN },
    monotonicNow: () => performance.now() - startedAt,
    utcNow: () => Date.now(),
  };
}
