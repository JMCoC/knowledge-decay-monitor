export declare const REVIEW_INTEGRATION_FILES: readonly string[];
export declare const REVIEW_PORT_COUNT: number;
export declare function isReviewStartupPortConflict(message: string, portBase: number): boolean;
export declare function normalizeReviewIntegrationFile(argument: unknown): string | null;
export declare function validateReviewIntegrationBatch(argumentsList: unknown): string[] | null;
