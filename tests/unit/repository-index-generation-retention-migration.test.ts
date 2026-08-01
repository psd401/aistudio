/** @jest-environment node */

import fs from "node:fs";
import path from "node:path";

const migrationName = "173-repository-index-generation-retention.sql";
const migration = fs.readFileSync(
  path.join(__dirname, "../../infra/database/schema", migrationName),
  "utf8",
);
const manifest = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../../infra/database/migrations.json"),
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

  it("tracks supersession time and adds the collector ordering index", () => {
    expect(migration).toContain(
      "ADD COLUMN IF NOT EXISTS superseded_at timestamptz",
    );
    expect(migration).toContain("DEFAULT statement_timestamp()");
    expect(migration).toContain("ALTER COLUMN superseded_at DROP DEFAULT");
    expect(migration).toContain(
      "CREATE TRIGGER trg_repository_index_generation_superseded_at",
    );
    expect(migration).toContain("NEW.superseded_at = clock_timestamp()");
    expect(migration).toContain("ELSIF TG_OP = 'INSERT' THEN");
    expect(migration).not.toContain("TG_OP = 'INSERT' OR OLD.status");
    expect(migration).toMatch(
      /CREATE INDEX IF NOT EXISTS\s+idx_repository_index_generations_superseded_retention/i,
    );
    expect(migration).toContain(
      "ON repository_index_generations (repository_id, superseded_at DESC, id DESC)",
    );
    expect(migration).toContain("WHERE status = 'superseded'");
  });
});
