export type ReviewMigrationStage = "s2" | "s3_01" | "s3_02" | "s3_07";

export function reviewMigrationStage(path: string): ReviewMigrationStage;
export function includeReviewMigration(path: string, stage: ReviewMigrationStage): boolean;
