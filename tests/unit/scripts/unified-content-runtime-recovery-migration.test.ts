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

  it("only resets the current active item version into the pending outbox", () => {
    expect(migration).toContain("version.id = job.item_version_id");
    expect(migration).toContain("item.lifecycle_status = 'active'");
    expect(migration).toContain("job.last_error_code = 'RECOVERED_BY_MIGRATION_122'");
  });
});
