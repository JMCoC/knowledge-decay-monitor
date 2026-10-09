import { afterEach, describe, expect, it, vi } from "vitest";
import { createProcessingBudget } from "@/modules/ingestion/processing-budget";

const CLAIMED_AT = Date.parse("2026-10-08T12:00:00.000Z");

afterEach(() => {
  vi.useRealTimers();
});

describe("processing claim budget", () => {
  it("reserves the final five seconds for an independent close signal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(CLAIMED_AT + 40_000);
    const budget = createProcessingBudget(new Date(CLAIMED_AT).toISOString());

    expect(budget.remainingMs()).toBe(10_000);
    expect(budget.workSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(budget.workSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(budget.workSignal.aborted).toBe(true);
    expect(() => budget.assertWorkRemaining()).toThrow();

    const closeSignal = budget.closeSignal(1_000);
    expect(closeSignal).not.toBe(budget.workSignal);
    expect(closeSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(closeSignal.aborted).toBe(true);
    budget.dispose();
  });

  it("does not extend an old claim when the worker enters later", () => {
    vi.useFakeTimers();
    vi.setSystemTime(CLAIMED_AT + 40_000);
    const budget = createProcessingBudget(
      new Date(CLAIMED_AT).toISOString(),
      Date.now,
      CLAIMED_AT + 10_000,
    );

    expect(budget.remainingMs()).toBe(10_000);
    budget.dispose();
  });

  it("does not let a future or invalid claim timestamp extend work", () => {
    vi.useFakeTimers();
    vi.setSystemTime(CLAIMED_AT + 1_000);
    const future = createProcessingBudget(
      new Date(CLAIMED_AT + 60_000).toISOString(),
      Date.now,
      CLAIMED_AT + 1_000,
    );
    expect(future.remainingMs()).toBe(50_000);
    future.dispose();

    expect(() => createProcessingBudget("not-a-timestamp", Date.now, CLAIMED_AT)).toThrow();
  });
});
