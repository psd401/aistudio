/** @jest-environment node */

import fs from "node:fs";
import path from "node:path";

const migrationPath = path.join(
  process.cwd(),
  "infra/database/schema/116-unified-repository-content.sql"
);
const sql = fs.readFileSync(migrationPath, "utf8");
const officeMigrationPath = path.join(
  process.cwd(),
  "infra/database/schema/117-unified-content-office-ingestion.sql"
);
const officeSql = fs.readFileSync(officeMigrationPath, "utf8");

describe("migration 116 unified repository content", () => {
  it.each([
    "repository_item_versions",
    "repository_upload_sessions",
    "repository_processing_jobs",
    "repository_artifacts",
    "repository_index_generations",
  ])("creates %s additively", (tableName) => {
    expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${tableName}`);
  });

  it("keeps canonical rollout flags disabled by default", () => {
    expect(sql).toContain("('CONTENT_PLATFORM_ENABLED', 'false'");
    expect(sql).toContain("('CONTENT_DUAL_WRITE_ENABLED', 'false'");
    expect(sql).toContain("('CONTENT_READ_V2_ENABLED', 'false'");
    expect(sql).toContain("('CONTENT_MAX_PDF_SIZE_MB', '500'");
  });

  it("enforces quarantine, job idempotency, and one active generation", () => {
    expect(sql).toContain("storage_status varchar(20) NOT NULL DEFAULT 'quarantined'");
    expect(sql).toContain("inspection_status varchar(20) NOT NULL DEFAULT 'pending'");
    expect(sql).toContain("uq_repository_processing_idempotency");
    expect(sql).toContain("uq_repository_artifact_key");
    expect(sql).toContain("uq_repository_chunks_generation_index");
    expect(sql).toContain("uq_repository_active_generation");
    expect(sql).toContain("WHERE status = 'active'");
  });

  it("does not use an unsupported dollar-quoted migration block", () => {
    expect(sql).not.toMatch(/^\s*DO \$\$/mu);
  });

  it("seeds an independent administrator-controlled Office processing limit", () => {
    expect(officeSql).toContain("('CONTENT_MAX_OFFICE_SIZE_MB', '100'");
    expect(officeSql).toContain("ON CONFLICT (key) DO NOTHING");
    expect(officeSql).not.toMatch(/^\s*DO \$\$/mu);
  });
});
