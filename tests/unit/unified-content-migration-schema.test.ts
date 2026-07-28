/** @jest-environment node */

import fs from "node:fs";
import path from "node:path";

describe("migration 155 unified content retirement safety", () => {
  const migrationPath = path.join(
    process.cwd(),
    "infra/database/schema/155-unified-content-migration-retirement.sql",
  );
  const migration = fs.readFileSync(migrationPath, "utf8");
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), "infra/database/migrations.json"),
      "utf8",
    ),
  ) as { migrationFiles: string[] };

  it("is registered, additive, resumable, and guarded by independent flags", () => {
    expect(manifest.migrationFiles).toContain(
      "155-unified-content-migration-retirement.sql",
    );
    expect(migration).toContain("repository_migration_runs");
    expect(migration).toContain("repository_migration_items");
    expect(migration).toContain("uq_repository_migration_source");
    expect(migration).toContain("repository_retrieval_shadow_observations");
    expect(migration).toContain("repository_legacy_retirement_events");
    expect(migration).toContain("CONTENT_REPOSITORY_CUTOVER_ENABLED");
    expect(migration).toContain("CONTENT_NEXUS_CUTOVER_ENABLED");
    expect(migration).toContain("CONTENT_ASSISTANT_ARCHITECT_CUTOVER_ENABLED");
    expect(migration).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(migration).not.toMatch(/\bTRUNCATE\b/i);
  });
});

describe("migration 160 unified content source eligibility", () => {
  const migrationPath = path.join(
    process.cwd(),
    "infra/database/schema/160-unified-content-migration-source-eligibility.sql",
  );
  const migration = fs.readFileSync(migrationPath, "utf8");
  const migrationRunner = fs.readFileSync(
    path.join(
      process.cwd(),
      "lib/repositories/content-platform/migration-runner.ts",
    ),
    "utf8",
  );
  const migrationControl = fs.readFileSync(
    path.join(
      process.cwd(),
      "lib/repositories/content-platform/migration-control-service.ts",
    ),
    "utf8",
  );
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), "infra/database/migrations.json"),
      "utf8",
    ),
  ) as { migrationFiles: string[] };

  it("records unsupported connector discoveries without hiding migrated data", () => {
    expect(manifest.migrationFiles).toContain(
      "160-unified-content-migration-source-eligibility.sql",
    );
    expect(migration).toContain("'excluded'");
    expect(migration).toContain(
      "connector_source.status = 'unsupported'",
    );
    expect(migration).toContain(
      "migration.canonical_version_id IS NULL",
    );
    expect(migration).toContain(
      "migration.canonical_object_key IS NULL",
    );
    expect(migration).toContain(
      "'exclusionReason', 'unsupported_connector_source'",
    );
    expect(migration).not.toMatch(/\bDELETE\b/i);
    expect(migration).not.toMatch(/\bTRUNCATE\b/i);
  });

  it("excludes unsupported connector discoveries from inventory and backfill", () => {
    for (const source of [migrationRunner, migrationControl]) {
      expect(source).toContain(
        "FROM repository_connector_sources connector_source",
      );
      expect(source).toContain(
        "connector_source.status = 'unsupported'",
      );
      expect(source).toContain(
        "COALESCE(item.metadata, '{}'::jsonb) ? 'migrationSourceKind'",
      );
    }
  });
});
