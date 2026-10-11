export type MigrationStage = "s1" | "s2_01" | "s2_02";

export function migrationStage(path: string): MigrationStage;
export function includeMigration(path: string, stage: MigrationStage): boolean;
