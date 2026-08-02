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
    expect(migration).not.toContain("DEFAULT statement_timestamp()");
    expect(migration).not.toContain("ALTER COLUMN superseded_at DROP DEFAULT");
    expect(migration).toContain(
      "CREATE OR REPLACE TRIGGER trg_repository_index_generation_superseded_at",
    );
    expect(migration).toContain("NEW.superseded_at := clock_timestamp()");
    expect(migration).toContain("ELSIF TG_OP = ''INSERT'' THEN");
    expect(migration).not.toContain("TG_OP = 'INSERT' OR OLD.status");
    expect(migration).toMatch(
      /CREATE INDEX IF NOT EXISTS\s+idx_repository_index_generations_superseded_retention/i,
    );
    expect(migration).toMatch(
      /CREATE INDEX IF NOT EXISTS\s+idx_repository_index_generations_superseded_backfill/i,
    );
    expect(migration).toContain(
      "ON repository_index_generations (created_at, id)",
    );
    expect(migration).toContain(
      "ON repository_index_generations (repository_id, superseded_at DESC, created_at DESC, id DESC)",
    );
    expect(migration).toMatch(
      /CREATE INDEX IF NOT EXISTS\s+idx_knowledge_repositories_active_index_generation/i,
    );
    expect(migration).toContain(
      "ON knowledge_repositories (active_index_generation_id)",
    );
    expect(migration).toContain("WHERE status = 'superseded'");
    expect(migration).toContain("REPOSITORY_GENERATION_GC_CURSOR");

    const addColumnIndex = migration.indexOf(
      "ADD COLUMN IF NOT EXISTS superseded_at timestamptz",
    );
    const triggerIndex = migration.indexOf(
      "CREATE OR REPLACE TRIGGER trg_repository_index_generation_superseded_at",
    );
    expect(addColumnIndex).toBeGreaterThanOrEqual(0);
    expect(triggerIndex).toBeGreaterThanOrEqual(0);
    expect(triggerIndex).toBeGreaterThan(addColumnIndex);
    expect(migration).not.toMatch(
      /\nUPDATE repository_index_generations\s+SET superseded_at/,
    );
    expect(migration).not.toMatch(
      /\nDROP TRIGGER IF EXISTS trg_repository_index_generation_superseded_at/,
    );
  });

  it("encodes the trigger function for the production line-based SQL splitter", () => {
    const functionLines = migration
      .split("\n")
      .filter((line) =>
        line.startsWith(
          "CREATE OR REPLACE FUNCTION set_repository_index_generation_superseded_at()",
        ),
      );

    expect(functionLines).toHaveLength(1);
    expect(functionLines[0]).toMatch(
      /^CREATE OR REPLACE FUNCTION .+ RETURNS trigger AS '.+' LANGUAGE plpgsql;$/,
    );
    expect(migration).not.toContain("AS $$");
  });
});
