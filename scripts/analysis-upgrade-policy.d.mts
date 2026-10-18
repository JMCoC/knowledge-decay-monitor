export type MigrationStage = "s1" | "s2_01" | "s2_02" | "s2_03" | "s2_04" | "s2_06";

export function migrationStage(path: string): MigrationStage;
export function includeMigration(path: string, stage: MigrationStage): boolean;
export function includeFunction(path: string, stage: MigrationStage): boolean;
export function filterFunctionConfigForStage(config: string, stage: MigrationStage): string;
