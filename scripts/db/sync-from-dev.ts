/**
 * Database Sync from AWS Dev to Local
 * Issue #607 - Local Development Environment
 *
 * This script syncs data from the AWS Aurora dev database to local PostgreSQL.
 * It exports data using pg_dump and imports to local.
 *
 * Prerequisites:
 *   - AWS CLI configured with appropriate credentials
 *   - Local PostgreSQL running (npm run db:up)
 *   - pg_dump and pg_restore installed locally
 *
 * Usage:
 *   bun run db:sync-dev
 *
 * Note: This requires network access to AWS Aurora (via VPN/bastion).
 * For most development work, the seed data (npm run db:seed) is sufficient.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { scriptLogger as log } from "./script-logger";

const LOCAL_DB_URL =
  process.env.LOCAL_DATABASE_URL ||
  "postgresql://postgres:postgres@localhost:5432/aistudio";

// Tables to exclude from sync (contain sensitive production data)
const EXCLUDED_TABLES = [
  "users", // Contains real user emails/PII
  "user_roles", // User-specific data
  "user_settings", // User preferences
  "sessions", // Authentication sessions
];

// Tables to sync (safe/anonymized data)
// NOTE: These are hardcoded table names - SQL injection is not possible
// since we only iterate over this known-safe list
const TABLES_TO_SYNC = [
  "roles",
  "tools",
  "role_tools",
  "ai_models",
  "ai_model_tiers",
  "model_role_restrictions",
  "navigation_items",
  "settings",
  "prompts",
  "prompt_categories",
];

async function main(): Promise<void> {
  log.section("AI Studio - Sync Data from AWS Dev");

  // Check if AWS environment variables are set
  const awsHost = process.env.AWS_DEV_DB_HOST;
  const awsUser = process.env.AWS_DEV_DB_USER;
  const awsPassword = process.env.AWS_DEV_DB_PASSWORD;
  const awsDatabase = process.env.AWS_DEV_DB_NAME || "aistudio";

  if (!awsHost || !awsUser || !awsPassword) {
    log.error("AWS database credentials not configured.");
    log.info("Required environment variables:");
    log.info("  AWS_DEV_DB_HOST     - Aurora cluster endpoint");
    log.info("  AWS_DEV_DB_USER     - Database username");
    log.info("  AWS_DEV_DB_PASSWORD - Database password");
    log.info("  AWS_DEV_DB_NAME     - Database name (default: aistudio)");
    log.info("Options to connect to AWS Aurora:");
    log.info("  1. Use AWS SSM Session Manager port forwarding");
    log.info("  2. Connect from a bastion host with network access");
    log.info("  3. Use AWS Client VPN");
    log.info("For most development work, use seed data instead:");
    log.info("  bun run db:seed");
    process.exit(1);
  }

  const awsDbUrl = `postgresql://${awsUser}:${encodeURIComponent(awsPassword)}@${awsHost}:5432/${awsDatabase}?sslmode=require`;

  // Create temp directory for dump files
  const tmpDir = path.join(process.cwd(), "tmp", "db-sync");
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  log.info("Syncing the following tables:");
  for (const t of TABLES_TO_SYNC) log.info(`  - ${t}`);
  log.info("Excluded tables (contain sensitive data):");
  for (const t of EXCLUDED_TABLES) log.info(`  - ${t}`);

  for (const table of TABLES_TO_SYNC) {
    const dumpFile = path.join(tmpDir, `${table}.sql`);

    log.info(`Syncing ${table}...`);

    try {
      // Export from AWS
      log.debug(`  Exporting from AWS...`);
      execSync(
        `pg_dump "${awsDbUrl}" --table=${table} --data-only --column-inserts --on-conflict-do-nothing > "${dumpFile}"`,
        { stdio: "pipe" }
      );

      // Import to local
      log.debug(`  Importing to local...`);
      execSync(`psql "${LOCAL_DB_URL}" -f "${dumpFile}"`, {
        stdio: "pipe",
      });

      // Get row count
      const countResult = execSync(
        `psql "${LOCAL_DB_URL}" -t -c "SELECT COUNT(*) FROM ${table};"`,
        { encoding: "utf8" }
      );
      log.success(`${table} (${countResult.trim()} rows)`);
    } catch (error: unknown) {
      const err = error as Error;
      log.warn(`Failed to sync ${table}: ${err.message}`);
    }

    // Clean up dump file
    if (fs.existsSync(dumpFile)) {
      fs.unlinkSync(dumpFile);
    }
  }

  // Clean up temp directory
  fs.rmdirSync(tmpDir, { recursive: true });

  log.section("Sync complete!");
  log.info("Note: User data was NOT synced for privacy.");
  log.info("Run 'bun run db:seed' to create local test users.");
}

main().catch((error) => {
  log.error("Sync failed", { error: error.message });
  process.exit(1);
});
