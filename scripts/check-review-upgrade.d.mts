export type ReviewUpgradeMode = "--disposable-local" | "--ci";

export function parseReviewUpgradeMode(
  args: string[],
  env?: Record<string, string | undefined>,
): ReviewUpgradeMode;
export function reviewProjectResourcesOwned(containers: string[], owned: string[]): boolean;
export function isReviewUpgradeTemporaryRoot(candidate: string, tempRoot: string, prefix: string): boolean;
