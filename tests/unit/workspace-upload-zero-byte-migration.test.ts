/** @jest-environment node */

import fs from "node:fs";
import path from "node:path";

const migrationName = "169-workspace-upload-zero-byte-files.sql";
const migration = fs.readFileSync(
  path.join(process.cwd(), "infra/database/schema", migrationName),
  "utf8"
);
const manifest = JSON.parse(
  fs.readFileSync(
    path.join(process.cwd(), "infra/database/migrations.json"),
    "utf8"
  )
) as { migrationFiles: string[] };

describe("migration 169 zero-byte workspace uploads", () => {
  it("runs immediately after the previous migration head", () => {
    const previousIndex = manifest.migrationFiles.indexOf(
      "168-repository-item-cancelled-status.sql"
    );

    expect(previousIndex).toBeGreaterThanOrEqual(0);
    expect(manifest.migrationFiles[previousIndex + 1]).toBe(migrationName);
  });

  it("replaces the positive-byte check with a nonnegative-byte check", () => {
    expect(migration).toContain(
      "DROP CONSTRAINT IF EXISTS " +
        "workspace_upload_reservations_expected_bytes_check"
    );
    expect(migration).toMatch(
      /CHECK\s*\(\s*expected_bytes\s*>=\s*0\s*\)/i
    );
    expect(migration).not.toMatch(
      /CHECK\s*\(\s*expected_bytes\s*>\s*0\s*\)/i
    );
  });
});
