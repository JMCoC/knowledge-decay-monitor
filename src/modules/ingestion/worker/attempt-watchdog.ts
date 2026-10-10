/** Native inference cannot be cancelled; an aborted, stuck attempt must restart. */
export function watchAttempt(signal: AbortSignal, restart: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => {
    timer = setTimeout(restart, 10_000);
    timer.unref?.();
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return () => {
    signal.removeEventListener("abort", onAbort);
    clearTimeout(timer);
  };
}
