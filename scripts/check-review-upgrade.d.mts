export type ReviewUpgradeMode = "--disposable-local" | "--ci";

export function parseReviewUpgradeMode(
  args: string[],
  env?: Record<string, string | undefined>,
): ReviewUpgradeMode;
export function reviewProjectResourcesOwned(containers: string[], owned: string[]): boolean;
export function isReviewUpgradeTemporaryRoot(candidate: string, tempRoot: string, prefix: string): boolean;
export function includeReviewDatabaseTestFile(
  fileName: string,
  stage: "s2" | "s3_01" | "s3_02",
): boolean;
export function reviewStorageObjectUrl(
  apiUrl: string,
  storagePath: string,
  operation: "upload" | "download",
): string;
