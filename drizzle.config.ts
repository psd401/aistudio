import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit Configuration for AWS RDS Data API
 *
 * Available commands:
 * - drizzle:generate: Generate migration files from schema changes
 * - drizzle:push: Push schema changes directly to database (use with caution in production)
 * - drizzle:studio: Launch Drizzle Studio (requires direct TCP connection - not available via Data API)
 * - drizzle:check: Validate migration files for correctness
 *
 * Note: Uses AWS RDS Data API driver which works without VPC connectivity.
 * Perfect for local development and serverless environments.
 *
 * Environment variables required:
 * - RDS_RESOURCE_ARN: Aurora cluster ARN
 * - RDS_SECRET_ARN: Secrets Manager ARN for database credentials
 * - RDS_DATABASE_NAME: Database name (defaults to 'aistudio')
 */

/**
 * Retrieves a required environment variable with proper error handling
 * @param key - Environment variable name
 * @returns Environment variable value
 * @throws Error if environment variable is not set
 */
function getRequiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `Required environment variable ${key} is not set. ` +
        `Please ensure it's defined in your environment or .env file.`
    );
  }
  return value;
}

export default defineConfig({
  dialect: "postgresql",
  driver: "aws-data-api",
  schema: "./lib/db/schema/index.ts",
  out: "./drizzle/migrations",
  dbCredentials: {
    database: process.env.RDS_DATABASE_NAME || "aistudio",
    resourceArn: getRequiredEnv("RDS_RESOURCE_ARN"),
    secretArn: getRequiredEnv("RDS_SECRET_ARN"),
  },
});
