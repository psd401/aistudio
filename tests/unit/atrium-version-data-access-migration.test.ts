/** @jest-environment node */

/**
 * Migration 183 (#1789) — `content_versions.data_access`.
 *
 * Migration 179 put the artifact data-bridge mode on the OBJECT, which made the
 * LIVE page's capability follow the author's draft. This migration moves the
 * stamp onto the version the code lives on.
 *
 * The load-bearing assertions:
 *  - the column is NULLABLE (documents carry no mode, and a pre-183 artifact
 *    version resolves as `?? object.data_access` — no capability changes at
 *    deploy time);
 *  - the enum type is NOT re-created (179 already declared it);
 *  - the backfill is idempotent and artifact-scoped, so a re-run can never
 *    overwrite a stamp application code wrote between two runs;
 *  - runner compatibility (no `DO $$`, no `CONCURRENTLY`).
 */

import fs from "node:fs";
import path from "node:path";
import { contentVersions } from "@/lib/db/schema/tables/content-versions";

const migrationName = "183-atrium-version-data-access.sql";
const migration = fs.readFileSync(
  path.join(process.cwd(), "infra/database/schema", migrationName),
  "utf8",
);
const executableSql = migration
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");
const normalizedSql = executableSql.replace(/\s+/g, " ");
const manifest = JSON.parse(
  fs.readFileSync(
    path.join(process.cwd(), "infra/database/migrations.json"),
    "utf8",
  ),
) as { migrationFiles: string[] };

describe("migration 183 version-scoped data access", () => {
  it("runs immediately after the previous migration head", () => {
    const previousIndex = manifest.migrationFiles.indexOf(
      "182-index-chunks-missing-embedding.sql",
    );

    expect(previousIndex).toBeGreaterThanOrEqual(0);
    expect(manifest.migrationFiles[previousIndex + 1]).toBe(migrationName);
  });

  it("adds a NULLABLE data_access column (documents and pre-183 rows carry none)", () => {
    expect(normalizedSql).toMatch(
      /ALTER TABLE content_versions ADD COLUMN IF NOT EXISTS data_access content_data_access\s*;/i,
    );
    // A NOT NULL / DEFAULT would stamp every document version with a meaningless
    // mode and erase the "no stamp → fall back to the object" signal.
    expect(normalizedSql).not.toMatch(/data_access content_data_access NOT NULL/i);
    expect(normalizedSql).not.toMatch(/data_access content_data_access DEFAULT/i);
  });

  it("does not re-create the enum type declared by migration 179", () => {
    expect(executableSql).not.toMatch(/CREATE TYPE content_data_access/i);
  });

  it("backfills artifact versions only, and only where nothing is stamped yet", () => {
    expect(normalizedSql).toMatch(/UPDATE content_versions v SET data_access = o\.data_access/i);
    expect(normalizedSql).toMatch(/o\.kind = 'artifact'/i);
    // The `IS NULL` guard is what makes a re-run a no-op instead of clobbering a
    // stamp written by `contentService.update` between two runs.
    expect(normalizedSql).toMatch(/v\.data_access IS NULL/i);
  });

  it("is compatible with the database initialization statement splitter", () => {
    expect(executableSql).not.toMatch(/\bDO\s+\$\$/i);
    expect(executableSql).not.toMatch(/\bCONCURRENTLY\b/i);
  });

  it("is mirrored by the Drizzle schema as a nullable column", () => {
    const column = contentVersions.dataAccess;

    expect(column.name).toBe("data_access");
    expect(column.notNull).toBe(false);
    expect(column.hasDefault).toBe(false);
  });
});
