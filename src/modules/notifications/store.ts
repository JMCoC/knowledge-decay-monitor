import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../types/database";
import type {
  NotificationAlertLease,
  NotificationCandidate,
  NotificationFailureCode,
  NotificationLease,
  NotificationResult,
  NotificationStore,
} from "./types";

const DATABASE_TIMEOUT_MS = 3_000;
const MAX_CANDIDATES = 5;
const MAX_ALERT_CANDIDATES = 50;

const contextSchema = z.object({
  eventId: z.uuid(),
  analysisId: z.uuid(),
  workspaceId: z.uuid(),
  recipientId: z.uuid(),
  recipientEmail: z.string(),
  type: z.enum(["analysis_completed", "analysis_failed"]),
  finishedAt: z.iso.datetime(),
});

const bodySchema = z.object({
  from: z.string().min(1),
  to: z.tuple([z.email()]),
  subject: z.string().min(1),
  html: z.string().min(1),
  text: z.string().min(1),
});

const claimedEventSchema = z.object({
  id: z.uuid(),
  operation_id: z.uuid(),
  attempt_count: z.number().int().min(1).max(3),
  lease_expires_at: z.iso.datetime(),
});

const candidateSchema = z.object({ event_id: z.uuid(), recover_expired: z.boolean() });
const alertCandidateSchema = z.object({ event_id: z.uuid() });
const alertLeaseSchema = z.object({
  eventId: z.uuid(),
  operationId: z.uuid(),
  code: z.enum(["DELIVERY_FAILED", "RECIPIENT_UNAVAILABLE", "INTERNAL_ERROR"]),
});
const preparedResponseSchema = z.object({
  body: bodySchema,
  requestJson: z.string().min(1).max(16_384),
  idempotencyKey: z.string().min(1).max(256),
  firstSubmissionAt: z.iso.datetime(),
});

type DbReply<T> = { data: T | null; error: unknown };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function failureCode(value: unknown): NotificationFailureCode | "LEASE_LOST" {
  if (value === "DELIVERY_FAILED" || value === "RECIPIENT_UNAVAILABLE" || value === "INTERNAL_ERROR" || value === "LEASE_LOST") {
    return value;
  }
  return "INTERNAL_ERROR";
}

function decodeEnvelope<T>(value: unknown, decode: (data: unknown) => T | null): NotificationResult<T> {
  const envelope = asRecord(value);
  if (envelope?.ok === false) return { ok: false, code: failureCode(envelope.code) };
  if (envelope?.ok !== true) return { ok: false, code: "INTERNAL_ERROR" };
  const data = decode(envelope.data);
  return data === null ? { ok: false, code: "INTERNAL_ERROR" } : { ok: true, data };
}

async function execute<T>(build: (signal: AbortSignal) => PromiseLike<DbReply<T>>): Promise<DbReply<T> | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, DATABASE_TIMEOUT_MS);
  });

  try {
    return await Promise.race([Promise.resolve().then(() => build(controller.signal)), timedOut]);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function boundedLimit(value: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(1, Math.floor(value))) : 1;
}

function toLease(value: unknown): NotificationLease | null {
  const parsed = claimedEventSchema.safeParse(value);
  if (!parsed.success) return null;
  return {
    eventId: parsed.data.id,
    operationId: parsed.data.operation_id,
    attemptCount: parsed.data.attempt_count,
    leaseExpiresAt: parsed.data.lease_expires_at,
  };
}

