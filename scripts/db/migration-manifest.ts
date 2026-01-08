/**
 * Migration Manifest - TypeScript Interface
 * Issue #607 - Local Development Environment
 *
 * This file re-exports the migration list from the single source of truth:
 *   /infra/database/migrations.json
 *
 * Used by:
 *   - scripts/db/run-migrations.ts (local development)
 *   - infra/database/lambda/db-init-handler.ts (AWS Lambda)
 *   - scripts/db/init-local.sh (Docker init - reads JSON directly)
 *
 * IMPORTANT: When adding new migrations:
 *   1. Add the filename to migrations.json
 *   2. The migration file must exist in infra/database/schema/
 *   3. Run `npm run db:migrate` locally to test
 *   4. Deploy to AWS - the Lambda will pick up the new migration
 */

import migrationsConfig from "../../infra/database/migrations.json";

export const MIGRATION_FILES = migrationsConfig.migrationFiles;
export const INITIAL_SETUP_FILES = migrationsConfig.initialSetupFiles;
export const SCHEMA_DIR = migrationsConfig.schemaDir;

export type MigrationFile = (typeof MIGRATION_FILES)[number];
export type InitialSetupFile = (typeof INITIAL_SETUP_FILES)[number];

/**
 * Validate that a migration file exists in the manifest
 */
export function isValidMigration(filename: string): filename is MigrationFile {
  return MIGRATION_FILES.includes(filename as MigrationFile);
}

/**
 * Validate that a setup file exists in the manifest
 */
export function isValidSetupFile(
  filename: string
): filename is InitialSetupFile {
  return INITIAL_SETUP_FILES.includes(filename as InitialSetupFile);
}
