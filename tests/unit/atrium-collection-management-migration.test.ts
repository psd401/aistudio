import fs from "node:fs";
import path from "node:path";

const migrationName = "166-atrium-collection-management.sql";
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

describe("Atrium collection management migration", () => {
  it("registers the additive migration and private-policy backstop", () => {
    expect(manifest.migrationFiles).toContain(migrationName);
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS owner_user_id");
    expect(migration).toMatch(
      /owner_user_id integer REFERENCES users\(id\) ON DELETE CASCADE/
    );
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS inherit_grants");
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS archived_at");
    expect(migration).toMatch(
      /owner_user_id IS NULL[\s\S]+default_visibility_level = 'private'[\s\S]+inherit_grants = false/
    );
  });

  it("creates distinct view/create grants and seeds PSD Staff Intranet", () => {
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS content_collection_grants"
    );
    expect(migration).toContain("CHECK (access IN ('view', 'create'))");
    expect(migration).toContain("UNIQUE (collection_id, access, grant_kind, grant_value)");
    expect(migration).toContain("'PSD Staff Intranet'");
    expect(migration).toContain("'psd-staff-intranet'");
  });
});
