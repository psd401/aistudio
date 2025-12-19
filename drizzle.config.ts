import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  driver: "aws-data-api",
  schema: "./lib/db/schema/index.ts",
  out: "./drizzle/migrations",
  dbCredentials: {
    database: process.env.RDS_DATABASE_NAME || "aistudio",
    resourceArn: process.env.RDS_RESOURCE_ARN!,
    secretArn: process.env.RDS_SECRET_ARN!,
  },
});
