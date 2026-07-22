#!/usr/bin/env bunx tsx
/**
 * List Migrations Script
 *
 * Lists all migrations in the shared migrations.json manifest and their status
 * (whether file exists in schema directory).
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #539 - Integrate Drizzle-Kit with existing Lambda migration system
 *
 * Usage:
 *   bunx tsx scripts/drizzle-helpers/list-migrations.ts
 *   bun run migration:list
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAbsolutePath, getNextMigrationNumber } from "./lib/migration-utils";

// Constants
const LAMBDA_SCHEMA_DIR = "./infra/database/schema";
const MIGRATIONS_MANIFEST_PATH = "./infra/database/migrations.json";

interface MigrationManifest {
  migrationFiles: string[];
}

interface MigrationInfo {
  filename: string;
  number: number;
  exists: boolean;
  size?: number;
  modified?: Date;
}

/**
 * Get all migrations from the same manifest used by the database Lambda and
 * local migration runner. The old handler-source parser broke when the Lambda
 * moved to this single source of truth.
 */
function getMigrations(): MigrationInfo[] {
  const manifestPath = getAbsolutePath(MIGRATIONS_MANIFEST_PATH);
  const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("migrationFiles" in parsed) ||
    !Array.isArray(parsed.migrationFiles) ||
    !parsed.migrationFiles.every(
      (filename) => typeof filename === "string" && filename.endsWith(".sql")
    )
  ) {
    throw new Error(
      `Invalid migrationFiles array in ${MIGRATIONS_MANIFEST_PATH}`
    );
  }
  const manifest = parsed as MigrationManifest;
  const migrations: MigrationInfo[] = [];

  for (const filename of manifest.migrationFiles) {
    const numberMatch = filename.match(/^(\d+)/);
    const number = numberMatch ? Number.parseInt(numberMatch[1], 10) : 0;

    const filePath = getAbsolutePath(path.join(LAMBDA_SCHEMA_DIR, filename));
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
function main(): void {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("📋 Migration Files List");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("");

  const migrations = getMigrations();
  const nextNumber = getNextMigrationNumber();

  console.log(`Source: ${MIGRATIONS_MANIFEST_PATH}`);
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
  console.log("  bun run drizzle:generate     Generate migration from schema changes");
  console.log("  bun run migration:prepare    Prepare drizzle migration for Lambda");
  console.log("  bun run migration:create     Create empty migration file");
  console.log("");
}

try {
  main();
} catch (error) {
  console.error("Fatal error:", error);
  process.exit(1);
}
