import { z } from "zod";
import { renderTerminalNotification } from "./templates.ts";
import type {
  NotificationAlertLease,
  NotificationContext,
  NotificationDispatchDeps,
  NotificationDispatchSummary,
  NotificationFailureCode,
  NotificationLease,
} from "./types.ts";

const MAX_WORK_ITEMS = 5;
const MAX_ALERTS_PER_RUN = 2;
const MAX_PARALLEL_SENDS = 2;
const EXECUTION_BUDGET_MS = 45_000;
const MIN_BUDGET_BEFORE_CLAIM_MS = 28_000;
const RESEND_TIMEOUT_MS = 10_000;
const RESEND_IDEMPOTENCY_WINDOW_MS = 23 * 60 * 60 * 1_000;

const contextSchema = z.object({
  eventId: z.uuid(),
  analysisId: z.uuid(),
  workspaceId: z.uuid(),
  recipientId: z.uuid(),
  recipientEmail: z.email(),
  type: z.enum(["analysis_completed", "analysis_failed"]),
  finishedAt: z.iso.datetime({ offset: true }),
});

const emailSchema = z.email();

function elapsedMs(startedAt: number, now: number): number {
  const elapsed = now - startedAt;
  return Number.isFinite(elapsed) ? Math.max(0, elapsed) : EXECUTION_BUDGET_MS;
}

function remainingBudget(deps: NotificationDispatchDeps, startedAt: number): number {
  return Math.max(0, EXECUTION_BUDGET_MS - elapsedMs(startedAt, deps.monotonicNow()));
}

function sameAuthorizedContext(before: NotificationContext, after: NotificationContext): boolean {
  return (
    before.eventId === after.eventId &&
    before.analysisId === after.analysisId &&
    before.workspaceId === after.workspaceId &&
    before.recipientId === after.recipientId &&
    before.recipientEmail.toLowerCase() === after.recipientEmail.toLowerCase() &&
    before.type === after.type &&
    before.finishedAt === after.finishedAt
  );
}

