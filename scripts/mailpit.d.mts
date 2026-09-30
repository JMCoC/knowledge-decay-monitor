export function tokenHashFromRecoveryLink(link: string): string;
export function waitForRecoveryLink(
  email: string,
  options?: { excludedTokenHashes?: string[] },
): Promise<string>;
