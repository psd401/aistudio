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
  console.log("==========================================");
  console.log("AI Studio - Sync Data from AWS Dev");
  console.log("==========================================");
  console.log("");

  // Check if AWS environment variables are set
  const awsHost = process.env.AWS_DEV_DB_HOST;
  const awsUser = process.env.AWS_DEV_DB_USER;
  const awsPassword = process.env.AWS_DEV_DB_PASSWORD;
  const awsDatabase = process.env.AWS_DEV_DB_NAME || "aistudio";

  if (!awsHost || !awsUser || !awsPassword) {
    console.log("ERROR: AWS database credentials not configured.");
    console.log("");
    console.log("Required environment variables:");
    console.log("  AWS_DEV_DB_HOST     - Aurora cluster endpoint");
    console.log("  AWS_DEV_DB_USER     - Database username");
    console.log("  AWS_DEV_DB_PASSWORD - Database password");
    console.log("  AWS_DEV_DB_NAME     - Database name (default: aistudio)");
    console.log("");
    console.log("Options to connect to AWS Aurora:");
    console.log("  1. Use AWS SSM Session Manager port forwarding");
    console.log("  2. Connect from a bastion host with network access");
    console.log("  3. Use AWS Client VPN");
    console.log("");
    console.log("For most development work, use seed data instead:");
    console.log("  bun run db:seed");
    console.log("");
    process.exit(1);
  }

  const awsDbUrl = `postgresql://${awsUser}:${encodeURIComponent(awsPassword)}@${awsHost}:5432/${awsDatabase}?sslmode=require`;

  // Create temp directory for dump files
  const tmpDir = path.join(process.cwd(), "tmp", "db-sync");
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  console.log("Syncing the following tables:");
  TABLES_TO_SYNC.forEach((t) => console.log(`  - ${t}`));
  console.log("");
  console.log("Excluded tables (contain sensitive data):");
  EXCLUDED_TABLES.forEach((t) => console.log(`  - ${t}`));
  console.log("");

  for (const table of TABLES_TO_SYNC) {
    const dumpFile = path.join(tmpDir, `${table}.sql`);

    console.log(`Syncing ${table}...`);

    try {
      // Export from AWS
      console.log(`  Exporting from AWS...`);
      execSync(
        `pg_dump "${awsDbUrl}" --table=${table} --data-only --column-inserts --on-conflict-do-nothing > "${dumpFile}"`,
        { stdio: "pipe" }
      );

      // Import to local
      console.log(`  Importing to local...`);
      execSync(`psql "${LOCAL_DB_URL}" -f "${dumpFile}"`, {
        stdio: "pipe",
      });

      // Get row count
      const countResult = execSync(
        `psql "${LOCAL_DB_URL}" -t -c "SELECT COUNT(*) FROM ${table};"`,
        { encoding: "utf8" }
      );
      console.log(`  Done (${countResult.trim()} rows)`);
    } catch (error: unknown) {
      const err = error as Error;
      console.log(`  WARNING: Failed to sync ${table}: ${err.message}`);
    }

    // Clean up dump file
    if (fs.existsSync(dumpFile)) {
      fs.unlinkSync(dumpFile);
    }
  }

  // Clean up temp directory
  fs.rmdirSync(tmpDir, { recursive: true });

  console.log("");
  console.log("==========================================");
  console.log("Sync complete!");
  console.log("==========================================");
  console.log("");
  console.log("Note: User data was NOT synced for privacy.");
  console.log("Run 'bun run db:seed' to create local test users.");
  console.log("");
}

main().catch((error) => {
  console.error("Sync failed:", error);
  process.exit(1);
});
