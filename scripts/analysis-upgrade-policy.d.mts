export type MigrationStage = "s1" | "s2_01" | "s2_02" | "s2_03" | "s2_04" | "s2_06" | "s2_08a" | "s2_08b" | "s2_11" | "s3_01" | "s3_02" | "s3_05" | "s3_04";

export function migrationStage(path: string): MigrationStage;
export function includeMigration(path: string, stage: MigrationStage): boolean;
export function databaseTestSourceForStage(path: string, stage: MigrationStage): string;
export function includeFunction(path: string, stage: MigrationStage): boolean;
export function filterFunctionConfigForStage(config: string, stage: MigrationStage): string;
