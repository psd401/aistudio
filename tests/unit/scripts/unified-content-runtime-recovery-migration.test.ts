/** @jest-environment node */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("unified-content runtime recovery migration", () => {
  const migration = readFileSync(
    resolve(
      process.cwd(),
      "infra/database/schema/122-unified-content-runtime-recovery.sql"
    ),
    "utf8"
  );

  it("never revives security-blocked item versions", () => {
    expect(migration).toContain(
      "job.last_error_code IS DISTINCT FROM 'SECURITY_INSPECTION_BLOCKED'"
    );
    expect(migration).toContain("version.storage_status <> 'blocked'");
    expect(migration).toContain("version.inspection_status <> 'blocked'");
  });

  it("only quarantines canonical current versions for the replacement worker", () => {
    expect(migration).toContain("version.id = job.item_version_id");
    expect(migration).toContain("item.lifecycle_status = 'active'");
    expect(migration).toContain("SET status = 'cancelled'");
    expect(migration).toContain("available_at = 'infinity'::timestamptz");
    expect(migration).toContain(
      "'{\"postDeployRecovery\":\"unified-content-runtime-v2\"}'::jsonb"
    );
    expect(migration).toContain("AND version.object_key ~ (");
    expect(migration).toContain("repository.active_index_generation_id");
    expect(migration).not.toContain("SET status = 'pending'");
  });
});

describe("unified-content post-deployment handoff migration", () => {
  const migration = readFileSync(
    resolve(
      process.cwd(),
      "infra/database/schema/123-unified-content-postdeploy-handoff.sql"
    ),
    "utf8"
  );

  it("quarantines recovery work so the old worker cannot claim it", () => {
    expect(migration).toContain("SET status = 'cancelled'");
    expect(migration).toContain("max_attempts = 5");
    expect(migration).toContain("available_at = 'infinity'::timestamptz");
    expect(migration).toContain(
      "'{\"postDeployRecovery\":\"unified-content-runtime-v2\"}'::jsonb"
    );
    expect(migration).not.toContain("SET status = 'pending'");
  });

  it("matches only known migration-122 and deployment-runtime signatures", () => {
    expect(migration).toContain("'RECOVERED_BY_MIGRATION_122'");
    expect(migration).toContain("'CONTENT_PLATFORM_DISABLED'");
    expect(migration).toContain("item.processing_status = 'embedding_failed'");
    expect(migration).not.toContain("job.status IN ('failed', 'cancelled')");
  });

  it("excludes blocked, noncanonical, inactive, and already-serving versions", () => {
    expect(migration).toContain(
      "job.last_error_code IS DISTINCT FROM 'SECURITY_INSPECTION_BLOCKED'"
    );
    expect(migration).toContain("item.lifecycle_status = 'active'");
    expect(migration).toContain("version.storage_status <> 'blocked'");
    expect(migration).toContain("version.inspection_status <> 'blocked'");
    expect(migration).toContain("AND version.object_key ~ (");
    expect(migration).toContain("repository.active_index_generation_id");
  });
});
