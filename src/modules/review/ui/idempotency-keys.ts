export interface IdempotencyKeyStore {
  forAttempt(signature: string): string;
  clear(signature: string): void;
}

export function createIdempotencyKeyStore(): IdempotencyKeyStore {
  const keys = new Map<string, string>();
  return {
    forAttempt(signature) {
      let key = keys.get(signature);
      if (!key) {
        key = crypto.randomUUID();
        keys.set(signature, key);
      }
      return key;
    },
    clear(signature) {
      keys.delete(signature);
    },
  };
}
