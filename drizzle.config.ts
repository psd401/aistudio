import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit Configuration for postgres.js driver
 *
 * Issue #603 - Migrated from AWS RDS Data API to direct PostgreSQL connection
 *
 * Available commands:
 * - npm run drizzle:generate: Generate migration files from schema changes
 * - npm run drizzle:push: Push schema changes directly to database (use with caution)
 * - npm run drizzle:studio: Launch Drizzle Studio (NOW WORKS with direct connection!)
 * - npm run drizzle:check: Validate migration files for correctness
 *
 * Environment variables required:
 * - DATABASE_URL: Full PostgreSQL connection string
 *   Format: postgresql://user:password@host:port/database
 *
 * For local development with SSM tunnel:
 *   1. Run: ./scripts/db-tunnel.sh dev
 *   2. Set DATABASE_URL=postgresql://user:password@localhost:5432/aistudio
 *   3. Run: npm run drizzle:studio
 */

/**
 * Get database URL from environment
 * Supports DATABASE_URL or individual DB_* variables
 */
function getDatabaseUrl(): string {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  const host = process.env.DB_HOST;
  const port = process.env.DB_PORT || "5432";
  const user = process.env.DB_USER;
  const password = process.env.DB_PASSWORD;
  const database = process.env.DB_NAME || process.env.RDS_DATABASE_NAME || "aistudio";

  if (host && user && password) {
    return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
  }

  throw new Error(
    "DATABASE_URL environment variable is not set. " +
    "Set DATABASE_URL or DB_HOST/DB_USER/DB_PASSWORD for Drizzle Kit commands. " +
    "For local dev, use: ./scripts/db-tunnel.sh dev"
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./lib/db/schema/index.ts",
  // Output to drizzle folder for staging - use prepare-migration.ts to format and copy to Lambda schema dir
  out: "./drizzle/migrations",
  dbCredentials: {
    url: getDatabaseUrl(),
  },
  // Strict mode to ensure schema consistency
  strict: true,
  // Verbose output for debugging
  verbose: true,
});
