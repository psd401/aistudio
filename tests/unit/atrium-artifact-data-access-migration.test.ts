/** @jest-environment node */

/**
 * Migration 179 (#1705) — `content_objects.data_access`.
 *
 * The load-bearing assertions here are the DEFAULT (`records`, so every artifact
 * created before this migration keeps working unchanged) and runner
 * compatibility: the db-init splitter enters block mode on a line starting with
 * `CREATE TYPE` and cannot handle a PL/pgSQL `DO $$` block, so the enum must be
 * declared as one bare statement.
 */

import fs from "node:fs";
import path from "node:path";
import { contentDataAccessEnum } from "@/lib/db/schema/enums";
import { CONTENT_DATA_ACCESS_MODES } from "@/lib/content/types";

const migrationName = "179-atrium-artifact-data-access.sql";
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

describe("migration 179 artifact data access", () => {
  it("runs immediately after the previous migration head", () => {
    const previousIndex = manifest.migrationFiles.indexOf(
      "178-atrium-ux-overhaul.sql",
    );

    expect(previousIndex).toBeGreaterThanOrEqual(0);
    expect(manifest.migrationFiles[previousIndex + 1]).toBe(migrationName);
  });

  it("declares exactly the three mutually exclusive modes", () => {
    expect(normalizedSql).toMatch(
      /CREATE TYPE content_data_access AS ENUM \('records', 'query', 'none'\);/i,
    );
  });

  it("defaults existing rows to the record store so nothing changes behaviour", () => {
    expect(normalizedSql).toMatch(
      /ADD COLUMN IF NOT EXISTS data_access content_data_access NOT NULL DEFAULT 'records'/i,
    );
  });

  it("is compatible with the database initialization statement splitter", () => {
    // A `DO $$` block would be split mid-body — the enum must be one statement.
    expect(executableSql).not.toMatch(/\bDO\s+\$\$/i);
    expect(executableSql).not.toMatch(/\bCONCURRENTLY\b/i);
    expect(executableSql).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK)\s*;/i);
    // The splitter leaves block mode on a line ending `);`, so the CREATE TYPE
    // must open and close on the same line.
    const createTypeLines = executableSql
      .split("\n")
      .filter((line) => /^\s*CREATE TYPE/i.test(line));
    expect(createTypeLines).toHaveLength(1);
    expect(createTypeLines[0].trim().endsWith(");")).toBe(true);
  });

  it("keeps every in-app mirror of the enum in sync with the SQL", () => {
    const sqlModes = /AS ENUM \(([^)]*)\)/i
      .exec(normalizedSql)?.[1]
      .split(",")
      .map((v) => v.trim().replace(/^'|'$/g, ""));

    expect(sqlModes).toEqual([...CONTENT_DATA_ACCESS_MODES]);
    expect(contentDataAccessEnum.enumValues).toEqual([
      ...CONTENT_DATA_ACCESS_MODES,
    ]);
  });

  it("keeps the psd-atrium skill's hand-maintained copy in sync", () => {
    // The skill is a standalone CJS script in the agent image and cannot import
    // from lib/, so its list is a manual mirror: pin it here.
    const skill = fs.readFileSync(
      path.join(process.cwd(), "infra/agent-image/skills/psd-atrium/run.js"),
      "utf8",
    );
    const match = /const DATA_ACCESS_MODES = \[([^\]]*)\];/.exec(skill);
    const skillModes = match?.[1]
      .split(",")
      .map((v) => v.trim().replace(/^'|'$/g, ""));

    expect(skillModes).toEqual([...CONTENT_DATA_ACCESS_MODES]);
  });

  it("documents a manual rollback", () => {
    expect(migration).toContain(
      "-- ALTER TABLE content_objects DROP COLUMN IF EXISTS data_access;",
    );
    expect(migration).toContain("-- DROP TYPE IF EXISTS content_data_access;");
  });
});