function parseContext(value: unknown): NotificationContext | null {
  const parsed = contextSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

async function failLease(
  deps: NotificationDispatchDeps,
  lease: NotificationLease,
  code: NotificationFailureCode,
  retryAfterSeconds?: number,
): Promise<boolean> {
  try {
    const result = retryAfterSeconds === undefined
      ? await deps.store.failed(lease, code)
      : await deps.store.failed(lease, code, retryAfterSeconds);
    return result.ok && result.data !== "lost";
  } catch {
    return false;
  }
}

async function recordFailure(
  deps: NotificationDispatchDeps,
  lease: NotificationLease,
  code: NotificationFailureCode,
  retryAfterSeconds?: number,
): Promise<{ sent: number; failed: number }> {
  await failLease(deps, lease, code, retryAfterSeconds);
  return { sent: 0, failed: 1 };
}

async function deliverLease(
  deps: NotificationDispatchDeps,
  lease: NotificationLease,
  startedAt: number,
): Promise<{ sent: number; failed: number }> {
  let firstContext: NotificationContext;
  try {
    const contextResult = await deps.store.context(lease);
    if (!contextResult.ok) {
      if (contextResult.code === "LEASE_LOST") return { sent: 0, failed: 0 };
      return recordFailure(deps, lease, contextResult.code);
    }
    const parsed = parseContext(contextResult.data);
    if (!parsed || !emailSchema.safeParse(parsed.recipientEmail).success) {
      return recordFailure(deps, lease, "RECIPIENT_UNAVAILABLE");
    }
    firstContext = parsed;
  } catch {
    return recordFailure(deps, lease, "INTERNAL_ERROR");
  }

  let candidateBody;
  try {
    candidateBody = renderTerminalNotification(firstContext, deps.config);
  } catch {
    return recordFailure(deps, lease, "INTERNAL_ERROR");
  }

  let prepared;
  try {
    const preparedResult = await deps.store.prepare(lease, candidateBody);
    if (!preparedResult.ok) {
      if (preparedResult.code === "LEASE_LOST") return { sent: 0, failed: 0 };
      return recordFailure(deps, lease, preparedResult.code);
    }
    prepared = preparedResult.data;
  } catch {
    return recordFailure(deps, lease, "INTERNAL_ERROR");
  }

  const firstSubmissionAt = Date.parse(prepared.firstSubmissionAt);
  const leaseExpiresAt = Date.parse(lease.leaseExpiresAt);
  const absoluteDeadline = Math.min(
    firstSubmissionAt + RESEND_IDEMPOTENCY_WINDOW_MS,
    leaseExpiresAt,
  );
  if (
    !Number.isFinite(firstSubmissionAt) ||
    !Number.isFinite(leaseExpiresAt) ||
    deps.utcNow() + RESEND_TIMEOUT_MS >= absoluteDeadline ||
    remainingBudget(deps, startedAt) < MIN_BUDGET_BEFORE_CLAIM_MS
  ) {
    return recordFailure(deps, lease, "INTERNAL_ERROR");
  }

  let currentContext: NotificationContext;
  try {
    const currentResult = await deps.store.context(lease);
    if (!currentResult.ok) {
      if (currentResult.code === "LEASE_LOST") return { sent: 0, failed: 0 };
      return recordFailure(deps, lease, currentResult.code);
    }
    const parsed = parseContext(currentResult.data);
    if (!parsed) return recordFailure(deps, lease, "RECIPIENT_UNAVAILABLE");
    currentContext = parsed;
  } catch {
    return recordFailure(deps, lease, "INTERNAL_ERROR");
  }

  if (
    !sameAuthorizedContext(firstContext, currentContext) ||
    currentContext.recipientEmail.toLowerCase() !== prepared.body.to[0].toLowerCase()
  ) {
    return recordFailure(deps, lease, "RECIPIENT_UNAVAILABLE");
  }

  if (
    deps.utcNow() + RESEND_TIMEOUT_MS >= absoluteDeadline ||
    remainingBudget(deps, startedAt) < MIN_BUDGET_BEFORE_CLAIM_MS
  ) {
    return recordFailure(deps, lease, "INTERNAL_ERROR");
  }

  let sendResult;
  try {
    sendResult = await deps.send(prepared);
  } catch {
    return recordFailure(deps, lease, "DELIVERY_FAILED");
  }

  if (!sendResult.ok) {
    return recordFailure(deps, lease, "DELIVERY_FAILED", sendResult.retryAfterSeconds);
  }

  try {
    const ack = await deps.store.sent(lease, sendResult.providerMessageId);
    if (!ack.ok) return { sent: 0, failed: ack.code === "LEASE_LOST" ? 0 : 1 };
    if (!ack.data) return { sent: 0, failed: 1 };
    return { sent: 1, failed: 0 };
  } catch {
    // Resend may have accepted the message. A lost DB acknowledgement is left
    // for lease recovery and the same persisted request/idempotency key.
    return { sent: 0, failed: 1 };
  }
}

async function processAlert(deps: NotificationDispatchDeps, alert: NotificationAlertLease): Promise<number> {
  let reported = false;
  try {
    reported = await deps.report(alert);
  } catch {
    reported = false;
  }

  if (reported) {
    try {
      const result = await deps.store.alertSent(alert);
      return result.ok && result.data ? 1 : 0;
    } catch {
      return 0;
    }
  }

  try {
    await deps.store.alertFailed(alert);
  } catch {
    // The alert lease will expire and can be recovered by a later invocation.
  }
  return 0;
}

export async function runNotificationDispatch(
  deps: NotificationDispatchDeps,
): Promise<NotificationDispatchSummary> {
  const startedAt = deps.monotonicNow();
  const summary: NotificationDispatchSummary = { claimed: 0, sent: 0, failed: 0, reported: 0 };
  let workItems = 0;

  let alertIds: string[] = [];
  try {
    const alerts = await deps.store.listAlerts(50);
    if (alerts.ok) alertIds = alerts.data;
    else summary.failed += 1;
  } catch {
    summary.failed += 1;
  }

  for (const eventId of alertIds.slice(0, MAX_ALERTS_PER_RUN)) {
    if (workItems >= MAX_WORK_ITEMS) break;
    let claimResult;
    try {
      claimResult = await deps.store.claimAlert(eventId);
    } catch {
      summary.failed += 1;
      continue;
    }
    if (!claimResult.ok) {
      summary.failed += 1;
      continue;
    }
    if (!claimResult.data) continue;
    workItems += 1;
    summary.reported += await processAlert(deps, claimResult.data);
  }

  const emailWorkLimit = MAX_WORK_ITEMS - workItems;
  if (emailWorkLimit <= 0 || remainingBudget(deps, startedAt) < 3_000) return summary;

  let candidates;
  try {
    candidates = await deps.store.listCandidates(emailWorkLimit);
  } catch {
    summary.failed += 1;
    return summary;
  }
  if (!candidates.ok) {
    summary.failed += 1;
    return summary;
  }

  const active = new Set<Promise<void>>();
  const settleOne = async () => {
    const pending = Array.from(active);
    if (pending.length > 0) await Promise.race(pending);
  };

  for (const candidate of candidates.data) {
    if (workItems >= MAX_WORK_ITEMS) break;
    if (remainingBudget(deps, startedAt) < 3_000) break;

    if (candidate.recoverExpired) {
      workItems += 1;
      try {
        const recovered = await deps.store.recover(candidate.eventId);
        if (!recovered.ok) summary.failed += 1;
        else if (recovered.data === "pending" || recovered.data === "failed") summary.failed += 1;
      } catch {
        summary.failed += 1;
      }
      continue;
    }

    if (remainingBudget(deps, startedAt) < MIN_BUDGET_BEFORE_CLAIM_MS) break;
    while (active.size >= MAX_PARALLEL_SENDS) await settleOne();

    let claim;
    try {
      claim = await deps.store.claim(candidate.eventId);
    } catch {
      summary.failed += 1;
      continue;
    }
    if (!claim.ok) {
      summary.failed += 1;
      continue;
    }
    if (!claim.data) continue;

    workItems += 1;
    summary.claimed += 1;
    const lease = claim.data;
    const task = deliverLease(deps, lease, startedAt)
      .then((result) => {
        summary.sent += result.sent;
        summary.failed += result.failed;
      })
      .catch(async () => {
        await failLease(deps, lease, "INTERNAL_ERROR");
        summary.failed += 1;
      })
      .finally(() => active.delete(task));
    active.add(task);
  }

  await Promise.all(active);
  return summary;
}
