import { afterEach, describe, expect, it, vi } from "vitest";
import { watchAttempt } from "@/modules/ingestion/worker/attempt-watchdog";

afterEach(() => vi.useRealTimers());

describe("bounded cleanup after abort", () => {
  it("requests a restart when native inference never settles after abort", async () => {
    vi.useFakeTimers();
    const attempt = new AbortController();
    const restart = vi.fn();
    const dispose = watchAttempt(attempt.signal, restart);
    const pendingInference = new Promise<void>(() => {});
    void pendingInference.finally(dispose);
    attempt.abort();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(restart).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(restart).toHaveBeenCalledOnce();
    dispose();
  });

  it("cancels the restart when an aborted job settles within the grace period", async () => {
    vi.useFakeTimers();
    const attempt = new AbortController();
    const restart = vi.fn();
    const dispose = watchAttempt(attempt.signal, restart);
    attempt.abort();
    dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(restart).not.toHaveBeenCalled();
  });

  it("removes the listener after normal completion", async () => {
    vi.useFakeTimers();
    const attempt = new AbortController();
    const restart = vi.fn();
    const dispose = watchAttempt(attempt.signal, restart);
    dispose();
    attempt.abort();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(restart).not.toHaveBeenCalled();
  });

  it("handles a signal already aborted before attaching the watchdog", async () => {
    vi.useFakeTimers();
    const restart = vi.fn();
    const dispose = watchAttempt(AbortSignal.abort(), restart);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(restart).toHaveBeenCalledOnce();
    dispose();
  });
});
