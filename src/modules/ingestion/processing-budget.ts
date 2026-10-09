export type ProcessingBudget = {
  remainingMs(): number;
  workSignal: AbortSignal;
  closeSignal(timeoutMs: number): AbortSignal;
  assertWorkRemaining(): void;
  dispose(): void;
};

export const PROCESSING_BUDGET_MS = 50_000;
export const PROCESSING_WORK_BUDGET_MS = 45_000;

export class ProcessingBudgetError extends Error {
  constructor(readonly reason: "invalid_claim_time" | "work_expired") {
    super("Processing budget is unavailable.");
    this.name = "ProcessingBudgetError";
  }
}

export function createProcessingBudget(
  startedAt: string | null | undefined,
  now: () => number = Date.now,
  workerEnteredAtMs = now(),
): ProcessingBudget {
  if (typeof startedAt !== "string" || startedAt.length === 0) {
    throw new ProcessingBudgetError("invalid_claim_time");
  }
  const claimStartedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(claimStartedAtMs) || !Number.isFinite(workerEnteredAtMs)) {
    throw new ProcessingBudgetError("invalid_claim_time");
  }

  const budgetStartedAtMs = Math.min(claimStartedAtMs, workerEnteredAtMs);
  const workDeadlineMs = budgetStartedAtMs + PROCESSING_WORK_BUDGET_MS;
  const deadlineMs = budgetStartedAtMs + PROCESSING_BUDGET_MS;
  const workController = new AbortController();
  const activeCloseTimers = new Set<ReturnType<typeof setTimeout>>();
  const remainingWorkMs = () => Math.max(0, workDeadlineMs - now());
  const remainingMs = () => Math.max(0, deadlineMs - now());
  let workTimer: ReturnType<typeof setTimeout> | undefined;

  if (remainingWorkMs() === 0) {
    workController.abort();
  } else {
    workTimer = setTimeout(() => workController.abort(), remainingWorkMs());
  }

  return {
    remainingMs,
    workSignal: workController.signal,
    closeSignal(timeoutMs) {
      const controller = new AbortController();
      const requestedMs = Number.isFinite(timeoutMs) ? Math.max(0, Math.floor(timeoutMs)) : 0;
      const timeout = Math.min(requestedMs, remainingMs());
      if (timeout === 0) {
        controller.abort();
      } else {
        const timer = setTimeout(() => {
          activeCloseTimers.delete(timer);
          controller.abort();
        }, timeout);
        activeCloseTimers.add(timer);
      }
      return controller.signal;
    },
    assertWorkRemaining() {
      if (workController.signal.aborted || remainingWorkMs() === 0) {
        workController.abort();
        throw new ProcessingBudgetError("work_expired");
      }
    },
    dispose() {
      if (workTimer) clearTimeout(workTimer);
      for (const timer of activeCloseTimers) clearTimeout(timer);
      activeCloseTimers.clear();
    },
  };
}
