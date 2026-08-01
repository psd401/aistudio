/** @jest-environment node */

import fs from "node:fs";
import path from "node:path";

const migrationName = "172-content-data-records.sql";
const migration = fs.readFileSync(
  path.join(process.cwd(), "infra/database/schema", migrationName),
  "utf8",
);
const executableSql = migration.replace(/--[^\n]*/g, "");
const normalizedSql = executableSql.replace(/\s+/g, " ");
const manifest = JSON.parse(
  fs.readFileSync(
    path.join(process.cwd(), "infra/database/migrations.json"),
    "utf8",
  ),
) as { migrationFiles: string[] };

describe("migration 172 content data records", () => {
  it("runs immediately after the previous migration head", () => {
    const previousIndex = manifest.migrationFiles.indexOf(
      "171-workspace-upload-zero-byte-files.sql",
    );

    expect(previousIndex).toBeGreaterThanOrEqual(0);
    expect(manifest.migrationFiles[previousIndex + 1]).toBe(migrationName);
  });

  it("creates the append-only artifact record shape", () => {
    expect(normalizedSql).toMatch(
      /CREATE TABLE IF NOT EXISTS content_data_records \( id UUID PRIMARY KEY DEFAULT gen_random_uuid\(\)/i,
    );
    expect(normalizedSql).toMatch(
      /content_id UUID NOT NULL REFERENCES content_objects\(id\) ON DELETE CASCADE/i,
    );
    expect(normalizedSql).toMatch(
      /user_id INTEGER REFERENCES users\(id\) ON DELETE SET NULL/i,
    );
    expect(normalizedSql).not.toMatch(/user_id INTEGER NOT NULL/i);
    expect(normalizedSql).toMatch(/payload JSONB NOT NULL/i);
    expect(normalizedSql).toMatch(
      /created_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/i,
    );
    expect(normalizedSql).not.toMatch(/\bupdated_at\b/i);
    expect(normalizedSql).not.toMatch(/\b(retention|expires_at|ttl)\b/i);
  });

  it("enforces the namespace contract in the database", () => {
    expect(normalizedSql).toMatch(/namespace VARCHAR\(64\) NOT NULL/i);
    expect(normalizedSql).toMatch(
      /CHECK \(namespace ~ '\^\[a-z0-9_-\]\{1,64\}\$'\)/i,
    );
  });

  it("indexes latest namespace reads and per-user reads", () => {
    expect(normalizedSql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_content_data_records_lookup ON content_data_records \(content_id, namespace, created_at DESC\)/i,
    );
    expect(normalizedSql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_content_data_records_user ON content_data_records \(content_id, namespace, user_id\)/i,
    );
  });

  it("is compatible with the database initialization statement splitter", () => {
    expect(executableSql).not.toMatch(/\bDO\s+\$\$/i);
    expect(executableSql).not.toMatch(/\bCONCURRENTLY\b/i);
    expect(executableSql).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK)\s*;/i);
  });

  it("documents a manual rollback", () => {
    expect(migration).toContain(
      "-- DROP TABLE IF EXISTS content_data_records;",
    );
  });
});