export function createNotificationStore(db: SupabaseClient<Database>): NotificationStore {
  return {
    async listCandidates(limit) {
      const reply = await execute((signal) =>
        db.rpc("list_notification_candidates", { p_limit: boundedLimit(limit, MAX_CANDIDATES) }).abortSignal(signal),
      );
      if (!reply || reply.error) return { ok: false, code: "INTERNAL_ERROR" };
      if (!Array.isArray(reply.data)) return { ok: false, code: "INTERNAL_ERROR" };
      const candidates: NotificationCandidate[] = [];
      for (const item of reply.data) {
        const parsed = candidateSchema.safeParse(item);
        if (!parsed.success) return { ok: false, code: "INTERNAL_ERROR" };
        candidates.push({ eventId: parsed.data.event_id, recoverExpired: parsed.data.recover_expired });
      }
      return { ok: true, data: candidates };
    },

    async claim(eventId) {
      const reply = await execute((signal) =>
        db.rpc("claim_notification_event", { p_event_id: eventId }).abortSignal(signal),
      );
      if (!reply || reply.error) return { ok: false, code: "INTERNAL_ERROR" };
      if (!Array.isArray(reply.data)) return { ok: false, code: "INTERNAL_ERROR" };
      if (reply.data.length === 0) return { ok: true, data: null };
      if (reply.data.length !== 1) return { ok: false, code: "INTERNAL_ERROR" };
      const claimed = toLease(reply.data[0]);
      return claimed ? { ok: true, data: claimed } : { ok: false, code: "INTERNAL_ERROR" };
    },

    async context(lease) {
      const reply = await execute((signal) =>
        db.rpc("get_notification_context", {
          p_event_id: lease.eventId,
          p_operation_id: lease.operationId,
        }).abortSignal(signal),
      );
      if (!reply || reply.error) return { ok: false, code: "INTERNAL_ERROR" };
      return decodeEnvelope(reply.data, (data) => {
        const parsed = contextSchema.safeParse(data);
        return parsed.success ? parsed.data : null;
      });
    },

    async prepare(lease, body) {
      const reply = await execute((signal) =>
        db.rpc("prepare_notification_delivery", {
          p_event_id: lease.eventId,
          p_operation_id: lease.operationId,
          p_request_json: JSON.stringify(body),
        }).abortSignal(signal),
      );
      if (!reply || reply.error) return { ok: false, code: "INTERNAL_ERROR" };
      const decoded = decodeEnvelope(reply.data, (data) => {
        const parsed = preparedResponseSchema.safeParse(data);
        if (!parsed.success || parsed.data.idempotencyKey !== `kdm-terminal/${lease.eventId}/v1`) return null;

        let requestBody: unknown;
        try {
          requestBody = JSON.parse(parsed.data.requestJson);
        } catch {
          return null;
        }
        const requestParsed = bodySchema.safeParse(requestBody);
        if (!requestParsed.success || JSON.stringify(requestParsed.data) !== JSON.stringify(parsed.data.body)) return null;
        return { ...parsed.data, body: requestParsed.data };
      });
      return decoded;
    },

    async sent(lease, providerMessageId) {
      const reply = await execute((signal) =>
        db.rpc("confirm_notification_sent", {
          p_event_id: lease.eventId,
          p_operation_id: lease.operationId,
          p_provider_message_id: providerMessageId,
        }).abortSignal(signal),
      );
      if (!reply || reply.error) return { ok: false, code: "INTERNAL_ERROR" };
      return reply.data === true ? { ok: true, data: true } : { ok: false, code: "LEASE_LOST" };
    },

    async failed(lease, code, retryAfterSeconds) {
      const safeRetry = Number.isInteger(retryAfterSeconds)
        ? Math.min(3_600, Math.max(0, retryAfterSeconds as number))
        : undefined;
      const reply = await execute((signal) =>
        db.rpc("record_notification_failure", {
          p_event_id: lease.eventId,
          p_operation_id: lease.operationId,
          p_error_code: code,
          ...(safeRetry === undefined ? {} : { p_retry_after_seconds: safeRetry }),
        }).abortSignal(signal),
      );
      if (!reply || reply.error) return { ok: false, code: "INTERNAL_ERROR" };
      if (reply.data === "pending" || reply.data === "failed" || reply.data === "lost") {
        return { ok: true, data: reply.data };
      }
      return { ok: false, code: "INTERNAL_ERROR" };
    },

    async recover(eventId) {
      const reply = await execute((signal) =>
        db.rpc("recover_notification_event", { p_event_id: eventId }).abortSignal(signal),
      );
      if (!reply || reply.error) return { ok: false, code: "INTERNAL_ERROR" };
      if (reply.data === "pending" || reply.data === "failed" || reply.data === "unchanged") {
        return { ok: true, data: reply.data };
      }
      return { ok: false, code: "INTERNAL_ERROR" };
    },

    async listAlerts(limit) {
      const reply = await execute((signal) =>
        db.rpc("list_notification_alerts", { p_limit: boundedLimit(limit, MAX_ALERT_CANDIDATES) }).abortSignal(signal),
      );
      if (!reply || reply.error) return { ok: false, code: "INTERNAL_ERROR" };
      if (!Array.isArray(reply.data)) return { ok: false, code: "INTERNAL_ERROR" };
      const eventIds: string[] = [];
      for (const item of reply.data) {
        const parsed = alertCandidateSchema.safeParse(item);
        if (!parsed.success) return { ok: false, code: "INTERNAL_ERROR" };
        eventIds.push(parsed.data.event_id);
      }
      return { ok: true, data: eventIds };
    },

    async claimAlert(eventId) {
      const reply = await execute((signal) =>
        db.rpc("claim_notification_alert", { p_event_id: eventId }).abortSignal(signal),
      );
      if (!reply || reply.error) return { ok: false, code: "INTERNAL_ERROR" };
      if (reply.data === null) return { ok: true, data: null };
      const parsed = alertLeaseSchema.safeParse(reply.data);
      return parsed.success ? { ok: true, data: parsed.data } : { ok: false, code: "INTERNAL_ERROR" };
    },

    async alertSent(alert: NotificationAlertLease) {
      const reply = await execute((signal) =>
        db.rpc("confirm_notification_alert", {
          p_event_id: alert.eventId,
          p_operation_id: alert.operationId,
        }).abortSignal(signal),
      );
      if (!reply || reply.error) return { ok: false, code: "INTERNAL_ERROR" };
      return reply.data === true ? { ok: true, data: true } : { ok: false, code: "LEASE_LOST" };
    },

    async alertFailed(alert: NotificationAlertLease) {
      const reply = await execute((signal) =>
        db.rpc("retry_notification_alert", {
          p_event_id: alert.eventId,
          p_operation_id: alert.operationId,
        }).abortSignal(signal),
      );
      if (!reply || reply.error) return { ok: false, code: "INTERNAL_ERROR" };
      return reply.data === true ? { ok: true, data: true } : { ok: false, code: "LEASE_LOST" };
    },
  };
}
