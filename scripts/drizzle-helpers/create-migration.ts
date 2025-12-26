#!/usr/bin/env npx tsx
/**
 * Create Empty Migration Script
 *
 * Creates a new empty migration file with the correct number and naming convention.
 * Use this for manual migrations when not using drizzle-kit generate.
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #539 - Integrate Drizzle-Kit with existing Lambda migration system
 *
 * Usage:
 *   npx tsx scripts/drizzle-helpers/create-migration.ts "add-user-preferences"
 *   npm run migration:create -- "add-user-preferences"
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  getAbsolutePath,
  getNextMigrationNumber,
  sanitizeForFilename,
} from "./lib/migration-utils";

// Constants
const LAMBDA_SCHEMA_DIR = "./infra/database/schema";


/**
 * Generate migration template content
 */
function generateMigrationTemplate(
  migrationNumber: number,
  description: string
): string {
  const now = new Date().toISOString();
  const formattedNumber = String(migrationNumber).padStart(3, "0");

  return `-- Migration ${formattedNumber}: ${description}
-- Created: ${now.split("T")[0]}
-- Part of Epic #526 - RDS Data API to Drizzle ORM Migration
--
-- COMPATIBILITY REQUIREMENTS:
-- - NO CONCURRENTLY (not supported by RDS Data API)
-- - Use IF NOT EXISTS/IF EXISTS for idempotency
-- - Single-statement execution (semicolon-separated)
-- - No transaction control (BEGIN/COMMIT) - Lambda manages this
--
-- ROLLBACK PROCEDURE:
-- If this migration fails or needs to be reverted:
--   1. Connect to database: psql -h <rds-endpoint> -U <username> -d aistudio
--   2. Run the rollback SQL below
--   3. Remove from migration_log:
--      DELETE FROM migration_log WHERE description = '${formattedNumber}-${sanitizeForFilename(description)}.sql';
--   4. Re-run migration via CDK deploy

-- ============================================================================
-- MIGRATION SQL
-- ============================================================================

-- TODO: Add your migration SQL here
-- Example:
-- CREATE TABLE IF NOT EXISTS "new_table" (
--   "id" SERIAL PRIMARY KEY,
--   "name" TEXT NOT NULL,
--   "created_at" TIMESTAMP DEFAULT NOW()
-- );

-- ============================================================================
-- ROLLBACK SQL (for manual rollback if needed)
-- ============================================================================

-- TODO: Add rollback SQL here
-- Example:
-- DROP TABLE IF EXISTS "new_table";
`;
}

/**
 * Main execution
 */
function main(): void {
  const description = process.argv[2];

  if (!description) {
    console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.error("❌ Missing migration description");
    console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.error("");
    console.error("Usage: npx tsx scripts/drizzle-helpers/create-migration.ts <description>");
    console.error("Example: npx tsx scripts/drizzle-helpers/create-migration.ts 'add-user-preferences'");
    console.error("");
    process.exit(1);
  }

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("🆕 Create New Migration");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("");

  // Step 1: Get next migration number
  console.log("🔢 Step 1: Determining next migration number...");

  const nextNumber = getNextMigrationNumber();
  const formattedNumber = String(nextNumber).padStart(3, "0");
  const sanitizedDesc = sanitizeForFilename(description);
  const filename = `${formattedNumber}-${sanitizedDesc}.sql`;

  console.log(`   Next number: ${formattedNumber}`);
  console.log(`   Filename: ${filename}`);

  // Step 2: Check if file already exists
  const filePath = getAbsolutePath(path.join(LAMBDA_SCHEMA_DIR, filename));
  if (fs.existsSync(filePath)) {
    console.error("");
    console.error(`❌ Migration file already exists: ${filePath}`);
    console.error("");
    process.exit(1);
  }

  // Step 3: Create the migration file
  console.log("");
  console.log("📝 Step 2: Creating migration file...");

  const content = generateMigrationTemplate(nextNumber, description);
  fs.writeFileSync(filePath, content);

  console.log(`   ✅ Created: ${filePath}`);

  // Step 4: Show next steps
  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("✅ Migration File Created!");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("");
  console.log("⚠️  NEXT STEPS:");
  console.log("");
  console.log(`1. Add your SQL to the migration file: ${filePath}`);
  console.log("");
  console.log(`2. Add to MIGRATION_FILES array in ./infra/database/lambda/db-init-handler.ts:`);
  console.log("");
  console.log(`   const MIGRATION_FILES = [`);
  console.log(`     // ... existing migrations ...`);
  console.log(`     '${filename}',  // ← ADD THIS LINE`);
  console.log(`   ];`);
  console.log("");
  console.log(`3. Test the migration:`);
  console.log(`   cd infra && npx cdk deploy AIStudio-DatabaseStack-Dev`);
  console.log("");
  console.log(`4. Verify in migration_log table that it ran successfully`);
  console.log("");
}

try {
  main();
} catch (error) {
  console.error("Fatal error:", error);
  process.exit(1);
}
