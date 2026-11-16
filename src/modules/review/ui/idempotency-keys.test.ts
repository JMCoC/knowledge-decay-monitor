import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdempotencyKeyStore } from "./idempotency-keys";

describe("idempotency key store", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reuses the exact key for a retry of the same payload and separates other payloads", () => {
    const randomUUID = vi.fn()
      .mockReturnValueOnce("key-first")
      .mockReturnValueOnce("key-second");
    vi.stubGlobal("crypto", { randomUUID });
    const store = createIdempotencyKeyStore();

    expect(store.forAttempt("same payload")).toBe("key-first");
    expect(store.forAttempt("same payload")).toBe("key-first");
    expect(store.forAttempt("different payload")).toBe("key-second");
    expect(randomUUID).toHaveBeenCalledTimes(2);
  });

  it("releases a key after a definitive response", () => {
    const randomUUID = vi.fn().mockReturnValueOnce("key-first").mockReturnValueOnce("key-after-clear");
    vi.stubGlobal("crypto", { randomUUID });
    const store = createIdempotencyKeyStore();

    expect(store.forAttempt("action")).toBe("key-first");
    store.clear("action");
    expect(store.forAttempt("action")).toBe("key-after-clear");
  });
});
