/** @jest-environment node */

import fs from "node:fs";
import path from "node:path";

const migrationName = "174-unified-content-message-sanitizer-recovery.sql";
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
const schema = fs.readFileSync(
  path.join(
    process.cwd(),
    "lib/db/schema/tables/repository-processing-jobs.ts",
  ),
  "utf8",
);
const releaseService = fs.readFileSync(
  path.join(
    process.cwd(),
    "lib/repositories/content-platform/post-deploy-recovery.ts",
  ),
  "utf8",
);

describe("migration 174 content message sanitizer recovery", () => {
  it("runs immediately after the globally previous migration", () => {
    const previousIndex = manifest.migrationFiles.indexOf(
      "173-repository-index-generation-retention.sql",
    );

    expect(previousIndex).toBeGreaterThanOrEqual(0);
    expect(manifest.migrationFiles[previousIndex + 1]).toBe(migrationName);
  });

  it("quarantines only exhausted inspect jobs with a locked error signature", () => {
    expect(migration).toContain("job.stage = 'inspect'");
    expect(migration).toContain("job.status = 'failed'");
    expect(migration).toContain("job.attempt >= job.max_attempts");
    expect(migration).toContain(
      "job.last_error_message LIKE '%set of allowed characters is%'",
    );
    expect(migration).toContain(
      "job.last_error_message LIKE 'Failed query:%repository_index_generations%'",
    );
    expect(migration).toContain(
      "post_deploy_recovery = 'content-message-sanitizer-v1'",
    );
    expect(migration).not.toContain("No searchable text was extracted");
  });

  it("never scopes recovery eligibility to a repository id", () => {
    expect(migration).not.toMatch(/repository_id\s*=\s*\d+/i);
    expect(migration).not.toMatch(/repository_id\s+IN\s*\(\s*\d+/i);
    expect(migration).toContain("item.current_version_id = version.id");
    expect(migration).toContain("item.lifecycle_status = 'active'");
    expect(migration).toContain("version.storage_status <> 'blocked'");
    expect(migration).toContain("version.inspection_status <> 'blocked'");
    expect(migration).toContain("version.object_key ~ (");
  });

  it("plumbs the marker through durable types and the release allowlist", () => {
    expect(schema.match(/"content-message-sanitizer-v1"/g)).toHaveLength(2);
    expect(releaseService).toContain(
      'POST_DEPLOY_CONTENT_MESSAGE_SANITIZER_MARKER =\n  "content-message-sanitizer-v1" as const',
    );
    expect(releaseService).toContain(
      "${POST_DEPLOY_CONTENT_MESSAGE_SANITIZER_MARKER}",
    );
  });
});
