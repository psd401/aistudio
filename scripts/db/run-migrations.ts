/**
 * Database Migration Runner for Local Development
 * Issue #607 - Local Development Environment
 *
 * This script runs database migrations against the local PostgreSQL instance.
 * It mirrors the logic in the AWS Lambda db-init-handler but runs locally.
 *
 * Usage:
 *   bun run db:migrate          # Run all pending migrations
 *   npm run db:migrate          # Same with npm
 *   tsx scripts/db/run-migrations.ts  # Direct execution
 *
 * Environment Variables:
 *   DATABASE_URL - PostgreSQL connection string (default: local docker)
 *   DB_SSL - Set to 'false' for local development without SSL
 */

import fs from "fs";
import path from "path";
import postgres from "postgres";

// Default to local PostgreSQL connection
const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@localhost:5432/aistudio";
const sslEnabled = process.env.DB_SSL !== "false";

// Migration files (must match MIGRATION_FILES in db-init-handler.ts)
const MIGRATION_FILES = [
  "010-knowledge-repositories.sql",
  "11_textract_jobs.sql",
  "12_textract_usage.sql",
  "013-add-knowledge-repositories-tool.sql",
  "014-model-comparisons.sql",
  "015-add-model-compare-tool.sql",
  "016-assistant-architect-repositories.sql",
  "017-add-user-roles-updated-at.sql",
  "018-model-replacement-audit.sql",
  "019-fix-navigation-role-display.sql",
  "020-add-user-role-version.sql",
  "023-navigation-multi-roles.sql",
  "024-model-role-restrictions.sql",
  "026-add-model-compare-source.sql",
  "027-messages-model-tracking.sql",
  "028-nexus-schema.sql",
  "029-ai-models-nexus-enhancements.sql",
  "030-nexus-provider-metrics.sql",
  "031-nexus-messages.sql",
  "032-remove-nexus-provider-constraint.sql",
  "033-ai-streaming-jobs.sql",
  "034-assistant-architect-enabled-tools.sql",
  "035-schedule-management-schema.sql",
  "036-remove-legacy-chat-tables.sql",
  "037-assistant-architect-events.sql",
  "039-prompt-library-schema.sql",
  "040-update-model-replacement-audit.sql",
  "041-add-user-cascade-constraints.sql",
  "042-ai-streaming-jobs-pending-index.sql",
  "043-migrate-documents-conversation-uuid.sql",
  "044-add-model-availability-flags.sql",
  "045-remove-chat-enabled-column.sql",
  "046-remove-nexus-capabilities-column.sql",
  "047-add-jsonb-defaults.sql",
  "048-remove-jsonb-not-null.sql",
];

const SCHEMA_DIR = path.join(
  process.cwd(),
  "infra",
  "database",
  "schema"
);

async function main(): Promise<void> {
  console.log("==========================================");
  console.log("AI Studio - Database Migration Runner");
  console.log("==========================================");
  console.log("");
  console.log(`Database: ${DATABASE_URL.replace(/:\/\/.*@/, "://*****@")}`);
  console.log(`SSL: ${sslEnabled ? "enabled" : "disabled"}`);
  console.log("");

  const sql = postgres(DATABASE_URL, {
    ssl: sslEnabled ? "require" : false,
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
  });

  try {
    // Test connection
    console.log("Testing database connection...");
    await sql`SELECT 1`;
    console.log("Connection successful!");
    console.log("");

    // Ensure migration_log table exists
    await sql`
      CREATE TABLE IF NOT EXISTS migration_log (
        id SERIAL PRIMARY KEY,
        step_number INTEGER NOT NULL,
        description TEXT NOT NULL,
        sql_executed TEXT,
        status VARCHAR(20) DEFAULT 'pending',
        error_message TEXT,
        executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    // Get already-run migrations
    const completedMigrations = await sql`
      SELECT description FROM migration_log WHERE status = 'completed'
    `;
    const completedSet = new Set(completedMigrations.map((r) => r.description));

    console.log("Processing migrations...");
    console.log("-------------------------");

    let runCount = 0;
    let skipCount = 0;

    for (const migrationFile of MIGRATION_FILES) {
      if (completedSet.has(migrationFile)) {
        console.log(`  SKIP: ${migrationFile} (already run)`);
        skipCount++;
        continue;
      }

      const filePath = path.join(SCHEMA_DIR, migrationFile);

      if (!fs.existsSync(filePath)) {
        console.log(`  WARN: ${migrationFile} not found`);
        continue;
      }

      console.log(`  RUN:  ${migrationFile}`);
      const startTime = Date.now();

      try {
        const sqlContent = fs.readFileSync(filePath, "utf8");

        // Split and execute statements
        const statements = splitSqlStatements(sqlContent);

        for (const statement of statements) {
          const trimmed = statement.trim();
          if (!trimmed || trimmed === ";") continue;

          try {
            await sql.unsafe(trimmed);
          } catch (err: unknown) {
            const error = err as Error;
            // Ignore "already exists" errors for idempotency
            if (
              error.message?.includes("already exists") ||
              error.message?.includes("duplicate key")
            ) {
              // Expected for idempotent migrations
            } else {
              throw error;
            }
          }
        }

        // Record success
        const duration = Date.now() - startTime;
        await sql`
          INSERT INTO migration_log (step_number, description, sql_executed, status)
          SELECT COALESCE(MAX(step_number), 0) + 1, ${migrationFile}, 'File executed', 'completed'
          FROM migration_log
        `;

        console.log(`        Completed in ${duration}ms`);
        runCount++;
      } catch (err: unknown) {
        const error = err as Error;
        console.error(`        FAILED: ${error.message}`);

        // Record failure
        await sql`
          INSERT INTO migration_log (step_number, description, sql_executed, status, error_message)
          SELECT COALESCE(MAX(step_number), 0) + 1, ${migrationFile}, 'File execution failed', 'failed', ${error.message}
          FROM migration_log
        `;

        throw error;
      }
    }

    console.log("");
    console.log("==========================================");
    console.log("Migration Summary");
    console.log("==========================================");
    console.log(`  Migrations run: ${runCount}`);
    console.log(`  Migrations skipped: ${skipCount}`);
    console.log(`  Total migrations: ${MIGRATION_FILES.length}`);
    console.log("");
  } finally {
    await sql.end();
  }
}

/**
 * Split SQL content into individual statements
 * Handles multi-line statements and preserves function/type definitions
 */
function splitSqlStatements(sqlContent: string): string[] {
  // Remove comments
  const withoutComments = sqlContent
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  const statements: string[] = [];
  let currentStatement = "";
  let inBlock = false;

  const lines = withoutComments.split("\n");

  for (const line of lines) {
    const trimmedLine = line.trim().toUpperCase();

    // Check if entering a block
    if (
      trimmedLine.startsWith("CREATE TYPE") ||
      trimmedLine.startsWith("CREATE FUNCTION") ||
      trimmedLine.startsWith("CREATE OR REPLACE FUNCTION") ||
      trimmedLine.startsWith("DROP TYPE")
    ) {
      inBlock = true;
    }

    currentStatement += line + "\n";

    // Check if line ends with semicolon
    if (line.trim().endsWith(";")) {
      if (
        inBlock &&
        (trimmedLine === ");" ||
          trimmedLine.endsWith(");") ||
          trimmedLine.endsWith("' LANGUAGE PLPGSQL;"))
      ) {
        inBlock = false;
      }

      if (!inBlock) {
        statements.push(currentStatement.trim());
        currentStatement = "";
      }
    }
  }

  if (currentStatement.trim()) {
    statements.push(currentStatement.trim());
  }

  return statements;
}

main().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
