import fs from "node:fs";
import path from "node:path";

const migrationName = "168-repository-item-cancelled-status.sql";
const migration = fs.readFileSync(
  path.join(process.cwd(), "infra/database/schema", migrationName),
  "utf8"
);
const manifest = JSON.parse(
  fs.readFileSync(
    path.join(process.cwd(), "infra/database/migrations.json"),
    "utf8"
  )
) as { migrationFiles: string[] };

function executableStatements(): string[] {
  return migration
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function processingStatuses(): string[] {
  const constraint = migration.match(
    /ADD CONSTRAINT repository_items_processing_status_check\s+CHECK\s*\(\s*processing_status IN\s*\(([\s\S]*?)\)\s*\);/
  );
  if (!constraint?.[1]) {
    throw new Error("repository_items processing-status CHECK was not found");
  }

  return Array.from(constraint[1].matchAll(/'([^']+)'/g), (match) => match[1]);
}

describe("migration 168 repository item cancellation", () => {
  it("runs immediately after the current migration head", () => {
    const previousIndex = manifest.migrationFiles.indexOf(
      "167-deep-research-interaction-binding.sql"
    );

    expect(previousIndex).toBeGreaterThanOrEqual(0);
    expect(manifest.migrationFiles[previousIndex + 1]).toBe(migrationName);
  });

  it("replaces the live legacy constraint and preserves every existing status", () => {
    expect(executableStatements()).toHaveLength(1);
    expect(migration).toContain(
      "DROP CONSTRAINT IF EXISTS repository_items_processing_status_check"
    );
    expect(processingStatuses()).toEqual([
      "pending",
      "processing",
      "processing_ocr",
      "processing_embeddings",
      "completed",
      "embedded",
      "failed",
      "embedding_failed",
      "cancelled",
    ]);
  });
});
