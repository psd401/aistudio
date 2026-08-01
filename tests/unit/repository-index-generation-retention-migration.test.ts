/** @jest-environment node */

import fs from "node:fs";
import path from "node:path";

const migrationName = "173-repository-index-generation-retention.sql";
const migration = fs.readFileSync(
  path.join(process.cwd(), "infra/database/schema", migrationName),
  "utf8",
);
const manifest = JSON.parse(
  fs.readFileSync(
    path.join(process.cwd(), "infra/database/migrations.json"),
    "utf8",
  ),
) as { migrationFiles: string[] };

describe("migration 173 repository generation retention", () => {
  it("runs immediately after the previous migration head", () => {
    const previousIndex = manifest.migrationFiles.indexOf(
      "172-content-data-records.sql",
    );

    expect(previousIndex).toBeGreaterThanOrEqual(0);
    expect(manifest.migrationFiles[previousIndex + 1]).toBe(migrationName);
  });

  it("adds the partial ordering index used by the bounded collector", () => {
    expect(migration).toMatch(
      /CREATE INDEX IF NOT EXISTS\s+idx_repository_index_generations_superseded_retention/i,
    );
    expect(migration).toContain(
      "ON repository_index_generations (repository_id, created_at DESC, id DESC)",
    );
    expect(migration).toContain("WHERE status = 'superseded'");
  });
});
