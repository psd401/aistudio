/**
 * Shared Migration Utilities
 *
 * Common functions used across migration helper scripts.
 * Extracted to eliminate code duplication.
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #539 - Integrate Drizzle-Kit with existing Lambda migration system
 */

import * as fs from "node:fs";
import * as path from "node:path";

// Constants
const DB_INIT_HANDLER_PATH = "./infra/database/lambda/db-init-handler.ts";

/**
 * Get project root directory (absolute path)
 * Handles execution from any subdirectory
 */
export function getProjectRoot(): string {
  // Walk up from current directory to find package.json
  let currentDir = process.cwd();
  while (currentDir !== "/") {
    if (fs.existsSync(path.join(currentDir, "package.json"))) {
      return currentDir;
    }
    currentDir = path.dirname(currentDir);
  }
  throw new Error("Could not find project root (no package.json found)");
}

/**
 * Get absolute path for a project-relative path
 */
export function getAbsolutePath(relativePath: string): string {
  return path.join(getProjectRoot(), relativePath);
}

/**
 * Get the next migration number based on existing migrations
 * Reads from MIGRATION_FILES array in db-init-handler.ts
 */
export function getNextMigrationNumber(): number {
  const handlerPath = getAbsolutePath(DB_INIT_HANDLER_PATH);
  const handlerContent = fs.readFileSync(handlerPath, "utf-8");

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
  const filenames = arrayMatch[1].match(/'([^']+\.sql)'/g) || [];

  // Find highest migration number
  let maxNumber = 9; // Start at 009 so first migration is 010

  for (const filename of filenames) {
    const match = filename.match(/'(\d+)/);
    if (match) {
      const num = Number.parseInt(match[1], 10);
      if (num > maxNumber) {
        maxNumber = num;
      }
    }
  }

  return maxNumber + 1;
}

/**
 * Sanitize description for filename
 * Removes special characters, converts to lowercase, limits length
 */
export function sanitizeForFilename(description: string): string {
  return description
    .toLowerCase()
    .replace(/[^\da-z]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 50);
}

/**
 * Validate that SQL is not empty
 */
export function validateNotEmpty(sql: string): void {
  const trimmed = sql.trim();
  if (trimmed.length === 0) {
    throw new Error("Migration SQL cannot be empty");
  }

  // Check if it's only comments
  const withoutComments = trimmed
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .trim();

  if (withoutComments.length === 0) {
    throw new Error("Migration SQL contains only comments, no actual SQL statements");
  }
}
