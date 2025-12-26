#!/usr/bin/env npx tsx
/**
 * List Migrations Script
 *
 * Lists all migrations in the MIGRATION_FILES array and their status
 * (whether file exists in schema directory).
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #539 - Integrate Drizzle-Kit with existing Lambda migration system
 *
 * Usage:
 *   npx tsx scripts/drizzle-helpers/list-migrations.ts
 *   npm run migration:list
 */

import * as fs from "node:fs";
import * as path from "node:path";

// Constants
const LAMBDA_SCHEMA_DIR = "./infra/database/schema";
const DB_INIT_HANDLER_PATH = "./infra/database/lambda/db-init-handler.ts";

interface MigrationInfo {
  filename: string;
  number: number;
  exists: boolean;
  size?: number;
  modified?: Date;
}

/**
 * Get all migrations from MIGRATION_FILES array
 */
function getMigrations(): MigrationInfo[] {
  const handlerContent = fs.readFileSync(DB_INIT_HANDLER_PATH, "utf-8");

  // Extract MIGRATION_FILES array
  const arrayMatch = handlerContent.match(
    /const\s+MIGRATION_FILES\s*=\s*\[([\S\s]*?)];/
  );
  if (!arrayMatch) {
    throw new Error(
      `Could not find MIGRATION_FILES array in ${DB_INIT_HANDLER_PATH}`
    );
  }

  // Extract all migration filenames
  const filenameMatches = arrayMatch[1].match(/'([^']+\.sql)'/g) || [];
  const migrations: MigrationInfo[] = [];

  for (const match of filenameMatches) {
    const filename = match.replace(/'/g, "");
    const numberMatch = filename.match(/^(\d+)/);
    const number = numberMatch ? Number.parseInt(numberMatch[1], 10) : 0;

    const filePath = path.join(LAMBDA_SCHEMA_DIR, filename);
    const exists = fs.existsSync(filePath);

    let size: number | undefined;
    let modified: Date | undefined;

    if (exists) {
      const stats = fs.statSync(filePath);
      size = stats.size;
      modified = stats.mtime;
    }

    migrations.push({
      filename,
      number,
      exists,
      size,
      modified,
    });
  }

  return migrations;
}

/**
 * Get the next migration number
 */
function getNextMigrationNumber(migrations: MigrationInfo[]): number {
  let maxNumber = 9;
  for (const m of migrations) {
    if (m.number > maxNumber) {
      maxNumber = m.number;
    }
  }
  return maxNumber + 1;
}

/**
 * Format file size
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Main execution
 */
async function main(): Promise<void> {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("📋 Migration Files List");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("");

  const migrations = getMigrations();
  const nextNumber = getNextMigrationNumber(migrations);

  console.log(`Source: ${DB_INIT_HANDLER_PATH}`);
  console.log(`Schema dir: ${LAMBDA_SCHEMA_DIR}`);
  console.log(`Total migrations: ${migrations.length}`);
  console.log(`Next number: ${String(nextNumber).padStart(3, "0")}`);
  console.log("");
  console.log("─────────────────────────────────────────────────────────────────");
  console.log("  #    Status   Size      Filename");
  console.log("─────────────────────────────────────────────────────────────────");

  let missingCount = 0;

  for (const m of migrations) {
    const num = String(m.number).padStart(3, "0");
    const status = m.exists ? "  ✅  " : "  ❌  ";
    const size = m.exists && m.size !== undefined ? formatSize(m.size).padStart(8) : "        ";

    console.log(`${num}  ${status}  ${size}   ${m.filename}`);

    if (!m.exists) {
      missingCount++;
    }
  }

  console.log("─────────────────────────────────────────────────────────────────");
  console.log("");

  if (missingCount > 0) {
    console.log(`⚠️  ${missingCount} migration(s) listed but file not found in schema directory`);
    console.log("");
  }

  console.log("📝 Commands:");
  console.log("  npm run drizzle:generate     Generate migration from schema changes");
  console.log("  npm run migration:prepare    Prepare drizzle migration for Lambda");
  console.log("  npm run migration:create     Create empty migration file");
  console.log("");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
